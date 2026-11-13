import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { cwd: root, env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

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
});
