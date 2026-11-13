#!/usr/bin/env node
/**
 * Local HTTP server for the demo merchant.
 *
 *   SYCEE_EPHEMERAL_KEYS=1 PAY_TO=0x2222222222222222222222222222222222222222 \
 *     node examples/demo-merchant/src/dev-server.mjs
 *
 * Set SQLITE_PATH to a file (Node 22+, node:sqlite) for a durable local store.
 * Without it the store is in-memory and is dropped when the process exits.
 * This process does not deploy anything.
 */

import http from 'node:http';
import { createMerchant } from './merchant.mjs';

const env = { ...process.env };
if (env.SQLITE_PATH) {
  try {
    const { sqliteAsD1 } = await import('./node-store.mjs');
    env.DB = sqliteAsD1(env.SQLITE_PATH);
    env.DB_KIND = 'sqlite';
  } catch (err) {
    console.warn(`sqlite unavailable (${err && err.message}); using in-memory store`);
  }
}

const merchant = await createMerchant(env);
const parsedPort = Number(env.PORT || 8787);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 8787;
// Railway sets PORT and reaches the process on 0.0.0.0. A local run with no
// PORT stays on loopback.
const host = env.HOST || (env.PORT ? '0.0.0.0' : '127.0.0.1');

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const url = `http://${req.headers.host || `${host}:${port}`}${req.url}`;
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
    const response = await merchant.fetch(new Request(url, init));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    res.end(bytes);
  } catch (err) {
    console.error('dev_server_error');
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
});

server.listen(port, host, () => {
  console.log(`SYCEE demo merchant listening on http://${host}:${port}`);
  console.log(`store=${merchant.storeKind} configured=${merchant.problems.length === 0}`);
  if (merchant.problems.length) console.log(`problems=${merchant.problems.join(',')}`);
});
