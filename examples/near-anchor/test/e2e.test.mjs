import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, NEAR_NETWORK: 'sandbox' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('default e2e is a simulated payment anchored on a local sandbox', async () => {
  const result = await run('scripts/e2e.mjs');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^payment: SIMULATED$/m);
  assert.match(result.stdout, /no Base Sepolia transfer, no funds moved/);
  assert.match(result.stdout, /^http_status: 200$/m);
  assert.match(result.stdout, /^receipt_hash: sha256:[0-9a-f]{64}$/m);
  assert.match(result.stdout, /^chain: local NEAR sandbox$/m);
  assert.match(result.stdout, /^verify: ok true$/m);
  assert.match(result.stdout, /^nearblocks: n\/a$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /ed25519:/);
});
