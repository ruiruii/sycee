/**
 * Node-only SQLite adapter. The worker entry does not import this module.
 * `node:sqlite` exists on Node 22+. Callers should catch a failed import and
 * fall back to the in-memory store.
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_SQL } from './schema.mjs';

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
          return {
            async first() {
              const row = db.prepare(sql).get(...params);
              return row ?? null;
            },
            async all() {
              return { results: db.prepare(sql).all(...params) };
            },
            async run() {
              const info = db.prepare(sql).run(...params);
              return { success: true, meta: { changes: info.changes ?? 0 } };
            },
          };
        },
      };
    },
  };
}
