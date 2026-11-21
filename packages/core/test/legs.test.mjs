import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptIdentity,
  legSupport,
  refusalRow,
  reproducibleCeiling,
  generateKeyPair,
  LEGS,
  LEG_STATUS,
  POSITIVE_MARKERS,
  REFUSAL_REASONS,
  REQUIRED_LEG_STATUS,
  BOUNDED_LEG_STATUS,
  LEG_SETTLEMENT,
  legSettlementCheck,
  ceilingFor,
} from '../src/index.mjs';

const KEYS = generateKeyPair();
const ATTEMPT = attemptIdentity({ payload: 'permit-payload', requirements: 'evm:8453', presentation: 1 });

function row(over = {}) {
  return refusalRow({
    decision: 'refused',
    reason: 'transfer_leg_failed',
    attemptIdentity: ATTEMPT,
    signingPublicKey: KEYS.publicKey,
    settlement: 'not_submitted',
    legs: { authorization: 'executed', transfer: 'failed' },
    ...over,
  });
}

/* ---------------------------------------------------------------- *
 * the reason exists because a split-leg scheme needs it
 * ---------------------------------------------------------------- */

test('transfer_leg_failed is in the closed set and closes at issuer_asserted when it claims the transfer executed', () => {
  assert.ok(REFUSAL_REASONS.transfer_leg_failed, 'the reason must be in the closed vocabulary');
  // the base ceiling allows chain_verifiable, because both legs are public
  assert.equal(ceilingFor('transfer_leg_failed'), 'chain_verifiable');
  // but a row cannot actually get there — see the repro test below
  assert.throws(
    () => row({ evidenceClass: 'chain_verifiable' }),
    /not_reproducible/,
    'a claim resting on "the transfer executed" cannot be chain_verifiable',
  );
});

test('the two legs and their four states are closed vocabularies', () => {
  assert.deepEqual(LEGS, ['authorization', 'transfer']);
  assert.deepEqual(Object.keys(LEG_STATUS), ['not_reached', 'executed', 'failed', 'unknown']);
  assert.deepEqual(Object.keys(POSITIVE_MARKERS), [...LEGS]);
});

/* ---------------------------------------------------------------- *
 * the row that must be rejected: plausible, and unsupported
 * ---------------------------------------------------------------- */

test('the canonical reject: authorization executed, transfer reverted, class chain_verifiable', () => {
  // the reason's base ceiling permits chain_verifiable, because both legs are public
  assert.equal(ceilingFor('transfer_leg_failed'), 'chain_verifiable');
  // and the row still cannot get there: the transfer leg has no per-attempt marker
  assert.throws(
    () => row({ evidenceClass: 'chain_verifiable' }),
    /refusalRow: not_reproducible — chain_verifiable exceeds a reproducible ceiling of issuer_asserted/,
  );
  // the honest version of the same event
  const honest = row();
  assert.equal(honest.evidence_class, 'issuer_asserted');
  assert.deepEqual(honest.legs, { authorization: 'executed', transfer: 'failed' });
  assert.equal(honest.final, true);
  assert.equal(honest.settlement, 'not_submitted');
});

/* ---------------------------------------------------------------- *
 * a cause needs the observation that cause requires
 * ---------------------------------------------------------------- */

test('naming a leg cause without observing that leg is refused', () => {
  // no legs at all: permitted, but the row says nothing about them
  const silent = row({ legs: undefined });
  assert.equal(silent.legs, undefined);

  // transfer_leg_failed with no transfer observation is a claim about nothing
  assert.throws(
    () => row({ legs: { authorization: 'executed' } }),
    /leg_not_observed/,
  );
});

test('a leg observed the wrong way round contradicts the reason', () => {
  // "the transfer leg failed" while recording that the authorization never ran
  assert.throws(
    () => row({ legs: { authorization: 'not_reached', transfer: 'failed' } }),
    /leg_contradicts_reason/,
  );
  // The reason is a conjunction, so the authorization leg may not be unread
  // either: a merchant that did not see it run cannot claim it ran. That
  // merchant records facilitator_timeout or internal_error (§15.3).
  assert.throws(
    () => row({ legs: { authorization: 'unknown', transfer: 'failed' } }),
    /leg_contradicts_reason/,
  );
  // and an honest facilitator timeout with the same unread leg is fine
  assert.equal(
    row({ reason: 'facilitator_timeout', legs: { authorization: 'unknown' }, settlement: 'unknown' })
      .legs.authorization,
    'unknown',
  );
});

test('a leg that is not a leg is refused rather than ignored', () => {
  assert.throws(
    () => row({ legs: { authorization: 'executed', transfer: 'failed', approval: 'executed' } }),
    /unknown_leg/,
  );
  assert.throws(
    () => row({ legs: { authorization: 'executed', transfer: 'probably' } }),
    /unknown_leg_status/,
  );
});

test('a reason that names no cause cannot record one on the transfer leg', () => {
  // §15.3 puts internal_error where the transfer leg was submitted and answered
  // nothing — that is `unknown`, and the row is allowed to say so.
  const unread = row({
    reason: 'internal_error',
    legs: { authorization: 'executed', transfer: 'unknown' },
    settlement: 'unknown',
  });
  assert.equal(unread.legs.transfer, 'unknown');
  assert.equal(unread.reason, 'internal_error');

  // `failed` is transfer_leg_failed's sentence. A row that writes it under
  // internal_error contradicts its own definition, which says it names no cause.
  assert.throws(
    () => row({
      reason: 'internal_error',
      legs: { authorization: 'unknown', transfer: 'failed' },
      settlement: 'unknown',
    }),
    /leg_contradicts_reason/,
  );
  // Narrowing the authorization leg to `unknown` used to make that row legal
  // without making it true. The bracketed cell is what closes it, so the same
  // input fails whatever the authorization leg records.
  assert.throws(
    () => row({
      reason: 'internal_error',
      legs: { authorization: 'executed', transfer: 'failed' },
      settlement: 'unknown',
    }),
    /leg_contradicts_reason/,
  );
  // the other reason §15.3 names beside it behaves the same way
  assert.throws(
    () => row({
      reason: 'facilitator_timeout',
      legs: { authorization: 'unknown', transfer: 'failed' },
      settlement: 'unknown',
    }),
    /leg_contradicts_reason/,
  );
  // and no reason may record a transfer that executed: that is a payment
  assert.throws(
    () => row({
      reason: 'internal_error',
      legs: { authorization: 'executed', transfer: 'executed' },
      settlement: 'unknown',
    }),
    /leg_contradicts_reason/,
  );
});

test('the legs are ordered: the second is not reached before the first has run', () => {
  // A transfer that was submitted at all was submitted after the authorization
  // ran, so `failed` on the first leg and `failed` on the second cannot both be
  // observations of the same attempt.
  assert.throws(
    () => row({
      reason: 'nonce_already_used',
      legs: { authorization: 'failed', transfer: 'failed' },
      settlement: 'not_submitted',
    }),
    /leg_contradicts_reason/,
  );
  // the same reason with the authorization observed as running admits the
  // transfer observation, because that order can exist
  assert.equal(
    row({
      reason: 'nonce_already_used',
      legs: { authorization: 'executed', transfer: 'failed' },
      settlement: 'not_submitted',
    }).legs.transfer,
    'failed',
  );
  // and a leg the reason never reached is not an order violation
  assert.equal(
    row({
      reason: 'invalid_signature',
      legs: { authorization: 'failed', transfer: 'not_reached' },
      settlement: 'not_submitted',
    }).legs.transfer,
    'not_reached',
  );
});

test('every reason in the closed set has a leg row, required or bounded', () => {
  for (const reason of Object.keys(REFUSAL_REASONS)) {
    if (reason === 'accepted') continue;
    assert.ok(
      reason in REQUIRED_LEG_STATUS || reason in BOUNDED_LEG_STATUS,
      `${reason} is in the closed set but neither leg table names it`,
    );
  }
});

test('a valid signature cannot carry a leg cause — a signature proves who, not what was seen', () => {
  assert.throws(
    () => row({ reason: 'invalid_signature', legs: { authorization: 'executed' } }),
    /leg_contradicts_reason/,
  );
  // the same reason with the leg observed as failing is fine
  assert.equal(row({ reason: 'invalid_signature', legs: { authorization: 'failed' } }).reason, 'invalid_signature');
});

/* ---------------------------------------------------------------- *
 * the ceiling is about third parties, not about the scheme
 * ---------------------------------------------------------------- */

test('a spent nonce is checkable; an unattributed balance is not', () => {
  // nonce_already_used: the nonce is scoped to this attempt's own signature, so
  // reading it as spent refutes exactly this attempt. It stays chain_verifiable.
  const nonce = refusalRow({
    decision: 'refused',
    reason: 'nonce_already_used',
    attemptIdentity: ATTEMPT,
    signingPublicKey: KEYS.publicKey,
    settlement: 'settled',
    legs: { authorization: 'executed' },
  });
  assert.equal(nonce.evidence_class, 'chain_verifiable');

  // transfer_leg_failed: the causal claim is "the transfer of this attempt ran
  // and then failed", and the ledger has no per-attempt marker for that leg.
  const repro = reproducibleCeiling('transfer_leg_failed', 'chain_verifiable');
  assert.equal(repro.ok, false);
  assert.equal(repro.ceiling, 'issuer_asserted');
  assert.match(repro.reason, /not which attempt moved it/);
});

test('a reason whose contract needs no executed leg keeps its ceiling', () => {
  for (const reason of ['wrong_amount', 'authorization_expired', 'insufficient_funds', 'internal_error']) {
    const repro = reproducibleCeiling(reason, ceilingFor(reason));
    assert.equal(repro.ok, true, `${reason} should be able to claim its own ceiling`);
  }
});

/* ---------------------------------------------------------------- *
 * mutation tests: each rule has a mutant that must be caught
 * ---------------------------------------------------------------- */

test('mutant: dropping the leg check lets the canonical reject through', () => {
  const mutant = (input) => {
    // the original, with the leg contract deleted
    const required = { ...REQUIRED_LEG_STATUS };
    delete required.transfer_leg_failed;
    return required[input.reason] ? { ok: true } : { ok: true };
  };
  assert.equal(mutant({ reason: 'transfer_leg_failed' }).ok, true);
  // the real function disagrees with the mutant on the same input
  assert.equal(legSupport({ legs: { authorization: 'executed' }, reason: 'transfer_leg_failed' }).ok, false);
});

test('mutant: treating "unknown" as "failed" hides a thousand refunds', () => {
  const lenient = (legs) => legs.transfer !== 'executed';
  const observed = { authorization: 'executed', transfer: 'unknown' };
  assert.equal(lenient(observed), true, 'the mutant says this is fine');
  assert.equal(legSupport({ legs: observed, reason: 'transfer_leg_failed' }).ok, false, 'the rule does not');
});

test('mutant: trusting the caller-supplied evidence class', () => {
  const trusting = (cls, reason) => ({ ok: true, ceiling: cls, evidenceClass: cls, reason });
  const honest = reproducibleCeiling('transfer_leg_failed', 'chain_verifiable');
  assert.notEqual(honest.ceiling, trusting('chain_verifiable', 'transfer_leg_failed').ceiling);
});

test('mutant: letting an unknown leg pass instead of rejecting it', () => {
  const silent = (legs) => Object.values(legs).every((v) => typeof v === 'string');
  assert.equal(silent({ authorization: 'executed', settlement: 'failed' }), true);
  assert.equal(
    legSupport({ legs: { authorization: 'executed', settlement: 'failed' }, reason: 'transfer_leg_failed' }).ok,
    false,
  );
});

test('mutant: dropping the bracketed cells lets internal_error claim a failed transfer', () => {
  // The table as it stood before the brackets: the transfer cell was an em dash,
  // which the code read as "not checked". This mutant is that reading.
  const requiredOnly = (legs, reason) => {
    for (const [leg, allowed] of Object.entries(REQUIRED_LEG_STATUS[reason] ?? {})) {
      const observed = legs[leg];
      if (observed === undefined || !allowed.includes(observed)) return false;
    }
    return true;
  };
  const observed = { authorization: 'unknown', transfer: 'failed' };
  assert.equal(requiredOnly(observed, 'internal_error'), true, 'the old reading accepts it');
  assert.equal(
    legSupport({ legs: observed, reason: 'internal_error' }).ok,
    false,
    'the bracketed cell rejects it, whatever the authorization leg records',
  );
});

test('mutant: dropping the order rule accepts a second leg reached before the first', () => {
  const tablesOnly = (legs, reason) => {
    for (const [table, required] of [[REQUIRED_LEG_STATUS, true], [BOUNDED_LEG_STATUS, false]]) {
      for (const [leg, allowed] of Object.entries(table[reason] ?? {})) {
        const observed = legs[leg];
        if (required && observed === undefined) return false;
        if (observed !== undefined && !allowed.includes(observed)) return false;
      }
    }
    return true;
  };
  const observed = { authorization: 'failed', transfer: 'failed' };
  assert.equal(tablesOnly(observed, 'nonce_already_used'), true, 'the two tables alone accept it');
  assert.equal(legSupport({ legs: observed, reason: 'nonce_already_used' }).ok, false, 'L4 does not');
});

/* ---------------------------------------------------------------- *
 * L6: the transfer leg and the settlement describe one event
 * ---------------------------------------------------------------- */

test('a permit that landed with the transfer never sent is constructible', () => {
  // §15.4 L6 admits this combination on purpose. Permit2 is two calls, and a
  // process that dies between them leaves exactly this row. If the rule rejected
  // it, the format could not describe a state the rail produces.
  const r = row({
    reason: 'internal_error',
    settlement: 'not_submitted',
    legs: { authorization: 'executed', transfer: 'not_reached' },
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.settlement, 'not_submitted');
  assert.equal(r.legs.transfer, 'not_reached');
});

test('a settlement that landed cannot sit beside a transfer that never concluded', () => {
  // `failed` is excluded from this loop on purpose: `internal_error` does not
  // admit it at all, so that row is refused one check earlier as a leg that
  // contradicts its reason.
  for (const transfer of ['not_reached', 'unknown']) {
    assert.throws(
      () => row({ reason: 'internal_error', settlement: 'settled', legs: { authorization: 'executed', transfer } }),
      /settlement_contradicts_leg/,
      `settled + transfer: ${transfer} must be refused`,
    );
  }
});

test('a transfer that never ran cannot sit beside a settlement in flight', () => {
  assert.throws(
    () => row({ reason: 'internal_error', settlement: 'pending', legs: { authorization: 'executed', transfer: 'not_reached' } }),
    /settlement_contradicts_leg/,
  );
});

test('an authorization that was stopped cannot sit beside a settlement that landed', () => {
  // The state this closes: a risk refusal, a commercial refusal, a malformed
  // payload or an expired authorization, each free to record `settled` beside an
  // authorization the row says never ran. The allowance that can predate an
  // attempt belongs to an accepted row, and an accepted row records no legs.
  for (const [reason, authorization] of [
    ['risk_policy_rejected', 'not_reached'],
    ['commercial_refusal', 'not_reached'],
    ['malformed_payload', 'not_reached'],
    ['authorization_expired', 'unknown'],
  ]) {
    assert.throws(
      () => row({ reason, settlement: 'settled', legs: { authorization } }),
      /settlement_contradicts_leg/,
      `${reason} with authorization: ${authorization} must not record settled`,
    );
  }
});

test('mutant: checking the reason tables but not the settlement accepts a row about two different attempts', () => {
  const tablesOnly = (legs, reason) => {
    for (const [table, required] of [[REQUIRED_LEG_STATUS, true], [BOUNDED_LEG_STATUS, false]]) {
      for (const [leg, allowed] of Object.entries(table[reason] ?? {})) {
        const observed = legs[leg];
        if (required && observed === undefined) return false;
        if (observed !== undefined && !allowed.includes(observed)) return false;
      }
    }
    return true;
  };
  const observed = { authorization: 'executed', transfer: 'not_reached' };
  assert.equal(tablesOnly(observed, 'internal_error'), true, 'the reason tables alone accept it');
  assert.equal(
    legSettlementCheck({ legs: observed, settlement: 'settled' }).ok,
    false,
    'L6 does not',
  );
  assert.deepEqual(
    [...LEG_SETTLEMENT.transfer.executed],
    ['settled', 'pending'],
    'and `executed` is the only transfer state `settled` pairs with',
  );
});
