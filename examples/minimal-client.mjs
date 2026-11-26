#!/usr/bin/env node
/**
 * Minimal client using @sycee/agent-sdk.
 *
 * Run after minimal-server.mjs is up:
 *   node examples/minimal-client.mjs
 *
 * This demo shows:
 *   1. 402 challenge
 *   2. paying with a fixed proof
 *   3. the same proof being used twice => redeem_count = 2
 *   4. the agent runtime attesting consumption
 */

import { generateKeyPair } from '@sycee/core';
import { createSpend, linkReceipts } from '@sycee/agent-sdk';

const BASE = process.env.SERVER || 'http://localhost:4000';

const merchantPublicKey = await fetch(`${BASE}/paid`)
  .then(() => null)
  .catch(() => {
    process.stderr.write('server not running? start: node examples/minimal-server.mjs\n');
    process.exit(1);
  });

// Merchant public key is not exposed by this toy server; in production the agent
// obtains it via well-known endpoint or registry.

const agentKeys = generateKeyPair();
const spend = createSpend({
  agentId: 'erc8004:8453:0xDEMO_AGENT',
  publicKey: agentKeys.publicKey,
  privateKey: agentKeys.privateKey,
  pay: async (challenge) => {
    process.stdout.write(`[agent] got 402 challenge: ${challenge.accepts?.[0]?.protocol}\n`);
    return 'demo-proof-1234';
  },
});

// --- First call: challenge, pay, consume ---
const r1 = await spend.fetch(`${BASE}/paid`);
process.stdout.write(`[call 1] status=${r1.status} redeem_count=${r1.headers.get('x-sycee-redeem-count')}\n`);

r1.gates.consumedBy('task_demo_1'); // agent attests consumption

// --- Second call with same proof: should show redeem_count = 2 ---
const r2 = await spend.fetch(`${BASE}/paid`);
process.stdout.write(`[call 2] status=${r2.status} redeem_count=${r2.headers.get('x-sycee-redeem-count')}\n`);
r2.gates.consumedBy('task_demo_2');

// --- Final receipts ---
const receipts = spend.receipts();
process.stdout.write(`\nTotal agent-side receipts: ${receipts.length}\n`);
for (const env of receipts) {
  process.stdout.write(
    `  resource=${env.vsr.resource_id} ` +
      `consumed=${env.vsr.result.consumed} ` +
      `redeem_count=${env.vsr.payment.redeem_count} ` +
      `completeness=${env.vsr.completeness}\n`,
  );
}

// --- Cross-check the two signed perspectives ---
const merchantEnv = Buffer.from(r2.headers.get('x-sycee-receipt'), 'base64url').toString('utf8');
const agentEnv = receipts[receipts.length - 1];
const link = linkReceipts(JSON.parse(merchantEnv), agentEnv);
process.stdout.write(`\nBilateral check: ${link.complete ? 'OK' : 'FAILED'} (${link.completeness})\n`);
if (!link.complete) link.problems.forEach((p) => process.stdout.write(`  ${p}\n`));
