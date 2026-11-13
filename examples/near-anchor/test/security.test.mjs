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

test('a function-call key can anchor and cannot move NEAR', async () => {
  const result = await run('scripts/security.mjs');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^key: function-call$/m);
  assert.match(result.stdout, /^methods: anchor,anchor_batch$/m);
  assert.match(result.stdout, /^deposit: not allowed$/m);
  assert.match(result.stdout, /^receipt_hash: sha256:[0-9a-f]{64}$/m);
  assert.match(result.stdout, /^public_key: ed25519:/m);
  assert.match(result.stdout, /^anchor_with_limited_key: ok$/m);
  assert.match(result.stdout, /^transfer NEAR: rejected \(/m);
  assert.match(result.stdout, /^add key: rejected \(/m);
  assert.match(result.stdout, /^call add_anchorer: rejected \(/m);
  assert.match(result.stdout, /^attached deposit: rejected \((?!\{\})/m);
  assert.match(result.stdout, /^duplicate anchor: rejected \(/m);
  assert.doesNotMatch(result.stdout, /rejected \(\{\}\)/);
  assert.match(result.stdout, /^payment: SIMULATED$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /private_key/);
});
