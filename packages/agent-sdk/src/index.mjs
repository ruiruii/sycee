/**
 * @sycee/agent-sdk — buyer-side (agent runtime) reference implementation.
 *
 * Two things only the buyer runtime can know:
 *   1. whether the paid result was actually referenced downstream  -> result.consumed
 *   2. how fresh the result was when it was used                   -> result.freshness_s
 *
 * The seller cannot observe either. This SDK instruments them and co-signs.
 */

import { buildVSR, sha256, signVSR, toSpanAttributes, verifyVSR, nowISO, SCHEMA_VERSION, attemptIdentity } from '@sycee/core';

/** The members of the attempt identity that live in the 402 challenge. */
const CHALLENGE_MEMBERS = ['scheme', 'network', 'payTo', 'asset', 'amount'];

/**
 * Compose the attempt identity from the request the agent made and the payment
 * requirements the seller handed back.
 *
 * Computed locally on purpose: copying the seller's value would make every
 * reconciliation pass by construction. The point of computing it separately is
 * that a disagreement becomes visible as two different keys, instead of two
 * parties quoting one number at each other.
 *
 * @returns {{ id: string|null, unavailable: string|null }}
 */
function identityFrom({ url, method, accept }) {
  if (!accept || typeof accept !== 'object') return { id: null, unavailable: 'challenge_has_no_accepts' };
  const missing = CHALLENGE_MEMBERS.filter((m) => typeof accept[m] !== 'string' || accept[m] === '');
  if (missing.length) return { id: null, unavailable: `challenge_missing_${missing.join('_')}` };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { id: null, unavailable: 'unparseable_url' };
  }

  try {
    return {
      id: attemptIdentity({
        method,
        origin: parsed.origin,
        path: parsed.pathname,
        query: parsed.search.replace(/^\?/, ''),
        payTo: accept.payTo,
        asset: accept.asset,
        network: accept.network,
        amount: accept.amount,
        scheme: accept.scheme,
      }),
      unavailable: null,
    };
  } catch (err) {
    // A members value this runtime cannot normalise is not an identity. Saying
    // so is better than substituting one.
    return { id: null, unavailable: `identity_error_${err && err.message ? err.message : 'unknown'}` };
  }
}

/**
 * Pull the seller's signed refusal out of a 402 body, if there is one.
 *
 * The first 402 is the challenge: an offer, not an answer, so it has none. A 402
 * that comes back after payment was sent is the seller declining an attempt the
 * buyer already made, and it is the one the buyer's ledger has to keep.
 */
async function refusalFrom(res) {
  if (res.status !== 402) return null;
  const body = await res.clone().json().catch(() => null);
  if (!body || typeof body !== 'object') return null;
  const receipt = body.refusal_receipt ?? null;
  const reason = body.refusal_reason ?? body.reason ?? null;
  if (!receipt && !reason) return null;
  return { reason, receipt };
}

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
    const accept = challenge?.accepts?.[0] ?? null;
    const identity = identityFrom({ url, method, accept });

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

    // A refusal is the seller's answer to a payment that was already sent. It
    // comes back as a signed receipt in the 402 body, and until now this SDK
    // dropped it — so the buyer's own ledger was missing exactly the case where
    // the two sides most often disagree.
    const refusal = await refusalFrom(res);

    const entry = {
      url,
      method,
      attemptIdentity: identity.id,
      identityUnavailable: identity.unavailable,
      // What the buyer actually saw, in the buyer's own words. The seller's row
      // says what the seller decided; this says what arrived.
      observedHttp: res.status,
      decision: res.ok ? 'accepted' : refusal ? 'refused' : 'unknown',
      proofHash,
      deliveredAt: nowISO(),
      deliveryStatus: res.ok ? 'delivered' : 'failed',
      status: res.status,
      refusal,
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

/* ------------------------------------------------------------------ *
 * Reconciliation: the buyer's ledger beside the seller's rows
 * ------------------------------------------------------------------ */

function briefBuyer(entry) {
  if (!entry) return null;
  return {
    observedHttp: entry.observedHttp,
    decision: entry.decision,
    refusalReason: entry.refusal?.reason ?? null,
    proofHash: entry.proofHash,
    at: entry.deliveredAt,
  };
}

function briefSeller(row) {
  if (!row) return null;
  return {
    decision: row.decision,
    reason: row.reason ?? null,
    settlement: row.settlement ?? null,
    proofHash: row.proof_hash ?? row.proofHash ?? null,
    presentation: row.presentation ?? null,
  };
}

function verdictFor(buyer, seller) {
  if (buyer && seller) {
    // The only thing both sides can see is whether the attempt ended in a
    // served response or a 402. Anything finer than that is one side's claim.
    const buyerAccepted = buyer.observedHttp < 400;
    const sellerAccepted = seller.decision === 'accepted';
    return buyerAccepted === sellerAccepted ? 'match' : 'status_disagrees';
  }
  return buyer ? 'only_buyer' : 'only_seller';
}

/**
 * Put the buyer's ledger beside the seller's rows, one attempt at a time.
 *
 * What this answers: do the two accounts describe the same set of attempts.
 * What it does not answer: which account is right. The buyer cannot see
 * settlement, the seller cannot see what arrived at the buyer, and a verdict
 * from either side would be a claim neither can support.
 *
 * `status_disagrees` means "look here", not "the seller lied" — and
 * `only_seller` can equally mean the buyer never turned logging on.
 *
 * @param {{ agentEntries?: any[], merchantRows?: any[] }} input
 */
export function reconcile({ agentEntries = [], merchantRows = [] } = {}) {
  const buyers = new Map();
  const sellers = new Map();
  const unidentified = [];

  for (const entry of agentEntries) {
    if (!entry.attemptIdentity) {
      unidentified.push({
        side: 'buyer',
        reason: entry.identityUnavailable ?? 'no_identity',
        url: entry.url,
        observedHttp: entry.observedHttp,
      });
      continue;
    }
    if (!buyers.has(entry.attemptIdentity)) buyers.set(entry.attemptIdentity, []);
    buyers.get(entry.attemptIdentity).push(entry);
  }

  for (const row of merchantRows) {
    const key = row.attempt_identity ?? row.attemptIdentity;
    if (!key) {
      unidentified.push({ side: 'seller', reason: 'row_without_identity', reason_code: row.reason ?? null });
      continue;
    }
    if (!sellers.has(key)) sellers.set(key, []);
    sellers.get(key).push(row);
  }

  const pairs = [];
  for (const key of new Set([...buyers.keys(), ...sellers.keys()])) {
    // Within one identity, the nth presentation is the nth time either side saw
    // this attempt. The buyer has no `presentation` field and does not need one.
    const buyerSide = [...(buyers.get(key) ?? [])].sort((a, b) =>
      String(a.deliveredAt).localeCompare(String(b.deliveredAt)));
    const sellerSide = [...(sellers.get(key) ?? [])].sort((a, b) =>
      (a.presentation ?? 1) - (b.presentation ?? 1));

    const n = Math.max(buyerSide.length, sellerSide.length);
    for (let i = 0; i < n; i++) {
      const buyer = buyerSide[i] ?? null;
      const seller = sellerSide[i] ?? null;
      pairs.push({
        attemptIdentity: key,
        presentation: i + 1,
        buyer: briefBuyer(buyer),
        seller: briefSeller(seller),
        verdict: verdictFor(buyer, seller),
      });
    }
  }

  const summary = {
    pairs: pairs.length,
    match: 0,
    status_disagrees: 0,
    only_buyer: 0,
    only_seller: 0,
    unidentified: unidentified.length,
  };
  for (const pair of pairs) summary[pair.verdict] += 1;

  return { pairs, summary, unidentified };
}
