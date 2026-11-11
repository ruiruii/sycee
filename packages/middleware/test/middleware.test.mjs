import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGates,
  memoryStore,
  settlementFromHeaders,
} from '../src/index.mjs';
import { generateKeyPair } from '@sycee/core';

const KEYS = generateKeyPair();

function makeGates(overrides = {}) {
  return createGates({
    resourceId: 'test.resource.v1',
    protocol: 'x402',
    price: { value: '0.001000', currency: 'USDC' },
    publicKey: KEYS.publicKey,
    privateKey: KEYS.privateKey,
    agentId: 'test:merchant',
    keyId: 'test-key',
    store: memoryStore(),
    ...overrides,
  });
}

/** Minimal req/res pair just enough for `guard`. */
function fakeRequest({ proof } = {}) {
  const headers = {};
  if (proof) headers['payment-signature'] = proof;
  return { method: 'GET', url: '/paid', headers };
}

function fakeResponse() {
  const state = { headers: {}, body: null, writableEnded: false };
  return {
    state,
    // Mirrors Node's ServerResponse: statusCode is read at end() time, so a plain
    // object property set by the middleware is reflected here too.
    get statusCode() {
      return this._status ?? 200;
    },
    set statusCode(v) {
      this._status = v;
      state.statusCode = v;
    },
    setHeader(k, v) {
      state.headers[k.toLowerCase()] = String(v);
    },
    getHeader(k) {
      return state.headers[k.toLowerCase()];
    },
    end(payload) {
      state.statusCode = this._status ?? 200;
      state.body = payload;
      state.writableEnded = true;
    },
  };
}

const handler = async () => ({ status: 200, body: { ok: true } });

test('a request with no payment proof gets a 402 challenge and no receipt', async () => {
  const res = fakeResponse();
  await makeGates({ attachReceipt: true }).guard(handler)(fakeRequest(), res);
  assert.equal(res.state.statusCode, 402);
  assert.equal(res.state.headers['x-gates-receipt'], undefined);
  const body = JSON.parse(res.state.body);
  assert.equal(body.error, 'payment_required');
});

test('the same proof presented twice increments redeem_count', async () => {
  const gates = makeGates();
  const r1 = fakeResponse();
  await gates.guard(handler)(fakeRequest({ proof: 'proof-abc' }), r1);
  assert.equal(r1.state.statusCode, 200);
  assert.equal(r1.state.headers['x-gates-redeem-count'], '1');

  const r2 = fakeResponse();
  await gates.guard(handler)(fakeRequest({ proof: 'proof-abc' }), r2);
  assert.equal(r2.state.headers['x-gates-redeem-count'], '2', 'a replay must be counted, not hidden');
  assert.equal(
    r2.state.headers['x-gates-proof-hash'],
    r1.state.headers['x-gates-proof-hash'],
    'both redemptions refer to the same proof',
  );
});

test('a different proof starts its own count', async () => {
  const gates = makeGates();
  const r1 = fakeResponse();
  await gates.guard(handler)(fakeRequest({ proof: 'proof-1' }), r1);
  const r2 = fakeResponse();
  await gates.guard(handler)(fakeRequest({ proof: 'proof-2' }), r2);
  assert.equal(r1.state.headers['x-gates-redeem-count'], '1');
  assert.equal(r2.state.headers['x-gates-redeem-count'], '1');
  assert.notEqual(
    r1.state.headers['x-gates-proof-hash'],
    r2.state.headers['x-gates-proof-hash'],
  );
});

test('a merchant receipt never claims the buyer consumed the result', async () => {
  const res = fakeResponse();
  const envelope = await makeGates().guard(handler)(fakeRequest({ proof: 'proof-x' }), res);
  assert.equal(envelope.vsr.result.consumed, 'unknown', 'only the buyer can attest consumption');
  assert.equal(envelope.vsr.signer.role, 'merchant');
  assert.equal(envelope.vsr.completeness, 'unilateral_merchant');
});

test('a rejected payment writes no receipt but still leaves the proof hash', async () => {
  const gates = makeGates({
    verifyPayment: async () => ({ ok: false, reason: 'insufficient_funds' }),
  });
  const res = fakeResponse();
  await gates.guard(handler)(fakeRequest({ proof: 'proof-bad' }), res);
  assert.equal(res.state.statusCode, 402);
  assert.equal(res.state.headers['x-gates-receipt'], undefined);
  assert.ok(
    res.state.headers['x-gates-proof-hash'],
    'the refusal still has to identify which attempt was refused',
  );
});

test('the receipt header decodes to a JSON envelope', async () => {
  const res = fakeResponse();
  await makeGates().guard(handler)(fakeRequest({ proof: 'proof-y' }), res);
  const decoded = JSON.parse(Buffer.from(res.state.headers['x-gates-receipt'], 'base64url').toString('utf8'));
  assert.equal(decoded.vsr.resource_id, 'test.resource.v1');
  assert.equal(typeof decoded.signature, 'string');
});

test('settlement headers map onto the predicate, unknown stays unset', () => {
  assert.equal(settlementFromHeaders({}), undefined, 'no signal is not the same as "absent"');
  assert.equal(settlementFromHeaders({ 'x-payment-settled': 'true' }), 'settled');
  assert.equal(settlementFromHeaders({ 'x-settlement-status': 'queued' }), 'in_flight');
  assert.equal(settlementFromHeaders({ 'x-settlement-status': 'absent' }), 'absent');
});
