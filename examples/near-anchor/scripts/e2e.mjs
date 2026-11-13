#!/usr/bin/env node
/**
 * One story: a simulated agent payment, a signed receipt, a NEAR anchor, a check.
 *
 *   npm run demo:e2e
 *     local merchant, simulated settlement, local NEAR sandbox. No secrets.
 *
 *   NEAR_ACCOUNT_ID=sycee-anchor.testnet NEAR_CONTRACT_ID=sycee-anchor.testnet \
 *     npm run demo:e2e -- --testnet
 *     same simulated payment, anchor on NEAR testnet.
 *     Key: NEAR_PRIVATE_KEY or ~/.near-credentials/testnet/<account>.json
 *
 *   npm run demo:e2e -- --testnet --receipt receipt.json
 *     skip the simulated purchase and anchor a receipt you already have.
 *
 * Refuses mainnet. Does not print a private key.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestHex, judgeReceipt, receiptHash } from '../lib/receipt.mjs';
import { simulatedPurchase } from '../lib/simulate-pay.mjs';
import { bootSandbox, WASM } from '../lib/near-sandbox.mjs';
import { changeCall, viewCall } from '../lib/rpc.mjs';

function flag(name) {
  return process.argv.includes(name);
}

function option(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function txOf(result) {
  return result?.transaction?.hash
    || result?.transaction_outcome?.id
    || null;
}

/**
 * @param {{ testnet?: boolean, receiptPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function runE2E(opts = {}) {
  const testnet = Boolean(opts.testnet);
  const env = opts.env ?? process.env;
  if ((env.NEAR_NETWORK || '') === 'mainnet') {
    throw new Error('refusing mainnet');
  }
  let envelope;
  let payment;
  if (opts.receiptPath) {
    envelope = JSON.parse(await readFile(opts.receiptPath, 'utf8'));
    payment = 'CALLER_RECEIPT';
  } else {
    const bought = await simulatedPurchase();
    envelope = bought.envelope;
    payment = 'SIMULATED';
  }
  const hash = receiptHash(envelope);
  const digest = digestHex(hash);
  /** @type {object} */
  const story = {
    payment,
    http_status: payment === 'SIMULATED' ? 200 : null,
    receipt_hash: hash,
  };

  if (!testnet) {
    const { existsSync } = await import('node:fs');
    if (!existsSync(WASM)) {
      throw new Error('missing wasm. From examples/near-anchor run: bash scripts/build.sh');
    }
    const { worker, contract } = await bootSandbox();
    try {
      const anchored = await contract.call(contract, 'anchor', {
        receipt_hash: digest,
        source_chain: 'eip155:84532',
        merchant_id: 'sycee:demo-merchant',
        batch_root: null,
      });
      const record = await contract.view('get_anchor', { receipt_hash: digest });
      const judged = judgeReceipt(envelope, record);
      story.chain = 'local NEAR sandbox';
      story.contract = contract.accountId;
      story.block_height = anchored.block_height;
      story.anchored = record?.receipt_hash === digest;
      story.verify = judged.ok ? 'ok true' : `ok false ${judged.errors.join('; ')}`;
      story.nearblocks = 'n/a';
    } finally {
      await worker.tearDown();
    }
    return story;
  }

  process.env.NEAR_NETWORK = 'testnet';
  process.env.NEAR_ACCOUNT_ID = env.NEAR_ACCOUNT_ID || process.env.NEAR_ACCOUNT_ID;
  process.env.NEAR_CONTRACT_ID = env.NEAR_CONTRACT_ID || process.env.NEAR_CONTRACT_ID || 'sycee-anchor.testnet';
  if (!process.env.NEAR_ACCOUNT_ID) {
    throw new Error('Set NEAR_ACCOUNT_ID=sycee-anchor.testnet. The key is read from NEAR_PRIVATE_KEY or ~/.near-credentials/testnet/<account>.json');
  }
  const sent = await changeCall('anchor', {
    receipt_hash: digest,
    source_chain: 'eip155:84532',
    merchant_id: envelope?.vsr?.signer?.agent_id || 'sycee:demo-merchant',
    batch_root: null,
  });
  const hashId = txOf(sent);
  const record = await viewCall(process.env.NEAR_CONTRACT_ID, 'get_anchor', { receipt_hash: digest });
  const judged = judgeReceipt(envelope, record);
  story.chain = 'NEAR testnet';
  story.contract = process.env.NEAR_CONTRACT_ID;
  story.block_height = record?.block_height ?? null;
  story.anchored = record?.receipt_hash === digest;
  story.verify = judged.ok ? 'ok true' : `ok false ${judged.errors.join('; ')}`;
  story.nearblocks = hashId
    ? `https://testnet.nearblocks.io/txns/${hashId}`
    : 'https://testnet.nearblocks.io/address/sycee-anchor.testnet';
  return story;
}

export function formatStory(story) {
  const tx = typeof story.nearblocks === 'string' && story.nearblocks.startsWith('https://')
    ? `&tx=${encodeURIComponent(story.nearblocks)}`
    : '';
  const page = `examples/near-anchor/demo/index.html?hash=${encodeURIComponent(story.receipt_hash)}&offline=0${tx}`;
  const lines = [
    'SYCEE e2e',
    `payment: ${story.payment}`,
    story.payment === 'SIMULATED'
      ? 'payment_note: mock facilitator, no Base Sepolia transfer, no funds moved'
      : 'payment_note: receipt supplied by the caller',
    `http_status: ${story.http_status ?? 'n/a'}`,
    `receipt_hash: ${story.receipt_hash}`,
    `chain: ${story.chain}`,
    `contract: ${story.contract}`,
    `block_height: ${story.block_height}`,
    `anchored: ${story.anchored}`,
    `verify: ${story.verify}`,
    `nearblocks: ${story.nearblocks}`,
    `demo_page: ${page}`,
    story.payment === 'SIMULATED'
      ? '故事：代理用模拟付款向本地演示商家买了一次接口。商家签了收据。收据指纹记到 NEAR 后核对成功。没有发生真实转账。'
      : '故事：使用你提供的收据，把指纹记到 NEAR 后核对。',
  ];
  return lines.join('\n');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const story = await runE2E({
      testnet: flag('--testnet'),
      receiptPath: option('--receipt'),
    });
    console.log(formatStory(story));
    if (!String(story.verify).startsWith('ok true')) process.exit(1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
