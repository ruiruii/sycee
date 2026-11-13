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
const api = new Function(`${lib}\nreturn { receiptHash, canonicalJSON, sha256Hex, SAMPLE_DIGEST, SAMPLE_RECEIPT, parseReceiptText, findHash, findTx };`)();

test('the demo page hashes a receipt the same way SYCEE does', () => {
  assert.equal(api.receiptHash(sample), receiptHash(sample));
  assert.equal(api.SAMPLE_DIGEST, receiptHash(sample).slice('sha256:'.length));
  assert.equal(api.receiptHash(api.SAMPLE_RECEIPT), receiptHash(sample));
  assert.equal(api.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(api.sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('the demo page queries sycee-anchor.testnet and still marks the public URL as unset', () => {
  assert.match(html, /value="sycee-anchor\.testnet"/);
  assert.match(html, /277456711/);
  assert.match(html, /9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ/);
  assert.match(html, /\[待填\]/);
  assert.match(html, /id="offline"[^>]*checked|checked[^>]*id="offline"/);
});

test('a pasted e2e transcript yields its hash and nearblocks link', () => {
  const text = [
    'payment: SIMULATED',
    'receipt_hash: sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03',
    'nearblocks: https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ',
  ].join('\n');
  assert.equal(api.findHash(text), 'sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03');
  assert.equal(api.findTx(text), 'https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ');
  assert.match(html, /URLSearchParams/);
});

test('a base64url receipt header parses to the same hash', () => {
  const header = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64url');
  assert.equal(api.receiptHash(api.parseReceiptText(header)), receiptHash(sample));
});
