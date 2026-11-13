/**
 * Read a VSR envelope or a demo-merchant evidence file.
 * Evidence is used for the chain label and the payTo id. Its public proof
 * hashes are truncated, so they are never anchored.
 */

import { readFile } from 'node:fs/promises';

/**
 * @param {string} text
 */
export function parseReceiptInput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('empty receipt input');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  return JSON.parse(decoded);
}

/**
 * @param {string} file
 */
export async function readJsonFile(file) {
  const text = await readFile(file, 'utf8');
  return parseReceiptInput(text);
}

/**
 * @param {unknown} value
 */
export function isEvidence(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      /** @type {{ service?: string }} */ (value).service === 'sycee-demo-merchant',
  );
}

/**
 * @param {unknown} evidence
 * @param {{ sourceChain?: string, merchantId?: string }} [overrides]
 */
export function metadataFromEvidence(evidence, overrides = {}) {
  const doc = evidence && typeof evidence === 'object' ? /** @type {any} */ (evidence) : {};
  const config = doc.config && typeof doc.config === 'object' ? doc.config : {};
  const sourceChain = overrides.sourceChain || config.network || 'eip155:84532';
  const merchantId = overrides.merchantId || config.pay_to || config.merchant_agent_id || '';
  if (!merchantId) {
    throw new Error('merchant id missing: pass --merchant-id or evidence with config.pay_to');
  }
  return { sourceChain: String(sourceChain), merchantId: String(merchantId) };
}

/**
 * Full envelopes hidden inside an evidence document, if a caller added them.
 * Truncated dashboard hashes are ignored on purpose.
 *
 * @param {unknown} evidence
 * @returns {object[]}
 */
export function envelopesFromEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return [];
  const doc = /** @type {any} */ (evidence);
  const found = [];
  for (const key of ['receipts', 'receipt']) {
    const value = doc[key];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of list) {
      if (item && typeof item === 'object' && item.vsr && item.signature) found.push(item);
    }
  }
  if (Array.isArray(doc.recent)) {
    const truncated = doc.recent.filter((row) => typeof row?.proof_hash === 'string' && !/^sha256:[0-9a-f]{64}$/.test(row.proof_hash));
    if (truncated.length && found.length === 0) {
      const err = new Error(
        'evidence.json truncates proof hashes. Pass the VSR envelope (the x-gates-receipt value), not the public dashboard row.',
      );
      err.truncated = truncated.length;
      throw err;
    }
  }
  return found;
}
