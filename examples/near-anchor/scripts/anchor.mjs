#!/usr/bin/env node
/**
 * Anchor one SYCEE receipt, or a batch of them, on the NEAR contract.
 *
 *   NEAR_ACCOUNT_ID=you.testnet \
 *   NEAR_CONTRACT_ID=you.testnet \
 *   NEAR_PRIVATE_KEY=ed25519:... \
 *   node scripts/anchor.mjs --receipt receipt.json --evidence evidence.json
 *
 * Refuses mainnet. Does not create an account.
 */

import { digestHex, receiptHash } from '../lib/receipt.mjs';
import { merkleTree } from '../lib/merkle.mjs';
import { envelopesFromEvidence, isEvidence, metadataFromEvidence, readJsonFile } from '../lib/load.mjs';
import { changeCall } from '../lib/rpc.mjs';

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function flags(name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
      out.push(value);
    }
  }
  return out;
}

const receiptFiles = [...flags('--receipt'), ...flags('--batch')];
const evidenceFile = flag('--evidence');
const merchantId = flag('--merchant-id') || process.env.MERCHANT_ID;
const sourceChain = flag('--source-chain') || process.env.SOURCE_CHAIN;

if (receiptFiles.length === 0 && !evidenceFile) {
  console.error('Pass --receipt <file> (repeatable) and optionally --evidence <file>.');
  process.exit(2);
}

/** @type {object[]} */
const envelopes = [];
let evidence;
for (const file of receiptFiles) {
  const parsed = await readJsonFile(file);
  if (Array.isArray(parsed)) envelopes.push(...parsed);
  else if (isEvidence(parsed)) evidence = parsed;
  else envelopes.push(parsed);
}
if (evidenceFile) evidence = await readJsonFile(evidenceFile);
if (evidence && isEvidence(evidence)) {
  try {
    envelopes.push(...envelopesFromEvidence(evidence));
  } catch (err) {
    if (envelopes.length === 0) throw err;
  }
}

if (envelopes.length === 0) {
  console.error('No VSR envelope found. The public evidence page does not include full receipts.');
  process.exit(2);
}

const meta = metadataFromEvidence(evidence ?? {}, { merchantId, sourceChain });
const digests = envelopes.map((envelope) => digestHex(receiptHash(envelope)));

if (digests.length === 1) {
  const result = await changeCall('anchor', {
    receipt_hash: digests[0],
    source_chain: meta.sourceChain,
    merchant_id: meta.merchantId,
    batch_root: null,
  });
  console.log(JSON.stringify({ receipt_hash: digests[0], source_chain: meta.sourceChain, merchant_id: meta.merchantId, result }, null, 2));
} else {
  const tree = merkleTree(digests);
  const result = await changeCall('anchor_batch', {
    receipt_hashes: digests,
    source_chain: meta.sourceChain,
    merchant_id: meta.merchantId,
  });
  console.log(JSON.stringify({
    batch_root: tree.root,
    receipt_hashes: digests,
    proofs: Object.fromEntries(digests.map((d) => [d, tree.proofFor(d)])),
    source_chain: meta.sourceChain,
    merchant_id: meta.merchantId,
    result,
  }, null, 2));
}
