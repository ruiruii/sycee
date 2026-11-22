#!/usr/bin/env node
/**
 * `sycee doctor` — which member do the two sides disagree on?
 *
 * The question a buyer asks when reconciliation reports `only_buyer` and
 * `only_seller` for the same call is "why". The two keys differ, and until the
 * seller publishes the members it hashed, there is nothing to say beyond that.
 *
 * The seller now publishes them. So this runs a request through a simulated
 * proxy that rewrites what the app sees, the way a misconfigured one does, and
 * prints what the buyer can conclude from the response alone — no seller logs,
 * no access to the seller's host.
 *
 *   node bin/sycee-doctor.mjs
 *   node bin/sycee-doctor.mjs --rewrite proto   # only the scheme
 *   node bin/sycee-doctor.mjs --rewrite path    # strip a prefix
 *   node bin/sycee-doctor.mjs --rewrite none    # the healthy case
 */

import { createGates } from '../packages/middleware/src/index.mjs';
import { createSpend, reconcile } from '../packages/agent-sdk/src/index.mjs';
import { generateKeyPair } from '@sycee/core';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const rewrite = argOf('rewrite', 'proto');

const MERCHANT = generateKeyPair();
const AGENT = generateKeyPair();

const REWRITES = {
  none: (seen) => seen,
  proto: (seen) => ({ ...seen, proto: seen.proto === 'http' ? 'https' : 'http' }),
  path: (seen) => ({ ...seen, path: seen.path.replace(/^\/api/, '') }),
  host: (seen) => ({ ...seen, host: seen.host.replace(/^localhost:\d+$/, 'api.example.com') }),
};

const mangle = REWRITES[rewrite];
if (!mangle) {
  console.error(`unknown --rewrite ${JSON.stringify(rewrite)}; one of ${Object.keys(REWRITES).join(', ')}`);
  process.exit(2);
}

const gates = createGates({
  resourceId: 'doctor.resource.v1',
  protocol: 'x402',
  price: { value: '0.005000', currency: 'USDC' },
  payTo: '0x00000000000000000000000000000000000000bb',
  network: 'eip155:8453',
  scheme: 'exact',
  publicKey: MERCHANT.publicKey,
  privateKey: MERCHANT.privateKey,
  agentId: 'doctor:merchant',
  keyId: 'doctor-key',
  replayPolicy: 'refuse',
  verifyPayment: async () => ({ ok: true, settlement: 'settled' }),
});

function fakeResponse() {
  const state = { headers: {}, body: null, statusCode: 200 };
  return {
    state,
    get statusCode() {
      return this._s ?? 200;
    },
    set statusCode(v) {
      this._s = v;
      state.statusCode = v;
    },
    setHeader(k, v) {
      state.headers[k.toLowerCase()] = String(v);
    },
    end(p) {
      state.body = p;
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

const handler = async () => ({ status: 200, body: { ok: true } });

const spend = createSpend({
  agentId: 'doctor:agent',
  publicKey: AGENT.publicKey,
  privateKey: AGENT.privateKey,
  pay: async () => 'doctor-proof',
  fetchImpl: async (url, init = {}) => {
    const parsed = new URL(url);
    const headers = {};
    for (const [k, v] of new Headers(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const seen = mangle({
      host: parsed.host,
      proto: parsed.protocol.replace(':', ''),
      path: parsed.pathname,
    });
    headers.host = seen.host;
    headers['x-forwarded-proto'] = seen.proto;
    const req = {
      method: init.method ?? 'GET',
      url: `${seen.path}${parsed.search}`,
      headers,
      socket: {},
    };
    const res = fakeResponse();
    await gates.guard(handler)(req, res);
    return asFetchResponse(res.state);
  },
});

const BUYER_URL = 'http://localhost:3000/api/paid';

console.log(`\n  buyer sends   ${BUYER_URL}`);
console.log(`  app sees      ${rewrite === 'none' ? '(the same request)' : `--rewrite ${rewrite}`}\n`);

await spend.fetch(BUYER_URL);

const [row] = gates.ledger();
const [entry] = spend.ledger;
const result = reconcile({ agentEntries: spend.ledger, merchantRows: gates.ledger() });

console.log(`  buyer key     ${entry.attemptIdentity ?? '(none)'}`);
console.log(`  seller key    ${row?.attempt_identity ?? '(no row)'}`);
console.log(`  same           ${entry.attemptIdentity === row?.attempt_identity ? 'yes' : 'no'}\n`);

if (!entry.divergedAt?.length) {
  console.log(
    entry.attemptIdentity === row?.attempt_identity
      ? '  conclusion    the two sides agree; nothing to diagnose\n'
      : '  conclusion    the keys differ and the seller published no member digests\n' +
          '                (a seller older than the header cannot be diagnosed remotely)\n',
  );
} else {
  console.log('  conclusion    the keys differ on:');
  for (const d of entry.divergedAt) {
    console.log(`                  ${d.member}`);
  }
  console.log('');
  console.log(`  what to change on the seller's side:`);
  const hint = {
    origin: "    a proxy is not forwarding the buyer's scheme/authority.\n" +
            '    forward X-Forwarded-Proto and X-Forwarded-Host, do not rewrite Host.',
    path: "    a proxy rewrites the path before the app sees it.\n" +
          '    keep the public prefix, or mount the app under the prefix it serves.',
    host: "    a proxy replaces Host with an internal name.\n" +
          '    forward X-Forwarded-Host with the host the buyer addressed.',
    amount: '    the price shown to the buyer is not the price the row was keyed over.',
    payTo: '    the published payTo is not the one the identity uses.',
    network: '    the published network is not the one the identity uses.',
    asset: '    the published asset is not the one the identity uses.',
    scheme: '    the published scheme is not the one the identity uses.',
    method: '    the buyer and the seller disagree on the method; check for a redirect.',
  }[entry.divergedAt[0].member];
  if (hint) console.log(hint);
  console.log('');
}

console.log(
  `  summary       pairs ${result.summary.pairs} | match ${result.summary.match} | ` +
    `only buyer ${result.summary.only_buyer} | only seller ${result.summary.only_seller}`,
);
if (result.summary.divergences_by_member) {
  console.log(`  by member     ${JSON.stringify(result.summary.divergences_by_member)}`);
}
console.log('\n  This names the member and stops. It does not say who should change.\n');
