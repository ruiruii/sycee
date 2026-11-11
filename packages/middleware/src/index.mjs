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
  requestFingerprint,
  settlementConsistency,
  sha256,
  signVSR,
  toSpanAttributes,
  attemptIdentity as deriveAttemptIdentity,
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
 */
export function memoryStore() {
  /** @type {Map<string, {count: number, resources: Set<string>, firstSeen: string}>} */
  const map = new Map();
  return {
    async incr(proofHash, resourceId) {
      let rec = map.get(proofHash);
      if (!rec) {
        rec = { count: 0, resources: new Set(), firstSeen: nowISO() };
        map.set(proofHash, rec);
      }
      rec.count += 1;
      if (resourceId) rec.resources.add(resourceId);
      return { count: rec.count, resources: [...rec.resources], firstSeen: rec.firstSeen };
    },
    async get(proofHash) {
      const rec = map.get(proofHash);
      if (!rec) return null;
      return { count: rec.count, resources: [...rec.resources], firstSeen: rec.firstSeen };
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
      return {
        count: Number(raw),
        resources: await client.smembers(`${key}:resources`),
        firstSeen: (await client.get(`${key}:first`)) ?? nowISO(),
      };
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
   * Derive the attempt identity for one presentation.
   *
   * Deliberately not called `proof_hash`: two presentations of one payload are
   * one payload and two attempts, so the identity must also carry which
   * presentation this is.
   */
  function identityFor(req, proof, presentation) {
    return deriveAttemptIdentity({
      payload: proof,
      requirements: canonicalJSON({
        resource: config.resourceFor?.(req) ?? config.resourceId,
        protocol,
        price: config.price ?? { value: '0.010000', currency: 'USDC' },
      }),
      presentation,
    });
  }

  /** Record a refusal, and hand the caller the row so it can be surfaced. */
  function recordRefusal({ req, res, proofHash, attemptId, reason, settlement, evidenceClass, payTo }) {
    if (!ledger) return null;
    const built = ledger.record({
      decision: 'refused',
      reason,
      attemptIdentity: attemptId,
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
    const body = {
      error: 'payment_required',
      gates_spec: 'v0.1',
      resource: config.resourceId,
      accepts: [
        {
          protocol,
          price: config.price ?? { value: '0.010000', currency: 'USDC' },
          note: 'Include a payment proof. SYCEE only records its hash.',
        },
      ],
    };
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
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

      // One identity per presentation: a settled attempt and its refused replay
      // share one payload but are two attempts, so they must not share one id.
      const attemptId = identityFor(req, proof, count);

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
          const row = recordRefusal({
            req,
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
        const priorSettlement = prior
          ? (settlementFromHeaders(req.headers ?? {}) ?? 'pending')
          : undefined;
        const verdict = classifyRepeat({
          priorCount: count - 1,
          priorSettlement,
          priorStatusKnown: prior !== null,
        });
        if (verdict.decision === 'refused') {
          const row = recordRefusal({
            req,
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

      const completeSeenAt = nowISO();
      const fingerprint = requestFingerprint({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        params: req.query ?? {},
      });

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
        requestFingerprint: fingerprint,
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
