import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVSR, canonicalJSON, generateKeyPairFromSeed, sha256, signVSR } from '@sycee/core';
import { digestHex, judgeReceipt, receiptHash } from '../lib/receipt.mjs';
import { envelopesFromEvidence, isEvidence, metadataFromEvidence, parseReceiptInput } from '../lib/load.mjs';

const keys = generateKeyPairFromSeed('11'.repeat(32));

function envelope() {
  return signVSR(buildVSR({
    protocol: 'x402',
    resourceId: 'base.tip.v1',
    proofHash: sha256('not-a-real-payment-proof'),
    redeemCount: 1,
    settlementStatus: 'settled',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-13T00:00:00.000Z',
    consumed: 'unknown',
    publicKey: keys.publicKey,
    agentId: 'sycee:demo-merchant',
    role: 'merchant',
    amount: { value: '0.001000', currency: 'USDC' },
  }), keys.privateKey);
}

test('receipt hash is sha256 of the canonical envelope', () => {
  const env = envelope();
  const expected = sha256(canonicalJSON({ vsr: env.vsr, signature: env.signature }));
  assert.equal(receiptHash(env), expected);
  assert.equal(receiptHash({ signature: env.signature, vsr: env.vsr, extra: 'ignored' }), expected);
  assert.match(digestHex(expected), /^[0-9a-f]{64}$/);
});

test('the x-gates-receipt base64url form hashes to the same value', () => {
  const env = envelope();
  const header = Buffer.from(canonicalJSON(env), 'utf8').toString('base64url');
  const parsed = parseReceiptInput(header);
  assert.equal(receiptHash(parsed), receiptHash(env));
});

test('a tampered receipt does not match an anchor of the original', () => {
  const env = envelope();
  const record = { receipt_hash: digestHex(receiptHash(env)) };
  const tampered = structuredClone(env);
  tampered.vsr.payment.redeem_count = 9;
  const judged = judgeReceipt(tampered, record);
  assert.equal(judged.ok, false);
  assert.ok(judged.errors.some((e) => e.includes('does not match') || e.startsWith('vsr:')));
});

test('evidence metadata comes from the demo merchant page, not from truncated hashes', () => {
  const evidence = {
    service: 'sycee-demo-merchant',
    config: { network: 'eip155:84532', pay_to: '0x2222222222222222222222222222222222222222' },
    recent: [{ proof_hash: 'sha256:abcd1234…wxyz' }],
  };
  assert.equal(isEvidence(evidence), true);
  assert.deepEqual(metadataFromEvidence(evidence), {
    sourceChain: 'eip155:84532',
    merchantId: '0x2222222222222222222222222222222222222222',
  });
  assert.throws(() => envelopesFromEvidence(evidence), /truncates proof hashes/);
});

test('refuses an envelope that embeds a raw payment credential', () => {
  const env = envelope();
  env.vsr.note = 'PAYMENT-SIGNATURE';
  assert.throws(() => receiptHash(env), /PAYMENT-SIGNATURE/);
});
