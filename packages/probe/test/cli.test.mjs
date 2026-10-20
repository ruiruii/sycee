import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EMPTY_DATA_HASH, deriveRedeemCount } from '@sycee/adapter-automaton';

// `import.meta.dirname` is Node 20.11+. This package still runs on 18.x in CI,
// where it is undefined and path.join throws ERR_INVALID_ARG_TYPE at import
// time — a failure that looks like a test failure but is a load failure.
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'gates-probe.mjs');
const reHash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const SHA = (hex) => `sha256:${hex}`;
const FP = SHA('a'.repeat(64));
const ATTEMPTS = [{ txHash: '0x' + 'b'.repeat(64), resourceId: 'search.v1', settled: true }];
const FORMS = deriveRedeemCount([], { fingerprint: FP, attempts: ATTEMPTS }).forms;

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function makeLedger() {
  const e0 = { index: 0, prevHash: SHA('0'.repeat(64)), timestamp: '2026-09-30T12:21:00.000Z', dataHash: EMPTY_DATA_HASH, keyId: 'k1', signature: 'x' };
  const e1 = { index: 1, prevHash: reHash(`${e0.prevHash}|${e0.timestamp}|${e0.dataHash}`), timestamp: '2026-09-30T12:21:01.000Z', dataHash: FORMS[0].dataHash, keyId: 'k1', signature: 'x' };
  const e2 = { index: 2, prevHash: reHash(`${e1.prevHash}|${e1.timestamp}|${e1.dataHash}`), timestamp: '2026-09-30T12:21:02.000Z', dataHash: SHA('c'.repeat(64)), keyId: 'k1', signature: 'x' };
  e0.hash = reHash(`${e0.prevHash}|${e0.timestamp}|${e0.dataHash}`);
  e1.hash = reHash(`${e1.prevHash}|${e1.timestamp}|${e1.dataHash}`);
  e2.hash = reHash(`${e2.prevHash}|${e2.timestamp}|${e2.dataHash}`);
  return {
    entries: [e0, e1, e2],
    pubkey: { keyId: 'k1', algorithm: 'ECDSA-P256-SHA256', history: [{ keyId: 'k0', publicKey: 'pem' }] },
    total: 3,
  };
}

let dir;
let ledgerPath;
let signedPath;

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'probe-cli-'));
  ledgerPath = join(dir, 'ledger.json');
  signedPath = join(dir, 'signed.json');
  await writeFile(ledgerPath, JSON.stringify(makeLedger()));
});

test('CLI probe --from-file --json emits a parseable report', async () => {
  const { code, out } = await runCli(
    ['probe', '--from-file', ledgerPath, '--json', '--fingerprint', FP, '--attempts', JSON.stringify(ATTEMPTS)],
    dir,
  );
  assert.equal(code, 0);
  const json = JSON.parse(out);
  assert.equal(json.tool, 'gates-probe');
  assert.equal(json.summary.total, 7);
  assert.equal(json.summary.fail, 0);
  assert.equal(json.summary.levels.L2, true);
});

test('CLI probe --from-file (text) prints a summary line', async () => {
  const { code, out } = await runCli(['probe', '--from-file', ledgerPath], dir);
  assert.equal(code, 0);
  assert.match(out, /SUMMARY:/);
  assert.match(out, /gates-probe v/);
});

test('CLI sign then verify round-trips', async () => {
  const signRes = await runCli(
    ['probe', '--from-file', ledgerPath, '--fingerprint', FP, '--attempts', JSON.stringify(ATTEMPTS), '--sign', '--out', signedPath],
    dir,
  );
  assert.equal(signRes.code, 0);
  const env = JSON.parse(await readFile(signedPath, 'utf8'));
  assert.ok(env.signature);
  assert.equal(env.signer.role, 'observer');

  const verifyRes = await runCli(['verify', signedPath], dir);
  assert.equal(verifyRes.code, 0);
  assert.match(verifyRes.out, /REPORT VALID/);
});

test('CLI verify rejects a tampered envelope', async () => {
  const env = JSON.parse(await readFile(signedPath, 'utf8'));
  env.report.summary.fail = 99;
  const badPath = join(dir, 'tampered.json');
  await writeFile(badPath, JSON.stringify(env));
  const { code, out } = await runCli(['verify', badPath], dir);
  assert.equal(code, 1);
  assert.match(out, /INVALID/);
});
