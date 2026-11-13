/**
 * Shared local NEAR sandbox helpers. No testnet, no keys on disk.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';
import { KeyPair } from 'near-api-js';
import { functionCallAccessKey } from 'near-api-js/lib/transaction.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM = path.join(here, '../out/sycee_anchor.wasm');

/** Gas budget for a function-call key. This is not a deposit allowance. */
export const GAS_ALLOWANCE = 250_000_000_000_000_000_000_000n;

/**
 * @param {string} contractId
 */
export function limitedAccessKey(contractId) {
  return functionCallAccessKey(contractId, ['anchor', 'anchor_batch'], GAS_ALLOWANCE);
}

export async function bootSandbox() {
  const worker = await Worker.init();
  const root = worker.rootAccount;
  const contract = await root.devDeploy(WASM);
  await contract.call(contract, 'new', { owner: contract.accountId, anchorers: [] });
  return { worker, root, contract };
}

export function freshKey() {
  return KeyPair.fromRandom('ed25519');
}

/**
 * Readable NEAR failure text. Error.message is often `{}` because the useful
 * fields (type, kind, cause) are not part of the message string.
 *
 * @param {unknown} err
 */
export function shortError(err) {
  const text = describeError(err).replace(/\s+/g, ' ').trim();
  return (text || 'rejected').slice(0, 280);
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 */
function describeError(value, depth = 0) {
  if (value == null || depth > 5) return '';
  if (typeof value === 'string') {
    if (value === '{}' || value === '[object Object]') return '';
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        const inner = describeError(parsed, depth + 1);
        if (inner) return inner;
      } catch {
        /* keep the raw string */
      }
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => describeError(item, depth + 1)).filter(Boolean).join(', ');
  }
  if (typeof value !== 'object') return '';

  const record = /** @type {Record<string, unknown>} */ (value);
  const parts = [];
  if (typeof record.type === 'string' && record.type) parts.push(record.type);
  for (const key of ['kind', 'cause']) {
    if (record[key] != null) {
      const inner = describeError(record[key], depth + 1);
      if (inner) parts.push(inner);
    }
  }
  const message = value instanceof Error ? value.message : '';
  if (message && message !== '{}' && message !== '[object Object]') {
    const inner = describeError(message, depth + 1);
    if (inner && !parts.includes(inner)) parts.push(inner);
  }
  if (parts.length) return parts.join(' ');

  const keys = Object.keys(record).filter((key) => key !== 'stack' && key !== 'message');
  if (keys.length === 1) {
    const inner = describeError(record[keys[0]], depth + 1);
    return inner ? `${keys[0]} ${inner}` : keys[0];
  }
  return keys.slice(0, 6).map((key) => {
    const inner = describeError(record[key], depth + 1);
    return inner ? `${key}=${inner}` : key;
  }).join(' ');
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function txHashOf(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (value);
  const direct = record.transaction?.hash
    || record.result?.transaction?.hash
    || record.transaction_outcome?.id
    || record.context?.transactionHash;
  if (typeof direct === 'string' && direct) return direct;
  if (value instanceof Error) return txHashOf({
    transaction_outcome: record.transaction_outcome,
    context: record.context,
    kind: record.kind,
    cause: record.cause,
  });
  return null;
}

/**
 * @param {string | null | undefined} hash
 * @param {boolean} testnet
 */
export function txLink(hash, testnet) {
  if (!hash) return 'n/a';
  if (!testnet) return `sandbox ${hash}`;
  return `https://testnet.nearblocks.io/txns/${hash}`;
}
