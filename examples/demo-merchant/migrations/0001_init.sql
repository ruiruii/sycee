-- SYCEE demo merchant. Proof hashes and signed receipts only.
-- Do not add a column for a payment payload, authorization, or raw proof.

CREATE TABLE IF NOT EXISTS redemptions (
  proof_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  resources TEXT NOT NULL,
  first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_hash TEXT NOT NULL,
  redeem_count INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  settlement TEXT NOT NULL,
  delivery TEXT NOT NULL,
  traffic TEXT NOT NULL,
  at TEXT NOT NULL,
  receipt_json TEXT,
  trade_no TEXT
);

CREATE INDEX IF NOT EXISTS idx_attempts_proof ON attempts(proof_hash);
CREATE INDEX IF NOT EXISTS idx_attempts_at ON attempts(id);

CREATE TABLE IF NOT EXISTS agent_receipts (
  proof_hash TEXT PRIMARY KEY,
  consumed TEXT NOT NULL,
  agent_id TEXT,
  traffic TEXT NOT NULL,
  at TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  resource_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_windows (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
