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
    /not reproducible/,
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
    /refusalRow: evidence chain_verifiable is not reproducible/,
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
  // and the same reason with the authorization leg merely unread is allowed —
  // that is what an unattributable positive observation looks like from outside
  assert.equal(
    row({ legs: { authorization: 'unknown', transfer: 'failed' } }).legs.authorization,
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
