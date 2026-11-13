import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingKeyFromEnvOrFile } from '../lib/rpc.mjs';
import { shortError } from '../lib/near-sandbox.mjs';
import { formatStory } from '../scripts/e2e.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'ed25519:not-a-real-key-and-must-not-be-logged';

function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('shortError keeps NEAR type and kind when the message is {}', () => {
  const err = new Error('{}');
  err.type = 'InvalidAccessKeyError';
  err.kind = { DepositWithFunctionCall: null };
  const text = shortError(err);
  assert.match(text, /InvalidAccessKeyError/);
  assert.match(text, /DepositWithFunctionCall/);
  assert.notEqual(text, '{}');
});

test('formatStory puts the testnet tx on the demo page url', () => {
  const tx = 'https://testnet.nearblocks.io/txns/6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo';
  const text = formatStory({
    payment: 'SIMULATED',
    http_status: 200,
    receipt_hash: `sha256:${'ab'.repeat(32)}`,
    chain: 'NEAR testnet',
    contract: 'sycee-anchor.testnet',
    block_height: 1,
    anchored: true,
    verify: 'ok true',
    nearblocks: tx,
  });
  assert.match(text, /demo_page: .*&tx=https%3A%2F%2Ftestnet\.nearblocks\.io%2Ftxns%2F6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo/);
});

test('the deploy script refuses mainnet and does not create an account', async () => {
  const text = await readFile(path.join(root, 'scripts/deploy.sh'), 'utf8');
  assert.doesNotMatch(text, /account create|create-account|near account create/);
  assert.match(text, /network-config testnet/);
  assert.match(text, /attached-deposit '0 NEAR'/);
  const mainnet = await run('scripts/deploy.sh', { NEAR_NETWORK: 'mainnet', NEAR_ACCOUNT_ID: 'someone.testnet' });
  assert.equal(mainnet.code, 2);
  assert.match(mainnet.stderr, /testnet/);
  const implicitMainnet = await run('scripts/deploy.sh', { NEAR_NETWORK: 'testnet', NEAR_ACCOUNT_ID: 'someone.near' });
  assert.equal(implicitMainnet.code, 2);
  assert.match(implicitMainnet.stderr, /mainnet/);
  assert.match(text, /sign-with-keychain/);
  assert.match(text, /sign-with-legacy-keychain/);
});

test('headless Linux falls back to the legacy key file, and the key is not printed', async () => {
  const base = {
    NEAR_NETWORK: 'testnet',
    NEAR_ACCOUNT_ID: 'example.testnet',
    NEAR_DEPLOY_PRINT_SIGN: '1',
    DBUS_SESSION_BUS_ADDRESS: '',
    XDG_RUNTIME_DIR: '',
  };
  const auto = await run('scripts/deploy.sh', { ...base, NEAR_SIGN_WITH: 'auto' });
  assert.equal(auto.code, 0, auto.stderr);
  if (process.platform === 'linux') {
    assert.match(auto.stdout, /^sign:sign-with-legacy-keychain$/m);
  } else {
    assert.match(auto.stdout, /^sign:sign-with-/m);
  }
  const forced = await run('scripts/deploy.sh', { ...base, NEAR_SIGN_WITH: 'keychain' });
  assert.match(forced.stdout, /^sign:sign-with-keychain$/m);
  const legacy = await run('scripts/deploy.sh', { ...base, NEAR_SIGN_WITH: 'legacy' });
  assert.match(legacy.stdout, /^sign:sign-with-legacy-keychain$/m);
  const bad = await run('scripts/deploy.sh', { ...base, NEAR_SIGN_WITH: 'ledger' });
  assert.equal(bad.code, 2);
  const joined = [auto, forced, legacy, bad].map((r) => r.stdout + r.stderr).join('\n');
  assert.doesNotMatch(joined, /ed25519:/);
});

test('anchor signing key comes from the legacy file and errors omit the key', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'sycee-cred-'));
  const dir = path.join(home, '.near-credentials', 'testnet');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'example.testnet.json'), JSON.stringify({
    account_id: 'example.testnet',
    public_key: 'ed25519:public-only',
    private_key: SECRET,
  }));
  const loaded = await signingKeyFromEnvOrFile({
    network: 'testnet',
    accountId: 'example.testnet',
    env: {},
    home,
  });
  assert.equal(loaded, SECRET);
  const fromEnv = await signingKeyFromEnvOrFile({
    network: 'testnet',
    accountId: 'example.testnet',
    env: { NEAR_PRIVATE_KEY: 'ed25519:from-env' },
    home: '/no/such/home',
  });
  assert.equal(fromEnv, 'ed25519:from-env');
  await assert.rejects(
    () => signingKeyFromEnvOrFile({ network: 'testnet', accountId: 'missing.testnet', env: {}, home }),
    (err) => {
      assert.equal(String(err.message).includes(SECRET), false);
      assert.match(err.message, /NEAR_PRIVATE_KEY/);
      return true;
    },
  );
});
