#!/usr/bin/env node
/**
 * Recompute a receipt hash and compare it to the on-chain anchor.
 *
 *   NEAR_CONTRACT_ID=you.testnet node scripts/verify.mjs --receipt receipt.json
 *
 * Optional batch check:
 *   node scripts/verify.mjs --receipt receipt.json --batch-root <hex> --proof <hex,hex>
 */

import { judgeReceipt, digestHex, receiptHash } from '../lib/receipt.mjs';
import { readJsonFile } from '../lib/load.mjs';
import { viewCall, networkConfig } from '../lib/rpc.mjs';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const receiptFile = flag('--receipt');
if (!receiptFile) {
  console.error('Pass --receipt <file>.');
  process.exit(2);
}

const envelope = await readJsonFile(receiptFile);
const hash = receiptHash(envelope);
const digest = digestHex(hash);
const contractId = process.env.NEAR_CONTRACT_ID;

if (!contractId || contractId.includes('待填')) {
  const local = judgeReceipt(envelope, null);
  console.log(JSON.stringify({
    ok: false,
    hash,
    digest,
    vsr_level: local.level,
    vsr_errors: local.errors.filter((e) => e.startsWith('vsr:')),
    chain: 'skipped',
    reason: 'NEAR_CONTRACT_ID is not set. The receipt was checked locally only.',
  }, null, 2));
  process.exit(local.errors.some((e) => e.startsWith('vsr:')) ? 1 : 2);
}

networkConfig();
const record = await viewCall(contractId, 'get_anchor', { receipt_hash: digest });
const judged = judgeReceipt(envelope, record);

let inclusion = null;
const batchRoot = flag('--batch-root');
const proofFlag = flag('--proof');
if (batchRoot) {
  const proof = proofFlag ? proofFlag.split(',').filter(Boolean) : [];
  inclusion = await viewCall(contractId, 'verify_inclusion', {
    receipt_hash: digest,
    proof,
    batch_root: batchRoot,
  });
  if (inclusion !== true) judged.errors.push('batch inclusion check failed');
  judged.ok = judged.errors.length === 0;
}

console.log(JSON.stringify({ ...judged, inclusion }, null, 2));
process.exit(judged.ok ? 0 : 1);
