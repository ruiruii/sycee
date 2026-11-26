#!/usr/bin/env node
/**
 * sycee-verify — check a refusal receipt without reading the specification.
 *
 * The check is one thing: re-run the constructor on what the row claims. If the
 * constructor refuses, the row could not have been produced by anything
 * conforming, and its code names which rule it broke. There is no second set of
 * rules in this file — if the answer here is wrong, the constructor is wrong,
 * and the conformance vectors are the place that gets fixed.
 *
 * Exit codes: 0 all pass, 1 at least one failure, 2 usage error.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusalRow, verifyClaim, REFUSAL_SCHEMA_VERSION } from '@sycee/core';

// The full vector set ships inside this package. A reader deciding whether to
// trust us should not have to clone a repository first — the cost of checking
// a claim is the cost of making it.
const BUILTIN_VECTORS = fileURLToPath(new URL('../vectors/', import.meta.url));

const USAGE = `sycee-verify — check a refusal receipt

usage
  sycee-verify <file.json>...
  sycee-verify --dir <directory>
  sycee-verify --conformance
  sycee-verify --example

options
  --json                 machine-readable output
  --quiet                print failures only
  --pay-to <address>     pin the payee; a row signed by it is reported, not failed
  --signing-key <key>    pin the signer; a row signed by another key fails
  --no-color             plain text
  --conformance          run the 76 bundled vectors, no files needed
  --example              run three built-in receipts, no files needed

A receipt is checked by reconstructing it from its own claims. The receipt
that cannot be reconstructed is the one that lies, and the code is the rule
it broke.`;

const args = process.argv.slice(2);
const opts = { json: false, quiet: false, example: false, color: true, payTo: null, signingKey: null };
const files = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') opts.json = true;
  else if (a === '--quiet') opts.quiet = true;
  else if (a === '--example') opts.example = true;
  else if (a === '--conformance') {
    for (const name of readdirSync(BUILTIN_VECTORS).sort()) {
      if (extname(name) === '.json') files.push(join(BUILTIN_VECTORS, name));
    }
  }
  else if (a === '--no-color') opts.color = false;
  else if (a === '--pay-to') opts.payTo = args[++i];
  else if (a === '--signing-key') opts.signingKey = args[++i];
  else if (a === '--dir') {
    const dir = args[++i];
    if (!dir) fail('--dir needs a directory');
    for (const name of readdirSync(dir).sort()) {
      if (extname(name) === '.json') files.push(join(dir, name));
    }
  } else if (a === '-h' || a === '--help') {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  } else if (a.startsWith('-')) {
    fail(`unknown option ${a}`);
  } else {
    files.push(a);
  }
}

function fail(message) {
  process.stderr.write(`sycee-verify: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * Colour, only when someone is watching
 * ------------------------------------------------------------------ */

const useColor = opts.color && process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const dim = paint('2');
const bold = paint('1');

/* ------------------------------------------------------------------ *
 * One receipt
 * ------------------------------------------------------------------ */

/** The row, whichever of the four shapes the file uses. */
function rowOf(doc) {
  if (doc?.type === 'x402-refusal-claim' && doc.refusal) return { row: doc.refusal, claim: doc };
  if (doc?.refusal && typeof doc.refusal === 'object') return { row: doc.refusal, envelope: doc };
  if (doc?.schema_version === REFUSAL_SCHEMA_VERSION) return { row: doc };
  // A constructor input, not a row: the constructor answers directly.
  return { row: null, input: doc };
}

/**
 * Turn a built row back into the input that would have produced it.
 *
 * Everything the row states is fed back in, including the fields that could be
 * over-claimed. That is the point: a row whose evidence class is above its
 * reason's ceiling fails here, because the constructor refuses to build it.
 */
function inputFromRow(row) {
  const input = {
    decision: row.decision,
    attemptIdentity: row.attempt_identity,
    settlement: row.settlement,
    final: row.final,
    signingPublicKey: row.signer?.public_key,
    resourceId: row.resource_id,
    protocol: row.protocol,
    observedAt: row.observed_at,
  };
  if (row.decision === 'refused') {
    input.reason = row.reason;
    input.evidenceClass = row.evidence_class;
  }
  if (row.legs !== undefined) input.legs = row.legs;
  if (row.proof_hash) input.proofHash = row.proof_hash;
  if (row.amount) input.amount = row.amount;
  if (row.signer?.agent_id) input.agentId = row.signer.agent_id;
  if (row.signer?.role) input.role = row.signer.role;
  return input;
}

/** Fields a reconstructed row must reproduce exactly. */
const IDENTITY_FIELDS = [
  'decision', 'reason', 'attempt_identity', 'settlement', 'final',
  'evidence_class', 'resource_id', 'protocol',
];

/**
 * Accept the wire spelling as well as the in-process one. A receipt copied out
 * of an issue is written with underscores; nobody should have to rename keys to
 * ask whether it holds together.
 */
function inputFromDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const pick = (...names) => {
    for (const n of names) if (doc[n] !== undefined) return doc[n];
    return undefined;
  };
  return {
    decision: doc.decision,
    reason: doc.reason,
    attemptIdentity: pick('attemptIdentity', 'attempt_identity'),
    settlement: doc.settlement,
    final: doc.final,
    signingPublicKey: pick('signingPublicKey', 'signing_public_key'),
    evidenceClass: pick('evidenceClass', 'evidence_class'),
    legs: doc.legs,
    resourceId: pick('resourceId', 'resource_id'),
    protocol: doc.protocol,
    observedAt: pick('observedAt', 'observed_at'),
    proofHash: pick('proofHash', 'proof_hash'),
    amount: doc.amount,
    agentId: pick('agentId', 'agent_id'),
    role: doc.role,
  };
}

function check(doc) {
  // A conformance vector states what it expects. Checking it means checking
  // that statement, not pretending a deliberate rejection is a failure.
  if (doc && doc.input && doc.expected) {
    const inner = check(doc.input);
    const want = doc.expected?.outcome;
    const label = `vector ${doc.id ?? '(no id)'}`;
    if (want === 'REJECT') {
      if (inner.code === doc.expected.code) {
        return { ...inner, against: label, code: null, detail: null, note: `rejected as ${doc.expected.code}, which is what the file states`, signature: 'absent' };
      }
      return {
        ...inner,
        against: label,
        code: inner.code ? 'a_different_rejection' : 'expected_a_rejection',
        detail: inner.code
          ? `the file states ${doc.expected.code}, the constructor says ${inner.code}`
          : `the file states a rejection (${doc.expected.code}); the constructor accepted`,
      };
    }
    if (inner.code) {
      return { ...inner, against: label, code: 'expected_an_accept', detail: `the file states an accept; the constructor says ${inner.code} — ${inner.detail}` };
    }
    return { ...inner, against: label, note: 'accepted, which is what the file states' };
  }

  const { row: found, claim } = rowOf(doc);
  const result = { file: null, against: null, code: null, detail: null, signature: 'absent', summary: null, note: null };

  let input;
  if (found) {
    result.against = REFUSAL_SCHEMA_VERSION;
    input = inputFromRow(found);
  } else {
    result.against = 'constructor input';
    input = inputFromDoc(doc);
  }

  let built;
  try {
    built = refusalRow(input);
  } catch (err) {
    // `refusalRow: code — detail` is the constructor's one error shape.
    const message = String(err?.message ?? err);
    const m = /^refusalRow: ([a-z_]+) — ([\s\S]*)$/.exec(message);
    result.code = m ? m[1] : 'threw';
    result.detail = m ? m[2] : message;
    result.summary = summarize(input);
    return result;
  }

  result.summary = summarize(built);

  // Only meaningful when the file claims to be a row: an input has no previous
  // statement to disagree with.
  if (found) {
    const drift = IDENTITY_FIELDS.filter((f) => built[f] !== found[f]);
    if (drift.length) {
      result.code = 'row_does_not_reconstruct';
      result.detail = drift
        .map((f) => `${f}: row says ${JSON.stringify(found[f])}, the constructor says ${JSON.stringify(built[f])}`)
        .join('; ');
      return result;
    }
    if (found.schema_version !== REFUSAL_SCHEMA_VERSION) {
      result.code = 'wrong_schema_version';
      result.detail = `expected ${REFUSAL_SCHEMA_VERSION}, got ${String(found.schema_version)}`;
      return result;
    }
  }

  if (claim || doc?.refusal) {
    const c = verifyClaim(claim ?? doc, { payTo: opts.payTo ?? undefined, signingPublicKey: opts.signingKey ?? undefined });
    result.signature = c.checks.signature ? 'verified' : 'failed';
    if (!c.valid) {
      result.code = 'claim_invalid';
      result.detail = c.errors.join('; ');
      return result;
    }
    if (c.notMeasured.length) result.summary.notMeasured = c.notMeasured;
  } else if (opts.signingKey && built.signer.public_key !== opts.signingKey) {
    result.code = 'signer_not_the_expected_key';
    result.detail = `row is signed by ${built.signer.public_key}, not ${opts.signingKey}`;
    return result;
  }

  return result;
}

function summarize(x) {
  return {
    decision: x.decision,
    reason: x.reason ?? null,
    settlement: x.settlement,
    final: x.final,
    evidence_class: x.evidence_class ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Three receipts that need no files
 * ------------------------------------------------------------------ */

const KEY = 'ed25519:MCowBQYDK2VwAyEAAj0cLopNEZIo4WTNp5tl9APja1mO9jTrvo8_OglWHoI';
const AID = `sha256:${'3f1c'.repeat(16)}`;

const EXAMPLES = [
  {
    name: 'a repeat presentation that names the settlement it saw',
    doc: { signing_public_key: KEY, attempt_identity: AID, decision: 'refused', reason: 'duplicate_payment', settlement: 'settled' },
  },
  {
    name: 'a failed transfer whose transfer leg was never read',
    doc: { signing_public_key: KEY, attempt_identity: AID, decision: 'refused', reason: 'transfer_leg_failed', settlement: 'unknown', legs: { authorization: 'executed', transfer: 'unknown' } },
  },
  {
    name: 'a pending settlement presented as final',
    doc: { signing_public_key: KEY, attempt_identity: AID, decision: 'refused', reason: 'internal_error', settlement: 'pending', final: true, legs: { authorization: 'unknown' } },
  },
];

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

function render(r, label, width) {
  const lines = [];
  if (r.code) {
    lines.push(`${red('FAIL')}  ${label}`);
    lines.push(`      ${yellow(r.code)}`);
    lines.push(...wrap(r.detail, 72).map((l) => `      ${l}`));
    if (r.summary) lines.push(`      ${dim(oneLine(r.summary))}`);
  } else {
    const s = r.summary;
    lines.push(`${green('PASS')}  ${label}`);
    lines.push(`      ${s.decision}${s.reason ? ` · ${s.reason}` : ''} · ${s.settlement} · ${s.final ? 'final' : 'not final'}${s.evidence_class ? ` · ${s.evidence_class}` : ''}`);
    if (r.note) lines.push(`      ${dim(r.note)}`);
    if (r.signature !== 'absent') lines.push(`      ${dim(`signature ${r.signature}`)}`);
    if (s.notMeasured?.length) lines.push(`      ${yellow(`not measured: ${s.notMeasured.join(', ')}`)}`);
  }
  void width;
  return lines;
}

function oneLine(s) {
  return `${s.decision}${s.reason ? ` · ${s.reason}` : ''} · ${s.settlement} · ${s.final ? 'final' : 'not final'}`;
}

function wrap(text, width) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const results = [];

if (opts.example) {
  for (const ex of EXAMPLES) {
    const r = check(ex.doc);
    r.file = ex.name;
    results.push(r);
  }
} else {
  if (!files.length) fail('no files given');
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(f, 'utf8'));
    } catch (err) {
      results.push({ file: f, code: 'unreadable', detail: String(err.message ?? err), summary: null, signature: 'absent' });
      continue;
    }
    const r = check(doc);
    r.file = f;
    results.push(r);
  }
}

const failed = results.filter((r) => r.code);

if (opts.json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  const width = Math.max(...results.map((r) => String(r.file).length), 8);
  for (const r of results) {
    if (opts.quiet && !r.code) continue;
    process.stdout.write(`${render(r, String(r.file).padEnd(width), width).join('\n')}\n\n`);
  }
  const total = results.length;
  const ok = total - failed.length;
  const line = `${ok}/${total} passed${failed.length ? `, ${failed.length} failed` : ''}`;
  process.stdout.write(`${failed.length ? red(line) : green(line)}\n`);
  if (!failed.length && !opts.quiet) {
    process.stdout.write(`${dim('every receipt here could have been produced by the constructor, and says what it claims.')}\n`);
  }
  void bold; void basename; void statSync;
}

process.exit(failed.length && !opts.example ? 1 : 0);
