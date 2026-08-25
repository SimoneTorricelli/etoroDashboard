-- Schema D1 "Torino Autopilot".
-- Applicalo con:  npx wrangler d1 execute torino --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  status         TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  equity_usd     REAL,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  run_id         TEXT PRIMARY KEY,
  taken_at       INTEGER NOT NULL,
  equity_usd     REAL NOT NULL,
  cash_usd       REAL NOT NULL,
  invested_usd   REAL NOT NULL,
  positions_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  run_id       TEXT PRIMARY KEY,
  computed_at  INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  run_id       TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  model        TEXT,
  attempts_json TEXT,
  prompt_chars INTEGER,
  raw_text     TEXT,
  parsed_json  TEXT,
  confidence   REAL,
  rationale    TEXT,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS validations (
  run_id          TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  violations_json TEXT NOT NULL,
  plan_json       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  symbol         TEXT NOT NULL,
  instrument_id  INTEGER NOT NULL,
  side           TEXT NOT NULL,
  amount_usd     REAL NOT NULL,
  position_id    INTEGER,
  mode           TEXT NOT NULL,
  state          TEXT NOT NULL,
  etoro_order_id TEXT,
  position_ids   TEXT,
  filled_usd     REAL NOT NULL DEFAULT 0,
  message        TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_run ON orders (run_id);

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT,
  at        INTEGER NOT NULL,
  level     TEXT NOT NULL,
  stage     TEXT NOT NULL,
  message   TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at DESC);

CREATE TABLE IF NOT EXISTS equity_curve (
  at           INTEGER PRIMARY KEY,
  equity_usd   REAL NOT NULL,
  invested_usd REAL,
  cash_usd     REAL,
  hwm_usd      REAL
);
