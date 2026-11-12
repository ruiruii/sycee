/**
 * Cloudflare Worker sketch — where @sycee/adapter-automaton sits relative
 * to the existing payment path.
 *
 * Read this as a diff-of-intent, not as a patch: the two `await gates.*` calls
 * are the whole integration. `appendAttestation`, `verifyPayment` and the
 * ledger internals are untouched.
 *
 * The D1 store below is the shape that makes G1 actually atomic. See the
 * concurrency caveat in the README before substituting Workers KV.
 */

import {
  createAutomatonAdapter,
  fingerprintFor,
  settlementFromAutomaton,
} from '@sycee/adapter-automaton';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ---------------------------------------------------------------- *
     * 1. Your existing paid routes — unchanged except for two calls.
     * ---------------------------------------------------------------- */
    if (url.pathname === '/v2/search') {
      const fp = fingerprintFor({
        method: request.method,
        url: url.pathname,
        params: Object.fromEntries(url.searchParams),
      });

      const gates = createAutomatonAdapter({
        append: (dataHash, meta) => appendAttestation(env, { dataHash }, meta),
        settlementFor: (txHash) => verifyPaymentOnChain(env, txHash),
        store: d1GuardStore(env.DB),
        cap: {
          perPayerPerWindow: Number(env.SYCEE_CAP_PER_PAYER ?? 5),
          windowMs: Number(env.SYCEE_CAP_WINDOW_MS ?? 60_000),
        },
      });

      const proof = request.headers.get('X-PAYMENT');

      // --- the refusal path -------------------------------------------
      // server.js:391 today: `if (spentTx.has(txHash)) return { ok:false,
      // reason:'tx_already_used' }` — enforced, and then forgotten. This is
      // the one line that makes the attempt leave a signed trace.
      const prior = await verifyPaymentOnChain(env, txHashFrom(proof));
      if (prior && prior.alreadySpent) {
        await gates.attestRefusal({
          fingerprint: fp,
          txHash: txHashFrom(proof),
          nonce: nonceFrom(proof),
          payer: payerFrom(proof),
        });
        return json({ error: 'payment_invalid', reason: 'tx_already_used' }, 402);
      }

      // --- the settle path ---------------------------------------------
      const res = await handleSearch(request);
      await gates.attestSettlement({
        fingerprint: fp,
        txHash: txHashFrom(proof),
        nonce: nonceFrom(proof),
        payer: payerFrom(proof),
        resourceId: 'search.v1',
        amount: { value: '0.020000', currency: 'USDC' },
      });

      return new Response(res.body, {
        status: 200,
        headers: { 'X-Payment-Settled': 'true' },
      });
    }

    /* ---------------------------------------------------------------- *
     * 2. A read-only endpoint exposing derivable counts.
     *    Optional — but it is what makes redeem_count auditable by a
     *    third party rather than merely asserted by us.
     * ---------------------------------------------------------------- */
    if (url.pathname === '/v2/redeem-count') {
      const fp = url.searchParams.get('fingerprint');
      const rows = await env.DB.prepare(
        'SELECT data_hash, kind, tx_hash FROM gates_groups WHERE group_key = ? ORDER BY rowid',
      ).bind(fp).all();
      return json({ fingerprint: fp, redeemCount: rows.results.length, entries: rows.results });
    }

    return new Response('not found', { status: 404 });
  },
};

/* ------------------------------------------------------------------ *
 * G1 over D1 — atomic, so two concurrent attempts cannot both win.
 * ------------------------------------------------------------------ */

function d1GuardStore(db) {
  return {
    async claim(key, ttlMs) {
      const expiresAt = Date.now() + ttlMs;
      // UNIQUE constraint on `key` makes the loser of a race fail rather than
      // silently double-append. This is the property KV cannot give you.
      const info = await db.prepare(
        'INSERT INTO gates_claims (key, expires_at) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET expires_at = ? WHERE gates_claims.expires_at <= ?',
      ).bind(key, expiresAt, expiresAt, Date.now()).run();
      return { fresh: (info.changes ?? 0) > 0 };
    },
    async bump(bucket, windowMs, limit) {
      const now = Date.now();
      const row = await db.prepare(
        'SELECT window_start, count FROM gates_windows WHERE bucket = ?',
      ).bind(bucket).first();
      if (!row || now - row.window_start >= windowMs) {
        await db.prepare(
          'INSERT INTO gates_windows (bucket, window_start, count) VALUES (?, ?, 1) ' +
          'ON CONFLICT(bucket) DO UPDATE SET window_start = ?, count = 1',
        ).bind(bucket, now, now).run();
        return { count: 1, allowed: 1 <= limit };
      }
      const next = row.count + 1;
      await db.prepare('UPDATE gates_windows SET count = ? WHERE bucket = ?')
        .bind(next, bucket).run();
      return { count: next, allowed: next <= limit };
    },
    async group(groupKey, entry) {
      await db.prepare(
        'INSERT INTO gates_groups (group_key, data_hash, kind, tx_hash, at) VALUES (?, ?, ?, ?, ?)',
      ).bind(groupKey, entry.dataHash, entry.kind, entry.txHash, Date.now()).run();
      const { count } = await db.prepare(
        'SELECT COUNT(*) AS count FROM gates_groups WHERE group_key = ?',
      ).bind(groupKey).first();
      return { size: count };
    },
    async groups(groupKey) {
      const rows = await db.prepare(
        'SELECT data_hash AS dataHash, kind, tx_hash AS txHash FROM gates_groups WHERE group_key = ?',
      ).bind(groupKey).all();
      return rows.results;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ *
 * CREATE TABLE gates_claims  (key TEXT PRIMARY KEY, expires_at INTEGER);
 * CREATE TABLE gates_windows (bucket TEXT PRIMARY KEY, window_start INTEGER, count INTEGER);
 * CREATE TABLE gates_groups  (group_key TEXT, data_hash TEXT, kind TEXT, tx_hash TEXT, at INTEGER);
 * CREATE INDEX idx_groups_key ON gates_groups(group_key);
 */

/* ------------------------------------------------------------------ *
 * Stubs — your existing internals.
 * ------------------------------------------------------------------ */

async function appendAttestation(env, { dataHash }, meta) {
  // existing appendAttestation: prevHash, timestamp, dataHash, hash, signature, keyId
  // `meta` is context for you; it is NOT part of the signed preimage.
  throw new Error('replace with your appendAttestation');
}

async function verifyPaymentOnChain(env, txHash) {
  // existing verifyPayment. Return { status: 'settled'|'in_flight'|'absent' }.
  throw new Error('replace with your verifyPayment');
}

/** Map your own wire value onto the enum — for your own response headers. */
export function settlementFor(res) {
  return settlementFromAutomaton({ status: res.status, headers: res.headers });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const txHashFrom = (proof) => proof;   // decode X-PAYMENT per your existing code
const nonceFrom = (proof) => proof;
const payerFrom = (proof) => proof;
async function handleSearch(request) { return { body: '{}' }; }
