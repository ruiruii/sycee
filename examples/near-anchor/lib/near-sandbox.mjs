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
 * @param {unknown} err
 */
export function shortError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').slice(0, 280);
}
