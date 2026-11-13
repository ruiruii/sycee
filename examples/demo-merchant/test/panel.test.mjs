import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { judgeReceipt as nearJudge, receiptHash as nearHash } from '../../near-anchor/lib/receipt.mjs';
import { judgeReceipt, receiptHash } from '../src/fingerprint.mjs';
import { nearFunctionCall } from '../src/anchor.mjs';
import { readNearConfig } from '../src/config.mjs';

const sample = JSON.parse(readFileSync(new URL('../../near-anchor/fixtures/sample-receipt.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../public/evidence.html', import.meta.url), 'utf8');
const start = html.indexOf('// HASH_LIB_START');
const end = html.indexOf('// HASH_LIB_END');
const lib = html.slice(start, end);
const api = new Function(`${lib}\nreturn { receiptHash, canonicalJSON, sha256Hex, digestHex, parseReceiptText, asEnvelope };`)();

test('the evidence panel hashes a receipt the same way verify.mjs does', () => {
  assert.equal(api.receiptHash(sample), nearHash(sample));
  assert.equal(api.receiptHash(sample), receiptHash(sample));
  assert.equal(api.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(api.sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
  const header = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64url');
  assert.equal(api.receiptHash(api.parseReceiptText(header)), nearHash(sample));
  const withExtra = { ...sample, at: '2026-01-01T00:00:00.000Z', anchor: { status: 'skipped' } };
  assert.equal(api.receiptHash(withExtra), nearHash(sample));
});

test('judgeReceipt stays locked to the near-anchor verifier', () => {
  const digest = nearHash(sample).slice('sha256:'.length);
  const cases = [
    null,
    { receipt_hash: digest, block_height: 1 },
    { receipt_hash: 'ab'.repeat(32) },
  ];
  for (const record of cases) {
    assert.deepEqual(judgeReceipt(sample, record), nearJudge(sample, record));
  }
  const tampered = { ...sample, signature: `${sample.signature.slice(0, -1)}${sample.signature.endsWith('A') ? 'B' : 'A'}` };
  assert.deepEqual(judgeReceipt(tampered, { receipt_hash: digest }), nearJudge(tampered, { receipt_hash: digest }));
  assert.equal(judgeReceipt(sample, { receipt_hash: digest }).ok, true);
});

test('the evidence panel is static black-and-gold HTML with no external script', () => {
  assert.match(html, /No scoring, no custody, no fund movement/);
  assert.match(html, /verify\.mjs/);
  assert.match(html, /#0c0b09/);
  assert.match(html, /#e0b44c/);
  assert.match(html, /value="sycee-anchor\.testnet"/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /ed25519-priv:/);
  assert.equal(html.includes('gates_spec'), false);
});

test('nearFunctionCall refuses mainnet and a non-zero deposit before loading a client', async () => {
  await assert.rejects(
    () => nearFunctionCall({
      method: 'anchor',
      args: {},
      attachedDeposit: '1',
      contractId: 'sycee-anchor.testnet',
      accountId: 'writer.testnet',
      rpcUrl: 'https://rpc.testnet.near.org',
      network: 'testnet',
      privateKey: `ed25519:${'a'.repeat(40)}`,
    }),
    /deposit_refused/,
  );
  await assert.rejects(
    () => nearFunctionCall({
      method: 'anchor',
      args: {},
      attachedDeposit: '0',
      contractId: 'sycee-anchor.testnet',
      accountId: 'alice.near',
      rpcUrl: 'https://rpc.testnet.near.org',
      network: 'testnet',
      privateKey: `ed25519:${'a'.repeat(40)}`,
    }),
    /near_mainnet_refused/,
  );
  await assert.rejects(
    () => nearFunctionCall({
      method: 'anchor',
      args: {},
      attachedDeposit: '0',
      contractId: 'sycee-anchor.testnet',
      accountId: 'writer.testnet',
      rpcUrl: 'https://rpc.testnet.near.org',
      network: 'testnet',
      privateKey: 'ed25519-priv:not-a-near-key-at-all',
    }),
    /near_key_malformed/,
  );
});

test('readNearConfig keeps the function-call key off the public view', () => {
  const key = `ed25519:${'k'.repeat(48)}`;
  const near = readNearConfig({
    NEAR_PRIVATE_KEY: key,
    NEAR_ACCOUNT_ID: 'writer.testnet',
  });
  assert.equal(near.enabled, true);
  assert.equal(near.privateKey, key);
  assert.equal(JSON.stringify(near.public).includes(key), false);
  assert.equal(near.public.contract, 'sycee-anchor.testnet');
  assert.equal(near.public.rpc_url, 'https://rpc.testnet.near.org');

  const mainnet = readNearConfig({
    NEAR_PRIVATE_KEY: key,
    NEAR_ACCOUNT_ID: 'writer.testnet',
    NEAR_NETWORK: 'mainnet',
  });
  assert.equal(mainnet.enabled, false);
  assert.equal(mainnet.privateKey, '');
  assert.ok(mainnet.problems.includes('near_mainnet_refused'));

  const off = readNearConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.lookup, true);
  assert.deepEqual(off.problems, []);
});
