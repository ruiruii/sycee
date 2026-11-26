#!/usr/bin/env node
/**
 * Minimal payable server using @sycee/middleware.
 *
 * Run:
 *   node examples/minimal-server.mjs
 *
 * Then in another terminal:
 *   curl -i http://localhost:4000/paid
 *     -> 402 Payment Required
 *
 *   curl -i -H 'payment-signature: demo-proof-1234' http://localhost:4000/paid
 *     -> 200 OK + x-sycee-receipt header
 */

import http from 'node:http';
import { generateKeyPair } from '@sycee/core';
import { createGates, memoryStore } from '@sycee/middleware';

const PORT = Number(process.env.PORT || 4000);
const { publicKey, privateKey } = generateKeyPair();

const gates = createGates({
  resourceId: 'paid.echo.v1',
  protocol: 'x402',
  price: { value: '0.001000', currency: 'USDC' },
  payTo: '0x00000000000000000000000000000000000000bb',
  network: 'eip155:8453',
  scheme: 'exact',
  publicKey,
  privateKey,
  agentId: 'erc8004:8453:0xDEMO_MERCHANT',
  keyId: 'demo-01',
  store: memoryStore(),
  // attach the signed receipt into the response body for easy inspection
  attachReceipt: true,
});

const paidHandler = async () => ({
  status: 200,
  body: { message: 'Hello from a paid endpoint', ts: new Date().toISOString() },
});

const server = http.createServer(async (req, res) => {
  if (req.url === '/paid') {
    await gates.guard(paidHandler)(req, res);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => {
  process.stdout.write(`SYCEE minimal server listening on http://localhost:${PORT}\n`);
  process.stdout.write(`\nTry:\n`);
  process.stdout.write(`  curl -i http://localhost:${PORT}/paid\n`);
  process.stdout.write(`  curl -i -H 'payment-signature: demo-proof-1234' http://localhost:${PORT}/paid\n`);
  process.stdout.write(`  curl -i -H 'payment-signature: demo-proof-1234' http://localhost:${PORT}/paid\n`);
});
