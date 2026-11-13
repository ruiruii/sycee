/**
 * Receipt fingerprint used by the demo merchant.
 *
 * This is the same check as examples/near-anchor/scripts/verify.mjs:
 *   receipt_hash = sha256(canonicalJSON({ vsr, signature }))
 *   verifyVSR(envelope) then compare the digest to get_anchor.
 *
 * The raw payment proof is never an input. A test locks this file to
 * examples/near-anchor/lib/receipt.mjs so the two cannot drift quietly.
 */

import { canonicalJSON, sha256, verifyVSR } from '@sycee/core';

const FORBIDDEN = ['PAYMENT-SIGNATURE', 'payment_proof', 'payment_signature', 'X-PAYMENT'];

/**
 * @param {unknown} envelope
 * @returns {{ vsr: object, signature: string }}
 */
export function asEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('expected a VSR envelope { vsr, signature }');
  }
  const body = /** @type {{ vsr?: unknown, signature?: unknown }} */ (envelope);
  if (!body.vsr || typeof body.vsr !== 'object') {
    throw new Error('expected a VSR envelope { vsr, signature }');
  }
  if (typeof body.signature !== 'string' || body.signature.length === 0) {
    throw new Error('envelope is missing its signature');
  }
  const clean = { vsr: body.vsr, signature: body.signature };
  const raw = JSON.stringify(clean);
  for (const token of FORBIDDEN) {
    if (raw.includes(token)) {
      throw new Error(`refusing to hash an envelope that embeds ${token}`);
    }
  }
  return clean;
}

/**
 * @param {unknown} envelope
 * @returns {string} `sha256:<64 hex>`
 */
export function receiptHash(envelope) {
  return sha256(canonicalJSON(asEnvelope(envelope)));
}

/**
 * @param {string} prefixed
 * @returns {string} 64 lowercase hex chars
 */
export function digestHex(prefixed) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(prefixed ?? ''));
  if (!match) throw new Error('receipt hash must be sha256:<64 hex>');
  return match[1];
}

/**
 * Local SYCEE check plus a comparison against an anchor record.
 * Chain lookup is the caller's job; this only judges the bytes.
 *
 * @param {unknown} envelope
 * @param {object | null | undefined} record `get_anchor` result
 */
export function judgeReceipt(envelope, record) {
  const clean = asEnvelope(envelope);
  const hash = sha256(canonicalJSON(clean));
  const digest = digestHex(hash);
  const verified = verifyVSR(clean);
  /** @type {string[]} */
  const errors = [];
  if (!verified.valid) errors.push(...verified.errors.map((e) => `vsr: ${e}`));
  if (!record) errors.push('not anchored');
  else if (String(record.receipt_hash).toLowerCase() !== digest) {
    errors.push('anchored hash does not match this receipt');
  }
  return {
    ok: errors.length === 0,
    errors,
    hash,
    digest,
    level: verified.level,
    record: record ?? null,
  };
}
