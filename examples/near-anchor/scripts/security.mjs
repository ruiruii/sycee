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
import { GAS_ALLOWANCE, WASM, bootSandbox, freshKey, limitedAccessKey, shortError, txHashOf, txLink } from '../lib/near-sandbox.mjs';
import { signingKeyFromEnvOrFile } from '../lib/rpc.mjs';

const METHODS = ['anchor', 'anchor_batch'];

function flag(name) {
  return process.argv.includes(name);
}

async function rejectOf(promise) {
  try {
    const value = await promise;
    return { ok: true, reason: null, tx: txHashOf(value) };
  } catch (err) {
    return { ok: false, reason: shortError(err), tx: txHashOf(err) };
  }
}

function outcome(label, result) {
  if (!result) return { status: 'failed', reason: 'no result', tx: null };
  if (result.ok === false || result.reason) {
    return { status: 'rejected', reason: result.reason || 'rejected', tx: result.tx || null };
  }
  return { status: label, reason: null, tx: result.tx || null };
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
  const anchorRaw = await agent.callRaw(contract, 'anchor', args, { signWithKey: limited });
  let anchor = null;
  try {
    anchor = anchorRaw.parseResult();
  } catch {
    anchor = null;
  }
  const anchorOk = anchor?.receipt_hash === digest;
  const transfer = outcome('transfer', await rejectOf(
    agent.batch(contract.accountId).transfer(1n).transact(limited),
  ));
  const extra = freshKey();
  const addKey = outcome('add key', await rejectOf(
    agent.batch(agent.accountId).addKey(extra.getPublicKey()).transact(limited),
  ));
  const otherMethod = outcome('add_anchorer', await rejectOf(
    agent.call(contract, 'add_anchorer', { account_id: 'nobody.test.near' }, { signWithKey: limited }),
  ));
  const deposit = outcome('deposit', await rejectOf(
    agent.call(contract, 'anchor', args, { signWithKey: limited, attachedDeposit: 1n }),
  ));
  const duplicate = outcome('duplicate', await rejectOf(
    agent.call(contract, 'anchor', args, { signWithKey: limited }),
  ));
  return {
    chain: 'local NEAR sandbox',
    testnet: false,
    contract: contract.accountId,
    agent: agent.accountId,
    public_key: limited.getPublicKey().toString(),
    anchor_with_limited_key: anchorOk ? 'ok' : 'failed',
    anchor_tx: txHashOf(anchorRaw),
    transfer_near: transfer.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    add_key: addKey.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    call_add_anchorer: otherMethod.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    attached_deposit: deposit.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    duplicate_anchor: duplicate.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    transfer_detail: transfer.reason,
    add_key_detail: addKey.reason,
    other_method_detail: otherMethod.reason,
    deposit_detail: deposit.reason,
    duplicate_detail: duplicate.reason,
    transfer_tx: transfer.tx,
    add_key_attempt_tx: addKey.tx,
    other_method_tx: otherMethod.tx,
    deposit_tx: deposit.tx,
    duplicate_tx: duplicate.tx,
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
    const added = await agent.batch(agent.accountId).addKey(
      limited.getPublicKey(),
      limitedAccessKey(contract.accountId),
    ).transact();
    const report = await sandboxAttempts(agent, contract, limited, digest);
    report.add_key_tx = txHashOf(added);
    return report;
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
  const added = await full.account.signAndSendTransaction({
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
  let anchorTx = null;
  try {
    const anchored = await limitedConn.account.functionCall({
      contractId,
      methodName: 'anchor',
      args,
      gas: '100000000000000',
      attachedDeposit: '0',
    });
    anchorStatus = 'ok';
    anchorTx = txHashOf(anchored);
  } catch (err) {
    anchorStatus = `failed ${shortError(err)}`;
    anchorTx = txHashOf(err);
  }
  const transfer = outcome('transfer', await rejectOf(limitedConn.account.signAndSendTransaction({
    receiverId: contractId,
    actions: [transferAction(1n)],
  })));
  const extra = KeyPair.fromRandom('ed25519');
  const addKey = outcome('add key', await rejectOf(limitedConn.account.signAndSendTransaction({
    receiverId: accountId,
    actions: [addKeyAction(extra.getPublicKey(), functionCallAccessKey(contractId, METHODS, GAS_ALLOWANCE))],
  })));
  const otherMethod = outcome('add_anchorer', await rejectOf(limitedConn.account.functionCall({
    contractId,
    methodName: 'add_anchorer',
    args: { account_id: accountId },
    gas: '30000000000000',
    attachedDeposit: '0',
  })));
  const deposit = outcome('deposit', await rejectOf(limitedConn.account.functionCall({
    contractId,
    methodName: 'anchor',
    args,
    gas: '100000000000000',
    attachedDeposit: '1',
  })));
  const duplicate = outcome('duplicate', await rejectOf(limitedConn.account.functionCall({
    contractId,
    methodName: 'anchor',
    args,
    gas: '100000000000000',
    attachedDeposit: '0',
  })));
  return {
    chain: 'NEAR testnet',
    testnet: true,
    contract: contractId,
    agent: accountId,
    public_key: limited.getPublicKey().toString(),
    add_key_tx: txHashOf(added),
    anchor_with_limited_key: anchorStatus,
    anchor_tx: anchorTx,
    transfer_near: transfer.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    add_key: addKey.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    call_add_anchorer: otherMethod.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    attached_deposit: deposit.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    duplicate_anchor: duplicate.status === 'rejected' ? 'rejected' : 'unexpectedly succeeded',
    transfer_detail: transfer.reason,
    add_key_detail: addKey.reason,
    other_method_detail: otherMethod.reason,
    deposit_detail: deposit.reason,
    duplicate_detail: duplicate.reason,
    transfer_tx: transfer.tx,
    add_key_attempt_tx: addKey.tx,
    other_method_tx: otherMethod.tx,
    deposit_tx: deposit.tx,
    duplicate_tx: duplicate.tx,
  };
}

function attemptLine(label, status, reason, hash, testnet) {
  const why = status === 'rejected' ? ` (${reason || 'rejected'})` : '';
  const where = hash ? ` tx ${txLink(hash, testnet)}` : '';
  return `${label}: ${status}${why}${where}`;
}

export function formatSecurity(report) {
  const testnet = report.chain === 'NEAR testnet' || report.testnet === true;
  return [
    'SYCEE security demo',
    'payment: SIMULATED',
    'payment_note: mock facilitator, no Base Sepolia transfer, no funds moved',
    `chain: ${report.chain}`,
    `contract: ${report.contract}`,
    `agent: ${report.agent}`,
    'key: function-call',
    `public_key: ${report.public_key}`,
    `methods: ${METHODS.join(',')}`,
    'deposit: not allowed',
    `gas_allowance_yocto: ${GAS_ALLOWANCE.toString()}`,
    `receipt_hash: ${report.receipt_hash}`,
    `add_key_tx: ${txLink(report.add_key_tx, testnet)}`,
    `anchor_tx: ${txLink(report.anchor_tx, testnet)}`,
    `anchor_with_limited_key: ${report.anchor_with_limited_key}`,
    attemptLine('transfer NEAR', report.transfer_near, report.transfer_detail, report.transfer_tx, testnet),
    attemptLine('add key', report.add_key, report.add_key_detail, report.add_key_attempt_tx, testnet),
    attemptLine('call add_anchorer', report.call_add_anchorer, report.other_method_detail, report.other_method_tx, testnet),
    attemptLine('attached deposit', report.attached_deposit, report.deposit_detail, report.deposit_tx, testnet),
    attemptLine('duplicate anchor', report.duplicate_anchor, report.duplicate_detail, report.duplicate_tx, testnet),
    'can: call anchor and anchor_batch on this contract, and pay gas up to the allowance',
    'cannot: transfer NEAR, attach a deposit, add a key, or call any other method',
    'note: transfer, add-key, and add_anchorer are rejected when the access key is checked. Those failures may not appear on an explorer.',
    '故事：代理只有一把受限钥匙。它能把收据指纹写上 NEAR，不能转账，也不能给自己加一把更大的钥匙。转账、加钥匙、调用别的方法在钥匙校验时就被拒绝，浏览器上不一定看得到。',
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
