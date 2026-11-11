#!/usr/bin/env node
/**
 * The refusal half, on one screen.
 *
 *   node examples/refusal-walkthrough.mjs
 *
 * A server refuses four payment attempts for four different reasons and accepts
 * one. Every decision lands on one ledger, every refusal is handed to the buyer
 * as a signed claim, and the last section checks each claim offline — including
 * the two things a claim must never be able to do: overclaim its evidence, or
 * present an unsettled payment as final.
 *
 * No network, no wallet, no accounts.
 */

import http from 'node:http';
import { createGates, memoryStore } from '@sycee/middleware';
import {
  generateKeyPair, verifyClaim, ceilingFor, sha256, canonicalJSON,
  refusalRow, signRefusal, exportClaim, attemptIdentity,
} from '@sycee/core';

const merchantKeys = generateKeyPair();
const PAY_TO = '0x1234567890abcdef1234567890abcdef12345678';

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = (s) => line(`\n${'─'.repeat(4)} ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);

// A verifier stand-in. In a real deployment this is the facilitator call.
const VERDICTS = new Map([
  ['proof-good', { ok: true, settlement: 'settled' }],
  ['proof-broke', { ok: false, reason: 'insufficient_funds' }],
  ['proof-expired', { ok: false, reason: 'authorization_expired' }],
  ['proof-cheap', { ok: false, reason: 'wrong_amount' }],
  ['proof-nope', { ok: false, reason: 'commercial_refusal' }],
]);

// The payee address and the signing key are deliberately different values; the
// middleware checks that they are, and refuses to record if they are not.
const gates = createGates({
  resourceId: 'search.v1',
  protocol: 'x402',
  price: { value: '0.010000', currency: 'USDC' },
  publicKey: merchantKeys.publicKey,
  privateKey: merchantKeys.privateKey,
  payTo: PAY_TO,
  store: memoryStore(),
  replayPolicy: 'refuse',
  attachReceipt: true,
  verifyPayment: async (proof) => VERDICTS.get(proof) ?? { ok: false, reason: 'unknown_proof' },
});

const server = http.createServer(async (req, res) => {
  if (req.url !== '/paid') {
    res.statusCode = 404;
    return res.end('not found');
  }
  const guard = gates.guard(async () => ({ status: 200, body: { page: 1, hits: 3 } }));
  await guard(req, res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

async function attempt(proof) {
  const r = await fetch(`${origin}/paid`, { headers: { 'payment-signature': proof } });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // a delivered body is JSON too in this demo, but never assume it
  }
  return { status: r.status, body, headers: r.headers };
}

try {
  rule('1. five attempts, one ledger');
  line('   proof            status  what the server said');
  const runs = [];
  for (const proof of ['proof-good', 'proof-broke', 'proof-expired', 'proof-cheap', 'proof-nope']) {
    const r = await attempt(proof);
    runs.push({ proof, ...r });
    const said = r.status === 200 ? 'served' : (r.body?.refusal_reason ?? r.body?.error ?? '?');
    line(`   ${proof.padEnd(16)} ${String(r.status).padEnd(7)} ${said}`);
  }

  rule('2. the ledger holds both outcomes');
  const tally = gates.tally();
  line(`   total=${tally.total}  accepted=${tally.accepted}  refused=${tally.refused}`);
  line(`   accepted + refused = ${tally.accepted + tally.refused} ${tally.accepted + tally.refused === tally.total ? '(adds up)' : '(MISMATCH)'}`);
  for (const row of gates.ledger()) {
    const reason = row.decision === 'accepted' ? '—' : `${row.reason} / ${row.evidence_class}`;
    line(`   ${row.decision.padEnd(9)} attempt=${row.attempt_identity.slice(7, 15)}…  ${reason}`);
  }

  rule('3. what a buyer can check itself, and what it cannot');
  const weak = gates.unverifiable();
  line(`   checks made without trusting the seller:  ${tally.refused - weak.length} of ${tally.refused}`);
  line(`   left as the seller's word only:           ${weak.length} (${weak.map((r) => r.reason).join(', ') || 'none'})`);
  for (const reason of ['insufficient_funds', 'commercial_refusal', 'not_a_known_reason']) {
    line(`   ceiling(${reason.padEnd(20)}) = ${ceilingFor(reason)}`);
  }

  rule('4. the claim the buyer holds, verified offline');
  const refused = runs.filter((r) => r.status === 402 && r.body?.refusal_receipt);
  line(`   ${refused.length} refusals came back with a signed claim`);
  for (const r of refused) {
    const claim = r.body.refusal_receipt;
    const v = verifyClaim(claim, { payTo: PAY_TO });
    line(
      `   ${r.proof.padEnd(16)} valid=${String(v.valid).padEnd(5)} ` +
        `reason=${claim.refusal.reason.padEnd(22)} class=${claim.refusal.evidence_class}` +
        `${v.notMeasured.length ? `  notMeasured=${v.notMeasured.join(',')}` : ''}`,
    );
  }

  rule('5. two things a claim is not allowed to do');
  // the smallest claim a buyer can check itself: insufficient_funds is
  // ledger-checkable, commercial_refusal is not, so this is the pair to bend.
  const sample = refused.find((r) => r.body.refusal_receipt.refusal.reason === 'insufficient_funds')
    .body.refusal_receipt;

  // building the forged claim from scratch is required: exportClaim recomputes
  // claim_id from the body, so a claim that was merely edited would also trip
  // the id check, and the reader would not see the reason check do its work.
  const forged = {
    type: 'x402-refusal-claim',
    version: 1,
    // insufficient_funds tops out at chain_verifiable; ask for the strongest
    // class the format has, which no reason in this demo can support.
    refusal: { ...sample.refusal, evidence_class: 'independently_witnessed' },
    signature: sample.signature,
  };
  const upgraded = { ...forged, claim_id: sha256(canonicalJSON(forged)), issued_at: sample.issued_at };
  const overclaim = verifyClaim(upgraded, { payTo: PAY_TO });
  line(`   a claim that elevates its own evidence class: valid=${overclaim.valid}`);
  line(`      caught by: ${overclaim.errors.map((e) => e.split(':')[0]).join(', ')}`);
  line('      the signature check fires first; the class check is the second line of defence,');
  line('      for a claim whose issuer signed the overstatement rather than a buyer editing it after.');

  // A refusal recorded while the earlier attempt is still in flight cannot be
  // final. Build that row directly: in this demo the first attempt settles
  // before the replay arrives, so the wire path never produces one.
  const inFlight = signRefusal(
    refusalRow({
      decision: 'refused',
      reason: 'replay_in_flight',
      attemptIdentity: attemptIdentity({ payload: 'proof-in-flight', requirements: 'req', presentation: 2 }),
      signingPublicKey: merchantKeys.publicKey,
      payTo: PAY_TO,
      settlement: 'pending',
    }),
    merchantKeys.privateKey,
  );
  line(`   an in-flight refusal is recorded with final=${inFlight.refusal.final}`);
  const claimPending = exportClaim(inFlight);
  const forgedFinal = {
    type: 'x402-refusal-claim',
    version: 1,
    refusal: { ...claimPending.refusal, final: true },
    signature: claimPending.signature,
  };
  const finalCheck = verifyClaim(
    { ...forgedFinal, claim_id: sha256(canonicalJSON(forgedFinal)), issued_at: claimPending.issued_at },
    { payTo: PAY_TO },
  );
  line(`   the same claim re-labelled final: valid=${finalCheck.valid}`);
  line(`      ${finalCheck.errors.at(-1) ?? '(no error — this would be a bug)'}`);

  rule('6. why the same proof used twice is two attempts');
  const again = await attempt('proof-good');
  line(`   second presentation of proof-good: status ${again.status}`);
  line(`   reason: ${again.body?.refusal_reason ?? '(served)'}`);
  line(`   the first attempt settled, so this refusal is final: ${gates.refusals().at(-1)?.final}`);
  const rows = gates.ledger().filter((r) => r.proof_hash);
  const distinct = new Set(rows.map((r) => r.attempt_identity)).size;
  line(`   rows=${rows.length}  distinct attempt identities=${distinct}`);

  line('');
  line('A refusal that leaves nothing behind cannot be reconciled. This one leaves');
  line('a row the seller cannot quietly drop, and a claim the buyer can carry away.');
} finally {
  await new Promise((r) => server.close(r));
}
