import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpend } from '../src/index.mjs';
import { generateKeyPair } from '@sycee/core';

const AGENT_KEYS = generateKeyPair();

function response({ status = 200, headers = {}, body = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    clone() {
      return { json: async () => body };
    },
  };
}

function makeSpend(script, proof = 'proof-abc') {
  const calls = [];
  let i = 0;
  const spend = createSpend({
    agentId: 'test:agent',
    publicKey: AGENT_KEYS.publicKey,
    privateKey: AGENT_KEYS.privateKey,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof next === 'function' ? next() : next;
    },
    pay: async (challenge) => {
      assert.ok(challenge, 'the 402 body is handed to the payer');
      return proof;
    },
  });
  return { spend, calls };
}

test('a non-402 response passes straight through without paying', async () => {
  const { spend, calls } = makeSpend([response({ status: 200 })]);
  const res = await spend.fetch('https://example.test/free');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'no second request when nothing is being charged');
  assert.equal(spend.receipts().length, 0, 'a free call leaves no spend entry');
});

test('a 402 is paid once and retried with the proof header', async () => {
  const { spend, calls } = makeSpend([
    response({ status: 402, body: { accepts: [{ protocol: 'x402' }] } }),
    response({ status: 200 }),
  ]);
  const res = await spend.fetch('https://example.test/paid');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.get('payment-signature'), 'proof-abc');
});

test('every paid call leaves one spend entry keyed by the proof hash', async () => {
  const { spend } = makeSpend([
    response({ status: 402 }),
    response({ status: 200 }),
  ]);
  await spend.fetch('https://example.test/paid');
  const [envelope] = spend.receipts();
  assert.match(envelope.vsr.payment.proof_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(envelope.vsr.result.consumed, 'unknown', 'delivery is not consumption');
});

test('the same proof used twice yields two entries with one proof hash', async () => {
  const { spend } = makeSpend([
    response({ status: 402 }),
    response({ status: 200 }),
    response({ status: 402 }),
    response({ status: 200 }),
  ]);
  await spend.fetch('https://example.test/paid');
  await spend.fetch('https://example.test/paid');
  const entries = spend.receipts();
  assert.equal(entries.length, 2, 'a replay is a second attempt and must stay visible');
  assert.equal(
    entries[0].vsr.payment.proof_hash,
    entries[1].vsr.payment.proof_hash,
    'identical proofs collapse to one hash so the two attempts can be reconciled',
  );
});

test('consumption is attested by the agent, not by the merchant', async () => {
  const { spend } = makeSpend([
    response({ status: 402 }),
    response({ status: 200 }),
  ]);
  const res = await spend.fetch('https://example.test/paid');
  res.gates.consumedBy('task_1');
  const [envelope] = spend.receipts();
  assert.equal(envelope.vsr.result.consumed, 'yes');
  assert.deepEqual(envelope.vsr.result.consumed_by, ['task_1']);
  assert.ok(envelope.vsr.result.consumed_at, 'attesting consumption records when it happened');
});

test('a failed retry is recorded as failed delivery, not as success', async () => {
  const { spend } = makeSpend([
    response({ status: 402 }),
    response({ status: 500 }),
  ]);
  const res = await spend.fetch('https://example.test/paid');
  assert.equal(res.status, 500);
  const [envelope] = spend.receipts();
  assert.equal(envelope.vsr.delivery.status, 'failed');
});
