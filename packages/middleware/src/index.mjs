/**
 * @sycee/middleware — resource-side (merchant) reference implementation.
 *
 * What this adds to an existing 402 handler:
 *   - counts how many times the SAME payment proof gets completed  -> redeem_count
 *   - records the settlement predicate -> settlement_status (§5.1)
 *   - records delivery status and timestamp
 *   - issues a signed VSR on every completed call
 *   - exports OTel `agent.spend.*` span attributes
 *
 * What it deliberately does NOT do:
 *   - move funds, verify the rail signature, or decide whether to accept payment
 *   - decide whether a settlement is final (the caller reports it; default in_flight)
 *   - score anyone
 *   - store the payment proof (only its hash)
 */

import {
  buildVSR,
  canonicalJSON,
  normalizeSettlement,
  nowISO,
  settlementConsistency,
  sha256,
  signVSR,
  toSpanAttributes,
  attemptIdentity as deriveAttemptIdentity,
  ATTEMPT_IDENTITY_SPEC,
  IDENTITY_MEMBERS,
  classifyRepeat,
  exportClaim,
  refusalLedger,
  signRefusal,
  REFUSAL_REASONS as REFUSAL_REASON_SET,
} from '@sycee/core';

/* ------------------------------------------------------------------ *
 * Receipt URL
 * ------------------------------------------------------------------ */

/**
 * The receipt itself travels in the `x-gates-receipt` header. This builds the
 * advertised URL for it, and is deliberately origin-relative: no route serves
 * a receipt by id on this middleware, so any absolute host baked in here would
 * be a claim about a deployment we do not control.
 */
function receiptUrl(req, proofHash) {
  const host = req?.headers?.host;
  const proto = req?.headers?.['x-forwarded-proto'] ?? 'http';
  const id = proofHash.slice(7, 23);
  return host ? `${proto}://${host}/receipt/${id}` : `/receipt/${id}`;
}

/* ------------------------------------------------------------------ *
 * Redemption store
 * ------------------------------------------------------------------ */

/**
 * In-process store. Single-instance only.
 * For multi-instance deployments implement the same interface over Redis.
 *
 * `recordSettlement` is how the store carries the one fact a repeat comparison
 * needs: how the attempt that already happened settled. A store that omits it
 * still works, and every repeat is then recorded as `could_not_compare` rather
 * than assumed to be pending.
 */
export function memoryStore() {
  /** @type {Map<string, {count: number, resources: Set<string>, firstSeen: string, settlement: string|null}>} */
  const map = new Map();
  return {
    async incr(proofHash, resourceId) {
      let rec = map.get(proofHash);
      if (!rec) {
        rec = { count: 0, resources: new Set(), firstSeen: nowISO(), settlement: null };
        map.set(proofHash, rec);
      }
      rec.count += 1;
      if (resourceId) rec.resources.add(resourceId);
      return { count: rec.count, resources: [...rec.resources], firstSeen: rec.firstSeen };
    },
    async get(proofHash) {
      const rec = map.get(proofHash);
      if (!rec) return null;
      return {
        count: rec.count,
        resources: [...rec.resources],
        firstSeen: rec.firstSeen,
        settlement: rec.settlement,
      };
    },
    async recordSettlement(proofHash, settlement) {
      const rec = map.get(proofHash);
      if (rec) rec.settlement = settlement;
    },
  };
}

/**
 * Redis-backed store. `client` must expose `incr`, `sadd`, `smembers`, `get`, `setnx`.
 * @param {any} client
 */
export function redisStore(client, { prefix = 'gates:proof:', ttlDays = 90 } = {}) {
  const ttl = Math.round(ttlDays * 86400);
  return {
    async incr(proofHash, resourceId) {
      const key = prefix + proofHash;
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttl);
      const resKey = `${key}:resources`;
      if (resourceId) {
        await client.sadd(resKey, resourceId);
        await client.expire(resKey, ttl);
      }
      const resources = await client.smembers(resKey);
      const firstSeen = (await client.get(`${key}:first`)) ?? nowISO();
      if (!(await client.get(`${key}:first`))) {
        await client.set(`${key}:first`, firstSeen, 'EX', ttl);
      }
      return { count: Number(count), resources, firstSeen };
    },
    async get(proofHash) {
      const key = prefix + proofHash;
      const raw = await client.get(key);
      if (raw === null || raw === undefined) return null;
      const resources = await client.smembers(`${key}:resources`);
      const firstSeen = (await client.get(`${key}:first`)) ?? nowISO();
      const settlement = (await client.get(`${key}:settlement`)) ?? null;
      return {
        count: Number(raw),
        resources,
        firstSeen,
        settlement,
      };
    },
    async recordSettlement(proofHash, settlement) {
      const key = prefix + proofHash;
      await client.set(`${key}:settlement`, settlement, 'EX', ttl);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Middleware factory
 * ------------------------------------------------------------------ */

const PAYMENT_HEADERS = ['payment-signature', 'x-payment', 'x-payment-signature', 'payment-proof'];

/**
 * Transport headers that may carry the settlement predicate on the wire (SPEC §5.1).
 * A transport may keep its own value; the mapping is `true -> settled`,
 * `queued -> in_flight`, absent -> `absent`.
 */
const SETTLEMENT_HEADERS = ['x-payment-settled', 'payment-settled', 'x-settlement-status'];

/**
 * Read a settlement signal from the request headers, if the transport emits one.
 * Returns `undefined` when nothing was signalled — never `absent`, because
 * "not yet observable" is not "not settled" (SPEC §5.1).
 *
 * @param {Record<string, any>} headers
 * @returns {'settled'|'in_flight'|'absent'|undefined}
 */
export function settlementFromHeaders(headers = {}) {
  for (const h of SETTLEMENT_HEADERS) {
    const raw = headers[h] ?? headers[h.toUpperCase()];
    if (raw === undefined || raw === null) continue;
    const v = Array.isArray(raw) ? raw[0] : raw;
    const value = String(v).trim().toLowerCase();
    if (value === 'true' || value === 'settled' || value === 'confirmed') return 'settled';
    if (value === 'queued' || value === 'pending' || value === 'in_flight') return 'in_flight';
    if (value === 'false' || value === 'absent' || value === 'none') return 'absent';
  }
  return undefined;
}

/**
 * What a repeat can be compared against, translated from the middleware's
 * settlement vocabulary into the refusal row's. `undefined` means the store has
 * nothing comparable — the earlier attempt is not "pending", it is unobserved,
 * and §5.1 says an absent observation is not a value.
 *
 * @param {{settlement?: string|null}|null|undefined} prior
 * @returns {'settled'|'pending'|'not_submitted'|undefined}
 */
function priorSettlementFor(prior) {
  const recorded = prior?.settlement;
  if (recorded === 'settled') return 'settled';
  if (recorded === 'in_flight') return 'pending';
  if (recorded === 'absent') return 'not_submitted';
  return undefined;
}

/**
 * @param {{
 *   resourceId: string,
 *   protocol?: string,
 *   price?: {value: string, currency: string},
 *   publicKey: string,
 *   privateKey: string,
 *   agentId?: string,
 *   keyId?: string,
 *   store?: ReturnType<typeof memoryStore>,
 *   onSpan?: (attrs: Record<string, unknown>) => void,
 *   attachReceipt?: boolean,
 *   verifyPayment?: (proofHeaderValue: string, req: any) => Promise<{ok: boolean, tradeNo?: string, reason?: string, settlement?: 'settled'|'in_flight'|'absent'|boolean}>,
 *   resourceFor?: (req: any) => string,
 *   settlementFor?: (proofHeaderValue: string, req: any) => Promise<'settled'|'in_flight'|'absent'|undefined>,
 *   keepRefusals?: boolean,
 *   payTo?: string,
 *   claimUrlFor?: (row: any) => string,
 * }} config
 */
export function createGates(config) {
  const store = config.store ?? memoryStore();
  const protocol = config.protocol ?? 'x402';
  const attachReceipt = config.attachReceipt ?? false;

  // Refusals are recorded by default. A middleware that only records accepted
  // calls is the exact state this was built to leave behind: the buyer has
  // nothing to point at, and "it paid / I refused" cannot be reconciled.
  const keepRefusals = config.keepRefusals ?? true;
  // 'count' (default) records the reuse and serves it; 'refuse' records it and
  // returns 402. Neither decides policy on the caller's behalf.
  const replayPolicy = config.replayPolicy ?? 'count';
  const ledger = keepRefusals ? refusalLedger({
    signingPublicKey: config.publicKey,
    privateKey: config.privateKey,
    payTo: config.payTo,
    protocol,
    agentId: config.agentId,
  }) : null;

  /**
   * Derive the attempt identity from the request as the client sent it (SPEC §3.1,
   * x402 §5.5). The presentation ordinal is not part of it: two presentations of
   * one request are one attempt that happened twice, and `presentation` on the row
   * is what tells the two rows apart.
   *
   * A request whose members cannot be read gets no identity, and the caller
   * records the attempt under a refusal instead of inventing one. Guessing the
   * members would produce an identity nobody else can reproduce.
   */
  /**
   * The payment requirements this server hands out, defined once.
   *
   * Five of these members are also inputs to the attempt identity. If the
   * challenge and the identity read them from different places, the buyer cannot
   * compute the identity we recorded, and there is no way for either side to
   * notice: both have a well-formed identity, and they simply never meet.
   */
  function paymentRequirements() {
    const price = config.price ?? { value: '0.010000', currency: 'USDC' };
    return {
      scheme: String(config.scheme ?? 'exact'),
      network: String(config.network ?? 'eip155:8453'),
      payTo: String(config.payTo ?? ''),
      asset: String(price.currency ?? ''),
      amount: String(price.value ?? price.amount ?? ''),
    };
  }

  /**
   * The origin as the buyer addressed it.
   *
   * A buyer computes `https://api.example.com`; this process behind a proxy sees
   * whatever the proxy forwarded. Hardcoding `https` here made local and proxied
   * deployments compute a different identity from every buyer that reached them,
   * which is a disagreement the protocol cannot report because neither side knows
   * the other's value. Forwarded headers are the way to agree; guessing is not.
   */
  function originFor(req) {
    const forwardedHost = req.headers?.['x-forwarded-host'];
    const host = forwardedHost ?? req.headers?.host;
    if (!host) return 'https://unknown.invalid';
    const forwardedProto = req.headers?.['x-forwarded-proto'];
    const proto = forwardedProto
      ? String(forwardedProto).split(',')[0].trim()
      : req.socket?.encrypted === true
        ? 'https'
        : 'http';
    return `${proto}://${String(host).split(',')[0].trim()}`;
  }

  /**
   * The nine members the identity is composed over, as this process sees them.
   *
   * One function, so the value that is hashed and the value that is published for
   * comparison cannot drift. A divergence report that is derived from the hash
   * would be a second implementation of the composition.
   */
  function identityMembersFor(req) {
    const url = new URL(req.url ?? '/', originFor(req));
    const reqs = paymentRequirements();
    return {
      method: req.method ?? 'GET',
      origin: url.origin,
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      payTo: reqs.payTo,
      asset: reqs.asset,
      network: reqs.network,
      amount: reqs.amount,
      scheme: reqs.scheme,
    };
  }

  function identityFor(req) {
    return deriveAttemptIdentity(identityMembersFor(req));
  }

  /**
   * The members, digested, for the buyer to compare against its own.
   *
   * Two hex strings that differ say only that something differs, and the buyer is
   * the side that has to fix it. So each member is published as a digest of its
   * value: a buyer can recompute its own and see which member it got wrong, and an
   * operator reading a log learns which one to look at without being handed the
   * values.
   *
   * `query` is reported as a match flag, not a digest. It can carry a credential,
   * and a six-character query can be recovered from its digest by trying the ones
   * a caller plausibly sends. The buyer already knows what it sent, so a flag is
   * as much as it needs; anyone else needs nothing.
   */
  function memberDigests(req) {
    const members = identityMembersFor(req);
    const out = {};
    for (const name of IDENTITY_MEMBERS) {
      out[name] = name === 'query' ? null : sha256(members[name]);
    }
    return out;
  }

  /** Publish the digests so the buyer can locate a divergence without us in it. */
  function attachMembers(req, res) {
    if (typeof res?.setHeader !== 'function') return;
    res.setHeader('x-sycee-members', Buffer.from(JSON.stringify(memberDigests(req)), 'utf8').toString('base64url'));
  }

  /** Record a refusal, and hand the caller the row so it can be surfaced. */
  function recordRefusal({ req, res, proofHash, attemptId, presentation, reason, settlement, evidenceClass, payTo }) {
    if (!ledger) return null;
    const built = ledger.record({
      decision: 'refused',
      reason,
      attemptIdentity: attemptId,
      presentation,
      resourceId: config.resourceFor?.(req) ?? config.resourceId,
      proofHash,
      settlement,
      final: settlement !== 'pending',
      evidenceClass,
      payTo,
    });
    const row = built.row;
    res?.setHeader?.('x-gates-refusal', Buffer.from(canonicalJSON(row), 'utf8').toString('base64url'));
    res?.setHeader?.('x-gates-refusal-reason', String(row.reason));
    // The refused rows are the ones a proxy disagrees on most often, so this is
    // the caller that matters most. Publishing the members only on the success
    // path left the buyer able to diagnose the calls that already worked.
    if (res) attachMembers(req, res);
    if (ledger.conflicts().length) {
      res?.setHeader?.('x-gates-refusal-conflict', 'true');
    }
    return row;
  }

  function readProof(req) {
    const headers = req?.headers ?? {};
    for (const h of PAYMENT_HEADERS) {
      const v = headers[h] ?? headers[h.toUpperCase()];
      if (v) return Array.isArray(v) ? v[0] : v;
    }
    return null;
  }

  function challenge(req, res) {
    const reqs = paymentRequirements();
    const body = {
      error: 'payment_required',
      gates_spec: 'v0.1',
      resource: config.resourceId,
      accepts: [
        {
          protocol,
          scheme: reqs.scheme,
          network: reqs.network,
          payTo: reqs.payTo,
          asset: reqs.asset,
          amount: reqs.amount,
          price: config.price ?? { value: '0.010000', currency: 'USDC' },
          // The buyer composes the same attempt identity from these members and
          // the request it just made. Without them it can only copy back the
          // identity we state, which says nothing about whether we agree.
          identity_spec: ATTEMPT_IDENTITY_SPEC,
          identity_members: IDENTITY_MEMBERS,
          note: 'Include a payment proof. SYCEE only records its hash.',
        },
      ],
    };
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    attachMembers(req, res);
    res.end(JSON.stringify(body));
  }

  /**
   * Wrap a paid handler. Handler signature: `(req, res) => Promise<{status?: number, body: unknown}>`
   * or a plain Node/Express handler that writes to `res` itself.
   */
  function guard(handler) {
    return async function gatesGuarded(req, res) {
      const proof = readProof(req);
      if (!proof) return challenge(req, res);

      const resourceId = config.resourceFor?.(req) ?? config.resourceId;
      const proofHash = sha256(proof);
      const proofSeenAt = nowISO();

      // --- redemption counting happens BEFORE we decide anything else ---
      const { count, resources, firstSeen } = await store.incr(proofHash, resourceId);

      // --- settlement predicate (SPEC §5.1) ------------------------------
      // Order of trust: a dedicated `settlementFor` hook, then the payment
      // verifier's own report, then the transport's wire header. If nothing can
      // be determined the value stays `in_flight`: "not yet observable" is not
      // "not settled", and the predicate stays fail-closed.
      let settlementStatus = 'in_flight';

      // One identity per request: a settled attempt and its refused replay share
      // it, and `presentation` is what tells the two rows apart.
      const attemptId = identityFor(req);

      /**
       * Which presentation of this attempt this is.
       *
       * Counted per identity, not per proof. `redeem_count` asks how many times
       * one proof was redeemed and answers 1 for two different proofs against
       * one URL; `presentation` asks how many times one attempt was presented,
       * and those two proofs are the 1st and 3rd presentation. Reusing the proof
       * count here gave two accepted rows `presentation: 1` — the same key with
       * the same ordinal, which the ledger can only read as a contradiction.
       */
      function nextPresentation() {
        if (!ledger) return count;
        const seen = ledger.rows().filter((row) => row.attempt_identity === attemptId).length;
        return seen + 1;
      }

      if (config.verifyPayment) {
        let verdict;
        try {
          verdict = await config.verifyPayment(proof, req);
        } catch (err) {
          // A throwing verifier is a refusal with a cause the server cannot
          // state; it still gets recorded rather than escaping as a 500.
          verdict = { ok: false, reason: 'internal_error', detail: String(err && err.message) };
        }
        if (!verdict.ok) {
          const reason = refusalReasonFor(verdict.reason);
          // The attempt never reached the rail, and that is a fact about it
          // worth keeping: a later presentation of this proof is a first
          // purchase, not a replay of a settled one.
          await store.recordSettlement?.(proofHash, 'absent');
          const row = recordRefusal({
            req,
            presentation: nextPresentation(),
            res,
            proofHash,
            attemptId,
            reason,
            settlement: 'not_submitted',
            payTo: config.payTo,
          });
          res.statusCode = 402;
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-gates-proof-hash', proofHash);
          res.end(JSON.stringify({
            error: 'payment_rejected',
            reason: verdict.reason,
            refusal_reason: row?.reason ?? null,
            refusal_receipt: row ? exportClaim(signRefusal(row, config.privateKey)) : null,
          }));
          return;
        }
        if (verdict.settlement !== undefined) {
          settlementStatus = normalizeSettlement(verdict.settlement);
        }
      }

      // Under `replayPolicy: 'refuse'` a repeat presentation is declined and
      // recorded before the handler runs, so the buyer holds a receivable
      // refusal instead of a silently billed second call.
      if (replayPolicy === 'refuse' && count > 1) {
        const prior = await store.get(proofHash);
        // The earlier attempt's settlement is read from what that attempt
        // recorded. This request's headers describe this request; using them
        // here filled in an absent observation with `pending`, which is the one
        // thing §5.1 forbids.
        const priorSettlement = priorSettlementFor(prior);
        const verdict = classifyRepeat({
          priorCount: count - 1,
          priorSettlement,
          priorStatusKnown: priorSettlement !== undefined,
        });
        if (verdict.decision === 'refused') {
          const row = recordRefusal({
            req,
            presentation: nextPresentation(),
            res,
            proofHash,
            attemptId,
            reason: verdict.reason,
            settlement: verdict.settlement,
            payTo: config.payTo,
          });
          res.statusCode = 402;
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-gates-proof-hash', proofHash);
          res.end(JSON.stringify({
            error: 'payment_rejected',
            reason: verdict.reason,
            refusal_reason: row?.reason ?? null,
            refusal_receipt: row ? exportClaim(signRefusal(row, config.privateKey)) : null,
          }));
          return;
        }
      }

      if (settlementStatus === 'in_flight' && config.settlementFor) {
        const reported = await config.settlementFor(proof, req);
        if (reported !== undefined) settlementStatus = normalizeSettlement(reported);
      }
      if (settlementStatus === 'in_flight') {
        const onWire = settlementFromHeaders(req.headers ?? {});
        if (onWire) settlementStatus = onWire;
      }

      // What this attempt saw about settlement, kept where the next presentation
      // of the same proof can read it. Without this the comparison has no input,
      // and the only way to produce a verdict would be to invent one.
      await store.recordSettlement?.(proofHash, settlementStatus);

      const completeSeenAt = nowISO();

      // The VSR's request_fingerprint is the same snapshot as the refusal row's
      // attempt_identity — SPEC §3.1 says the probe-step identifier and the
      // settlement-critical identity are one and the same. Computing a second,
      // narrower digest here would give the two records two keys that a verifier
      // cannot line up, which is the one thing the pair exists to let happen.

      // capture the handler's output without changing its behaviour
      let captured = null;
      const originalEnd = res.end.bind(res);
      let wrote = false;
      const outHeaders = {};
      res.setHeader('x-gates-proof-hash', proofHash);
      res.setHeader('x-gates-redeem-count', String(count));

      const result = await handler(req, res);

      if (result && typeof result === 'object' && 'body' in result) {
        captured = result;
      }
      wrote = res.writableEnded === true;

      const deliveredAt = nowISO();
      const deliveryStatus = captured
        ? (captured.status ?? 200) < 400
          ? 'delivered'
          : 'failed'
        : wrote
          ? 'delivered'
          : 'delivered';

      // Consumption is observable only by the buyer runtime, not by the seller.
      // Per SPEC §5.3, a merchant-signed VSR MUST set result.consumed = 'unknown'.
      // The buyer attests consumption with its own signature via @sycee/agent-sdk
      // (role 'agent'); linkReceipts() binds the two sides into bilateral evidence.
      const consumed = 'unknown';
      const consumedBy = undefined;

      const completeness = 'unilateral_merchant';

      // Fail-closed is preserved: settlement is not gating, but the pair
      // (settlement, delivery) is surfaced so a verifier can tell "incomplete"
      // from "contradiction" (SPEC §5.1).
      const consistency = settlementConsistency({ deliveryStatus, settlementStatus });

      const vsr = buildVSR({
        protocol,
        resourceId,
        proofHash,
        redeemCount: count,
        redeemResources: resources,
        settlementStatus,
        deliveryStatus,
        deliveredAt,
        consumed,
        consumedBy,
        consumedAt: consumed === 'yes' ? deliveredAt : undefined,
        requestFingerprint: attemptId,
        proofSeenAt: firstSeen ?? proofSeenAt,
        completeSeenAt,
        amount: config.price,
        publicKey: config.publicKey,
        agentId: config.agentId,
        keyId: config.keyId,
        role: 'merchant',
        completeness,
      });

      // The accepted row goes on the same ledger as the refusals, so the two
      // sides of one attempt are comparable instead of living in two stores.
      if (ledger) {
        ledger.record({
          decision: 'accepted',
          attemptIdentity: attemptId,
          presentation: nextPresentation(),
          resourceId,
          proofHash,
          settlement: settlementStatus === 'settled' ? 'settled' : settlementStatus === 'absent' ? 'unknown' : 'pending',
          final: settlementStatus !== 'in_flight',
          payTo: config.payTo,
          evidenceClass: undefined,
        });
      }

      const envelope = signVSR(vsr, config.privateKey);
      const encoded = Buffer.from(canonicalJSON(envelope), 'utf8').toString('base64url');

      res.setHeader('x-gates-receipt', encoded);
      // The members this row was keyed over, so the buyer can compare against its
      // own even when the call succeeded. A success that disagreed on `origin`
      // would otherwise be rejected by the buyer as unmatched and reported by
      // nobody as a disagreement.
      attachMembers(req, res);
      // No route serves /v1/receipt on this server, so the header points at the
      // request's own origin rather than a host we do not own.
      res.setHeader('x-gates-receipt-url', receiptUrl(req, proofHash));
      res.setHeader('x-gates-settlement-status', settlementStatus);
      if (consistency !== 'ok') res.setHeader('x-gates-settlement-consistency', consistency);
      for (const [k, v] of Object.entries(outHeaders)) res.setHeader(k, v);

      config.onSpan?.(toSpanAttributes(vsr));

      if (captured && !wrote) {
        res.statusCode = captured.status ?? 200;
        res.setHeader('content-type', 'application/json');
        const payload = attachReceipt
          ? { ...(typeof captured.body === 'object' ? captured.body : { data: captured.body }), _gates: envelope }
          : captured.body;
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      }
      return envelope;
    };
  }

  return {
    guard,
    store,
    readProof,
    /** Every decision this server made, accepted and refused, in order. */
    refusals: () => (ledger ? ledger.refusals() : []),
    ledger: () => (ledger ? ledger.rows() : []),
    tally: () => (ledger ? ledger.tally() : { total: 0, accepted: 0, refused: 0 }),
    unverifiable: () => (ledger ? ledger.unverifiable() : []),
    conflicts: () => (ledger ? ledger.conflicts() : []),
    /** Export one refusal as a claim the buyer can hold and show to a third party. */
    exportClaim: (index = 0) => {
      const refused = ledger ? ledger.refusals() : [];
      if (!refused[index]) return null;
      return exportClaim(signRefusal(refused[index], config.privateKey));
    },
    /** Signed, portable claims for every refusal this server recorded. */
    claims: () => (ledger ? ledger.refusals().map((r) => exportClaim(signRefusal(r, config.privateKey))) : []),
  };
}

/**
 * Wire strings a verifier hook may use, mapped onto the closed reason set.
 * Anything unmapped is still recorded — at the weakest evidence class — rather
 * than dropped, because a refusal that disappears is the failure this avoids.
 */
const REASON_ALIASES = {
  replay_already_settled: 'duplicate_payment',
  replay_in_flight: 'duplicate_payment',
  invalid_proof: 'invalid_signature',
  bad_signature: 'invalid_signature',
  expired: 'authorization_expired',
};

function refusalReasonFor(wire) {
  if (wire && Object.prototype.hasOwnProperty.call(REASON_ALIASES, wire)) {
    return REASON_ALIASES[wire];
  }
  // unknown wire strings do not silently become a *stronger* claim
  return Object.prototype.hasOwnProperty.call(REFUSAL_REASON_SET, wire) ? wire : 'internal_error';
}

export { buildVSR, signVSR, toSpanAttributes } from '@sycee/core';
