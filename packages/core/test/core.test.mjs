import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVSR,
  canonicalJSON,
  generateKeyPair,
  sha256,
  signVSR,
  toSpanAttributes,
  verifyVSR,
} from '../src/index.mjs';

const KEYS = generateKeyPair();

/** Smallest receipt that still exercises signing and verification. */
function receipt(overrides = {}) {
  return buildVSR({
    protocol: 'x402',
    resourceId: 'test.resource.v1',
    proofHash: sha256('demo-proof'),
    redeemCount: 1,
    redeemResources: ['test.resource.v1'],
    publicKey: KEYS.publicKey,
    agentId: 'test:merchant',
    keyId: 'test-key',
    role: 'merchant',
    completeness: 'unilateral_merchant',
    ...overrides,
  });
}

test('canonical JSON ignores key order, including in nested objects', () => {
  assert.equal(canonicalJSON({ b: 1, a: 2 }), canonicalJSON({ a: 2, b: 1 }));
  assert.equal(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const x = canonicalJSON({ outer: { z: [1, 2], y: { q: true, p: null } } });
  const y = canonicalJSON({ outer: { y: { p: null, q: true }, z: [1, 2] } });
  assert.equal(x, y);
});

test('sha256 is stable and prefixed', () => {
  const h = sha256('demo-proof');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sha256('demo-proof'), h);
  assert.notEqual(sha256('demo-proof'), sha256('demo-proof-2'));
});

test('a freshly signed merchant receipt verifies at L1', () => {
  const report = verifyVSR(signVSR(receipt(), KEYS.privateKey));
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.equal(report.level, 'L1', 'a unilateral merchant receipt is L1');
  assert.deepEqual(report.errors, []);
});

test('changing redeem_count after signing must not verify', () => {
  const envelope = signVSR(receipt(), KEYS.privateKey);
  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.vsr.payment.redeem_count = 3;
  const report = verifyVSR(tampered);
  assert.equal(report.valid, false, 'the signature covers redeem_count');
  assert.equal(report.level, 'invalid');
});

test('swapping in a different signer public key must not verify', () => {
  const other = generateKeyPair();
  const envelope = signVSR(receipt({ publicKey: other.publicKey }), other.privateKey);
  const spoofed = JSON.parse(JSON.stringify(envelope));
  spoofed.vsr.signer.public_key = KEYS.publicKey;
  assert.equal(verifyVSR(spoofed).valid, false, 'the public key is part of the signed body');
});

test('an unsigned receipt is L0 telemetry, never a valid receipt', () => {
  const report = verifyVSR({ vsr: receipt() });
  assert.equal(report.level, 'L0');
  assert.ok(
    report.warnings.some((w) => w.includes('signature: absent')),
    'the absence of a signature has to be reported',
  );
});

test('settlement status is reported separately from validity', () => {
  const inFlight = verifyVSR(signVSR(receipt({ settlementStatus: 'in_flight' }), KEYS.privateKey));
  assert.equal(inFlight.valid, true, 'in_flight is not an error');
  assert.equal(inFlight.settlement.status, 'in_flight');
  assert.equal(inFlight.settlement.finalized, false, 'in_flight must never read as final');

  const settled = verifyVSR(signVSR(receipt({ settlementStatus: 'settled' }), KEYS.privateKey));
  assert.equal(settled.settlement.finalized, true);
});

test('settled plus failed delivery is reported as a contradiction', () => {
  // The pair (settlement, delivery) is what §5.1 checks, not just settlement.
  const report = verifyVSR(
    signVSR(receipt({ settlementStatus: 'absent', deliveryStatus: 'delivered' }), KEYS.privateKey),
  );
  assert.equal(report.settlement.consistency, 'contradiction', 'delivered without payment');
});

test('settled plus failed delivery is not treated as a contradiction', () => {
  const report = verifyVSR(
    signVSR(receipt({ settlementStatus: 'settled', deliveryStatus: 'failed' }), KEYS.privateKey),
  );
  assert.equal(
    report.settlement.consistency,
    'ok',
    'a paid-but-undelivered request is incomplete service, not a broken record',
  );
});

test('span attributes carry the redeem count through unchanged', () => {
  const attrs = toSpanAttributes(receipt({ redeemCount: 3 }));
  assert.equal(attrs['agent.spend.payment.redeem_count'], 3);
  assert.equal(attrs['agent.spend.result.consumed'], 'unknown');
});

test('extra is confined to _vendor, never spread onto core fields', () => {
  const vsr = receipt({ extra: { name: 'USDC', version: '2' } });
  assert.deepEqual(vsr._vendor, { name: 'USDC', version: '2' });
  assert.equal(vsr.schema_version, 'sycee/v0.1', 'schema_version stays the constructor\'s');
  assert.equal(vsr.protocol, 'x402');
  assert.equal(vsr.name, undefined, 'a vendor key must not land on the top level');
});

test('an extra key already in the _vendor namespace is kept there', () => {
  const vsr = receipt({ extra: { _vendor: { payment_proof: '0xdeadbeef' } } });
  assert.deepEqual(vsr._vendor, { payment_proof: '0xdeadbeef' });
  assert.equal(vsr.payment_proof, undefined, 'vendor data must not escape _vendor');
});

test('an extra key that collides with a core field is rejected, not overridden', () => {
  assert.throws(
    () => receipt({ extra: { schema_version: 'EVIL' } }),
    /collides with a core field/,
    'overriding a signed field must fail loudly, not silently',
  );
  assert.throws(
    () => receipt({ extra: { payment: { proof_hash: 'sha256:forged' } } }),
    /collides with a core field/,
  );
});

test('the red line catches a credential regardless of casing or field spelling', () => {
  const cases = [
    { _vendor: { 'Payment-Signature': '0xsig' } },
    { _vendor: { paymentProof: '0xsig' } },
    { _vendor: { X_PAYMENT: '0xsig' } },
    { _vendor: { payment_payload: { nonce: '0x01' } } },
  ];
  for (const extra of cases) {
    const report = verifyVSR({ vsr: receipt({ extra }) });
    assert.ok(
      report.errors.some((e) => e.includes('red line')),
      `expected a red-line error for ${JSON.stringify(extra)}`,
    );
  }
});

test('the red line does not fire on ordinary fields', () => {
  const report = verifyVSR({ vsr: receipt({ extra: { _vendor: { name: 'USDC' } } }) });
  assert.equal(
    report.errors.some((e) => e.includes('red line')),
    false,
    'a benign vendor field must not be mistaken for a credential',
  );
});
