/**
 * L2 is a verdict about a pair, not a property of one envelope.
 *
 * These tests exist because the format used to allow the opposite: a single
 * envelope could write `completeness: bilateral` and be reported as L2, with
 * nothing to pair against. Any signer could reach the highest level by writing
 * one word. The rule below is the fix, and it has to fail loudly if it regresses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVSR, signVSR, verifyVSR, generateKeyPair } from '@sycee/core';
import { linkReceipts } from '../src/index.mjs';

const PROOF = `sha256:${'a'.repeat(64)}`;
const merchantKeys = generateKeyPair();
const agentKeys = generateKeyPair();

function envelope({ role, keys, consumed = 'unknown', proofHash = PROOF, resourceId = 'search.v1', completeness }) {
  const vsr = buildVSR({
    protocol: 'x402',
    resourceId,
    proofHash,
    redeemCount: 1,
    deliveryStatus: 'delivered',
    consumed,
    consumedBy: consumed === 'yes' ? ['task_1'] : undefined,
    publicKey: keys.publicKey,
    role,
    completeness,
  });
  return signVSR(vsr, keys.privateKey);
}

test('a lone envelope claiming bilateral verifies at L1, with the claim named', () => {
  const lone = envelope({
    role: 'merchant',
    keys: merchantKeys,
    consumed: 'yes',
    completeness: 'bilateral',
  });

  const check = verifyVSR(lone);
  assert.equal(check.valid, true, 'the signature is still good — only the level is capped');
  assert.equal(check.level, 'L1');
  assert.ok(
    check.warnings.some((w) => w.includes('claim about a pair')),
    'the warning must say what the field actually is',
  );
});

test('the pair reaches L2 only when both verify and the roles differ', () => {
  const merchant = envelope({ role: 'merchant', keys: merchantKeys });
  const agent = envelope({ role: 'agent', keys: agentKeys, consumed: 'yes' });

  // neither artifact is L2 on its own, whatever it says
  assert.equal(verifyVSR(merchant).level, 'L1');
  assert.equal(verifyVSR(agent).level, 'L1');

  const link = linkReceipts(merchant, agent);
  assert.deepEqual(link.problems, []);
  assert.equal(link.complete, true);
  assert.equal(link.completeness, 'bilateral');
  assert.equal(link.level, 'L2');
});

test('two signatures from the same side are one party talking twice', () => {
  const first = envelope({ role: 'merchant', keys: merchantKeys });
  const second = envelope({ role: 'merchant', keys: merchantKeys });

  const link = linkReceipts(first, second);
  assert.equal(link.complete, false);
  assert.equal(link.level, 'L1');
  assert.ok(link.problems.some((p) => p.includes('one merchant and one agent')));
});

test('a pair describing different payments is not a pair', () => {
  const merchant = envelope({ role: 'merchant', keys: merchantKeys });
  const agent = envelope({
    role: 'agent',
    keys: agentKeys,
    consumed: 'yes',
    proofHash: `sha256:${'b'.repeat(64)}`,
  });

  const link = linkReceipts(merchant, agent);
  assert.equal(link.complete, false);
  assert.equal(link.level, 'L1');
  assert.ok(link.problems.some((p) => p.includes('proof_hash mismatch')));
});

test('an unsigned counterpart cannot complete a pair', () => {
  const merchant = envelope({ role: 'merchant', keys: merchantKeys });
  const agent = envelope({ role: 'agent', keys: agentKeys, consumed: 'yes' });
  const unsigned = { vsr: agent.vsr };

  const link = linkReceipts(merchant, unsigned);
  assert.equal(link.complete, false);
  assert.equal(link.level, 'L1');
});

test('a synthesised agent resource_id is a caveat, not a manufactured mismatch', () => {
  const merchant = envelope({ role: 'merchant', keys: merchantKeys });
  // The agent side had no seller resource_id, so the SDK fell back to the URL
  // and marked it synthetic. The value differs from the seller's; that is our
  // fallback, not the seller's claim, so it must not read as a disagreement.
  // The marker has to be present at signing time, or the signature breaks.
  const agentVsr = buildVSR({
    protocol: 'x402',
    resourceId: 'https://seller.example/paid',
    proofHash: PROOF,
    redeemCount: 1,
    deliveryStatus: 'delivered',
    consumed: 'yes',
    consumedBy: ['task_1'],
    publicKey: agentKeys.publicKey,
    role: 'agent',
    extra: { _vendor: { resource_id_synthetic: true } },
  });
  const agent = signVSR(agentVsr, agentKeys.privateKey);

  const link = linkReceipts(merchant, agent);
  assert.equal(link.complete, true, 'the synthesised value must not block the pair');
  assert.ok(
    !link.problems.some((p) => p.includes('resource_id mismatch')),
    'no real mismatch was observed, so none may be reported',
  );
  assert.ok(
    link.warnings.some((w) => w.includes('synthesised')),
    'the caveat still has to be visible',
  );
});
