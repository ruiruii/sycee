#!/usr/bin/env node
/**
 * Show what a restricted agent key can and cannot do.
 *
 *   npm run demo:security
 *     local NEAR sandbox. No secrets.
 *
 *   NEAR_ACCOUNT_ID=sycee-anchor.testnet NEAR_CONTRACT_ID=sycee-anchor.testnet \
 *     npm run demo:security -- --testnet
 *     Adds one function-call key to that account (testnet gas only) and
 *     tries the same calls. The full key stays in ~/.near-credentials or
 *     NEAR_PRIVATE_KEY and is never printed.
 *
 * The function-call key may call only anchor and anchor_batch on the
 * contract. It cannot attach a deposit, transfer NEAR, or add a key.
 * A gas allowance is set so the allowed calls can pay fees. That allowance
 * is not permission to move funds.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { KeyPair } from 'near-api-js';
import { addKey as addKeyAction, functionCallAccessKey, transfer as transferAction } from 'near-api-js/lib/transaction.js';
import { digestHex, receiptHash } from '../lib/receipt.mjs';
import { simulatedPurchase } from '../lib/simulate-pay.mjs';
import { GAS_ALLOWANCE, WASM, bootSandbox, freshKey, limitedAccessKey, shortError } from '../lib/near-sandbox.mjs';
import { signingKeyFromEnvOrFile } from '../lib/rpc.mjs';

const METHODS = ['anchor', 'anchor_batch'];

function flag(name) {
  return process.argv.includes(name);
}

async function rejectOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return shortError(err);
  }
}

/**
 * @param {import('near-workspaces').NearAccount} agent
 * @param {import('near-workspaces').NearAccount} contract
 * @param {import('near-api-js').KeyPair} limited
 * @param {string} digest
 */
async function sandboxAttempts(agent, contract, limited, digest) {
  const args = {
    receipt_hash: digest,
    source_chain: 'eip155:84532',
    merchant_id: 'sycee:demo-merchant',
    batch_root: null,
  };
  const anchor = await agent.call(contract, 'anchor', args, { signWithKey: limited });
  const transfer = await rejectOf(
    agent.batch(contract.accountId).transfer(1n).transact(limited),
  );
  const extra = freshKey();
  const addKey = await rejectOf(
    agent.batch(agent.accountId).addKey(extra.getPublicKey()).transact(limited),
  );
  const otherMethod = await rejectOf(
    agent.call(contract, 'add_anchorer', { account_id: 'nobody.test.near' }, { signWithKey: limited }),
  );
  const deposit = await rejectOf(
    agent.call(contract, 'anchor', args, { signWithKey: limited, attachedDeposit: 1n }),
  );
  const duplicate = await rejectOf(
    agent.call(contract, 'anchor', args, { signWithKey: limited }),
  );
  return {
    chain: 'local NEAR sandbox',
    contract: contract.accountId,
    agent: agent.accountId,
    anchor_with_limited_key: anchor?.receipt_hash === digest ? 'ok' : 'failed',
    transfer_near: transfer ? 'rejected' : 'unexpectedly succeeded',
    add_key: addKey ? 'rejected' : 'unexpectedly succeeded',
    call_add_anchorer: otherMethod ? 'rejected' : 'unexpectedly succeeded',
    attached_deposit: deposit ? 'rejected' : 'unexpectedly succeeded',
    duplicate_anchor: duplicate ? 'rejected' : 'unexpectedly succeeded',
    transfer_detail: transfer,
    add_key_detail: addKey,
    other_method_detail: otherMethod,
    deposit_detail: deposit,
    duplicate_detail: duplicate,
  };
}

async function runSandbox(digest) {
  if (!existsSync(WASM)) {
    throw new Error('missing wasm. From examples/near-anchor run: bash scripts/build.sh');
  }
  const { worker, root, contract } = await bootSandbox();
  try {
    const agent = await root.createSubAccount('agent');
    await contract.call(contract, 'add_anchorer', { account_id: agent.accountId });
    const limited = freshKey();
    await agent.batch(agent.accountId).addKey(
      limited.getPublicKey(),
      limitedAccessKey(contract.accountId),
    ).transact();
    return await sandboxAttempts(agent, contract, limited, digest);
  } finally {
    await worker.tearDown();
  }
}

async function connectWith(accountId, secret) {
  const { connect, keyStores, KeyPair: KP } = await import('near-api-js');
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KP.fromString(secret);
  await keyStore.setKey('testnet', accountId, keyPair);
  const near = await connect({
    networkId: 'testnet',
    nodeUrl: 'https://rpc.testnet.near.org',
    keyStore,
  });
  return { account: await near.account(accountId), keyPair };
}

async function runTestnet(digest) {
  const accountId = process.env.NEAR_ACCOUNT_ID;
  const contractId = process.env.NEAR_CONTRACT_ID || 'sycee-anchor.testnet';
  if (!accountId) {
    throw new Error('Set NEAR_ACCOUNT_ID=sycee-anchor.testnet. Key: NEAR_PRIVATE_KEY or ~/.near-credentials/testnet/<account>.json');
  }
  if (/\.near$/.test(accountId) || /\.near$/.test(contractId)) {
    throw new Error('refusing a mainnet-style *.near account');
  }
  const fullSecret = await signingKeyFromEnvOrFile({ network: 'testnet', accountId });
  const full = await connectWith(accountId, fullSecret);
  const limited = KeyPair.fromRandom('ed25519');
  await full.account.signAndSendTransaction({
    receiverId: accountId,
    actions: [addKeyAction(
      limited.getPublicKey(),
      functionCallAccessKey(contractId, METHODS, GAS_ALLOWANCE),
    )],
  });
  const limitedConn = await connectWith(accountId, limited.toString());
  const args = {
    receipt_hash: digest,
    source_chain: 'eip155:84532',
    merchant_id: 'sycee:demo-merchant',
    batch_root: null,
  };
  let anchorStatus = 'failed';
  try {
    await limitedConn.account.functionCall({
      contractId,
      methodName: 'anchor',
      args,
      gas: '100000000000000',
      attachedDeposit: '0',
    });
    anchorStatus = 'ok';
  } catch (err) {
    anchorStatus = `failed ${shortError(err)}`;
  }
  const transfer = await rejectOf(limitedConn.account.signAndSendTransaction({
    receiverId: contractId,
    actions: [transferAction(1n)],
  }));
  const extra = KeyPair.fromRandom('ed25519');
  const addKey = await rejectOf(limitedConn.account.signAndSendTransaction({
    receiverId: accountId,
    actions: [addKeyAction(extra.getPublicKey(), functionCallAccessKey(contractId, METHODS, GAS_ALLOWANCE))],
  }));
  const otherMethod = await rejectOf(limitedConn.account.functionCall({
    contractId,
    methodName: 'add_anchorer',
    args: { account_id: accountId },
    gas: '30000000000000',
    attachedDeposit: '0',
  }));
  const deposit = await rejectOf(limitedConn.account.functionCall({
    contractId,
    methodName: 'anchor',
    args,
    gas: '100000000000000',
    attachedDeposit: '1',
  }));
  const duplicate = await rejectOf(limitedConn.account.functionCall({
    contractId,
    methodName: 'anchor',
    args,
    gas: '100000000000000',
    attachedDeposit: '0',
  }));
  return {
    chain: 'NEAR testnet',
    contract: contractId,
    agent: accountId,
    anchor_with_limited_key: anchorStatus,
    transfer_near: transfer ? 'rejected' : 'unexpectedly succeeded',
    add_key: addKey ? 'rejected' : 'unexpectedly succeeded',
    call_add_anchorer: otherMethod ? 'rejected' : 'unexpectedly succeeded',
    attached_deposit: deposit ? 'rejected' : 'unexpectedly succeeded',
    duplicate_anchor: duplicate ? 'rejected' : 'unexpectedly succeeded',
    transfer_detail: transfer,
    add_key_detail: addKey,
    other_method_detail: otherMethod,
    deposit_detail: deposit,
    duplicate_detail: duplicate,
  };
}

export function formatSecurity(report) {
  return [
    'SYCEE security demo',
    'payment: SIMULATED',
    'payment_note: mock facilitator, no Base Sepolia transfer, no funds moved',
    `chain: ${report.chain}`,
    `contract: ${report.contract}`,
    `agent: ${report.agent}`,
    'key: function-call',
    `methods: ${METHODS.join(',')}`,
    'deposit: not allowed',
    `gas_allowance_yocto: ${GAS_ALLOWANCE.toString()}`,
    `anchor_with_limited_key: ${report.anchor_with_limited_key}`,
    `transfer NEAR: ${report.transfer_near}`,
    `add key: ${report.add_key}`,
    `call add_anchorer: ${report.call_add_anchorer}`,
    `attached deposit: ${report.attached_deposit}`,
    `duplicate anchor: ${report.duplicate_anchor}`,
    'can: call anchor and anchor_batch on this contract, and pay gas up to the allowance',
    'cannot: transfer NEAR, attach a deposit, add a key, or call any other method',
    '故事：代理只有一把受限钥匙。它能把收据指纹写上 NEAR，不能转账，也不能给自己加一把更大的钥匙。',
  ].join('\n');
}

/**
 * @param {{ testnet?: boolean }} [opts]
 */
export async function runSecurity(opts = {}) {
  if ((process.env.NEAR_NETWORK || '') === 'mainnet') {
    throw new Error('refusing mainnet');
  }
  const bought = await simulatedPurchase();
  const digest = digestHex(receiptHash(bought.envelope));
  const report = opts.testnet ? await runTestnet(digest) : await runSandbox(digest);
  report.receipt_hash = `sha256:${digest}`;
  report.payment = 'SIMULATED';
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const report = await runSecurity({ testnet: flag('--testnet') });
    console.log(formatSecurity(report));
    const bad = [
      report.anchor_with_limited_key,
      report.transfer_near,
      report.add_key,
      report.call_add_anchorer,
      report.attached_deposit,
      report.duplicate_anchor,
    ];
    if (bad[0] !== 'ok' || bad.slice(1).some((line) => line !== 'rejected')) process.exit(1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
