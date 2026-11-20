#!/usr/bin/env node
/**
 * Two paid calls, one used and one thrown away.
 *
 *   node examples/bilateral-consumption.mjs
 *
 * Both calls return HTTP 200. Both are charged. From the seller's side the two
 * are identical: a delivered response and a counted redemption. The difference
 * only exists downstream, where the agent either references the result or does
 * not.
 *
 * That difference is what the agent runtime signs, and it is the one thing a
 * delivery receipt cannot contain. This file is the smallest end-to-end
 * demonstration of it: no network, no wallet, no accounts.
 */

import http from 'node:http';
import { generateKeyPair, verifyVSR } from '@sycee/core';
import { createGates, memoryStore } from '@sycee/middleware';
import { createSpend, linkReceipts } from '@sycee/agent-sdk';

const RULE = '─'.repeat(72);

const merchantKeys = generateKeyPair();
const agentKeys = generateKeyPair();

const say = (s = '') => process.stdout.write(`${s}\n`);
const head = (s) => say(`\n${s}\n${RULE}`);

// ---------------------------------------------------------------- seller side
const gates = createGates({
  resourceId: 'search.v1',
  protocol: 'x402',
  price: { value: '0.010000', currency: 'USDC' },
  publicKey: merchantKeys.publicKey,
  privateKey: merchantKeys.privateKey,
  agentId: 'demo:merchant',
  keyId: 'demo-01',
  store: memoryStore(),
  attachReceipt: true,
});

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/search')) {
    // A search endpoint that always answers. Nothing here knows or can know
    // whether the answer will be used.
    return gates.guard(async () => ({
      status: 200,
      body: { results: ['result-A', 'result-B'] },
    }))(req, res);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** The agent runtime: a task, a downstream use, and a decision to sign. */
function makeAgent(proof) {
  return createSpend({
    agentId: 'demo:agent',
    publicKey: agentKeys.publicKey,
    privateKey: agentKeys.privateKey,
    pay: async () => proof,
  });
}

const receiptFrom = (res) =>
  JSON.parse(Buffer.from(res.headers.get('x-gates-receipt'), 'base64url').toString('utf8'));

try {
  head('CALL 1 — the result is used');
  const agentA = makeAgent('demo-proof-A');
  const resA = await agentA.fetch(`${base}/search?q=agent-payments`);
  const bodyA = await resA.json();
  say(`  HTTP ${resA.status}  ${JSON.stringify(bodyA.results)}`);

  // This is the only line in the whole file the seller cannot produce:
  // the runtime states that this result entered a downstream context.
  const agentReceiptA = resA.gates.consumedBy('msg_4829');
  const merchantReceiptA = receiptFrom(resA);
  say(`  the runtime passes result-A into msg_4829 and signs consumed=yes`);

  head('CALL 2 — the result is thrown away');
  const agentB = makeAgent('demo-proof-B');
  const resB = await agentB.fetch(`${base}/search?q=agent-payments`);
  const bodyB = await resB.json();
  say(`  HTTP ${resB.status}  ${JSON.stringify(bodyB.results)}`);

  // The filter rejected both results, so nothing was referenced. The money was
  // spent and the bytes were delivered; the value was not consumed.
  const agentReceiptB = resB.gates.notConsumed();
  const merchantReceiptB = receiptFrom(resB);
  say(`  the runtime drops both results and signs consumed=no`);

  head('WHAT THE SELLER RECORDED');
  for (const [label, m] of [['call 1', merchantReceiptA], ['call 2', merchantReceiptB]]) {
    say(
      `  ${label}  status=${m.vsr.delivery.status}  ` +
        `consumed=${m.vsr.result.consumed}  redeem_count=${m.vsr.payment.redeem_count}`,
    );
  }
  say('  Two delivered responses. Two counted payments. The seller cannot tell them apart.');

  head('WHAT THE BUYER RECORDED');
  for (const [label, a] of [['call 1', agentReceiptA], ['call 2', agentReceiptB]]) {
    say(
      `  ${label}  consumed=${a.vsr.result.consumed}  ` +
        `consumed_by=${JSON.stringify(a.vsr.result.consumed_by ?? [])}`,
    );
  }

  head('DO THE TWO SIDES LINE UP?');
  for (const [label, m, a] of [
    ['call 1', merchantReceiptA, agentReceiptA],
    ['call 2', merchantReceiptB, agentReceiptB],
  ]) {
    const link = linkReceipts(m, a);
    const v = verifyVSR(a);
    say(
      `  ${label}  completeness=${link.completeness}  pair level=${link.level}  ` +
        `agent receipt alone=${v.level} valid=${v.valid}  ` +
        `problems=${link.problems.length}`,
    );
  }

  head('THE POINT');
  say('  Both calls: HTTP 200, charged, delivered, receipted.');
  say('  One was used. One was idle spend. Only the buyer could say which.');
  say('');
  say('  A delivery receipt can prove the bytes arrived.');
  say('  It cannot prove the bytes were worth paying for.');
} finally {
  await new Promise((r) => server.close(r));
}
