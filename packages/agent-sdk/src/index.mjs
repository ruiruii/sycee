/**
 * @sycee/agent-sdk — buyer-side (agent runtime) reference implementation.
 *
 * Two things only the buyer runtime can know:
 *   1. whether the paid result was actually referenced downstream  -> result.consumed
 *   2. how fresh the result was when it was used                   -> result.freshness_s
 *
 * The seller cannot observe either. This SDK instruments them and co-signs.
 */

import { buildVSR, sha256, canonicalJSON, signVSR, toSpanAttributes, verifyVSR, nowISO, SCHEMA_VERSION, attemptIdentity } from '@sycee/core';

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
/**
 * The nine members as the buyer composes them, or the reason it cannot.
 *
 * Separate from `identityFrom` so the same values feed the hash and the
 * comparison. Comparing against a second derivation would report a divergence
 * produced by our own two code paths rather than by the seller.
 */
function membersFrom({ url, method, accept }) {
  if (!accept || typeof accept !== 'object') return { members: null, unavailable: 'challenge_has_no_accepts' };
  const missing = CHALLENGE_MEMBERS.filter((m) => typeof accept[m] !== 'string' || accept[m] === '');
  if (missing.length) return { members: null, unavailable: `challenge_missing_${missing.join('_')}` };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { members: null, unavailable: 'unparseable_url' };
  }

  return {
    members: {
      method,
      origin: parsed.origin,
      path: parsed.pathname,
      query: parsed.search.replace(/^\?/, ''),
      payTo: accept.payTo,
      asset: accept.asset,
      network: accept.network,
      amount: accept.amount,
      scheme: accept.scheme,
    },
    unavailable: null,
  };
}

function identityFrom({ url, method, accept }) {
  const { members, unavailable } = membersFrom({ url, method, accept });
  if (!members) return { id: null, unavailable };
  try {
    return { id: attemptIdentity(members), unavailable: null };
  } catch (err) {
    // A members value this runtime cannot normalise is not an identity. Saying
    // so is better than substituting one.
    return { id: null, unavailable: `identity_error_${err && err.message ? err.message : 'unknown'}` };
  }
}

/**
 * Decode the seller's `x-sycee-members` header, if it sent one.
 *
 * Every member but `query` is published as a digest; `query` is a flag, because
 * it can carry a credential and a short one is recoverable from its digest. A
 * seller older than this header sends nothing, which is not an error.
 */
function publishedMembers(res) {
  const raw = res.headers?.get?.('x-sycee-members');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Which members the two sides disagree on, given both values.
 *
 * The buyer cannot see the seller's values, only their digests. So it hashes its
 * own and compares. For `query` the seller sends no digest and there is nothing
 * to compare; it is omitted here rather than listed as a divergence, because a
 * member nobody can compare is not a member the two sides disagree on.
 *
 * @returns {Array<{member: string, ours: string, theirs: string}>}
 */
function divergences(members, published) {
  if (!members || !published) return [];
  const out = [];
  for (const name of Object.keys(members)) {
    const theirs = published[name];
    // `null` is the seller's "I did not publish this one"; absent is the same
    // statement made by an older seller. Neither is a disagreement.
    if (theirs === null || theirs === undefined) continue;
    const ours = sha256(String(members[name]));
    if (ours !== theirs) out.push({ member: name, ours, theirs });
  }
  return out;
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
    // Hash the proof the way the signature path hashes everything: canonical
    // JSON, so two structurally identical proofs cannot hash differently just
    // because their keys were inserted in a different order. The seller hashes
    // the wire bytes it received; a buyer-side object must match on content,
    // not on property order, or the two sides disagree for no real reason.
    const proofHash = sha256(typeof proof === 'string' ? proof : canonicalJSON(proof));

    // Read the current header name, falling back to the legacy `x-gates-*` one
    // so a buyer keeps working against a seller that has not moved yet. New code
    // emits both (see middleware `setAliasedHeader`); this side prefers sycee.
    const receiptHeader = res.headers.get('x-sycee-receipt') ?? res.headers.get('x-gates-receipt');
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

    // Which members the seller says it hashed. Without this, a mismatch is one
    // opaque pair of hex strings and the buyer has no way to find the member it
    // got wrong — which is the buyer's own deployment half the time.
    const composed = membersFrom({ url, method, accept });
    const published = publishedMembers(res);

    const entry = {
      url,
      method,
      attemptIdentity: identity.id,
      identityUnavailable: identity.unavailable,
      // Empty when the seller sends no header, or when the two sides agree. A
      // non-empty list is the whole diagnosis: this member, these two digests.
      divergedAt: divergences(composed.members, published),
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
    // When the seller's receipt carries a resource_id, use it — both sides then
    // describe the same resource and a mismatch means a real disagreement. When
    // it does not, `entry.url` is a stand-in, not something the seller asserted:
    // pairing it against the seller's own resource_id would raise a mismatch
    // that our fallback invented. So the fallback is marked synthetic, and the
    // reconciliation skips that comparison instead of reporting noise.
    const sellerResourceId = entry.merchantReceipt?.vsr?.resource_id;
    const resourceIdSynthetic = sellerResourceId === undefined || sellerResourceId === null;
    const vsr = buildVSR({
      protocol: entry.merchantReceipt?.vsr?.protocol ?? 'x402',
      resourceId: sellerResourceId ?? entry.url,
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
      extra: resourceIdSynthetic ? { _vendor: { resource_id_synthetic: true } } : undefined,
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

  const warnings = [...m.warnings, ...a.warnings];

  if (merchantEnvelope?.vsr?.payment?.proof_hash !== agentEnvelope?.vsr?.payment?.proof_hash) {
    problems.push('proof_hash mismatch: the two receipts describe different payments');
  }
  // A resource_id the agent's SDK had to synthesise from the URL is not a claim
  // the seller ever made, so comparing it would manufacture a mismatch. Report
  // it as a caveat, not a disagreement.
  const agentResourceSynthetic = agentEnvelope?.vsr?._vendor?.resource_id_synthetic === true;
  if (agentResourceSynthetic) {
    if (merchantEnvelope?.vsr?.resource_id !== agentEnvelope?.vsr?.resource_id) {
      warnings.push('resource_id: the agent side used a synthesised value (from the URL), not one the seller asserted — not a real divergence');
    }
  } else if (merchantEnvelope?.vsr?.resource_id !== agentEnvelope?.vsr?.resource_id) {
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
    warnings,
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

  // Group the buyer's divergence reports by member, not by attempt.
  //
  // 412 unmatched rows that all disagree on `origin` are one proxy configuration,
  // not 412 incidents. Reporting them as a count of rows sends an operator
  // looking for a bug in the wrong place, and a per-row list is unreadable at
  // that size. `query` has no digest to compare and is counted separately.
  const byMember = {};
  const explained = { only_buyer: 0, only_seller: 0 };
  // A pair's buyer half is a brief, not the entry, so the divergences have to be
  // looked up on the entry it came from. Keyed by identity *and* presentation,
  // because one identity can carry several presentations in one ledger.
  const entryByKey = new Map();
  for (const entry of agentEntries) {
    if (!entry.attemptIdentity) continue;
    const list = entryByKey.get(entry.attemptIdentity) ?? [];
    list.push(entry);
    entryByKey.set(entry.attemptIdentity, list);
  }
  const taken = new Map();
  for (const pair of pairs) {
    if (pair.verdict !== 'only_buyer' && pair.verdict !== 'only_seller') continue;
    const list = entryByKey.get(pair.attemptIdentity) ?? [];
    const idx = taken.get(pair.attemptIdentity) ?? 0;
    taken.set(pair.attemptIdentity, idx + 1);
    const found = list[idx]?.divergedAt ?? [];
    if (!found.length) continue;
    explained[pair.verdict] += 1;
    for (const d of found) byMember[d.member] = (byMember[d.member] ?? 0) + 1;
  }
  if (Object.keys(byMember).length) {
    summary.divergences_by_member = byMember;
    summary.explained = explained;
  }

  return { pairs, summary, unidentified };
}
