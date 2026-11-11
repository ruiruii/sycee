#!/usr/bin/env node
/**
 * A single file you can run without reading anything else.
 *
 *   node examples/walkthrough.mjs
 *
 * Starts a payable server on a random local port, lets a buyer call it three
 * times with the same payment proof, and prints what each side recorded.
 *
 * No network, no wallet, no accounts. The "payment proof" is a string; SYCEE
 * only ever handles its hash.
 */

import http from 'node:http';
import { generateKeyPair, verifyVSR } from '@sycee/core';
import { createGates, memoryStore } from '@sycee/middleware';
import { createSpend, linkReceipts } from '@sycee/agent-sdk';

const PROOF = 'demo-proof-1234';
const merchantKeys = generateKeyPair();
const agentKeys = generateKeyPair();

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = (s) => line(`\n${'─'.repeat(4)} ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);

// ---------------------------------------------------------------- server side
const gates = createGates({
  resourceId: 'paid.echo.v1',
  protocol: 'x402',
  price: { value: '0.001000', currency: 'USDC' },
  publicKey: merchantKeys.publicKey,
  privateKey: merchantKeys.privateKey,
  agentId: 'demo:merchant',
  keyId: 'demo-01',
  store: memoryStore(),
  attachReceipt: true,
});

const server = http.createServer(async (req, res) => {
  if (req.url === '/paid') {
    return gates.guard(async () => ({ status: 200, body: { ok: true } }))(req, res);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  rule('1. a request with no payment proof');
  const bare = await fetch(`${base}/paid`);
  line(`   status ${bare.status} — ${(await bare.clone().json()).error}`);
  line(`   no receipt issued: ${bare.headers.get('x-gates-receipt') === null}`);

  rule('2. the buyer pays');
  const spend = createSpend({
    agentId: 'demo:agent',
    publicKey: agentKeys.publicKey,
    privateKey: agentKeys.privateKey,
    pay: async () => PROOF,
  });

  const first = await spend.fetch(`${base}/paid`);
  line(`   status ${first.status}`);
  line(`   proof hash        ${first.headers.get('x-gates-proof-hash')}`);
  line(`   redeem_count      ${first.headers.get('x-gates-redeem-count')}`);

  rule('3. the same proof is presented again');
  const second = await spend.fetch(`${base}/paid`);
  line(`   status ${second.status}`);
  line(`   redeem_count      ${second.headers.get('x-gates-redeem-count')}  <- counted, not hidden`);
  line(`   same proof hash   ${
    first.headers.get('x-gates-proof-hash') === second.headers.get('x-gates-proof-hash')
  }`);

  rule('4. what each side has on record');
  const merchantEnvelope = JSON.parse(
    Buffer.from(second.headers.get('x-gates-receipt'), 'base64url').toString('utf8'),
  );
  second.gates.consumedBy('task-demo');
  const agentEnvelope = spend.receipts().at(-1);

  line(`   seller  actor=merchant  consumed=${merchantEnvelope.vsr.result.consumed}  ` +
       `redeem_count=${merchantEnvelope.vsr.payment.redeem_count}`);
  line(`   buyer   actor=agent     consumed=${agentEnvelope.vsr.result.consumed}  ` +
       `redeem_count=${agentEnvelope.vsr.payment.redeem_count}`);

  rule('5. do the two sides line up?');
  const link = linkReceipts(merchantEnvelope, agentEnvelope);
  line(`   complete=${link.complete}  completeness=${link.completeness}`);
  for (const p of link.problems) line(`   problem: ${p}`);

  rule('6. both receipts verify offline');
  for (const [who, envelope] of [['seller', merchantEnvelope], ['buyer', agentEnvelope]]) {
    const v = verifyVSR(envelope);
    line(`   ${who.padEnd(7)} valid=${v.valid}  level=${v.level}  ` +
         `settlement=${v.settlement.status} (final=${v.settlement.finalized})`);
  }

  line('');
  line('The seller was charged nothing and holds no payment proof — only its hash.');
  line('The replay is visible on both sides, which is the whole point.');
} finally {
  await new Promise((r) => server.close(r));
}
