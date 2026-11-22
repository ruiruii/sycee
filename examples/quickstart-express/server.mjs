#!/usr/bin/env node
/**
 * SYCEE quickstart — Express merchant, five minutes to a counted paid route.
 *
 * What this file shows:
 *   1. one paid route (`GET /search`) guarded by createGates
 *   2. a `verifyPayment` hook, i.e. where your existing facilitator plugs in
 *   3. redeem_count printed per request, so "same proof used again" is visible
 *
 * What SYCEE does NOT do: it never verifies a payment and never touches money.
 * The hook below is the only place a payment is judged.
 */

import express from 'express';
import { generateKeyPair } from '@sycee/core';
import { createGates } from '@sycee/middleware';

const PORT = Number(process.env.PORT || 3000);
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://facilitator.example.com';

// Demo-only keys: regenerated on every boot, so receipts signed by a previous
// boot will not verify. Persist a real keypair in production (see README).
const { publicKey, privateKey } = generateKeyPair();

/**
 * The only place a payment is judged.
 *
 * Contract: `(proofHeaderValue, req) => Promise<{ok, tradeNo?, reason?, settlement?}>`
 *   proofHeaderValue  raw value of the `payment-signature` request header
 *   req               the Express request (method, originalUrl, headers, ...)
 *   ok                true = accept, false = refuse (a 402 is sent, refusal recorded)
 *   tradeNo           your facilitator's id for this payment, if it has one
 *   reason            on refusal, a short wire string such as 'invalid_signature'
 *   settlement        'settled' | 'in_flight' | 'absent' (or true = settled)
 */
async function verifyWithFacilitator(proof, req) {
  // Local fake implementation so the example runs with nothing else installed.
  // Set DEMO_FACILITATOR=0 to use the real call below.
  if (process.env.DEMO_FACILITATOR !== '0') {
    if (proof.startsWith('demo-')) {
      return { ok: true, tradeNo: `demo-${proof}`, settlement: 'settled' };
    }
    return { ok: false, reason: 'invalid_signature' };
  }

  // ---------------------------------------------------------------------
  // Real integration: call your existing facilitator's /verify endpoint.
  // SYCEE does not care what is inside `proof`; forward it as-is.
  // ---------------------------------------------------------------------
  const res = await fetch(`${FACILITATOR_URL}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proof,
      resource: 'search.v1',
      price: { value: '0.010000', currency: 'USDC' },
      method: req.method,
      url: req.originalUrl,
    }),
  });

  if (!res.ok) {
    // A transport failure is not proof of fraud; refuse closed but say why.
    return { ok: false, reason: 'internal_error' };
  }

  const verdict = await res.json(); // your facilitator: { ok, tradeNo?, settlement? }
  if (verdict.ok !== true) {
    return { ok: false, reason: verdict.reason ?? 'invalid_signature' };
  }
  return {
    ok: true,
    tradeNo: verdict.tradeNo,
    settlement: verdict.settlement ?? 'in_flight',
  };
}

const gates = createGates({
  resourceId: 'search.v1',
  protocol: 'x402',
  price: { value: '0.010000', currency: 'USDC' },
  // Payment terms the 402 challenge publishes and the attempt identity is
  // composed over. payTo has no default: without it the identity cannot be
  // computed and a paid request fails loudly. network/scheme default here only
  // so the example is explicit; set them to your real chain and scheme.
  payTo: '0x00000000000000000000000000000000000000bb',
  network: 'eip155:8453',
  scheme: 'exact',
  publicKey,
  privateKey,
  agentId: 'erc8004:8453:0xQUICKSTART',
  keyId: 'quickstart-01',
  // In-memory redemption store: single process, lost on restart. See README.
  attachReceipt: true,
  verifyPayment: verifyWithFacilitator,
});

const app = express();

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// The guarded handler returns { status, body }; createGates writes the response
// and adds x-gates-receipt / x-gates-redeem-count headers.
app.get(
  '/search',
  gates.guard(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const redeemCount = res.getHeader('x-gates-redeem-count');
    const proofHash = String(res.getHeader('x-gates-proof-hash') ?? '');

    console.log(
      `[search] q=${JSON.stringify(q)} proof=${proofHash.slice(0, 19)}… redeem_count=${redeemCount}`,
    );

    return {
      status: 200,
      body: {
        query: q,
        results: [
          { title: `Result for "${q}"`, url: `https://example.com/?q=${encodeURIComponent(q)}` },
        ],
      },
    };
  }),
);

app.listen(PORT, () => {
  console.log(`SYCEE quickstart listening on http://localhost:${PORT}`);
  console.log(`  curl -i http://localhost:${PORT}/search?q=hello`);
  console.log(`  curl -i -H 'payment-signature: demo-proof-1' 'http://localhost:${PORT}/search?q=hello'`);
});
