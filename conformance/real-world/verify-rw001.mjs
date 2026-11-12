#!/usr/bin/env node
/**
 * RW-001 independent verification — x402-receipts origin (Base mainnet USDC).
 *
 * Zero dependencies. Node >= 18 (uses global fetch).
 *
 *   node conformance/real-world/verify-rw001.mjs
 *
 * The point of this script is that RW-001 must be reproducible WITHOUT trusting
 * the contributor. Every assertion below is re-run from public endpoints and
 * from a public Base RPC. It prints a transcript; it does not assert quietly.
 *
 * Note: needs unrestricted outbound network. Some sandboxed networks answer DNS
 * for unknown hosts with placeholder addresses, in which case every fetch times
 * out — that is an environment problem, not a result.
 *
 * No external dependencies: it imports only workspace-internal `@sycee/*`
 * packages, so it runs from a clean checkout after `npm install`.
 */

import {
  EMPTY_DATA_HASH,
  contentBindingRatio,
  deriveRedeemCount,
} from '@sycee/adapter-automaton';

const ORIGIN = 'https://api.automaton-sovereign.workers.dev';
const RPC = 'https://mainnet.base.org';

/**
 * The request fingerprint of the logical request this payment settled.
 *
 * The origin does not publish it, and this harness cannot derive it: the
 * fingerprint is computed from the HTTP request (method + url + canonical
 * params), and this script never makes a paid request — spend is deliberately
 * gated off. So the binding half cannot be tested end-to-end until the origin
 * publishes the fingerprint for this payment (or for any payment).
 *
 * Supply it via `--fingerprint <sha256:...>` or `SYCEE_RW001_FINGERPRINT`.
 * Once it is set in CI, the red half turns green by itself on the next run.
 * `GATES_RW001_FINGERPRINT` is still read so an environment set before the
 * rename keeps working. It is the previous variable name, not the project name.
 */
const FINGERPRINT =
  process.env.SYCEE_RW001_FINGERPRINT?.trim() ||
  process.env.GATES_RW001_FINGERPRINT?.trim() ||
  (() => {
    const i = process.argv.indexOf('--fingerprint');
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1].trim() : null;
  })() ||
  null;

const TX = '0x3bf944626e3429c7acf1bbc135d82cd73d8e74fec2de4dd03e93a269993d62d8';
const EXPECTED = {
  block: 51984731,
  payer: '0x20e0f41f8b2cea0b2ec015b97dfd11b3c743b8d9',
  payee: '0x71deac098914a009e3720524642a6be6f65ee528',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  valueBaseUnits: 20000,
  index: 20,
  indexHash: 'c71f0e2fd7d26c43a681b844af9634d5244019ff3320a71c587be9f0af5a30b7',
  indexTs: '2026-09-30T12:21:40.058Z',
  currentKeyId: '6db8674197d1601f',
  retiredKeyId: '7e32754cf3911ccf',
  retiredIndex: 0,
  retiredIndexHash: '78941ded6efa4fa1442a5b5f05e98da1142e4ee418bd49dbb318998b3415be87',
  retiredIndexTs: '2026-09-25T14:34:35.659Z',
};

const { createHash, createPublicKey, verify } = await import('node:crypto');
const { readFile } = await import('node:fs/promises');

let failures = 0;
const asNum = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));
function check(label, actual, expected) {
  // Coerce numeric-looking values (e.g. an API returning "20000" vs our 20000)
  // so a string/number mismatch does not masquerade as a real payment discrepancy.
  const a = asNum(actual), e = asNum(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

console.log('\n=== 1. On-chain payment (public Base RPC — no trust in the contributor) ===');
{
  const rpc = async (method, params) => {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await r.json()).result;
  };
  const tx = await rpc('eth_getTransactionByHash', [TX]);
  const body = tx.input.slice(10);
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  check('block', parseInt(tx.blockNumber, 16), EXPECTED.block);
  check('asset (tx to)', tx.to.toLowerCase(), EXPECTED.asset);
  check('payer (calldata word 0)', '0x' + word(0).slice(-40), EXPECTED.payer);
  check('payee (calldata word 1)', '0x' + word(1).slice(-40), EXPECTED.payee);
  check('value (calldata word 2, base units)', parseInt(word(2), 16), EXPECTED.valueBaseUnits);
  check('scheme (selector)', tx.input.slice(0, 10), '0xe3ee160e'); // EIP-3009 transferWithAuthorization
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  console.log(`  [INFO] confirmations: ${head - EXPECTED.block}`);
}

console.log('\n=== 2. Keyring ===');
const pub = await getJSON(`${ORIGIN}/v2/pubkey`);
check('current keyId', pub.keyId, EXPECTED.currentKeyId);
check('algorithm', pub.algorithm, 'ECDSA-P256-SHA256');
const retired = (pub.history ?? []).find((h) => h.keyId === EXPECTED.retiredKeyId);
console.log(`  [${retired ? 'PASS' : 'FAIL'}] retired key ${EXPECTED.retiredKeyId} published in history`);
if (!retired) failures++;

console.log('\n=== 3. Ledger: page through every entry, recompute each hash + link ===');
// Page from 0 with increasing `from`; do not assume the window starts at 0 once
// `total` exceeds the per-page limit (tip from the contributor: the old
// contiguity assert would rot the moment the ledger outgrew one window).
const PAGE = 50;
const entries = [];
let from = 0;
let total = null;
while (true) {
  const led = await getJSON(`${ORIGIN}/v2/ledger?from=${from}&limit=${PAGE}`);
  if (total === null) total = led.total;
  const batch = led.entries ?? [];
  entries.push(...batch);
  if (batch.length < PAGE) break;
  from += batch.length;
}
entries.sort((a, b) => a.index - b.index);
console.log(`  [INFO] entries fetched: ${entries.length} (reported total: ${total})`);
let matched = 0;
const mismatched = [];
const brokenLinks = [];
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const h = createHash('sha256').update(`${e.prevHash}|${e.timestamp}|${e.dataHash}`).digest('hex');
  if (h === e.hash) matched++;
  else mismatched.push(e.index);
  // Independent link check: entry N's prevHash must equal entry N-1's hash.
  // The contributor asserted the hash formula; they did not assert the links.
  if (i > 0 && e.prevHash !== entries[i - 1].hash) brokenLinks.push(e.index);
}
check('hash recomputation matches', `${matched}/${entries.length}`, `${entries.length}/${entries.length}`);
if (mismatched.length) console.log(`  [INFO] mismatched indices: ${mismatched.join(', ')}`);
check('contiguous 0..N with no gaps', entries.every((e, i) => e.index === i), true);
check('prevHash links every entry to its predecessor', brokenLinks.length === 0, true);
if (brokenLinks.length) console.log(`  [INFO] broken links at indices: ${brokenLinks.join(', ')}`);

// --- RED HALF: the gap between evidence of signing and evidence of spend ---
// This is the half the contributor himself showed is currently unfilled. It is
// reported, not asserted as pass/fail: today it SHOULD read "empty / unbound"
// until his origin binds a settlement to an entry. That is the point of RW-001
// as a known-gap vector: the chain reproduces, the settlement link does not yet.
console.log('\n=== 3b. Known gap (RED half) — reported, expected to fail today ===');

// --- 3b.1 content binding ratio -------------------------------------------
// How many entries bind *anything* at all. Independent of SYCEE: an entry
// whose dataHash is sha256("{}") is an attestation that signs an empty object.
const binding = contentBindingRatio(entries);
console.log(`  [GAP] entries whose dataHash is sha256("{}") (no payload): ` +
  `${binding.empty}/${binding.total} (bound: ${binding.bound}, ratio ${binding.ratio.toFixed(3)})` +
  (binding.emptyIndices.length
    ? ` (indices ${binding.emptyIndices[0]}..${binding.emptyIndices[binding.emptyIndices.length - 1]})`
    : ''));
if (binding.empty > 0) {
  console.log(`  [INFO] ${binding.empty} entries attest "we signed something", not "we signed something about this".`);
}

// --- 3b.2 gates-subject binding -------------------------------------------
// Does any entry carry a dataHash that a SYCEE subject would produce for
// this payment? Uses the adapter, so the assertion is the same code the origin
// would call — not a re-implementation of it.
if (!FINGERPRINT) {
  console.log('  [PENDING] no request fingerprint published for this payment — binding cannot be tested yet.');
  console.log('            Supply --fingerprint <sha256:...> or SYCEE_RW001_FINGERPRINT to enable this half.');
  console.log('            The harness cannot derive it: it never makes a paid request (spend is gated off).');
} else {
  const attempts = [{ txHash: TX, resourceId: 'search.v1', settled: true }];
  const derived = deriveRedeemCount(entries, { fingerprint: FINGERPRINT, attempts });
  const expected = deriveRedeemCount(
    [{ index: -1, dataHash: EMPTY_DATA_HASH }],
    { fingerprint: FINGERPRINT, attempts },
  );
  // Guard against a fingerprint that produces no candidate hashes at all.
  if (derived.forms.length === 0 || expected.forms.length === 0) {
    console.log('  [FAIL] fingerprint produced no candidate dataHash — check the value');
    failures++;
  } else {
    const ok = derived.boundToFingerprint;
    if (!ok) failures++;
    console.log(`  [${ok ? 'PASS' : 'GAP'}] entries binding this logical request via a gates subject: ${derived.redeemCount}`);
    for (const m of derived.matched) {
      console.log(`            index ${m.index} — ${m.kind} (tx ${m.txHash.slice(0, 12)}…)`);
    }
    if (!ok) {
      console.log('  [INFO] RW-001 is a KNOWN-GAP vector: chain reproduces; settlement link does not yet.');
    }
  }
}
console.log('  [INFO] RED half is reported, not asserted — it SHOULD read unbound until the origin binds a subject.');

/** signature is ECDSA-P256-SHA256 (DER) over the ASCII hex string of `hash` */
const verifyEntry = (e, pem) =>
  verify('sha256', Buffer.from(e.hash, 'ascii'),
    { key: createPublicKey(pem), dsaEncoding: 'der' },
    Buffer.from(e.signature, 'base64'));

console.log('\n=== 4. Attestation for the payment (index 20, current key) ===');
const e20 = entries.find((e) => e.index === EXPECTED.index);
check('index 20 present', Boolean(e20), true);
if (e20) {
  check('index 20 hash', e20.hash, EXPECTED.indexHash);
  check('index 20 timestamp', e20.timestamp, EXPECTED.indexTs);
  check('index 20 keyId', e20.keyId, EXPECTED.currentKeyId);
  check('index 20 signature verifies (current key)', verifyEntry(e20, pub.publicKey), true);
}
const v20 = await getJSON(`${ORIGIN}/v2/verify?index=20`);
check('index 20 signedBy', v20.signedBy, 'current');
check('index 20 chainIntact', v20.chainIntact, true);

console.log('\n=== VECTOR: invalid-verify-current-key-only (negative / verifier-behavior) ===');
// Loaded from a vector descriptor so the expectations are data, not inline
// literals. A verifier that resolves the signing key as "the current key only"
// (ignoring published key history) is non-conformant per SPEC §7.4 and produces
// a false negative the moment a signer rotates a key. RW-001 entry 0 — signed by
// a retired key that is still published in /v2/pubkey `history` — is the concrete
// instance of that failure mode.
const VEC = JSON.parse(
  await readFile(new URL('./vectors/invalid-verify-current-key-only.json', import.meta.url), 'utf8')
);
console.log(`  [INFO] ${VEC.summary}`);
console.log(`  [INFO] guards: ${VEC.guards}`);
const e0 = entries.find((e) => e.index === VEC.inputs.entryIndex);
check('entry 0 present', Boolean(e0), true);
check('entry 0 keyId is the retired key', e0?.keyId, VEC.inputs.expectedKeyId);
check('precondition: retired key published in history', Boolean(retired), VEC.expected.retiredKeyPublishedInHistory);
if (e0 && retired) {
  // Conformant resolver: resolve by key_id against current + history.
  check('history-aware resolver verifies entry 0 (conformant, §7.3/§7.4)',
    verifyEntry(e0, retired.publicKey), VEC.expected.historyAwareResolverVerifies);
  // Non-conformant resolver: current-key-only. It MUST reject a validly-signed
  // historical entry — that rejection is the false negative the vector guards
  // against. Reported as [DEMO] (expected behaviour), not as a [FAIL] gate.
  const ckoRejects = verifyEntry(e0, pub.publicKey) === false;
  console.log(`  [DEMO] current-key-only resolver rejects valid entry 0 = ${ckoRejects}` +
    ` — this false negative is the exact failure mode "${VEC.id}" names; a conformant` +
    ` verifier MUST resolve by key_id against current + history`);
}
const v0 = await getJSON(`${ORIGIN}/v2/verify?index=0`);
check('entry 0 signedBy', v0.signedBy, VEC.expected.signedBy);

console.log('\n=== 6. Their own payment-check endpoint ===');
const vp = await getJSON(`${ORIGIN}/v1/verify-payment?txHash=${TX}`);
check('/v1/verify-payment ok', vp.ok, true);
check('/v1/verify-payment blockNumber', vp.blockNumber, EXPECTED.block);
check('/v1/verify-payment valueBaseUnits', vp.valueBaseUnits, EXPECTED.valueBaseUnits);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
