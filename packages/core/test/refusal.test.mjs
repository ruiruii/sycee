import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptIdentity,
  ceilingFor,
  classifyRepeat,
  exportClaim,
  finalityCheck,
  mergeRow,
  refusalLedger,
  refusalRow,
  signRefusal,
  signingKeyCheck,
  verifyClaim,
  withinCeiling,
  generateKeyPair,
  canonicalJSON,
  EVIDENCE_ORDER,
} from '../src/index.mjs';

const KEYS = generateKeyPair();
const OTHER = generateKeyPair();
const ATTEMPT = attemptIdentity({ payload: 'payload-a', requirements: 'req-a', presentation: 1 });

function row(over = {}) {
  return refusalRow({
    decision: 'refused',
    reason: 'insufficient_funds',
    attemptIdentity: ATTEMPT,
    signingPublicKey: KEYS.publicKey,
    settlement: 'not_submitted',
    ...over,
  });
}

/* ---------------------------------------------------------------- *
 * evidence class is a ceiling, not a field the issuer picks
 * ---------------------------------------------------------------- */

test('each reason maps to a ceiling, and an unknown reason falls to the weakest one', () => {
  assert.equal(ceilingFor('invalid_signature'), 'client_verifiable');
  assert.equal(ceilingFor('duplicate_payment'), 'chain_verifiable');
  assert.equal(ceilingFor('commercial_refusal'), 'issuer_asserted');
  // a reason nobody reviewed must not sound more rigorous than it is
  assert.equal(ceilingFor('some_new_reason_added_later'), 'issuer_asserted');
});

test('a claim may sit at or below its ceiling, never above it', () => {
  assert.equal(withinCeiling('client_verifiable', 'invalid_signature'), true);
  assert.equal(withinCeiling('issuer_asserted', 'invalid_signature'), true, 'downgrading is honest');
  assert.equal(withinCeiling('chain_verifiable', 'invalid_signature'), false, 'buyer-checkable is not ledger-checkable');
  assert.equal(withinCeiling('chain_verifiable', 'commercial_refusal'), false, 'a policy refusal cannot claim ledger proof');
  assert.equal(withinCeiling('independently_witnessed', 'insufficient_funds'), false, 'nothing here witnesses');
  assert.equal(withinCeiling('nonsense', 'insufficient_funds'), false);
});

test('refusalRow refuses to build a row that overclaims', () => {
  assert.throws(
    () => row({ reason: 'commercial_refusal', evidenceClass: 'chain_verifiable' }),
    /exceeds the ceiling for commercial_refusal/,
  );
  // the default is the ceiling itself
  assert.equal(row({ reason: 'commercial_refusal' }).evidence_class, 'issuer_asserted');
  // a caller may lower it
  assert.equal(row({ reason: 'invalid_signature', evidenceClass: 'issuer_asserted' }).evidence_class, 'issuer_asserted');
});

test('an unrecognised reason cannot be built at all — a refusal needs a name', () => {
  assert.throws(() => row({ reason: 'because_i_said_so' }), /unknown reason/);
});

test('an accepted row carries no reason and no class', () => {
  const r = refusalRow({
    decision: 'accepted',
    attemptIdentity: ATTEMPT,
    signingPublicKey: KEYS.publicKey,
    settlement: 'pending',
  });
  assert.equal(r.reason, undefined);
  assert.equal(r.evidence_class, undefined);
  assert.equal(r.final, false, 'a pending settlement is never presented as final');
});

/* ---------------------------------------------------------------- *
 * finality: an uncertain settlement is not a final refusal
 * ---------------------------------------------------------------- */

test('a pending settlement can never be marked final', () => {
  const f = finalityCheck({ settlement: 'pending', final: true, decision: 'refused' });
  assert.equal(f.ok, false);
  assert.match(f.error, /cannot be final/);
  assert.equal(finalityCheck({ settlement: 'pending', final: false, decision: 'refused' }).ok, true);
});

test('an accepted attempt cannot claim nothing was submitted', () => {
  assert.equal(finalityCheck({ settlement: 'not_submitted', final: true, decision: 'accepted' }).ok, false);
});

test('a settlement state outside the closed set is rejected', () => {
  assert.equal(finalityCheck({ settlement: 'maybe', final: true, decision: 'refused' }).ok, false);
});

/* ---------------------------------------------------------------- *
 * signing key is never the payee address
 * ---------------------------------------------------------------- */

test('a signing key that is the payee address is refused at build time', () => {
  const addr = '0x1111111111111111111111111111111111111111';
  const k = signingKeyCheck({ signingPublicKey: addr, payTo: addr });
  assert.equal(k.ok, false);
  assert.equal(k.code, 'signing_key_is_payee');
});

test('a distinct key passes, and a missing payee is reported as not measured', () => {
  const k = signingKeyCheck({
    signingPublicKey: KEYS.publicKey,
    payTo: '0x2222222222222222222222222222222222222222',
  });
  assert.equal(k.ok, true);
  assert.equal(k.code, 'distinct');

  const unknown = signingKeyCheck({ signingPublicKey: KEYS.publicKey });
  assert.equal(unknown.ok, true, 'no comparison available is not a failure');
  assert.equal(unknown.code, 'not_measured', 'but it must not be reported as a pass either');
});

test('the not-measured verdict survives into the claim, as notMeasured', () => {
  const claim = exportClaim(signRefusal(row(), KEYS.privateKey));
  const v = verifyClaim(claim);
  assert.equal(v.valid, true);
  assert.deepEqual(v.notMeasured, ['signing_key_vs_payee']);
  assert.equal(v.checks.signingKeyDistinct, false, 'not measured is not verified');
});

test('a verifier that knows the payee can catch a key/payee collision', () => {
  const addr = '0x3333333333333333333333333333333333333333';
  const claim = exportClaim(signRefusal(row(), KEYS.privateKey));
  const v = verifyClaim(claim, { payTo: addr });
  assert.equal(v.valid, true);
  assert.deepEqual(v.notMeasured, []);
});

/* ---------------------------------------------------------------- *
 * attempt identity: payload is not attempt
 * ---------------------------------------------------------------- */

test('one payload presented twice is one payload and two attempts', () => {
  const first = attemptIdentity({ payload: 'same', requirements: 'r', presentation: 1 });
  const second = attemptIdentity({ payload: 'same', requirements: 'r', presentation: 2 });
  assert.notEqual(first, second, 'the replay must not collapse into the settled attempt');
  const again = attemptIdentity({ payload: 'same', requirements: 'r', presentation: 1 });
  assert.equal(first, again, 'and the same presentation must derive the same value');
});

test('different requirements are a different attempt', () => {
  const a = attemptIdentity({ payload: 'p', requirements: 'r1', presentation: 1 });
  const b = attemptIdentity({ payload: 'p', requirements: 'r2', presentation: 1 });
  assert.notEqual(a, b);
});

test('attemptIdentity is sha256:<64 hex> and refuses empty input', () => {
  assert.match(ATTEMPT, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => attemptIdentity({ payload: '', requirements: 'r' }), /payload required/);
  assert.throws(() => attemptIdentity({ payload: 'p' }), /requirements required/);
});

/* ---------------------------------------------------------------- *
 * repeat classification: the two refusals are different facts
 * ---------------------------------------------------------------- */

test('a first presentation is accepted, a repeat of a settled one is a replay', () => {
  assert.deepEqual(classifyRepeat({ priorCount: 0 }), {
    decision: 'accepted',
    reason: null,
    settlement: 'not_submitted',
  });
  assert.deepEqual(classifyRepeat({ priorCount: 1, priorSettlement: 'settled' }), {
    decision: 'refused',
    reason: 'replay_already_settled',
    settlement: 'settled',
  });
});

test('an unreadable earlier attempt is not the same as a repeat', () => {
  const r = classifyRepeat({ priorCount: 1, priorStatusKnown: false });
  assert.equal(r.reason, 'could_not_compare');
  assert.equal(r.settlement, 'unknown', 'and the settlement claim stays unknown, not settled');
});

test('an earlier attempt that never reached the rail does not block this one', () => {
  assert.equal(classifyRepeat({ priorCount: 1, priorSettlement: 'not_submitted' }).decision, 'accepted');
});

test('a concurrent presentation is refused without claiming the money moved', () => {
  const r = classifyRepeat({ priorCount: 1, priorSettlement: 'pending' });
  assert.equal(r.reason, 'replay_in_flight');
  assert.equal(r.settlement, 'pending');
});

/* ---------------------------------------------------------------- *
 * ledger: every decision, and contradictions surface instead of overwriting
 * ---------------------------------------------------------------- */

test('the ledger records accepted and refused rows together and the tally adds up', () => {
  const led = refusalLedger({ signingPublicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
  const a1 = attemptIdentity({ payload: 'p1', requirements: 'r', presentation: 1 });
  const a2 = attemptIdentity({ payload: 'p1', requirements: 'r', presentation: 2 });

  led.record({ decision: 'accepted', attemptIdentity: a1, settlement: 'settled' });
  led.record({ decision: 'refused', reason: 'replay_already_settled', attemptIdentity: a2, settlement: 'settled' });

  assert.equal(led.rows().length, 2);
  assert.equal(led.refusals().length, 1);
  assert.deepEqual(led.tally(), { total: 2, accepted: 1, refused: 1 });
  assert.equal(led.tally().accepted + led.tally().refused, led.tally().total);
});

test('a refusal that contradicts an earlier acceptance of the same attempt is reported, not overwritten', () => {
  const led = refusalLedger({ signingPublicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
  const a = attemptIdentity({ payload: 'p', requirements: 'r', presentation: 1 });
  led.record({ decision: 'accepted', attemptIdentity: a, settlement: 'settled' });
  const out = led.record({ decision: 'refused', reason: 'insufficient_funds', attemptIdentity: a, settlement: 'not_submitted' });

  assert.equal(out.recorded, false);
  assert.equal(out.conflict.path, 'decision');
  assert.equal(led.rows().length, 1, 'the earlier row is still there');
  assert.equal(led.conflicts().length, 1, 'and the contradiction is visible');
});

test('a replay refusal legitimately follows an acceptance of the same payload', () => {
  const led = refusalLedger({ signingPublicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
  const a1 = attemptIdentity({ payload: 'p', requirements: 'r', presentation: 1 });
  const a2 = attemptIdentity({ payload: 'p', requirements: 'r', presentation: 2 });
  assert.equal(led.record({ decision: 'accepted', attemptIdentity: a1, settlement: 'settled' }).recorded, true);
  assert.equal(led.record({ decision: 'refused', reason: 'replay_already_settled', attemptIdentity: a2, settlement: 'settled' }).recorded, true);
  assert.equal(led.rows().length, 2);
});

test('the same row recorded twice is stored once', () => {
  const led = refusalLedger({ signingPublicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
  const input = { decision: 'refused', reason: 'commercial_refusal', attemptIdentity: ATTEMPT, settlement: 'not_submitted', observedAt: '2026-01-01T00:00:00.000Z' };
  led.record(input);
  const second = led.record(input);
  assert.equal(second.duplicate, true);
  assert.equal(led.rows().length, 1);
});

test('the ledger separates refusals a buyer cannot check from the rest', () => {
  const led = refusalLedger({ signingPublicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
  led.record({ decision: 'refused', reason: 'invalid_signature', attemptIdentity: attemptIdentity({ payload: 'a', requirements: 'r' }), settlement: 'not_submitted' });
  led.record({ decision: 'refused', reason: 'commercial_refusal', attemptIdentity: attemptIdentity({ payload: 'b', requirements: 'r' }), settlement: 'not_submitted' });
  const weak = led.unverifiable();
  assert.equal(weak.length, 1);
  assert.equal(weak[0].reason, 'commercial_refusal');
});

test('mergeRow keeps identifiers stable across rows about one attempt', () => {
  const a = refusalRow({ decision: 'refused', reason: 'facilitator_timeout', attemptIdentity: ATTEMPT, signingPublicKey: KEYS.publicKey, settlement: 'unknown' });
  const b = { ...a, resource_id: 'a-different-resource' };
  const out = mergeRow([a], b);
  assert.equal(out.added, false);
  assert.equal(out.conflict.path, 'resource_id');
});

/* ---------------------------------------------------------------- *
 * claim: what the buyer actually holds
 * ---------------------------------------------------------------- */

test('a claim verifies offline and pins the claim id to its own content', () => {
  const claim = exportClaim(signRefusal(row(), KEYS.privateKey));
  const v = verifyClaim(claim);
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.equal(v.checks.signature, true);
  assert.equal(v.checks.evidenceWithinCeiling, true);

  const tampered = { ...claim, refusal: { ...claim.refusal, reason: 'commercial_refusal' } };
  assert.equal(verifyClaim(tampered).valid, false, 'editing the reason breaks the signature');
});

test('a claim signed by a different key than it names is rejected', () => {
  const env = signRefusal(row(), KEYS.privateKey);
  const forged = { ...env, refusal: { ...env.refusal, signer: { ...env.refusal.signer, public_key: OTHER.publicKey } } };
  assert.equal(verifyClaim(exportClaim(forged)).valid, false);
});

test('a claim that overclaims an evidence class fails verification', () => {
  const env = signRefusal(row({ reason: 'commercial_refusal' }), KEYS.privateKey);
  const upgraded = { ...env, refusal: { ...env.refusal, evidence_class: 'chain_verifiable' } };
  const v = verifyClaim(exportClaim(upgraded));
  assert.equal(v.valid, false);
  assert.match(v.errors.join('; '), /exceeds the ceiling/);
});

test('a pending refusal presented as final fails verification', () => {
  const env = signRefusal(row({ reason: 'replay_in_flight', settlement: 'pending' }), KEYS.privateKey);
  const upgraded = { ...env, refusal: { ...env.refusal, final: true } };
  assert.equal(verifyClaim(exportClaim(upgraded)).valid, false);
});

test('a verifier that pins the signing key catches a swapped signer', () => {
  const claim = exportClaim(signRefusal(row(), KEYS.privateKey));
  assert.equal(verifyClaim(claim, { signingPublicKey: KEYS.publicKey }).valid, true);
  assert.equal(verifyClaim(claim, { signingPublicKey: OTHER.publicKey }).valid, false);
});

test('every evidence class in the order is a value the format actually uses', () => {
  assert.equal(EVIDENCE_ORDER[0], 'issuer_asserted', 'weakest first, so the comparison is a ceiling');
  assert.equal(EVIDENCE_ORDER.at(-1), 'independently_witnessed');
});

test('canonical serialization of a row is stable', () => {
  const a = row();
  const b = row({ observedAt: a.observed_at });
  assert.equal(canonicalJSON(a), canonicalJSON(b));
});
