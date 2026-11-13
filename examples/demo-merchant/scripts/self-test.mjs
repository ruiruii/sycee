#!/usr/bin/env node
/**
 * Pay the demo merchant on a real x402 testnet, replay the same authorization,
 * and submit agent-signed consumed=yes and consumed=no receipts.
 *
 * Required environment:
 *   MERCHANT_URL              base URL of a running demo merchant
 *   BUYER_EVM_PRIVATE_KEY     testnet buyer key (0x + 32 bytes). Also accepts EVM_PRIVATE_KEY.
 *
 * The buyer key pays. A separate ephemeral Ed25519 key signs the consumption
 * receipts. Both flows are labeled self-test (header x-sycee-traffic and
 * agent_id sycee:self-test). This script does not deploy, and it does not
 * print the buyer key or the raw payment header.
 *
 * Install the client once, from the repo root or from this directory:
 *   npm install --no-save --prefix examples/demo-merchant @x402/fetch@2.31.0 @x402/evm@2.31.0 viem@2.57.19
 */

import { generateKeyPair } from '@sycee/core';
import { createSpend, linkReceipts } from '@sycee/agent-sdk';
import { truncateProofHash } from '../src/evidence.mjs';

const origin = (process.env.MERCHANT_URL || '').replace(/\/+$/, '');
const buyerKey = process.env.BUYER_EVM_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY || '';

if (!origin || !buyerKey) {
  console.error('Set MERCHANT_URL and BUYER_EVM_PRIVATE_KEY (a Base Sepolia buyer key).');
  process.exit(1);
}

let x402Client;
let x402HTTPClient;
let ExactEvmScheme;
let privateKeyToAccount;
try {
  ({ x402Client, x402HTTPClient } = await import('@x402/fetch'));
  ({ ExactEvmScheme } = await import('@x402/evm'));
  ({ privateKeyToAccount } = await import('viem/accounts'));
} catch {
  console.error('The x402 client is not installed. From the repo root, run:');
  console.error('  npm install --no-save --prefix examples/demo-merchant @x402/fetch@2.31.0 @x402/evm@2.31.0 viem@2.57.19');
  process.exit(1);
}

const account = privateKeyToAccount(buyerKey.startsWith('0x') ? buyerKey : `0x${buyerKey}`);
const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(account));
const httpClient = new x402HTTPClient(client);
const agentKeys = generateKeyPair();

const selfHeaders = {
  'x-sycee-traffic': 'self-test',
  'x-sycee-agent-id': 'sycee:self-test',
};

let lastHeader = null;
const spend = createSpend({
  agentId: 'sycee:self-test',
  publicKey: agentKeys.publicKey,
  privateKey: agentKeys.privateKey,
  pay: async (_challenge, init, url) => {
    const probeHeaders = new Headers(init?.headers ?? {});
    probeHeaders.delete('payment-signature');
    probeHeaders.delete('PAYMENT-SIGNATURE');
    const probe = await fetch(url, { method: init?.method ?? 'GET', headers: probeHeaders });
    if (probe.status !== 402) {
      throw new Error(`expected a 402 challenge, got ${probe.status}`);
    }
    const required = httpClient.getPaymentRequiredResponse((name) => probe.headers.get(name));
    if (!required?.accepts?.length) {
      throw new Error('402 did not carry a decodable PAYMENT-REQUIRED header');
    }
    await probe.arrayBuffer().catch(() => {});
    const payload = await client.createPaymentPayload(required);
    const encoded = httpClient.encodePaymentSignatureHeader(payload);
    const header = encoded['PAYMENT-SIGNATURE'] ?? encoded['payment-signature'];
    if (!header) throw new Error('x402 client did not return a PAYMENT-SIGNATURE header');
    lastHeader = header;
    return header;
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

const before = await fetch(`${origin}/evidence.json`).then((res) => res.json());
const tip = `${origin}/v1/base/tip`;

console.log(`merchant ${origin}`);
console.log(`buyer ${account.address}`);
console.log('label self-test');

const yesRes = await spend.fetch(tip, { headers: selfHeaders });
const yesBody = await yesRes.json().catch(() => null);
console.log(`pay status=${yesRes.status} redeem_count=${yesRes.headers.get('x-gates-redeem-count')} block=${yesBody?.block_number ?? '?'}`);
if (yesRes.status !== 200) fail('first payment was not accepted');

const paidHeader = lastHeader;
const proofHash = yesRes.headers.get('x-gates-proof-hash');
const replay = await fetch(tip, { headers: { ...selfHeaders, 'payment-signature': paidHeader } });
const replayBody = await replay.json().catch(() => ({}));
console.log(`replay status=${replay.status} reason=${replayBody.reason ?? replayBody.error ?? '?'}`);
if (replay.status !== 402) fail('replay was not refused');

const yesReceipt = yesRes.gates.consumedBy('task_self_test_yes');
const merchantYes = JSON.parse(Buffer.from(yesRes.headers.get('x-gates-receipt'), 'base64url').toString('utf8'));
const yesLink = linkReceipts(merchantYes, yesReceipt);
if (!yesLink.complete) fail(`consumed=yes did not link: ${yesLink.problems.join('; ')}`);
const postYes = await postReceipt(yesReceipt);
console.log(`consumed=yes posted status=${postYes.status}`);
if (postYes.status !== 200) fail('consumed=yes was not accepted');

const noRes = await spend.fetch(tip, { headers: selfHeaders });
console.log(`second pay status=${noRes.status} redeem_count=${noRes.headers.get('x-gates-redeem-count')}`);
if (noRes.status !== 200) fail('second payment was not accepted');
const noReceipt = noRes.gates.notConsumed();
const merchantNo = JSON.parse(Buffer.from(noRes.headers.get('x-gates-receipt'), 'base64url').toString('utf8'));
const noLink = linkReceipts(merchantNo, noReceipt);
if (!noLink.complete) fail(`consumed=no did not link: ${noLink.problems.join('; ')}`);
const postNo = await postReceipt(noReceipt);
console.log(`consumed=no posted status=${postNo.status}`);
if (postNo.status !== 200) fail('consumed=no was not accepted');

const after = await fetch(`${origin}/evidence.json`).then((res) => res.json());
const truncated = truncateProofHash(proofHash);
const replayRow = after.recent.find((row) => row.proof_hash === truncated && row.redeem_count >= 2);
console.log(`evidence self_test ${before.traffic.self_test} -> ${after.traffic.self_test}`);
console.log(`evidence redeem max ${before.redeem_count.max} -> ${after.redeem_count.max}`);
console.log(`consumed ${after.consumed.label ?? `published k=${after.consumed.k}`}`);
if (!replayRow) fail(`no recent self-test row with truncated ${truncated} and redeem_count>=2`);
if (after.traffic.self_test < before.traffic.self_test + 3) {
  fail('self-test traffic did not increase by the pay, the replay, and the second pay');
}
if (after.consumed.published === false && after.consumed.label !== 'not published (k<10)') {
  fail('consumed aggregate was neither published nor labeled not published (k<10)');
}

const evidenceText = JSON.stringify(after);
if (paidHeader && evidenceText.includes(paidHeader)) fail('evidence.json contains the raw payment header');

console.log('self-test ok');

async function postReceipt(receipt) {
  const res = await fetch(`${origin}/v1/agent-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...selfHeaders },
    body: JSON.stringify({ receipt }),
  });
  return res;
}
