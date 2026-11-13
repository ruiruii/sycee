import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { merkleTree } from '../lib/merkle.mjs';

function hex(n) {
  return n.toString(16).padStart(64, '0');
}

test('the root does not depend on input order', () => {
  const a = [hex(1), hex(2), hex(3), hex(4)];
  const b = [hex(4), hex(2), hex(1), hex(3)];
  assert.equal(merkleTree(a).root, merkleTree(b).root);
  assert.notEqual(merkleTree(a).root, hex(1));
});

test('a proof recomputes the root', () => {
  const leaves = [hex(4), hex(9), hex(1), hex(7)];
  const tree = merkleTree(leaves);
  const proof = tree.proofFor(hex(1));
  let current = createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(hex(1), 'hex')])).digest();
  for (const siblingHex of proof) {
    const sibling = Buffer.from(siblingHex, 'hex');
    const left = Buffer.compare(current, sibling) <= 0 ? current : sibling;
    const right = Buffer.compare(current, sibling) <= 0 ? sibling : current;
    current = createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), left, right])).digest();
  }
  assert.equal(current.toString('hex'), tree.root);
});
