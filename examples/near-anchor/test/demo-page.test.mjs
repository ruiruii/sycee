import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { receiptHash } from '../lib/receipt.mjs';
import sample from '../fixtures/sample-receipt.json' with { type: 'json' };

const html = await readFile(new URL('../demo/index.html', import.meta.url), 'utf8');
const start = html.indexOf('// HASH_LIB_START');
const end = html.indexOf('// HASH_LIB_END');
const lib = html.slice(start, end);
const api = new Function(`${lib}\nreturn { receiptHash, canonicalJSON, sha256Hex, SAMPLE_DIGEST, SAMPLE_RECEIPT, parseReceiptText };`)();

test('the demo page hashes a receipt the same way SYCEE does', () => {
  assert.equal(api.receiptHash(sample), receiptHash(sample));
  assert.equal(api.SAMPLE_DIGEST, receiptHash(sample).slice('sha256:'.length));
  assert.equal(api.receiptHash(api.SAMPLE_RECEIPT), receiptHash(sample));
  assert.equal(api.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(api.sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('the demo page does not claim a deployed contract', () => {
  assert.match(html, /\[待填\]/);
  assert.doesNotMatch(html, /已部署到测试网|deployed on testnet/i);
});

test('a base64url receipt header parses to the same hash', () => {
  const header = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64url');
  assert.equal(api.receiptHash(api.parseReceiptText(header)), receiptHash(sample));
});
