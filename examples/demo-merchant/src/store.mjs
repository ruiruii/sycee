/**
 * Redemption and evidence stores.
 *
 * `memoryStore` is the local / test fallback. `d1Store` speaks the D1
 * prepared-statement API (and the node:sqlite adapter in node-store.mjs,
 * which is not imported by the worker). Both keep the same stats shape.
 *
 * Nothing in this file accepts a payment payload. `proof_hash` is the only
 * payment identifier that lands in a row.
 */

import { nowISO } from '@sycee/core';

const INCR_SQL = `INSERT INTO redemptions (proof_hash, count, resources, first_seen)
VALUES (?1, 1, ?2, ?3)
ON CONFLICT(proof_hash) DO UPDATE SET
  count = redemptions.count + 1,
  resources = CASE
    WHEN redemptions.resources = '' THEN excluded.resources
    WHEN instr(',' || redemptions.resources || ',', ',' || excluded.resources || ',') > 0 THEN redemptions.resources
    ELSE redemptions.resources || ',' || excluded.resources
  END
RETURNING count, resources, first_seen`;

/**
 * @returns {Store}
 */
export function memoryStore() {
  /** @type {Map<string, {count: number, resources: string[], firstSeen: string}>} */
  const redemptions = new Map();
  /** @type {any[]} */
  const attempts = [];
  /** @type {Map<string, any>} */
  const agents = new Map();
  /** @type {Map<string, {start: number, count: number}>} */
  const rates = new Map();

  return {
    kind: 'memory',
    async incr(proofHash, resourceId) {
      let rec = redemptions.get(proofHash);
      if (!rec) {
        rec = { count: 0, resources: [], firstSeen: nowISO() };
        redemptions.set(proofHash, rec);
      }
      rec.count += 1;
      if (resourceId && !rec.resources.includes(resourceId)) rec.resources.push(resourceId);
      return { count: rec.count, resources: [...rec.resources], firstSeen: rec.firstSeen };
    },
    async get(proofHash) {
      const rec = redemptions.get(proofHash);
      if (!rec) return null;
      return { count: rec.count, resources: [...rec.resources], firstSeen: rec.firstSeen };
    },
    async addAttempt(row) {
      attempts.push({ id: attempts.length + 1, ...row });
    },
    async merchantReceipt(proofHash) {
      for (let i = attempts.length - 1; i >= 0; i--) {
        const row = attempts[i];
        if (row.proof_hash === proofHash && row.decision === 'accepted' && row.receipt) return row.receipt;
      }
      return null;
    },
    async agentReceipt(proofHash) {
      return agents.get(proofHash) ?? null;
    },
    async addAgentReceipt(row) {
      agents.set(row.proof_hash, row);
    },
    async rateLimit(bucket, limit, windowMs) {
      const now = Date.now();
      let row = rates.get(bucket);
      if (!row || now - row.start >= windowMs) {
        row = { start: now, count: 1 };
        rates.set(bucket, row);
        return { allowed: true, remaining: Math.max(0, limit - 1) };
      }
      row.count += 1;
      return { allowed: row.count <= limit, remaining: Math.max(0, limit - row.count) };
    },
    async stats() {
      return summarize({
        redemptions: [...redemptions.values()].map((r) => ({ count: r.count })),
        attempts,
        agents: [...agents.values()],
      });
    },
    async setAnchor(proofHash, anchor) {
      for (let i = attempts.length - 1; i >= 0; i -= 1) {
        if (attempts[i].proof_hash === proofHash && attempts[i].decision === 'accepted') {
          attempts[i].anchor = anchor;
          return;
        }
      }
    },
    async listReceipts(limit = 20) {
      const lim = clampLimit(limit);
      const rows = [];
      for (let i = attempts.length - 1; i >= 0 && rows.length < lim; i -= 1) {
        const row = attempts[i];
        if (row.decision === 'accepted' && row.receipt) rows.push(publicAttempt(row));
      }
      return rows;
    },
    async dump() {
      return {
        redemptions: [...redemptions.entries()].map(([proof_hash, rec]) => ({ proof_hash, ...rec })),
        attempts,
        agent_receipts: [...agents.values()],
        rate_windows: [...rates.entries()].map(([bucket, row]) => ({ bucket, ...row })),
      };
    },
  };
}

/**
 * @param {{ prepare(sql: string): { bind(...args: any[]): { first(): Promise<any>, all(): Promise<{results?: any[]}>, run(): Promise<any> } } }} db
 */
export function d1Store(db) {
  return {
    kind: 'd1',
    async incr(proofHash, resourceId) {
      try {
        const row = await first(db, INCR_SQL, proofHash, resourceId ?? '', nowISO());
        return {
          count: Number(row.count),
          resources: row.resources ? String(row.resources).split(',').filter(Boolean) : [],
          firstSeen: row.first_seen,
        };
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async get(proofHash) {
      try {
        const row = await first(db, 'SELECT count, resources, first_seen FROM redemptions WHERE proof_hash = ?1', proofHash);
        if (!row) return null;
        return {
          count: Number(row.count),
          resources: row.resources ? String(row.resources).split(',').filter(Boolean) : [],
          firstSeen: row.first_seen,
        };
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async addAttempt(row) {
      try {
        await run(
          db,
          `INSERT INTO attempts (proof_hash, redeem_count, decision, reason, settlement, delivery, traffic, at, receipt_json, trade_no)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          row.proof_hash,
          row.redeem_count,
          row.decision,
          row.reason ?? null,
          row.settlement,
          row.delivery,
          row.traffic,
          row.at,
          row.receipt ? JSON.stringify(row.receipt) : null,
          row.trade_no ?? null,
        );
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async merchantReceipt(proofHash) {
      try {
        const row = await first(
          db,
          `SELECT receipt_json FROM attempts
           WHERE proof_hash = ?1 AND decision = 'accepted' AND receipt_json IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
          proofHash,
        );
        if (!row?.receipt_json) return null;
        return JSON.parse(row.receipt_json);
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async agentReceipt(proofHash) {
      try {
        const row = await first(
          db,
          'SELECT proof_hash, consumed, agent_id, traffic, at, receipt_json, resource_id FROM agent_receipts WHERE proof_hash = ?1',
          proofHash,
        );
        return row ? hydrateAgent(row) : null;
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async addAgentReceipt(row) {
      try {
        await run(
          db,
          `INSERT INTO agent_receipts (proof_hash, consumed, agent_id, traffic, at, receipt_json, resource_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          row.proof_hash,
          row.consumed,
          row.agent_id ?? null,
          row.traffic,
          row.at,
          JSON.stringify(row.receipt),
          row.resource_id,
        );
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async rateLimit(bucket, limit, windowMs) {
      try {
        const now = Date.now();
        const row = await first(db, 'SELECT window_start, count FROM rate_windows WHERE bucket = ?1', bucket);
        if (!row || now - Number(row.window_start) >= windowMs) {
          await run(
            db,
            `INSERT INTO rate_windows (bucket, window_start, count) VALUES (?1, ?2, 1)
             ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`,
            bucket,
            now,
          );
          return { allowed: true, remaining: Math.max(0, limit - 1) };
        }
        const next = Number(row.count) + 1;
        await run(db, 'UPDATE rate_windows SET count = ?1 WHERE bucket = ?2', next, bucket);
        return { allowed: next <= limit, remaining: Math.max(0, limit - next) };
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async setAnchor(proofHash, anchor) {
      try {
        await run(
          db,
          `UPDATE attempts SET anchor_json = ?1 WHERE id = (
             SELECT id FROM attempts WHERE proof_hash = ?2 AND decision = 'accepted' ORDER BY id DESC LIMIT 1
           )`,
          JSON.stringify(anchor),
          proofHash,
        );
      } catch (err) {
        if (/no such column/i.test(String(err && err.message))) return;
        throw annotateDb(err);
      }
    },
    async listReceipts(limit = 20) {
      const lim = clampLimit(limit);
      try {
        return mapReceiptRows(await all(
          db,
          `SELECT proof_hash, redeem_count, decision, settlement, delivery, traffic, at, receipt_json, anchor_json
           FROM attempts
           WHERE decision = 'accepted' AND receipt_json IS NOT NULL
           ORDER BY id DESC LIMIT ?1`,
          lim,
        ));
      } catch (err) {
        if (!/no such column/i.test(String(err && err.message))) throw annotateDb(err);
        return mapReceiptRows(await all(
          db,
          `SELECT proof_hash, redeem_count, decision, settlement, delivery, traffic, at, receipt_json
           FROM attempts
           WHERE decision = 'accepted' AND receipt_json IS NOT NULL
           ORDER BY id DESC LIMIT ?1`,
          lim,
        ));
      }
    },
    async stats() {
      try {
        const redeem = await first(
          db,
          `SELECT
             COALESCE(SUM(CASE WHEN count = 1 THEN 1 ELSE 0 END), 0) AS eq1,
             COALESCE(SUM(CASE WHEN count > 1 THEN 1 ELSE 0 END), 0) AS gt1,
             COALESCE(MAX(count), 0) AS maxc
           FROM redemptions`,
        );
        const decisions = await all(db, 'SELECT decision, COUNT(*) AS n FROM attempts GROUP BY decision');
        const settlements = await all(db, 'SELECT settlement, COUNT(*) AS n FROM attempts GROUP BY settlement');
        const traffic = await all(db, 'SELECT traffic, COUNT(*) AS n FROM attempts GROUP BY traffic');
        const consumed = await all(db, 'SELECT consumed, COUNT(*) AS n FROM agent_receipts GROUP BY consumed');
        const recent = await all(
          db,
          `SELECT proof_hash, redeem_count, settlement, delivery, decision, traffic, at
           FROM attempts ORDER BY id DESC LIMIT 20`,
        );
        return {
          accepted: countOf(decisions, 'decision', 'accepted'),
          refused: countOf(decisions, 'decision', 'refused'),
          redeem: { eq1: num(redeem?.eq1), gt1: num(redeem?.gt1), max: num(redeem?.maxc) },
          settlement: {
            settled: countOf(settlements, 'settlement', 'settled'),
            in_flight: countOf(settlements, 'settlement', 'in_flight'),
            absent: countOf(settlements, 'settlement', 'absent'),
          },
          traffic: {
            self_test: countOf(traffic, 'traffic', 'self-test'),
            external: countOf(traffic, 'traffic', 'external'),
          },
          consumed: {
            k: consumed.reduce((sum, row) => sum + num(row.n), 0),
            yes: countOf(consumed, 'consumed', 'yes'),
            no: countOf(consumed, 'consumed', 'no'),
            unknown: countOf(consumed, 'consumed', 'unknown'),
          },
          recent: recent.map((row) => ({
            proof_hash: row.proof_hash,
            redeem_count: num(row.redeem_count),
            settlement: row.settlement,
            delivery: row.delivery,
            decision: row.decision,
            traffic: row.traffic,
            at: row.at,
          })),
        };
      } catch (err) {
        throw annotateDb(err);
      }
    },
    async dump() {
      try {
        return {
          redemptions: await all(db, 'SELECT proof_hash, count, resources, first_seen FROM redemptions'),
          attempts: await all(
            db,
            'SELECT id, proof_hash, redeem_count, decision, reason, settlement, delivery, traffic, at, receipt_json, trade_no FROM attempts',
          ),
          agent_receipts: await all(
            db,
            'SELECT proof_hash, consumed, agent_id, traffic, at, receipt_json, resource_id FROM agent_receipts',
          ),
          rate_windows: await all(db, 'SELECT bucket, window_start, count FROM rate_windows'),
        };
      } catch (err) {
        throw annotateDb(err);
      }
    },
  };
}

function summarize({ redemptions, attempts, agents }) {
  let eq1 = 0;
  let gt1 = 0;
  let max = 0;
  for (const rec of redemptions) {
    if (rec.count === 1) eq1 += 1;
    if (rec.count > 1) gt1 += 1;
    if (rec.count > max) max = rec.count;
  }
  const settlement = { settled: 0, in_flight: 0, absent: 0 };
  const traffic = { self_test: 0, external: 0 };
  let accepted = 0;
  let refused = 0;
  for (const row of attempts) {
    if (row.decision === 'accepted') accepted += 1;
    if (row.decision === 'refused') refused += 1;
    if (row.settlement === 'settled' || row.settlement === 'in_flight' || row.settlement === 'absent') {
      settlement[row.settlement] += 1;
    }
    if (row.traffic === 'self-test') traffic.self_test += 1;
    if (row.traffic === 'external') traffic.external += 1;
  }
  const consumed = { k: agents.length, yes: 0, no: 0, unknown: 0 };
  for (const row of agents) {
    if (row.consumed === 'yes' || row.consumed === 'no' || row.consumed === 'unknown') {
      consumed[row.consumed] += 1;
    }
  }
  const recent = [...attempts].reverse().slice(0, 20).map((row) => ({
    proof_hash: row.proof_hash,
    redeem_count: row.redeem_count,
    settlement: row.settlement,
    delivery: row.delivery,
    decision: row.decision,
    traffic: row.traffic,
    at: row.at,
  }));
  return { accepted, refused, redeem: { eq1, gt1, max }, settlement, traffic, consumed, recent };
}

function publicAttempt(row) {
  return {
    proof_hash: row.proof_hash,
    redeem_count: row.redeem_count,
    decision: row.decision,
    settlement: row.settlement,
    delivery: row.delivery,
    traffic: row.traffic,
    at: row.at,
    receipt: row.receipt,
    anchor: row.anchor ?? null,
  };
}

function mapReceiptRows(rows) {
  const out = [];
  for (const row of rows) {
    let receipt = null;
    try {
      receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
    } catch {
      continue;
    }
    if (!receipt) continue;
    let anchor = null;
    if (row.anchor_json) {
      try {
        anchor = JSON.parse(row.anchor_json);
      } catch {
        anchor = null;
      }
    }
    out.push(publicAttempt({
      proof_hash: row.proof_hash,
      redeem_count: num(row.redeem_count),
      decision: row.decision,
      settlement: row.settlement,
      delivery: row.delivery,
      traffic: row.traffic,
      at: row.at,
      receipt,
      anchor,
    }));
  }
  return out;
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, 50);
}

function hydrateAgent(row) {
  return {
    proof_hash: row.proof_hash,
    consumed: row.consumed,
    agent_id: row.agent_id,
    traffic: row.traffic,
    at: row.at,
    resource_id: row.resource_id,
    receipt: JSON.parse(row.receipt_json),
  };
}

function annotateDb(err) {
  if (/no such table/i.test(String(err && err.message))) {
    const wrapped = new Error('database_not_initialized');
    wrapped.code = 'database_not_initialized';
    return wrapped;
  }
  return err;
}

function num(value) {
  return Number(value ?? 0);
}

function countOf(rows, key, expected) {
  const found = rows.find((row) => row[key] === expected);
  return num(found?.n);
}

async function first(db, sql, ...params) {
  const row = await db.prepare(sql).bind(...params).first();
  return row ?? null;
}

async function all(db, sql, ...params) {
  const out = await db.prepare(sql).bind(...params).all();
  return out?.results ?? [];
}

async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}
