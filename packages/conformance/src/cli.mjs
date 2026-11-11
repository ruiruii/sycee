#!/usr/bin/env node
/**
 * gates-conformance CLI
 *
 *   node src/cli.mjs verify <file.json> [...]   run full conformance check
 *   node src/cli.mjs span   <file.json>         print agent.spend.* span attributes
 *   node src/cli.mjs gen-vectors                (re)generate conformance/vectors
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvelope } from './index.mjs';
import { buildVSR, generateKeyPairFromSeed, sha256, signVSR } from '@sycee/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const VECTORS = resolve(repoRoot, 'conformance/vectors');

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'verify':
    runVerify(args);
    break;
  case 'span':
    runSpan(args);
    break;
  case 'gen-vectors':
    genVectors();
    break;
  default:
    process.stdout.write(`usage: gates-conformance <verify|span|gen-vectors> [files...]\n`);
    process.exit(1);
}

function runVerify(args) {
  const useManifest = args.includes('--manifest');
  const levelArg = args.find((a) => a.startsWith('--level='));
  const level = levelArg ? levelArg.slice('--level='.length) : null;
  let files = args.filter((a) => !a.startsWith('--'));

  /** @type {Map<string, any>} */
  const expectations = new Map();
  if (useManifest || level) {
    let m;
    try {
      m = JSON.parse(readFileSync(resolve(process.cwd(), 'conformance/vectors/manifest.json'), 'utf8'));
    } catch (e) {
      process.stderr.write(`verify: cannot read manifest.json: ${e.message}\n`);
      process.exit(1);
    }
    // The manifest stores bare file names; the CLI is normally handed
    // `conformance/vectors/<name>.json`. Key on the basename on both sides, or
    // every lookup misses and every vector is reported as passing.
    for (const c of m.cases) expectations.set(basename(c.file), c);
    if (level) {
      const selected = m.cases.filter((c) => c.level === level);
      if (!selected.length) {
        const known = [...new Set(m.cases.map((c) => c.level))].join(', ');
        process.stderr.write(`verify: no vectors at level ${level} (known levels: ${known})\n`);
        process.exit(1);
      }
      files = selected.map((c) => `conformance/vectors/${basename(c.file)}`);
    }
  }
  if (!files.length) {
    process.stderr.write(`verify: no input files (level=${level ?? 'all'})\n`);
    process.exit(1);
  }

  let failed = 0;
  let uncompared = 0;
  for (const file of files) {
    const envelope = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
    const report = checkEnvelope(envelope);
    const exp = expectations.get(basename(file));
    const actualValid = report.schemaValid && report.signatureValid && report.level !== 'invalid';
    // With no manifest entry there is nothing to compare against, so fall back to
    // the envelope's own validity. Returning `true` here would make a tampered
    // vector indistinguishable from a good one whenever the lookup misses.
    const matches =
      exp
        ? report.schemaValid === exp.schemaValid &&
          report.signatureValid === exp.signatureValid &&
          report.level === exp.level
        : actualValid;
    const status = matches ? 'PASS' : 'FAIL';
    if (!matches) failed++;
    if (!exp) uncompared++;
    process.stdout.write(
      `${status}  ${file}\n` +
        `      level=${report.level} schema=${report.schemaValid} signature=${report.signatureValid}\n`,
    );
    if (exp) {
      process.stdout.write(
        `      expected level=${exp.level} schema=${exp.schemaValid} signature=${exp.signatureValid}\n`,
      );
    } else {
      process.stdout.write(`      expected level=(none in manifest)\n`);
    }
    for (const e of report.schemaErrors) process.stdout.write(`      schema:   ${e}\n`);
    for (const e of report.semanticErrors) process.stdout.write(`      semantic: ${e}\n`);
    for (const w of report.warnings) process.stdout.write(`      warning:  ${w}\n`);
  }
  if (uncompared) {
    process.stdout.write(
      `\nverify: ${uncompared}/${files.length} file(s) had no manifest entry; ` +
        `judged on envelope validity alone\n`,
    );
  }
  process.exit(failed ? 1 : 0);
}

function runSpan(files) {
  for (const file of files) {
    const envelope = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
    process.stdout.write(JSON.stringify(checkEnvelope(envelope).spanAttributes, null, 2) + '\n');
  }
}

/* ------------------------------------------------------------------ *
 * Vector generation
 * ------------------------------------------------------------------ */

function genVectors() {
  mkdirSync(VECTORS, { recursive: true });
  // Fixed timestamp: vectors must be byte-reproducible so CI can detect drift.
  const VECTOR_TS = '2026-10-09T12:00:01.800Z';
  const keys = generateKeyPairFromSeed(
    sha256('sycee/v0.1 conformance vectors').slice(7), // deterministic: reproducible vectors
  );
  const proof = 'PAYMENT-SIGNATURE:deadbeef'; // illustrative only; never stored
  const proofHash = sha256(proof);

  /** @type {Array<{name: string, build: () => any, expect: any}>} */
  const cases = [
    {
      name: 'valid-consumed-yes',
      expect: { schemaValid: true, signatureValid: true, level: 'L2', note: 'bilateral hint present' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'settled',
        redeemResources: ['search.v1'],
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'yes',
        consumedBy: ['task_4829'],
        consumedAt: '2026-10-09T12:00:05.100Z',
        requestFingerprint: sha256('GET /search {"q":"agent payments"}'),
        proofSeenAt: '2026-10-09T12:00:00.000Z',
        completeSeenAt: '2026-10-09T12:00:01.200Z',
        amount: { value: '0.010000', currency: 'USDC' },
        bytes: 4821,
        publicKey: keys.publicKey,
        agentId: 'erc8004:8453:0x9a1f',
        keyId: '2026Q4-01',
        role: 'merchant',
        completeness: 'bilateral',
      })),
    },
    {
      name: 'valid-consumed-unknown',
      expect: { schemaValid: true, signatureValid: true, level: 'L1', note: 'no downstream instrumentation' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'settled',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'unknown',
        publicKey: keys.publicKey,
        role: 'merchant',
        completeness: 'unilateral_merchant',
      })),
    },
    {
      name: 'valid-consumed-no-idle-spend',
      expect: { schemaValid: true, signatureValid: true, level: 'L2', note: 'delivered, never referenced' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'settled',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'no',
        publicKey: keys.publicKey,
        role: 'agent',
        completeness: 'bilateral',
      })),
    },
    {
      name: 'valid-redeem-count-3',
      expect: { schemaValid: true, signatureValid: true, level: 'L2', note: 'one proof, three completions' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 3,
        settlementStatus: 'settled',
        redeemResources: ['search.v1', 'fetch.v1', 'summarize.v1'],
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:09.800Z',
        consumed: 'yes',
        consumedBy: ['task_4829', 'task_4830'],
        consumedAt: '2026-10-09T12:00:12.100Z',
        publicKey: keys.publicKey,
        role: 'merchant',
        completeness: 'bilateral',
      })),
    },
    {
      // The whole point of SYCEE: the seller never sees consumption.
      // This receipt is signed by the agent runtime instead.
      name: 'valid-agent-side-bilateral',
      expect: { schemaValid: true, signatureValid: true, level: 'L2', note: 'agent attests consumption' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'settled',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'yes',
        consumedBy: ['task_4829'],
        consumedAt: '2026-10-09T12:00:05.100Z',
        publicKey: keys.publicKey,
        agentId: 'erc8004:8453:0x9a1f',
        role: 'agent',
        completeness: 'bilateral',
      })),
    },
    {
      // "Not yet observable" is not "not settled" (SPEC §5.1). The proof was
      // broadcast, confirmations are below the threshold, and the seller still
      // produced bytes. This is incomplete evidence, not a contradiction.
      name: 'valid-settlement-in-flight',
      expect: { schemaValid: true, signatureValid: true, level: 'L1', note: 'delivered before finality — incomplete, fail-closed' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'in_flight',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'unknown',
        publicKey: keys.publicKey,
        role: 'merchant',
        completeness: 'unilateral_merchant',
      })),
    },
    {
      // Settled but never fulfilled: money moved, bytes did not. A real
      // dispute case, and a warning rather than an error — the receipt is
      // coherent, the outcome is just bad.
      name: 'valid-settlement-settled-undelivered',
      expect: { schemaValid: true, signatureValid: true, level: 'L1', note: 'paid without fulfilment — dispute material' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'settled',
        deliveryStatus: 'failed',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'unknown',
        publicKey: keys.publicKey,
        role: 'merchant',
        completeness: 'unilateral_merchant',
      })),
    },
    {
      // The contradiction: the seller claims it produced bytes for a payment
      // that has no transaction at all. A verifier MUST flag this (SPEC §5.1).
      name: 'invalid-settlement-absent-delivered',
      expect: { schemaValid: true, signatureValid: true, level: 'invalid', note: 'absent settlement + delivered bytes = contradiction' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        settlementStatus: 'absent',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-10-09T12:00:01.800Z',
        consumed: 'unknown',
        publicKey: keys.publicKey,
        role: 'merchant',
        completeness: 'unilateral_merchant',
      })),
    },
    {
      name: 'invalid-missing-consumed',
      expect: { schemaValid: false, signatureValid: true, level: 'invalid', note: 'result.consumed is MUST; signature itself is valid' },
      build: () => {
        const vsr = buildVSR({
          protocol: 'x402',
          resourceId: 'search.v1',
          proofHash,
          redeemCount: 1,
          deliveredAt: VECTOR_TS,
          publicKey: keys.publicKey,
          role: 'merchant',
        });
        delete vsr.result.consumed;
        return envelope(vsr);
      },
    },
    {
      name: 'invalid-tampered-redeem-count',
      expect: { schemaValid: true, signatureValid: false, level: 'invalid', note: 'redeem_count 3 -> 1 after signing' },
      build: () => {
        const env = envelope(buildVSR({
          protocol: 'x402',
          resourceId: 'search.v1',
          proofHash,
          redeemCount: 3,
          deliveredAt: VECTOR_TS,
          publicKey: keys.publicKey,
          role: 'merchant',
        }));
        env.vsr.payment.redeem_count = 1;
        return env;
      },
    },
    {
      name: 'invalid-embedded-proof',
      expect: { schemaValid: true, signatureValid: true, level: 'invalid', note: 'raw credential hidden in _vendor — red line caught by semantic check' },
      build: () => envelope(buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        deliveredAt: VECTOR_TS,
        publicKey: keys.publicKey,
        role: 'merchant',
        extra: { _vendor: { payment_proof: proof } },
      })),
    },
    {
      name: 'invalid-unsigned-l0',
      expect: { schemaValid: false, signatureValid: false, level: 'L0', note: 'signature is required by the schema; without it, only L0 telemetry' },
      build: () => ({ vsr: buildVSR({
        protocol: 'x402',
        resourceId: 'search.v1',
        proofHash,
        redeemCount: 1,
        consumed: 'unknown',
        deliveredAt: VECTOR_TS,
        publicKey: keys.publicKey,
        role: 'merchant',
      }) }),
    },
  ];

  function envelope(vsr) {
    return signVSR(vsr, keys.privateKey);
  }

  // No timestamp: vectors must be byte-reproducible so CI can detect drift.
  const manifest = {
    version: 'sycee/v0.1',
    signer: { algorithm: 'Ed25519', public_key: keys.publicKey },
    cases: [],
  };
  for (const c of cases) {
    const doc = c.build();
    writeFileSync(resolve(VECTORS, `${c.name}.json`), JSON.stringify(doc, null, 2) + '\n');
    manifest.cases.push({ file: `${c.name}.json`, ...c.expect });
    process.stdout.write(`wrote ${c.name}.json\n`);
  }
  writeFileSync(resolve(VECTORS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`wrote manifest.json (${manifest.cases.length} cases)\n`);
}
