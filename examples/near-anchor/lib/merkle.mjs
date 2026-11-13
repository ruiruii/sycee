/**
 * Same Merkle tree the contract computes.
 *
 * Leaf  = SHA-256(0x00 || receipt_hash_bytes)
 * Node  = SHA-256(0x01 || min(left, right) || max(left, right))
 * Leaves are sorted by the leaf hash before pairing. An odd node is promoted.
 * The root is not the receipt hash itself.
 */

import { createHash } from 'node:crypto';

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);
export const MAX_BATCH = 32;

function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest();
}

/** @param {string} hex */
export function leafNode(hex) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('receipt hash must be 32 bytes');
  return sha256Bytes(Buffer.concat([LEAF, raw]));
}

/** @param {Buffer} a @param {Buffer} b */
export function hashPair(a, b) {
  const left = Buffer.compare(a, b) <= 0 ? a : b;
  const right = Buffer.compare(a, b) <= 0 ? b : a;
  return sha256Bytes(Buffer.concat([NODE, left, right]));
}

/**
 * @param {string[]} hexHashes 64-char hex, no prefix
 * @returns {{ root: string, proofFor: (target: string) => string[] }}
 */
export function merkleTree(hexHashes) {
  if (hexHashes.length === 0) throw new Error('empty batch');
  if (hexHashes.length > MAX_BATCH) throw new Error('batch exceeds 32 receipts');
  const normalized = hexHashes.map((h) => h.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error('duplicate receipt hash');

  /** @type {{ node: Buffer, has: boolean }[]} */
  let level = normalized.map((h) => ({ node: leafNode(h), has: false }));
  level.sort((a, b) => Buffer.compare(a.node, b.node));

  /**
   * @param {string} target
   */
  function proofFor(target) {
    const want = leafNode(target.toLowerCase());
    let nodes = level.map((entry) => ({ node: Buffer.from(entry.node), has: entry.node.equals(want) }));
    if (!nodes.some((entry) => entry.has)) throw new Error('receipt hash is not in this batch');
    /** @type {string[]} */
    const proof = [];
    while (nodes.length > 1) {
      /** @type {{ node: Buffer, has: boolean }[]} */
      const next = [];
      for (let i = 0; i < nodes.length; i += 2) {
        if (i + 1 === nodes.length) {
          next.push(nodes[i]);
          continue;
        }
        const left = nodes[i];
        const right = nodes[i + 1];
        if (left.has) proof.push(right.node.toString('hex'));
        else if (right.has) proof.push(left.node.toString('hex'));
        next.push({ node: hashPair(left.node, right.node), has: left.has || right.has });
      }
      nodes = next;
    }
    return proof;
  }

  let nodes = level.map((entry) => entry.node);
  while (nodes.length > 1) {
    /** @type {Buffer[]} */
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 === nodes.length) next.push(nodes[i]);
      else next.push(hashPair(nodes[i], nodes[i + 1]));
    }
    nodes = next;
  }

  return { root: nodes[0].toString('hex'), proofFor };
}
