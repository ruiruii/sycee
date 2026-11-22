/**
 * The buyer's half, against the seller's half, on one real pair of
 * implementations.
 *
 * The claim being tested is not "the rows look similar". It is that two
 * processes which never talk to each other, given only the request and the 402
 * challenge, arrive at the same attempt identity — and that when they do not,
 * the result says so instead of passing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpend, reconcile } from '../src/index.mjs';
import { createGates } from '../../middleware/src/index.mjs';
import { generateKeyPair } from '@sycee/core';

const KEYS = generateKeyPair();
const AGENT_KEYS = generateKeyPair();

function fakeResponse() {
  const state = { headers: {}, body: null, statusCode: 200 };
  return {
    state,
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
      state.body = payload;
      state.writableEnded = true;
    },
  };
}

/** Turn the middleware's Node-shaped response into what `fetch` returns. */
function asFetchResponse(state) {
  const status = state.statusCode ?? 200;
  const headers = new Map(Object.entries(state.headers));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    clone() {
      return { json: async () => (state.body ? JSON.parse(state.body) : {}) };
    },
  };
}

/** A `fetch` that delivers the request straight to a middleware instance. */
function wireTo(gates, handler) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const headers = {};
    for (const [k, v] of new Headers(init.headers ?? {})) headers[k.toLowerCase()] = v;
    // What a buyer behind nothing would send; the middleware has to reconstruct
    // the same origin from these.
    headers.host = parsed.host;
    headers['x-forwarded-proto'] = parsed.protocol.replace(':', '');

    const req = {
      method: init.method ?? 'GET',
      url: `${parsed.pathname}${parsed.search}`,
      headers,
      socket: {},
    };
    const res = fakeResponse();
    await gates.guard(handler)(req, res);
    return asFetchResponse(res.state);
  };
}

function makeGates(overrides = {}) {
  return createGates({
    resourceId: 'test.resource.v1',
    protocol: 'x402',
    price: { value: '0.005000', currency: 'USDC' },
    payTo: '0x00000000000000000000000000000000000000bb',
    network: 'eip155:8453',
    scheme: 'exact',
    publicKey: KEYS.publicKey,
    privateKey: KEYS.privateKey,
    agentId: 'test:merchant',
    keyId: 'test-key',
    replayPolicy: 'refuse',
    verifyPayment: async () => ({ ok: true, settlement: 'settled' }),
    ...overrides,
  });
}

function makeSpend(fetchImpl) {
  return createSpend({
    agentId: 'test:agent',
    publicKey: AGENT_KEYS.publicKey,
    privateKey: AGENT_KEYS.privateKey,
    fetchImpl,
    pay: async () => 'proof-buyer-side',
  });
}

const handler = async () => ({ status: 200, body: { ok: true } });

test('two processes that never met compute the same attempt identity', async () => {
  const gates = makeGates();
  const spend = makeSpend(wireTo(gates, handler));

  const res = await spend.fetch('https://api.example.test/paid?x=1');
  assert.equal(res.status, 200);

  const [entry] = spend.ledger;
  const [row] = gates.ledger();

  assert.ok(entry.attemptIdentity, 'the buyer composed an identity from the challenge');
  assert.equal(
    entry.attemptIdentity,
    row.attempt_identity,
    'the buyer and the seller describe the same attempt with the same key',
  );
});

test('a settled call and its refused replay reconcile to 2/2, not 1/1', async () => {
  const gates = makeGates();
  const spend = makeSpend(wireTo(gates, handler));

  await spend.fetch('https://api.example.test/paid');
  await spend.fetch('https://api.example.test/paid');

  const result = reconcile({ agentEntries: spend.ledger, merchantRows: gates.ledger() });

  assert.equal(result.summary.pairs, 2);
  assert.equal(result.summary.match, 2);
  assert.equal(result.summary.only_buyer, 0, 'the refusal did not vanish from either side');
  assert.equal(result.summary.only_seller, 0);

  const refused = result.pairs.find((p) => p.buyer.observedHttp === 402);
  assert.ok(refused, 'the second presentation is in the comparison');
  assert.equal(refused.seller.decision, 'refused');
  assert.equal(refused.seller.reason, 'replay_already_settled');
});

test('the buyer keeps the seller-signed refusal instead of dropping it', async () => {
  const gates = makeGates();
  const spend = makeSpend(wireTo(gates, handler));

  await spend.fetch('https://api.example.test/paid');
  await spend.fetch('https://api.example.test/paid');

  const refusal = spend.ledger[1].refusal;
  assert.ok(refusal, 'a 402 that follows payment is recorded');
  assert.equal(refusal.reason, 'replay_already_settled');
  assert.ok(refusal.receipt, "the seller's signature travels with the refusal");
  assert.equal(refusal.receipt.refusal.reason, 'replay_already_settled');
  assert.equal(refusal.receipt.type, 'x402-refusal-claim');
});

test('a challenge that omits the payment members yields no identity, and says why', async () => {
  const spend = createSpend({
    agentId: 'test:agent',
    publicKey: AGENT_KEYS.publicKey,
    privateKey: AGENT_KEYS.privateKey,
    fetchImpl: async (url, init) =>
      init?.headers
        ? { status: 200, ok: true, headers: { get: () => null }, clone: () => ({ json: async () => ({}) }) }
        : {
            status: 402,
            ok: false,
            headers: { get: () => null },
            clone: () => ({ json: async () => ({ accepts: [{ protocol: 'x402' }] }) }),
          },
    pay: async () => 'proof-buyer-side',
  });

  const res = await spend.fetch('https://api.example.test/paid');
  assert.equal(res.status, 200);
  assert.equal(spend.ledger[0].attemptIdentity, null);
  assert.match(spend.ledger[0].identityUnavailable, /challenge_missing_/);

  const result = reconcile({ agentEntries: spend.ledger, merchantRows: [] });
  assert.equal(result.summary.pairs, 0, 'an attempt without a key is not silently paired');
  assert.equal(result.summary.unidentified, 1);
  assert.equal(result.unidentified[0].side, 'buyer');
});

test('a buyer who sees 402 where the seller recorded accepted is a disagreement, not a match', async () => {
  const result = reconcile({
    agentEntries: [
      {
        attemptIdentity: 'sha256:aa',
        observedHttp: 402,
        decision: 'refused',
        deliveredAt: '2026-01-01T00:00:00.000Z',
        proofHash: 'sha256:pp',
      },
    ],
    merchantRows: [
      { attempt_identity: 'sha256:aa', decision: 'accepted', presentation: 1, proof_hash: 'sha256:pp' },
    ],
  });

  assert.equal(result.summary.match, 0);
  assert.equal(result.summary.status_disagrees, 1);
  assert.equal(result.pairs[0].verdict, 'status_disagrees');
});

test('a row the buyer never saw is reported as one side only, without a verdict', async () => {
  const result = reconcile({
    agentEntries: [],
    merchantRows: [
      { attempt_identity: 'sha256:bb', decision: 'refused', reason: 'wrong_amount', presentation: 1 },
    ],
  });

  assert.equal(result.summary.only_seller, 1);
  assert.equal(result.pairs[0].buyer, null);
  assert.equal(result.pairs[0].verdict, 'only_seller');
});

test('two proofs against one URL are two presentations of one attempt', async () => {
  const gates = makeGates();
  let proof = 'proof-first';
  const spend = createSpend({
    agentId: 'test:agent',
    publicKey: AGENT_KEYS.publicKey,
    privateKey: AGENT_KEYS.privateKey,
    fetchImpl: wireTo(gates, handler),
    pay: async () => proof,
  });

  await spend.fetch('https://api.example.test/paid');
  proof = 'proof-second';
  await spend.fetch('https://api.example.test/paid');

  const rows = gates.ledger();
  assert.equal(rows.length, 2, 'both purchases are on the ledger');
  assert.equal(rows[0].attempt_identity, rows[1].attempt_identity, 'one URL, one attempt');
  assert.equal(rows[0].presentation, 1);
  assert.equal(rows[1].presentation, 2, 'counted per identity, not per proof');

  const result = reconcile({ agentEntries: spend.ledger, merchantRows: rows });
  assert.equal(result.summary.match, 2);
});

test('a first refusal under a new proof is kept, not dropped as a duplicate of the earlier acceptance', async () => {
  const gates = makeGates({
    verifyPayment: async (proof) =>
      proof === 'proof-good' ? { ok: true, settlement: 'settled' } : { ok: false, reason: 'wrong_amount' },
  });
  let proof = 'proof-good';
  const spend = createSpend({
    agentId: 'test:agent',
    publicKey: AGENT_KEYS.publicKey,
    privateKey: AGENT_KEYS.privateKey,
    fetchImpl: wireTo(gates, handler),
    pay: async () => proof,
  });

  await spend.fetch('https://api.example.test/paid');
  proof = 'proof-bad';
  const res = await spend.fetch('https://api.example.test/paid');
  assert.equal(res.status, 402);

  const rows = gates.ledger();
  assert.equal(rows.length, 2, 'the refusal was not read as a contradiction of the acceptance');
  assert.equal(rows[1].decision, 'refused');
  assert.equal(rows[1].presentation, 2);

  const result = reconcile({ agentEntries: spend.ledger, merchantRows: rows });
  assert.equal(result.summary.match, 2);
  assert.equal(result.pairs[1].seller.reason, 'wrong_amount');
});
