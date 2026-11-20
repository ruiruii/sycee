/**
 * @sycee/core/refusal — the refusal half of the record.
 *
 * A merchant-signed VSR describes the outcome of an attempt *that reached a
 * handler*. It has no way to say "I declined, here is why", so a buyer whose
 * attempt was refused holds nothing but its own word. SPEC §5.4 defines the
 * refusal record; this module builds, signs, derives and verifies it.
 *
 * Design rules this module enforces, in code rather than in prose:
 *
 *   1. A refusal is recorded by default. `refusalRow()` emits a row for every
 *      decision, accepted or refused, so the accepted rows and the refused rows
 *      sit on one ledger and can be reconciled against each other.
 *   2. The evidence class is a ceiling, not a field the issuer picks. Each
 *      reason code maps to the highest class that is honest for it; an
 *      unrecognised code closes at the lowest class. Claiming more is an error.
 *   3. Two decisions about the same attempt cannot silently disagree. Merging
 *      a record that contradicts an earlier one about the same
 *      `attempt_identity` is refused, not overwritten.
 *   4. The signing key is never the address funds are paid to. Enforced at
 *      build time when both are known, and at verify time when the verifier
 *      knows the payee.
 *   5. A pending settlement is never presented as final.
 */

import { sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import {
  canonicalJSON,
  generateKeyPair,
  loadPrivateKey,
  loadPublicKey,
  nowISO,
  sha256,
  verifyVSR,
} from './index.mjs';

export const REFUSAL_SCHEMA_VERSION = 'sycee/refusal/v0.1';

/* ------------------------------------------------------------------ *
 * 1. Closed vocabularies
 * ------------------------------------------------------------------ */

/**
 * The highest evidence class that is honest for each reason.
 *
 * - `client_verifiable` — the buyer can check this itself from the bytes it
 *   sent and the response it got.
 * - `chain_verifiable`  — checkable against public ledger state.
 * - `issuer_asserted`   — only the issuer knows; the buyer must take its word.
 */
export const REASON_CEILING = Object.freeze({
  // the buyer holds the payload; it can re-check these itself
  invalid_signature: 'client_verifiable',
  wrong_amount: 'client_verifiable',
  wrong_recipient: 'client_verifiable',
  malformed_payload: 'client_verifiable',
  // public ledger state settles these
  authorization_expired: 'chain_verifiable',
  authorization_not_yet_valid: 'chain_verifiable',
  insufficient_funds: 'chain_verifiable',
  duplicate_payment: 'chain_verifiable',
  nonce_already_used: 'chain_verifiable',
  // both legs are public, but whether THIS attempt moved funds is not — see POSITIVE_MARKERS
  transfer_leg_failed: 'chain_verifiable',
  // no third party can check these; the issuer's word is all there is
  facilitator_timeout: 'issuer_asserted',
  risk_policy_rejected: 'issuer_asserted',
  commercial_refusal: 'issuer_asserted',
  internal_error: 'issuer_asserted',
});

/** Ordered weakest to strongest, so "exceeds the ceiling" is a comparison. */
export const EVIDENCE_ORDER = Object.freeze([
  'issuer_asserted',
  'client_verifiable',
  'chain_verifiable',
  'independently_witnessed',
]);

/** Two ways a comparison can fail to happen. They are different facts. */
export const REFUSAL_REASONS = Object.freeze({
  /** accepted, served */
  accepted: null,
  /** the same proof was already settled; this presentation is a repeat */
  replay_already_settled: 'the proof being presented was settled on an earlier attempt',
  /** the same proof is being presented concurrently and the first one is not final yet */
  replay_in_flight: 'another presentation of the same proof is not yet resolved',
  /** the prior attempt was recorded, but its settlement state could not be read */
  could_not_compare: 'the earlier attempt exists but its settlement state was unreadable',
  /** there is no prior attempt and the payload itself failed its own checks */
  invalid_signature: 'the payment payload does not carry a valid authorization signature',
  wrong_amount: 'the authorized amount differs from the price',
  wrong_recipient: 'the authorized recipient is not this merchant',
  malformed_payload: 'the payment payload could not be decoded',
  authorization_expired: 'the authorization window has already closed',
  authorization_not_yet_valid: 'the authorization window has not opened yet',
  insufficient_funds: 'the payer balance does not cover the authorized amount',
  nonce_already_used: 'the authorization nonce was already consumed on chain',
  transfer_leg_failed: 'the authorization leg executed and the transfer leg did not, in the same attempt',
  facilitator_timeout: 'the facilitator did not answer within the request budget',
  risk_policy_rejected: 'the issuer declined for a policy it does not disclose',
  commercial_refusal: 'the issuer declined commercially; no technical cause',
  internal_error: 'the issuer failed internally and is not claiming a cause',
});

export const DECISIONS = Object.freeze(['accepted', 'refused']);

/** Settlement predicate for a refused attempt. Never claims finality it lacks. */
export const SETTLEMENT_STATES = Object.freeze(['not_submitted', 'pending', 'settled', 'unknown']);

/* ------------------------------------------------------------------ *
 * 2. Pure rules (each one is a single testable function)
 * ------------------------------------------------------------------ */

/**
 * The two legs of a split-leg authorization, in the order they execute.
 *
 * A scheme that arrives as one call — EIP-3009 `transferWithAuthorization` is
 * the reference case — cannot produce a row split across these, because the
 * nonce and the balance change in one transaction. The gaps below are
 * unreachable for those schemes, which is the property that makes them gaps.
 */
export const LEGS = Object.freeze(['authorization', 'transfer']);

/** What the merchant could see about each leg at the moment it recorded. */
export const LEG_STATUS = Object.freeze({
  not_reached: 'the merchant never submitted this leg',
  executed: 'the merchant observed this leg complete',
  failed: 'the merchant observed this leg revert or be rejected',
  unknown: 'the merchant submitted this leg and learned nothing conclusive',
});

/**
 * A refusal may name a cause only when it holds the observation that cause
 * requires. Fill an absent observation with a default and the row claims more
 * than it saw — which is the defect this whole extension exists to catch.
 *
 * `transfer` is not always required: when the authorization leg never executed,
 * there is no second leg to have an opinion about.
 */
export const REQUIRED_LEG_STATUS = Object.freeze({
  invalid_signature: { authorization: ['failed', 'unknown'] },
  wrong_amount: { authorization: ['failed', 'unknown'] },
  wrong_recipient: { authorization: ['failed', 'unknown'] },
  malformed_payload: { authorization: ['failed', 'unknown', 'not_reached'] },
  authorization_expired: { authorization: ['failed', 'unknown'] },
  authorization_not_yet_valid: { authorization: ['failed', 'unknown'] },
  insufficient_funds: { authorization: ['failed', 'unknown'] },
  nonce_already_used: { authorization: ['failed', 'executed'] },
  transfer_leg_failed: {
    // The transfer leg must at least have been reached and failed. `unknown` is
    // deliberately excluded: "I submitted it and learned nothing" is a different
    // sentence from "it reverted", and merging the two is the drift this reason
    // exists to name. The authorization leg is left unpinned — recording
    // `not_reached` alongside a failed transfer is caught by the authorization
    // leg's own contract below, and recording `unknown` there is honest silence.
    authorization: ['executed', 'unknown'],
    transfer: ['failed'],
  },
  facilitator_timeout: { authorization: ['unknown'] },
  internal_error: { authorization: ['executed', 'unknown'] },
  risk_policy_rejected: { authorization: ['not_reached', 'unknown'] },
  commercial_refusal: { authorization: ['not_reached', 'unknown'] },
  replay_already_settled: { authorization: ['executed'] },
});

/**
 * The evidence ceiling is a claim about third parties, not about the scheme.
 *
 * Three facts sit close together and are easy to conflate. A nonce read against
 * a single attempt is a negative observation, and it carries over exactly: the
 * nonce is spent, so *this* attempt cannot have executed. A refusal that says
 * "the nonce was already spent" therefore stays checkable. A refusal that says
 * "the transfer leg of this attempt executed and then failed" rests on a
 * positive observation of a balance movement, and the ledger carries no attempt
 * identity to attribute it to. That one can never be stronger than the issuer's
 * word, and no scheme change fixes it — only a per-attempt marker on the
 * transfer leg would, and none exists in the reference schemes.
 */
export const POSITIVE_MARKERS = Object.freeze({
  authorization: 'nonce consumed on chain',
  transfer: 'balance moved — not attributable to one attempt',
});

/** Legs whose "executed" is a positive, unattributable observation. */
const UNATTRIBUTABLE_LEGS = Object.freeze(['transfer']);

/**
 * Which legs a reason's truth actually depends on having run.
 *
 * Separate from `REQUIRED_LEG_STATUS` on purpose: that table says what a row must
 * *observe*; this one says what the reason needs to be *true*. They differ for
 * `nonce_already_used`, where the nonce being spent is a fact about the attempt's
 * own signature and reads as a negative — checkable — while the transfer leg of a
 * split authorization reads as a positive nobody can attribute.
 */
export const DEPENDS_ON_EXECUTED = Object.freeze({
  transfer_leg_failed: ['authorization', 'transfer'],
});

/**
 * Can a third party reproduce the observation behind this claim?
 *
 * A reason reaches its own ceiling unless it relies on a leg whose executed
 * state no third party can attribute to one attempt. Absence of a contract
 * means the reason makes no leg claim at all, so it keeps its ceiling.
 *
 * @param {string} reason
 * @param {string} evidenceClass  what the row claims
 * @returns {{ok: boolean, ceiling: string, reason?: string}}
 */
export function reproducibleCeiling(reason, evidenceClass) {
  const contract = REQUIRED_LEG_STATUS[reason] ?? {};
  // A reason relies on a leg when executing that leg is a state the reason needs
  // in order to be true at all — single-valued `executed`, or `executed` sitting
  // beside a failure state that no third party can tell apart from it.
  // `nonce_already_used` is the exception the doc argues for: a spent nonce is a
  // negative read with a positive marker.
  // A reason depends on a leg for its *positive* claim when it needs the leg to
  // have run. `transfer_leg_failed` is the reference case: the reason only exists
  // because the transfer ran and then failed, so the row's causal claim rests on
  // the one observation no third party can attribute to a single attempt.
  const dependedOn = DEPENDS_ON_EXECUTED[reason] ?? [];
  const unattributable = dependedOn.filter((leg) => UNATTRIBUTABLE_LEGS.includes(leg));
  const ceiling = unattributable.length > 0 ? 'issuer_asserted' : ceilingFor(reason);

  const ci = EVIDENCE_ORDER.indexOf(evidenceClass);
  if (ci < 0) return { ok: false, ceiling, reason: 'evidence class is not in the enum' };
  if (ci > EVIDENCE_ORDER.indexOf(ceiling)) {
    const why = unattributable.length > 0
      ? THE_UNATTRIBUTED_BALANCE
      : `no leg this reason relies on is unattributable, so its ceiling is ${ceiling}`;
    return {
      ok: false,
      ceiling,
      reason: `${evidenceClass} exceeds a reproducible ceiling of ${ceiling}: ${why}`,
    };
  }
  return { ok: true, ceiling };
}

/** The sentence that carries the whole argument, kept in one place. */
export const THE_UNATTRIBUTED_BALANCE =
  'the ledger shows a balance moved, not which attempt moved it — the second leg of a split '
  + 'authorization has no per-attempt marker a third party can read, so a claim resting on it '
  + 'cannot be reproduced by anyone but the issuer';

/**
 * Check an observation record against the reason it is offered for.
 *
 * This is the function that rejects the plausible-but-unsupported row. It does
 * not judge whether the reason is true — nothing can. It judges whether the row
 * is in a position to have known.
 *
 * @param {{legs?: object, reason?: string}} input
 * @returns {{ok: boolean, code?: string, detail?: string}}
 */
export function legSupport({ legs, reason }) {
  if (!reason || !REFUSAL_REASONS[reason]) {
    return { ok: false, code: 'unreviewed_reason', detail: `no closed reason to support: ${String(reason)}` };
  }
  if (!legs || typeof legs !== 'object') {
    // Silence about both legs is not evidence that both failed.
    return { ok: true, code: 'not_measured', detail: 'no leg observation was supplied; the row asserts only its reason' };
  }
  for (const [leg, status] of Object.entries(legs)) {
    if (!LEGS.includes(leg)) {
      return { ok: false, code: 'unknown_leg', detail: `${leg} is not a leg of a split-leg authorization` };
    }
    if (!LEG_STATUS[status]) {
      return { ok: false, code: 'unknown_leg_status', detail: `${leg}: ${status} is not an observable state` };
    }
  }
  const required = REQUIRED_LEG_STATUS[reason];
  if (!required) {
    return { ok: false, code: 'no_leg_contract', detail: `${reason} has no leg contract; it cannot carry leg observations` };
  }
  for (const [leg, allowed] of Object.entries(required)) {
    const observed = legs[leg];
    if (observed === undefined) {
      return {
        ok: false,
        code: 'leg_not_observed',
        detail: `${reason} is a claim about the ${leg} leg; the row records nothing about it`,
      };
    }
    if (!allowed.includes(observed)) {
      return {
        ok: false,
        code: 'leg_contradicts_reason',
        detail: `${reason} needs ${leg} = ${allowed.join(' | ')}, the row records ${observed}`,
      };
    }
  }
  return { ok: true, code: 'supported' };
}

/**
 * The highest evidence class a reason is allowed to claim.
 * Unrecognised reasons close at the lowest class — they never get the benefit
 * of the doubt.
 * @param {string} reason
 * @returns {'issuer_asserted'|'client_verifiable'|'chain_verifiable'}
 */
export function ceilingFor(reason) {
  return REASON_CEILING[reason] ?? 'issuer_asserted';
}

/**
 * @param {string} cls
 * @param {string} reason
 * @returns {boolean} true when `cls` is no stronger than the reason allows
 */
export function withinCeiling(cls, reason) {
  const ci = EVIDENCE_ORDER.indexOf(cls);
  const li = EVIDENCE_ORDER.indexOf(ceilingFor(reason));
  if (ci < 0) return false;
  return ci <= li;
}

/**
 * Build the key material that a record must be signed with, and prove it is
 * not the address funds are paid to.
 *
 * The two addresses are different things: one signs records, one receives
 * money. Sharing them means one compromise does both, and it also lets a
 * merchant's record identity drift with its payout rotation.
 *
 * @param {object} input
 * @param {string} input.signingPublicKey  `ed25519:<b64url>`
 * @param {string} [input.payTo]           address funds are paid to, if known
 * @param {{signingPublicKey: string, payTo?: string}} [input.known]
 * @returns {{ok: boolean, code?: string, detail?: string}}
 */
export function signingKeyCheck({ signingPublicKey, payTo, known = {} }) {
  const payee = payTo ?? known.payTo;
  // The collision check runs before the format check on purpose: if the same
  // value is serving as both, that is the finding worth reporting, whether or
  // not the value also happens to be well-formed as a key.
  if (payee && String(payee).toLowerCase() === String(signingPublicKey ?? '').toLowerCase()) {
    return {
      ok: false,
      code: 'signing_key_is_payee',
      detail: 'the signing key is the payee address; records and funds must not share one key',
    };
  }
  if (typeof signingPublicKey !== 'string' || !/^ed25519:[A-Za-z0-9_-]{16,}$/.test(signingPublicKey)) {
    return { ok: false, code: 'signing_key_malformed', detail: 'signing key must be ed25519:<b64url>' };
  }
  if (!payee) {
    // Not measured is not the same as measured and fine. Say which.
    return {
      ok: true,
      code: 'not_measured',
      detail: 'no payee address was supplied, so the signing key could not be compared to it',
    };
  }
  return { ok: true, code: 'distinct' };
}

/**
 * A pending settlement may not be presented as a final refusal, and a settling
 * attempt may not be recorded as if nothing was submitted.
 * @param {{settlement: string, final: boolean, decision: string}} row
 * @returns {{ok: boolean, error?: string}}
 */
export function finalityCheck({ settlement, final, decision }) {
  if (!SETTLEMENT_STATES.includes(settlement)) {
    return { ok: false, error: `settlement: must be ${SETTLEMENT_STATES.join(' | ')}` };
  }
  if (!DECISIONS.includes(decision)) {
    return { ok: false, error: `decision: must be ${DECISIONS.join(' | ')}` };
  }
  if (settlement === 'pending' && final) {
    return {
      ok: false,
      error: 'finality: settlement is pending, so the decision cannot be final — the payment may still land',
    };
  }
  if (decision === 'accepted' && settlement === 'not_submitted') {
    return {
      ok: false,
      error: 'finality: an accepted attempt cannot have settlement = not_submitted',
    };
  }
  return { ok: true };
}

/**
 * Decide what a record must say about a repeat presentation of a proof.
 *
 * This is the case a payload-only identity cannot express: the same payload
 * presented twice is one payload and two attempts.
 *
 * @param {{priorCount: number, priorSettlement?: 'settled'|'pending'|'not_submitted'|'unknown', priorStatusKnown?: boolean}} input
 * @returns {{decision: 'accepted'|'refused', reason: string|null, settlement: string}}
 */
export function classifyRepeat({ priorCount, priorSettlement, priorStatusKnown = true }) {
  if (!priorCount || priorCount < 1) {
    return { decision: 'accepted', reason: null, settlement: 'not_submitted' };
  }
  if (!priorStatusKnown) {
    return { decision: 'refused', reason: 'could_not_compare', settlement: 'unknown' };
  }
  if (priorSettlement === 'settled') {
    return { decision: 'refused', reason: 'replay_already_settled', settlement: 'settled' };
  }
  if (priorSettlement === 'pending') {
    return { decision: 'refused', reason: 'replay_in_flight', settlement: 'pending' };
  }
  if (priorSettlement === 'not_submitted') {
    // the earlier attempt never reached the rail, so this one is not a replay
    return { decision: 'accepted', reason: null, settlement: 'not_submitted' };
  }
  return { decision: 'refused', reason: 'could_not_compare', settlement: 'unknown' };
}

/* ------------------------------------------------------------------ *
 * 3. Row construction and signing
 * ------------------------------------------------------------------ */

/**
 * The refusal-side identity: derived once from the attempt, never from the
 * payload alone. `presentation` distinguishes two presentations of one payload.
 *
 * @param {{payload: string, requirements: string, presentation?: string|number}} input
 * @returns {string} `sha256:<hex>`
 */
export function attemptIdentity({ payload, requirements, presentation = 1 }) {
  if (typeof payload !== 'string' || !payload) throw new TypeError('attemptIdentity: payload required');
  if (typeof requirements !== 'string' || !requirements) {
    throw new TypeError('attemptIdentity: requirements required');
  }
  return sha256(
    canonicalJSON({
      spec: REFUSAL_SCHEMA_VERSION,
      payload: sha256(payload),
      requirements: sha256(requirements),
      presentation: String(presentation),
    }),
  );
}

/**
 * Build an unsigned refusal row. Use `signRefusal` to get an envelope.
 *
 * @param {object} input
 * @param {'accepted'|'refused'} input.decision
 * @param {string} [input.reason]                required when refused
 * @param {string} input.attemptIdentity
 * @param {string} [input.resourceId]
 * @param {string} [input.protocol]
 * @param {string} [input.proofHash]             hash of the proof presented, if any
 * @param {string} input.signingPublicKey
 * @param {'merchant'|'agent'} [input.role]
 * @param {string} [input.agentId]
 * @param {object} [input.amount]
 * @param {string} input.settlement              not_submitted | pending | settled | unknown
 * @param {boolean} [input.final]
 * @param {string} [input.evidenceClass]         defaults to the reason's ceiling
 * @param {object} [input.legs]                  { authorization, transfer } — what was observed
 * @param {string} [input.observedAt]
 * @returns {object}
 */
export function refusalRow(input) {
  const decision = input.decision;
  if (!DECISIONS.includes(decision)) {
    throw new TypeError(`refusalRow: decision must be ${DECISIONS.join(' | ')}`);
  }
  const reason = decision === 'refused' ? input.reason : null;
  if (decision === 'refused' && !REFUSAL_REASONS[reason]) {
    throw new TypeError(
      `refusalRow: unknown reason ${String(reason)} — refusing needs a name, so add it to REFUSAL_REASONS`,
    );
  }
  if (typeof input.attemptIdentity !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.attemptIdentity)) {
    throw new TypeError('refusalRow: attemptIdentity must be sha256:<64 hex>');
  }

  const settlement = input.settlement ?? 'not_submitted';
  const final = input.final ?? settlement !== 'pending';
  const f = finalityCheck({ settlement, final, decision });
  if (!f.ok) throw new TypeError(`refusalRow: ${f.error}`);

  const k = signingKeyCheck({ signingPublicKey: input.signingPublicKey, payTo: input.payTo });
  if (!k.ok) throw new TypeError(`refusalRow: ${k.code} — ${k.detail}`);

  // An accepted row asserts no reason; a refused row's class is capped by its
  // reason. A caller may lower the class, never raise it.
  // Default to the reproducible ceiling, not the reason's base ceiling: a row that
  // picks its own default would be claiming more than anyone can check, by omission.
  const claimed = decision === 'refused'
    ? (input.evidenceClass ?? reproducibleCeiling(reason, ceilingFor(reason)).ceiling)
    : null;
  if (decision === 'refused' && !withinCeiling(claimed, reason)) {
    throw new TypeError(
      `refusalRow: evidence ${claimed} exceeds the ceiling for ${reason} (${ceilingFor(reason)})`,
    );
  }

  // A cause needs the observation that cause requires, and the class needs to be
  // one a third party could reproduce. Both checks run before the row exists, so
  // an unsupported row is never constructible — not merely unflattering.
  if (decision === 'refused') {
    const support = legSupport({ legs: input.legs, reason });
    if (!support.ok) {
      throw new TypeError(`refusalRow: ${support.code} — ${support.detail}`);
    }
    const reproducible = reproducibleCeiling(reason, claimed);
    if (!reproducible.ok) {
      throw new TypeError(`refusalRow: evidence ${claimed} is not reproducible — ${reproducible.reason}`);
    }
  }

  const row = {
    schema_version: REFUSAL_SCHEMA_VERSION,
    decision,
    attempt_identity: input.attemptIdentity,
    resource_id: input.resourceId ?? 'unknown',
    protocol: input.protocol ?? 'x402',
    settlement,
    final,
    observed_at: input.observedAt ?? nowISO(),
    signer: {
      public_key: input.signingPublicKey,
      role: input.role ?? 'merchant',
    },
    key_check: k.code,
  };
  if (reason) {
    row.reason = reason;
    row.reason_detail = REFUSAL_REASONS[reason];
    row.evidence_class = claimed;
  }
  if (input.proofHash) row.proof_hash = input.proofHash;
  // Recorded as observed, not as inferred. Absent means nothing was observed,
  // which is a different statement from "both legs failed".
  if (input.legs) row.legs = input.legs;
  if (input.amount) row.amount = input.amount;
  if (input.agentId) row.signer.agent_id = input.agentId;

  return JSON.parse(canonicalJSON(row));
}

/**
 * Sign a refusal row.
 * @param {object} row
 * @param {string} privateKeyRef
 * @returns {{refusal: object, signature: string}}
 */
export function signRefusal(row, privateKeyRef) {
  const payload = Buffer.from(canonicalJSON(row), 'utf8');
  const sig = ed25519Sign(null, payload, loadPrivateKey(privateKeyRef));
  return { refusal: row, signature: sig.toString('base64url') };
}

/* ------------------------------------------------------------------ *
 * 4. Ledger: one row per decision, refusals included
 * ------------------------------------------------------------------ */

const BINDING_RULES = Object.freeze({
  // a repeat decision about one attempt must not change these
  same: ['decision'],
  // identifiers must agree even when the decision differs (for example a
  // pending record that later resolves)
  stable: ['attempt_identity', 'signer.public_key', 'resource_id'],
});

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Merge a new row into a set of rows for one attempt.
 *
 * Every decision is kept. Two rows about the same attempt that contradict each
 * other on the decision itself are rejected: overwriting one with the other is
 * exactly the silent disagreement this record exists to prevent.
 *
 * @param {object[]} rows
 * @param {object} incoming
 * @returns {{rows: object[], added: boolean, conflict?: {path: string, had: unknown, got: unknown}}}
 */
export function mergeRow(rows, incoming) {
  const same = rows.filter((r) => r.attempt_identity === incoming.attempt_identity);
  for (const path of BINDING_RULES.stable) {
    for (const r of same) {
      const a = getPath(r, path);
      const b = getPath(incoming, path);
      if (a !== undefined && b !== undefined && a !== b) {
        return { rows, added: false, conflict: { path, had: a, got: b } };
      }
    }
  }
  for (const r of same) {
    if (r.decision === 'accepted' && incoming.decision === 'refused' && incoming.reason !== 'replay_already_settled' && incoming.reason !== 'replay_in_flight') {
      return {
        rows,
        added: false,
        conflict: { path: 'decision', had: 'accepted', got: incoming.decision },
      };
    }
  }
  const signature = canonicalJSON(incoming);
  if (rows.some((r) => canonicalJSON(r) === signature)) return { rows, added: false };
  return { rows: [...rows, incoming], added: true };
}

/**
 * An append-only ledger. One method, one behaviour: record a decision.
 *
 * A merchant uses `recordAttempt` on every 402 path and `recordOutcome` on the
 * accepted path; both end up in the same list, so "buyer says it paid / seller
 * says it refused" has somewhere to line up.
 *
 * @param {{signingPublicKey: string, privateKey: string, payTo?: string, protocol?: string, agentId?: string}} config
 */
export function refusalLedger(config) {
  /** @type {object[]} */
  const rows = [];
  const conflicts = [];

  function recordAttempt(input) {
    const row = refusalRow({
      signingPublicKey: config.signingPublicKey,
      payTo: config.payTo,
      protocol: config.protocol,
      agentId: config.agentId,
      ...input,
    });
    const merged = mergeRow(rows, row);
    if (merged.conflict) {
      conflicts.push({ row, conflict: merged.conflict });
      return { recorded: false, row, conflict: merged.conflict };
    }
    if (!merged.added) return { recorded: false, row, duplicate: true };
    rows.length = 0;
    rows.push(...merged.rows);
    return { recorded: true, row };
  }

  return {
    /** Record a refusal (or any explicit decision) for one attempt. */
    record: recordAttempt,
    /** All rows, accepted and refused, in the order they were recorded. */
    rows: () => rows.map((r) => ({ ...r })),
    /** Rows that carry a refusal, in the order they were recorded. */
    refusals: () => rows.filter((r) => r.decision === 'refused').map((r) => ({ ...r })),
    /** Rows whose evidence class is the weakest one — the ones a buyer cannot check. */
    unverifiable: () => rows
      .filter((r) => r.decision === 'refused' && r.evidence_class === 'issuer_asserted')
      .map((r) => ({ ...r })),
    /** Rows the ledger refused to accept because they contradicted an earlier one. */
    conflicts: () => conflicts.map((c) => ({ ...c })),
    /** Signed envelopes for every row, in ledger order. */
    envelopes: (privateKeyRef = config.privateKey) => rows.map((r) => signRefusal(r, privateKeyRef)),
    /** Two counts that must add up to the number of rows. */
    tally: () => ({
      total: rows.length,
      accepted: rows.filter((r) => r.decision === 'accepted').length,
      refused: rows.filter((r) => r.decision === 'refused').length,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 5. Export: a row becomes something a buyer can hold
 * ------------------------------------------------------------------ */

/**
 * Turn a ledger row into a portable claim a buyer can carry.
 *
 * The payload is the signed refusal envelope; the artifact adds what a holder
 * needs to check it without contacting the merchant: the claim itself, and a
 * digest over it.
 *
 * @param {{refusal: object, signature: string}} envelope
 * @param {{verifyUrl?: string}} [opts]
 */
export function exportClaim(envelope, opts = {}) {
  if (!envelope?.refusal || !envelope?.signature) {
    throw new TypeError('exportClaim: expected a signed refusal envelope');
  }
  const body = {
    type: 'x402-refusal-claim',
    version: 1,
    refusal: envelope.refusal,
    signature: envelope.signature,
  };
  if (opts.verifyUrl) body.verify_url = opts.verifyUrl;
  return {
    ...body,
    claim_id: sha256(canonicalJSON(body)),
    issued_at: nowISO(),
  };
}

/**
 * Verify a portable claim offline. No network, no merchant contact.
 *
 * Reports what it could not check as `not_measured` rather than as a pass:
 * a comparison that did not happen is not a comparison that succeeded.
 *
 * @param {any} claim
 * @param {{payTo?: string, signingPublicKey?: string}} [opts]
 */
export function verifyClaim(claim, opts = {}) {
  const errors = [];
  const notMeasured = [];
  const refusal = claim?.refusal;
  if (!refusal || typeof refusal !== 'object') {
    return { valid: false, errors: ['claim: missing refusal'], notMeasured, checks: {} };
  }
  if (refusal.schema_version !== REFUSAL_SCHEMA_VERSION) {
    errors.push(`schema_version: expected ${REFUSAL_SCHEMA_VERSION}, got ${String(refusal.schema_version)}`);
  }

  // signature
  const envelope = { vsr: null, refusal, signature: claim.signature };
  let signatureOk = false;
  try {
    signatureOk = ed25519Verify(
      null,
      Buffer.from(canonicalJSON(refusal), 'utf8'),
      loadPublicKey(refusal.signer?.public_key),
      Buffer.from(String(claim.signature ?? ''), 'base64url'),
    );
  } catch (err) {
    errors.push(`signature: verification error — ${/** @type {Error} */ (err).message}`);
  }
  if (!signatureOk && !errors.some((e) => e.startsWith('signature'))) {
    errors.push('signature: ed25519 verification failed');
  }
  void envelope;

  // evidence ceiling — the reason a claim is honest is bounded by its reason
  const checks = { signature: signatureOk };
  if (refusal.decision === 'refused') {
    if (!REFUSAL_REASONS[refusal.reason]) {
      errors.push(`reason: unknown ${String(refusal.reason)}`);
    } else if (!withinCeiling(refusal.evidence_class, refusal.reason)) {
      errors.push(
        `evidence_class: ${refusal.evidence_class} exceeds the ceiling for ${refusal.reason} (${ceilingFor(refusal.reason)})`,
      );
    }
    checks.evidenceWithinCeiling = !errors.some((e) => e.startsWith('evidence_class'));
  }

  // finality
  const f = finalityCheck({
    settlement: refusal.settlement,
    final: refusal.final,
    decision: refusal.decision,
  });
  if (!f.ok) errors.push(f.error);
  checks.finality = f.ok;

  // signing key vs payee
  const k = signingKeyCheck({
    signingPublicKey: refusal.signer?.public_key,
    payTo: opts.payTo,
    known: { payTo: refusal.signer?.pay_to },
  });
  if (!k.ok) errors.push(`${k.code}: ${k.detail}`);
  if (k.code === 'not_measured') notMeasured.push('signing_key_vs_payee');
  checks.signingKeyDistinct = k.ok && k.code !== 'not_measured';

  // a verifier that was given the expected key can pin it
  if (opts.signingPublicKey && refusal.signer?.public_key !== opts.signingPublicKey) {
    errors.push('signer: public key does not match the expected key');
  }

  return { valid: errors.length === 0, errors, notMeasured, checks };
}

/* ------------------------------------------------------------------ *
 * 6. Test key material
 * ------------------------------------------------------------------ */

export { generateKeyPair, verifyVSR };
