import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';
import { buildVSR, canonicalJSON, generateKeyPairFromSeed, sha256, signVSR } from '@sycee/core';
import { digestHex, receiptHash } from '../lib/receipt.mjs';
import { merkleTree } from '../lib/merkle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = path.join(here, '../out/sycee_anchor.wasm');

function sample(seedByte, redeemCount = 1) {
  const keys = generateKeyPairFromSeed(seedByte.repeat(32));
  return signVSR(buildVSR({
    protocol: 'x402',
    resourceId: 'base.tip.v1',
    proofHash: sha256(`sample-${seedByte}`),
    redeemCount,
    settlementStatus: 'settled',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-13T00:00:00.000Z',
    consumed: 'unknown',
    publicKey: keys.publicKey,
    agentId: 'sycee:demo-merchant',
    role: 'merchant',
    amount: { value: '0.001000', currency: 'USDC' },
  }), keys.privateKey);
}

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.join(here, '..'),
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('sandbox: anchor, reject duplicate and stranger, look up, verify', async () => {
  const worker = await Worker.init();
  try {
    const root = worker.rootAccount;
    const contract = await root.devDeploy(wasm);
    const alice = await root.createSubAccount('alice');
    await contract.call(contract, 'new', { owner: contract.accountId, anchorers: [] });

    const env = sample('ab');
    const digest = digestHex(receiptHash(env));
    const anchored = await contract.call(contract, 'anchor', {
      receipt_hash: digest,
      source_chain: 'eip155:84532',
      merchant_id: '0x2222222222222222222222222222222222222222',
      batch_root: null,
    });
    assert.equal(anchored.receipt_hash, digest);
    assert.equal(anchored.source_chain, 'eip155:84532');
    assert.equal(anchored.predecessor, contract.accountId);
    assert.equal(typeof anchored.block_timestamp_ns, 'string');
    assert.ok(BigInt(anchored.block_timestamp_ns) > 0n);
    assert.equal(await contract.view('is_anchored', { receipt_hash: `sha256:${digest}` }), true);

    const stored = await contract.view('get_anchor', { receipt_hash: digest });
    assert.equal(stored.receipt_hash, digest);
    assert.equal(stored.merchant_id, '0x2222222222222222222222222222222222222222');

    const missing = await contract.view('get_anchor', { receipt_hash: '11'.repeat(32) });
    assert.equal(missing, null);

    await assert.rejects(
      contract.call(contract, 'anchor', {
        receipt_hash: digest,
        source_chain: 'eip155:84532',
        merchant_id: '0x2222222222222222222222222222222222222222',
        batch_root: null,
      }),
      /duplicate receipt hash/,
    );

    const other = digestHex(receiptHash(sample('cd')));
    await assert.rejects(
      alice.call(contract, 'anchor', {
        receipt_hash: other,
        source_chain: 'eip155:84532',
        merchant_id: 'merchant',
        batch_root: null,
      }),
      /unauthorized/,
    );
    assert.equal(await contract.view('is_anchored', { receipt_hash: other }), false);

    await assert.rejects(
      contract.call(contract, 'anchor', {
        receipt_hash: other,
        source_chain: 'eip155:84532',
        merchant_id: 'merchant',
        batch_root: null,
      }, { attachedDeposit: 1n }),
      /doesn't accept deposit|does not accept funds/,
    );

    const raw = await contract.callRaw(contract, 'anchor', {
      receipt_hash: other,
      source_chain: 'eip155:84532',
      merchant_id: 'sycee:demo-merchant',
      batch_root: null,
    });
    const logs = raw.logs.join('\n');
    assert.match(logs, /EVENT_JSON:/);
    assert.match(logs, /"standard":"sycee-anchor"/);
    assert.match(logs, /"event":"anchor"/);

    const batchEnvelopes = [sample('11'), sample('22'), sample('33'), sample('44')];
    const digests = batchEnvelopes.map((item) => digestHex(receiptHash(item)));
    const tree = merkleTree(digests);
    const rootHex = await contract.call(contract, 'anchor_batch', {
      receipt_hashes: [...digests].reverse(),
      source_chain: 'eip155:84532',
      merchant_id: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(rootHex, tree.root);
    const proof = tree.proofFor(digests[1]);
    assert.equal(await contract.view('verify_inclusion', {
      receipt_hash: digests[1],
      proof,
      batch_root: rootHex,
    }), true);
    assert.equal(await contract.view('verify_inclusion', {
      receipt_hash: digests[1],
      proof: ['22'.repeat(32)],
      batch_root: rootHex,
    }), false);

    const dir = await mkdtemp(path.join(tmpdir(), 'sycee-anchor-'));
    const receiptPath = path.join(dir, 'receipt.json');
    await writeFile(receiptPath, canonicalJSON(env));
    const rpcUrl = worker.rpcAddr;
    const verified = await runNode(path.join(here, '../scripts/verify.mjs'), ['--receipt', receiptPath], {
      NEAR_NETWORK: 'sandbox',
      NEAR_RPC_URL: rpcUrl,
      NEAR_CONTRACT_ID: contract.accountId,
    });
    assert.equal(verified.code, 0, verified.stderr + verified.stdout);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.digest, digest);
    assert.equal(report.record.receipt_hash, digest);
  } finally {
    await worker.tearDown();
  }
});
