/**
 * @sycee/agent-sdk — buyer-side (agent runtime) reference implementation.
 *
 * Two things only the buyer runtime can know:
 *   1. whether the paid result was actually referenced downstream  -> result.consumed
 *   2. how fresh the result was when it was used                   -> result.freshness_s
 *
 * The seller cannot observe either. This SDK instruments them and co-signs.
 */

import { buildVSR, sha256, signVSR, toSpanAttributes, verifyVSR, nowISO, SCHEMA_VERSION } from '@sycee/core';

/**
 * @param {{
 *   agentId?: string,
 *   publicKey: string,
 *   privateKey: string,
 *   keyId?: string,
 *   pay: (challenge: any, init: RequestInit, url: string) => Promise<string|Record<string,string>>,
 *   onSpan?: (attrs: Record<string, unknown>) => void,
 *   fetchImpl?: typeof fetch,
 * }} config
 */
export function createSpend(config) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  /** @type {any[]} */
  const ledger = [];

  /**
   * fetch that transparently handles a 402 challenge.
   * @param {string} url
   * @param {RequestInit} [init]
   */
  async function spendFetch(url, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    let res = await fetchImpl(url, init);

    if (res.status !== 402) return res;

    const challenge = await res.clone().json().catch(() => ({}));
    const proof = await config.pay(challenge, init, url);
    const headers = new Headers(init.headers ?? {});
    if (typeof proof === 'string') {
      headers.set('payment-signature', proof);
    } else {
      for (const [k, v] of Object.entries(proof)) headers.set(k, String(v));
    }

    res = await fetchImpl(url, { ...init, headers });
    const proofHash = sha256(typeof proof === 'string' ? proof : JSON.stringify(proof));

    const receiptHeader = res.headers.get('x-gates-receipt');
    let merchantReceipt = null;
    if (receiptHeader) {
      try {
        merchantReceipt = JSON.parse(Buffer.from(receiptHeader, 'base64url').toString('utf8'));
      } catch {
        merchantReceipt = null;
      }
    }

    const entry = {
      url,
      method,
      proofHash,
      deliveredAt: nowISO(),
      deliveryStatus: res.ok ? 'delivered' : 'failed',
      status: res.status,
      merchantReceipt,
      consumed: 'unknown',
      consumedBy: [],
      consumedAt: null,
    };
    ledger.push(entry);

    Object.defineProperty(res, 'gates', { value: makeHandle(entry), enumerable: false });
    return res;
  }

  function makeHandle(entry) {
    return {
      proofHash: entry.proofHash,
      /**
       * Record that this paid result was referenced downstream.
       * @param {string|string[]} by task_id / message_id / conversation_id
       */
      consumedBy(by, at = nowISO()) {
        const list = Array.isArray(by) ? by : [by];
        entry.consumedBy = [...new Set([...entry.consumedBy, ...list])];
        entry.consumed = 'yes';
        if (!entry.consumedAt) entry.consumedAt = at;
        return receipt(entry);
      },
      /** Record that the result was delivered but never referenced (idle spend). */
      notConsumed() {
        entry.consumed = 'no';
        return receipt(entry);
      },
      receipt: () => receipt(entry),
      entry,
    };
  }

  /**
   * Build + sign the agent-side VSR for a ledger entry.
   * @param {any} entry
   */
  function receipt(entry) {
    const vsr = buildVSR({
      protocol: entry.merchantReceipt?.vsr?.protocol ?? 'x402',
      resourceId: entry.merchantReceipt?.vsr?.resource_id ?? entry.url,
      proofHash: entry.proofHash,
      redeemCount: entry.merchantReceipt?.vsr?.payment?.redeem_count ?? 1,
      redeemResources: entry.merchantReceipt?.vsr?.payment?.redeem_resources,
      deliveryStatus: entry.deliveryStatus,
      deliveredAt: entry.deliveredAt,
      consumed: entry.consumed,
      consumedBy: entry.consumedBy.length ? entry.consumedBy : undefined,
      consumedAt: entry.consumedAt ?? undefined,
      requestFingerprint: entry.merchantReceipt?.vsr?.request_fingerprint,
      amount: entry.merchantReceipt?.vsr?.amount,
      publicKey: config.publicKey,
      agentId: config.agentId,
      keyId: config.keyId,
      role: 'agent',
      completeness: entry.merchantReceipt ? 'bilateral' : 'unilateral_agent',
    });
    const envelope = signVSR(vsr, config.privateKey);
    config.onSpan?.(toSpanAttributes(vsr));
    return envelope;
  }

  /**
   * Run a task scope. Paid results fetched inside the scope and never marked
   * consumed are finally recorded as `consumed = no` (idle spend),
   * unless `assumeUnknown` is set.
   */
  async function scope(taskId, fn, { assumeUnknown = false } = {}) {
    const before = ledger.length;
    const out = await fn(spendFetch, taskId);
    for (let i = before; i < ledger.length; i++) {
      const entry = ledger[i];
      if (entry.consumed === 'unknown' && !assumeUnknown) {
        entry.consumed = 'no';
        receipt(entry);
      }
    }
    return out;
  }

  /** Wrap a tool function so every paid call inside it is attributed to `taskId`. */
  function wrapTool(taskId, fn) {
    return async (...args) => {
      const before = ledger.length;
      const out = await fn(spendFetch, ...args);
      for (let i = before; i < ledger.length; i++) {
        const entry = ledger[i];
        if (entry.consumed === 'unknown') {
          entry.consumedBy = [taskId];
          entry.consumed = 'yes';
          entry.consumedAt = nowISO();
          receipt(entry);
        }
      }
      return out;
    };
  }

  return {
    fetch: spendFetch,
    scope,
    wrapTool,
    ledger,
    receipts: () => ledger.map(receipt),
  };
}

/**
 * Cross-check a merchant receipt against an agent receipt.
 *
 * This function is where L2 is decided. `completeness: bilateral` inside one
 * envelope is a claim the envelope cannot support — the counterpart may not
 * exist, may be unsigned, or may describe a different attempt. The verdict is
 * computed here, from two artifacts that each verify on their own.
 *
 * Requirements for a pair to be bilateral:
 *   - both envelopes verify (signature, schema, red lines);
 *   - the same `payment.proof_hash` — otherwise they describe different payments;
 *   - the same `resource_id` — one attempt against one resource;
 *   - one signer is `merchant` and the other is `agent` — two signatures from
 *     the same side are one party talking twice.
 *
 * @param {any} merchantEnvelope
 * @param {any} agentEnvelope
 * @returns {{ complete: boolean, completeness: 'bilateral'|'unilateral',
 *             level: 'L2'|'L1', problems: string[], warnings: string[] }}
 */
export function linkReceipts(merchantEnvelope, agentEnvelope) {
  const m = verifyVSR(merchantEnvelope);
  const a = verifyVSR(agentEnvelope);
  const problems = [...m.errors, ...a.errors];

  if (merchantEnvelope?.vsr?.payment?.proof_hash !== agentEnvelope?.vsr?.payment?.proof_hash) {
    problems.push('proof_hash mismatch: the two receipts describe different payments');
  }
  if (merchantEnvelope?.vsr?.resource_id !== agentEnvelope?.vsr?.resource_id) {
    problems.push('resource_id mismatch');
  }

  // An unsigned receipt is L0 telemetry, not a counterpart: pairing two artifacts
  // where one has no signature would let the unsigned side borrow the other's
  // evidence.
  if (m.level === 'L0' || a.level === 'L0') {
    problems.push('signature: both sides must be signed — an unsigned receipt is telemetry, not a counterpart');
  }

  const roles = [merchantEnvelope?.vsr?.signer?.role, agentEnvelope?.vsr?.signer?.role];
  const oneEach = roles.includes('merchant') && roles.includes('agent') && roles[0] !== roles[1];
  if (!oneEach) {
    problems.push(
      `signer roles: a pair must be one merchant and one agent, got ${roles.map(String).join(' + ')}`,
    );
  }

  const complete = problems.length === 0;
  return {
    complete,
    completeness: complete ? 'bilateral' : 'unilateral',
    level: complete ? 'L2' : 'L1',
    problems,
    warnings: [...m.warnings, ...a.warnings],
  };
}

export { SCHEMA_VERSION };
