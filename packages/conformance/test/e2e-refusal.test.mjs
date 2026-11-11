/**
 * End-to-end: one payable server, one buyer, three attempts on the same proof.
 *
 * This is the scenario the project exists for — the third attempt is a replay,
 * and both sides have to be able to tell afterwards that it happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair } from '@sycee/core';
import { createGates, memoryStore } from '@sycee/middleware';
import { createSpend, linkReceipts } from '@sycee/agent-sdk';

const MERCHANT = generateKeyPair();
const AGENT = generateKeyPair();
const PROOF = 'e2e-proof-1';

async function withServer(fn) {
  const gates = createGates({
    resourceId: 'paid.echo.v1',
    protocol: 'x402',
    price: { value: '0.001000', currency: 'USDC' },
    publicKey: MERCHANT.publicKey,
    privateKey: MERCHANT.privateKey,
    agentId: 'e2e:merchant',
    keyId: 'e2e-01',
    store: memoryStore(),
    attachReceipt: true,
  });

  const server = http.createServer(async (req, res) => {
    if (req.url === '/paid') return gates.guard(async () => ({ status: 200, body: { ok: true } }))(req, res);
    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function makeSpend(base) {
  return createSpend({
    agentId: 'e2e:agent',
    publicKey: AGENT.publicKey,
    privateKey: AGENT.privateKey,
    pay: async () => PROOF,
  });
}

test('three calls with one proof: 402, then 200, then a counted replay', async () => {
  await withServer(async (base) => {
    // 1. no proof at all -> challenge
    const bare = await fetch(`${base}/paid`);
    assert.equal(bare.status, 402);

    // 2 + 3. the buyer pays twice with the same proof
    const spend = makeSpend(base);
    const first = await spend.fetch(`${base}/paid`);
    const second = await spend.fetch(`${base}/paid`);

    assert.equal(first.headers.get('x-gates-redeem-count'), '1');
    assert.equal(
      second.headers.get('x-gates-redeem-count'),
      '2',
      'the replay is counted on the server side, not silently allowed',
    );
    assert.equal(
      first.headers.get('x-gates-proof-hash'),
      second.headers.get('x-gates-proof-hash'),
      'both attempts point at the same proof, which is what makes them reconcilable',
    );
  });
});

test('buyer and seller receipts link to the same proof', async () => {
  await withServer(async (base) => {
    const spend = makeSpend(base);
    const res = await spend.fetch(`${base}/paid`);
    const merchantEnvelope = JSON.parse(
      Buffer.from(res.headers.get('x-gates-receipt'), 'base64url').toString('utf8'),
    );
    res.gates.consumedBy('task-e2e');
    const agentEnvelope = spend.receipts().at(-1);

    const link = linkReceipts(merchantEnvelope, agentEnvelope);
    assert.equal(link.complete, true, link.problems.join('; '));
    assert.equal(link.completeness, 'bilateral');
    assert.equal(
      merchantEnvelope.vsr.payment.proof_hash,
      agentEnvelope.vsr.payment.proof_hash,
    );
  });
});

test('the seller side cannot claim consumption; only the buyer can', async () => {
  await withServer(async (base) => {
    const spend = makeSpend(base);
    const res = await spend.fetch(`${base}/paid`);
    const merchantEnvelope = JSON.parse(
      Buffer.from(res.headers.get('x-gates-receipt'), 'base64url').toString('utf8'),
    );
    assert.equal(merchantEnvelope.vsr.result.consumed, 'unknown');
    assert.equal(merchantEnvelope.vsr.signer.role, 'merchant');

    res.gates.consumedBy('task-e2e');
    const agentEnvelope = spend.receipts().at(-1);
    assert.equal(agentEnvelope.vsr.result.consumed, 'yes');
    assert.equal(agentEnvelope.vsr.signer.role, 'agent');
  });
});
