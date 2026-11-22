/**
 * Two ledgers, one attempt at a time.
 *
 * A buyer and a seller that never share state each record what they saw. The
 * comparison is the product: not that either ledger is complete, but that the
 * four attempts appear on both sides under the same keys, and the two refusals
 * did not vanish from the seller's half.
 *
 * Run: node examples/buyer-reconcile.mjs
 */

import { createSpend, reconcile } from '@sycee/agent-sdk';
import { createGates } from '@sycee/middleware';
import { generateKeyPair } from '@sycee/core';

const MERCHANT = generateKeyPair();
const AGENT = generateKeyPair();

/* ------------------------------------------------------------------ *
 * A buyer behind nothing, a seller with no HTTP in between
 * ------------------------------------------------------------------ */

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

function wireTo(gates) {
  const handler = async () => ({ status: 200, body: { ok: true } });
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const headers = {};
    for (const [k, v] of new Headers(init.headers ?? {})) headers[k.toLowerCase()] = v;
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

/* ------------------------------------------------------------------ *
 * The run: two proofs, each presented once, then once again
 * ------------------------------------------------------------------ */

const gates = createGates({
  resourceId: 'demo.resource.v1',
  protocol: 'x402',
  price: { value: '0.005000', currency: 'USDC' },
  payTo: '0x00000000000000000000000000000000000000bb',
  network: 'eip155:8453',
  scheme: 'exact',
  publicKey: MERCHANT.publicKey,
  privateKey: MERCHANT.privateKey,
  agentId: 'demo:merchant',
  keyId: 'demo-key',
  replayPolicy: 'refuse',
  // The first proof settles; the second is still in flight when it is presented
  // again. Two different repeat reasons, two different rows.
  verifyPayment: async (proof) =>
    proof === 'proof-settled' ? { ok: true, settlement: 'settled' } : { ok: true },
});

let nextProof = 'proof-settled';
const spend = createSpend({
  agentId: 'demo:agent',
  publicKey: AGENT.publicKey,
  privateKey: AGENT.privateKey,
  fetchImpl: wireTo(gates),
  pay: async () => nextProof,
});

const URL_PAID = 'https://api.example.test/paid';

await spend.fetch(URL_PAID); // first presentation, settles
await spend.fetch(URL_PAID); // same proof again -> replay_already_settled
nextProof = 'proof-in-flight';
await spend.fetch(URL_PAID); // new proof, settlement not yet observable
await spend.fetch(URL_PAID); // same proof again -> replay_in_flight

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const result = reconcile({ agentEntries: spend.ledger, merchantRows: gates.ledger() });

const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, n);
const short = (id) => (id ? `${id.slice(0, 14)}…${id.slice(-6)}` : '-');

console.log('\nbuyer                          seller                     verdict');
console.log('-'.repeat(78));
for (const pair of result.pairs) {
  const buyer = pair.buyer
    ? `${pad(pair.buyer.observedHttp, 4)} ${pad(short(pair.buyer.proofHash), 22)}`
    : pad('-', 27);
  const seller = pair.seller
    ? `${pad(pair.seller.decision, 9)} ${pad(pair.seller.reason ?? '-', 16)}`
    : pad('-', 26);
  console.log(`${buyer} ${seller} ${pair.verdict}`);
}

console.log('-'.repeat(78));
console.log(
  `${result.summary.match}/${result.summary.pairs} match`,
  `| disagreements ${result.summary.status_disagrees}`,
  `| only buyer ${result.summary.only_buyer}`,
  `| only seller ${result.summary.only_seller}`,
  `| unidentified ${result.summary.unidentified}`,
);
console.log(
  '\nSame key on both sides:',
  result.pairs.every((p) => p.seller) ? 'yes, computed independently' : 'not for every attempt',
);
console.log('Who is right: not decided here. The buyer cannot see settlement;');
console.log('the seller cannot see what arrived. Both gaps are named, not filled.\n');
