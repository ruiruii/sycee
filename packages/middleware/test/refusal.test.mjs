import test from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair, verifyClaim, attemptIdentity, canonicalJSON, refusalLedger } from '@sycee/core';
import { createGates, memoryStore } from '../src/index.mjs';

const KEYS = generateKeyPair();
const PAY_TO = '0x9999999999999999999999999999999999999999';

function fakeResponse() {
  const state = { statusCode: undefined, headers: {}, body: null, writableEnded: false };
  return {
    state,
    set statusCode(v) {
      state.statusCode = v;
    },
    get statusCode() {
      return state.statusCode;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    setHeader(k, v) {
      state.headers[k.toLowerCase()] = String(v);
    },
    getHeader(k) {
      return state.headers[k.toLowerCase()];
    },
    end(payload) {
      state.body = payload;
      state.writableEnded = true;
    },
  };
}

function makeGates(over = {}) {
  return createGates({
    resourceId: 'search.v1',
    protocol: 'x402',
    price: { value: '0.01', currency: 'USDC' },
    publicKey: KEYS.publicKey,
    privateKey: KEYS.privateKey,
    payTo: PAY_TO,
    store: memoryStore(),
    ...over,
  });
}

function req(headers = {}, url = '/search') {
  return { method: 'POST', url, headers };
}

function decode(header) {
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
}

/* ---------------------------------------------------------------- *
 * the gap this closes: a refusal leaves a row
 * ---------------------------------------------------------------- */

test('a refused payment records a row, and the row names a reason with a bounded class', async () => {
  const gates = makeGates({
    verifyPayment: async () => ({ ok: false, reason: 'insufficient_funds' }),
  });
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: { ok: true } }))(req({ 'payment-signature': 'proof-1' }), res);

  assert.equal(res.state.statusCode, 402);
  const rows = gates.refusals();
  assert.equal(rows.length, 1, 'a refused attempt must leave something behind');
  assert.equal(rows[0].decision, 'refused');
  assert.equal(rows[0].reason, 'insufficient_funds');
  assert.equal(rows[0].evidence_class, 'chain_verifiable');
  assert.equal(rows[0].proof_hash, rows[0].proof_hash.match(/^sha256:[0-9a-f]{64}$/)[0]);
  assert.equal(rows[0].signer.role, 'merchant');
});

test('the 402 body carries a claim the buyer can hold and verify offline', async () => {
  const gates = makeGates({ verifyPayment: async () => ({ ok: false, reason: 'wrong_amount' }) });
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'proof-2' }), res);

  const body = JSON.parse(res.state.body);
  assert.equal(body.error, 'payment_rejected');
  assert.ok(body.refusal_receipt, 'the buyer must not be left with only its own word');
  const v = verifyClaim(body.refusal_receipt, { payTo: PAY_TO });
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.equal(v.checks.signingKeyDistinct, true, 'the signing key is not the payee address');
  assert.equal(body.refusal_receipt.refusal.reason, 'wrong_amount');
});

test('a verifier that throws is recorded as a refusal instead of escaping as a 500', async () => {
  const gates = makeGates({
    verifyPayment: async () => {
      throw new Error('facilitator unreachable');
    },
  });
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'proof-3' }), res);

  assert.equal(res.state.statusCode, 402);
  const [row] = gates.refusals();
  assert.equal(row.reason, 'internal_error');
  assert.equal(row.evidence_class, 'issuer_asserted', 'a server failure proves nothing to the buyer');
});

test('an unrecognised verifier reason is recorded at the weakest class, not dropped', async () => {
  const gates = makeGates({ verifyPayment: async () => ({ ok: false, reason: 'some_vendor_code' }) });
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'proof-4' }), res);

  const [row] = gates.refusals();
  assert.equal(row.reason, 'internal_error');
  assert.equal(row.evidence_class, 'issuer_asserted');
});

test('a known vendor string maps onto the closed reason set', async () => {
  const gates = makeGates({ verifyPayment: async () => ({ ok: false, reason: 'invalid_proof' }) });
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'proof-5' }), res);
  assert.equal(gates.refusals()[0].reason, 'invalid_signature');
});

/* ---------------------------------------------------------------- *
 * accepted and refused rows live on one ledger
 * ---------------------------------------------------------------- */

test('accepted and refused decisions share one ledger and the tally adds up', async () => {
  const gates = makeGates();
  await gates.guard(async () => ({ status: 200, body: { hit: 1 } }))(req({ 'payment-signature': 'proof-ok' }), fakeResponse());
  await gates.guard(async () => ({ status: 200, body: {} }))(req({}), fakeResponse());

  const tally = gates.tally();
  assert.equal(tally.total, 1, 'the call with no proof is a challenge, not a decision');
  assert.equal(tally.accepted, 1);
  assert.equal(tally.refused, 0);
  assert.equal(gates.ledger().length, 1);
});

test('a challenge with no proof is not recorded as a refusal', async () => {
  const gates = makeGates();
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: {} }))(req({}), res);
  assert.equal(res.state.statusCode, 402);
  assert.equal(gates.ledger().length, 0, 'nothing was refused; the buyer simply had not paid yet');
});

test('every refusal in the ledger exports as a verified claim', async () => {
  const gates = makeGates({
    verifyPayment: async (proof) => (proof === 'good' ? { ok: true, settlement: 'settled' } : { ok: false, reason: 'commercial_refusal' }),
  });
  await gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'bad-1' }), fakeResponse());
  await gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'bad-2' }), fakeResponse());

  const claims = gates.claims();
  assert.equal(claims.length, 2);
  for (const c of claims) {
    const v = verifyClaim(c, { payTo: PAY_TO });
    assert.equal(v.valid, true, v.errors.join('; '));
    assert.equal(c.refusal.evidence_class, 'issuer_asserted');
  }
});

/* ---------------------------------------------------------------- *
 * the payload-is-not-attempt case, end to end
 * ---------------------------------------------------------------- */

test('a replay is a second attempt, not the same attempt twice', async () => {
  const gates = makeGates();
  const handler = gates.guard(async () => ({ status: 200, body: { hit: 1 } }));
  const first = fakeResponse();
  const second = fakeResponse();
  await handler(req({ 'payment-signature': 'same-proof' }), first);
  await handler(req({ 'payment-signature': 'same-proof' }), second);

  const rows = gates.ledger();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].attempt_identity, rows[1].attempt_identity, 'two presentations, two attempts');
  assert.equal(rows[0].decision, 'accepted');
  assert.equal(rows[1].decision, 'accepted', 'count mode records the reuse without refusing it');
  assert.equal(second.state.headers['x-gates-redeem-count'], '2');
});

test('under replayPolicy refuse, a repeat is declined with a claim instead of billed twice', async () => {
  const gates = makeGates({ replayPolicy: 'refuse' });
  const handler = gates.guard(async () => ({ status: 200, body: { hit: 1 } }));

  let delivered = 0;
  const counted = gates.guard(async () => {
    delivered += 1;
    return { status: 200, body: { hit: delivered } };
  });

  const first = fakeResponse();
  await counted(req({ 'payment-signature': 'twice' }), first);
  assert.equal(delivered, 1, 'the first call is served');

  const second = fakeResponse();
  await counted(req({ 'payment-signature': 'twice' }), second);
  assert.equal(second.state.statusCode, 402);
  assert.equal(delivered, 1, 'the handler did not run a second time');

  const body = JSON.parse(second.state.body);
  assert.ok(body.refusal_receipt);
  const [row] = gates.refusals();
  assert.equal(row.decision, 'refused');
  assert.equal(row.reason, 'replay_in_flight');
  assert.equal(row.final, false, 'the first attempt is not yet final, so neither is the refusal');

  const v = verifyClaim(body.refusal_receipt, { payTo: PAY_TO });
  assert.equal(v.valid, true, v.errors.join('; '));
});

/* ---------------------------------------------------------------- *
 * key hygiene
 * ---------------------------------------------------------------- */

test('a middleware configured with the payee address as its signing key refuses to record', async () => {
  const gates = createGates({
    resourceId: 'search.v1',
    publicKey: PAY_TO,
    privateKey: KEYS.privateKey,
    payTo: PAY_TO,
    store: memoryStore(),
  });
  await assert.rejects(
    () => gates.guard(async () => ({ status: 200, body: {} }))(req({ 'payment-signature': 'p' }), fakeResponse()),
    /signing_key_is_payee/,
  );
});

test('with keepRefusals off the older behaviour is unchanged and nothing is stored', async () => {
  const gates = makeGates({ keepRefusals: false });
  const res = fakeResponse();
  await gates.guard(async () => ({ status: 200, body: { ok: true } }))(req({ 'payment-signature': 'p' }), res);
  assert.equal(gates.ledger().length, 0);
  assert.equal(gates.refusals().length, 0);
  assert.ok(res.state.headers['x-gates-receipt'], 'the accepted receipt is still issued');
});

test('two servers record one attempt under their own key, so neither can speak for the other', async () => {
  const a = makeGates();
  const otherKeys = generateKeyPair();
  const b = makeGates({ publicKey: otherKeys.publicKey, privateKey: otherKeys.privateKey });
  const env = { 'payment-signature': 'shared' };
  await a.guard(async () => ({ status: 200, body: {} }))(req(env), fakeResponse());
  await b.guard(async () => ({ status: 200, body: {} }))(req(env), fakeResponse());

  const [rowA] = a.ledger();
  const [rowB] = b.ledger();
  assert.equal(rowA.attempt_identity, rowB.attempt_identity, 'the attempt is the attempt, whoever recorded it');
  assert.notEqual(rowA.signer.public_key, rowB.signer.public_key, 'but the claim about it is each server\'s own');
});

test('the ledger refuses to record a second, contradictory verdict on one attempt', () => {
  const led = refusalLedger({ signingPublicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
  const id = attemptIdentity({ payload: 'x', requirements: 'y', presentation: 1 });
  assert.equal(led.record({ decision: 'accepted', attemptIdentity: id, settlement: 'settled' }).recorded, true);
  const second = led.record({
    decision: 'refused',
    reason: 'insufficient_funds',
    attemptIdentity: id,
    settlement: 'not_submitted',
  });
  assert.equal(second.recorded, false, 'a contradiction is reported, not written over the first row');
  assert.equal(second.conflict.path, 'decision');
  assert.equal(led.rows().length, 1);
  assert.equal(led.conflicts().length, 1);
  void canonicalJSON;
});
