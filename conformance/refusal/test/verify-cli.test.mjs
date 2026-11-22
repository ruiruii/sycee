import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../../../bin/sycee-verify.mjs', import.meta.url).pathname;

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const KEY = 'ed25519:MCowBQYDK2VwAyEAAj0cLopNEZIo4WTNp5tl9APja1mO9jTrvo8_OglWHoI';
const AID = `sha256:${'3f1c'.repeat(16)}`;

function tmp(name, value) {
  const dir = mkdtempSync(join(tmpdir(), 'sycee-verify-'));
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 1));
  return path;
}

/* ------------------------------------------------------------------ *
 * what the tool is for: an answer, not a lecture
 * ------------------------------------------------------------------ */

test('a receipt the constructor could have produced passes, and says what it claims', () => {
  const f = tmp('ok.json', {
    signing_public_key: KEY,
    attempt_identity: AID,
    decision: 'refused',
    reason: 'duplicate_payment',
    settlement: 'settled',
  });
  const r = run(['--no-color', f]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /PASS/);
  assert.match(r.out, /duplicate_payment · settled · final · chain_verifiable/);
  assert.match(r.out, /1\/1 passed/);
});

test('a receipt that contradicts its own reason fails, with the code the vectors use', () => {
  const f = tmp('bad.json', {
    signing_public_key: KEY,
    attempt_identity: AID,
    decision: 'refused',
    reason: 'transfer_leg_failed',
    settlement: 'unknown',
    legs: { authorization: 'executed', transfer: 'unknown' },
  });
  const r = run(['--no-color', f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL/);
  assert.match(r.out, /leg_contradicts_reason/);
});

/* ------------------------------------------------------------------ *
 * a built row, not just an input
 * ------------------------------------------------------------------ */

test('a row that cannot be reconstructed from what it states is reported, not accepted', () => {
  const row = {
    schema_version: 'sycee/refusal/v0.2',
    decision: 'refused',
    reason: 'wrong_amount',
    attempt_identity: AID,
    resource_id: 'r',
    protocol: 'x402',
    settlement: 'not_submitted',
    final: true,
    observed_at: '2026-11-21T00:00:00.000Z',
    signer: { public_key: KEY, role: 'merchant' },
    key_check: 'not_measured',
    // the constructor would not give this row an evidence class above its
    // reason's reproducible ceiling, so this row could not have been built
    evidence_class: 'independently_witnessed',
  };
  const f = tmp('row.json', row);
  const r = run(['--no-color', f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL/);
});

test('a row that reconstructs exactly passes, and the summary comes from its own fields', () => {
  // build one the way a merchant would, then hand the tool the row rather than
  // the input: that is the path a reader of someone else's receipt takes.
  const built = JSON.parse(
    spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import * as c from '@sycee/core';
       const r = c.refusalRow({decision:'refused',reason:'wrong_amount',settlement:'not_submitted',
         attemptIdentity:'${AID}',signingPublicKey:'${KEY}',resourceId:'r',protocol:'x402',
         observedAt:'2026-11-21T00:00:00.000Z'});
       process.stdout.write(JSON.stringify(r));`,
    ], { encoding: 'utf8', cwd: new URL('../../../', import.meta.url).pathname }).stdout,
  );
  const f = tmp('built-row.json', built);
  const r = run(['--no-color', f]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /PASS/);
  assert.match(r.out, /client_verifiable/);
});

/* ------------------------------------------------------------------ *
 * a conformance vector states what it expects
 * ------------------------------------------------------------------ */

test('a vector that expects a rejection passes when the rejection is the one it names', () => {
  const f = tmp('vec.json', {
    id: 'reject-something',
    input: {
      signing_public_key: KEY,
      attempt_identity: AID,
      decision: 'refused',
      reason: 'transfer_leg_failed',
      settlement: 'unknown',
      legs: { authorization: 'executed', transfer: 'unknown' },
    },
    expected: { outcome: 'REJECT', code: 'leg_contradicts_reason' },
  });
  const r = run(['--no-color', f]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /rejected as leg_contradicts_reason/);
});

test('a vector whose stated rejection is not the one that happens fails', () => {
  const f = tmp('vec-bad.json', {
    id: 'reject-something-else',
    input: {
      signing_public_key: KEY,
      attempt_identity: AID,
      decision: 'refused',
      reason: 'transfer_leg_failed',
      settlement: 'unknown',
      legs: { authorization: 'executed', transfer: 'unknown' },
    },
    expected: { outcome: 'REJECT', code: 'finality_pending_is_not_final' },
  });
  const r = run(['--no-color', f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /a_different_rejection/);
});

/* ------------------------------------------------------------------ *
 * the housekeeping a command-line tool owes its caller
 * ------------------------------------------------------------------ */

test('--example needs no files and shows three receipts without failing the shell', () => {
  const r = run(['--no-color', '--example']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /1\/3 passed/);
});

test('--json is parseable and carries the same verdict', () => {
  const f = tmp('j.json', {
    signing_public_key: KEY,
    attempt_identity: AID,
    decision: 'accepted',
    settlement: 'settled',
  });
  const r = run(['--json', f]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].code, null);
  assert.equal(parsed[0].summary.decision, 'accepted');
});

test('an unknown option exits 2 rather than guessing', () => {
  const r = run(['--nope']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option/);
});

test('a file that is not JSON is reported, not thrown', () => {
  const f = tmp('broken.json', '{ not json');
  const r = run(['--no-color', f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unreadable/);
});
