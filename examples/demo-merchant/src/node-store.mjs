/**
 * Node-only SQLite adapter. The worker entry does not import this module.
 * `node:sqlite` exists on Node 22+. Callers should catch a failed import and
 * fall back to the in-memory store.
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_SQL } from './schema.mjs';

/**
 * `node:sqlite` binds only anonymous `?` placeholders. A statement written for
 * D1 with numbered ones (`?1`, `?2`, …) throws
 * `ERR_SQLITE_ERROR: column index out of range` on the first bind, because the
 * engine reads `?1` as a positional slot and then finds more arguments than it
 * has slots. D1 accepts both forms, and the statements in `store.mjs` are
 * written for D1 — so the rewrite belongs here, at the adapter boundary, rather
 * than in the SQL text the worker also uses.
 *
 * Numbered placeholders may legitimately repeat (`?1 … ?1`), which is one of
 * the reasons they are used. Replacing each with `?` therefore has to expand
 * the argument list to one entry per occurrence, in source order.
 *
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {{sql: string, params: unknown[]}}
 */
function positionalize(sql, params) {
  if (!/\?\d/.test(sql)) return { sql, params };
  /** @type {number[]} */
  const order = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_match, digits) => {
    order.push(Number(digits) - 1);
    return '?';
  });
  return { sql: rewritten, params: order.map((i) => params[i]) };
}

/**
 * A D1-shaped binding over a local SQLite file (or ":memory:").
 * @param {string} path
 */
export function sqliteAsD1(path) {
  const db = new DatabaseSync(path);
  db.exec(MIGRATION_SQL);
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const q = positionalize(sql, params);
          return {
            async first() {
              const row = db.prepare(q.sql).get(...q.params);
              return row ?? null;
            },
            async all() {
              return { results: db.prepare(q.sql).all(...q.params) };
            },
            async run() {
              const info = db.prepare(q.sql).run(...q.params);
              return { success: true, meta: { changes: info.changes ?? 0 } };
            },
          };
        },
      };
    },
  };
}
