-- Schema D1 "Torino Autopilot".
-- Applicalo con:  npx wrangler d1 execute torino --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Lease globale: impedisce la sovrapposizione fra cron, trigger manuali e MCP.
-- Se una run termina senza cleanup, il lock diventa nuovamente acquisibile
-- dopo lease_until.
CREATE TABLE IF NOT EXISTS pipeline_lock (
  lock_key    TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_orders_live_recovery
  ON orders (mode, state, updated_at DESC);

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

-- Registro delle posizioni: alimenta le regole di holding period e cooldown.
CREATE TABLE IF NOT EXISTS holdings_ledger (
  symbol             TEXT PRIMARY KEY,
  instrument_id      INTEGER,
  first_bought_at    INTEGER,
  last_bought_at     INTEGER,
  last_sold_at       INTEGER,
  average_down_count INTEGER NOT NULL DEFAULT 0,
  opportunistic      INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

-- Anomalie rilevate dal watcher orario e relative decisioni.
CREATE TABLE IF NOT EXISTS watcher_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  symbol         TEXT NOT NULL,
  instrument_id  INTEGER,
  kind           TEXT NOT NULL,
  metrics_json   TEXT,
  classification TEXT,
  confidence     REAL,
  rationale      TEXT,
  action         TEXT NOT NULL,
  run_id         TEXT,
  model          TEXT
);
CREATE INDEX IF NOT EXISTS idx_watcher_at ON watcher_events (at DESC);

-- Cache permanente simbolo -> instrumentId eToro.
CREATE TABLE IF NOT EXISTS universe_cache (
  symbol        TEXT PRIMARY KEY,
  instrument_id INTEGER NOT NULL,
  name          TEXT,
  asset_class   TEXT,
  matched_as    TEXT,
  updated_at    INTEGER NOT NULL
);

-- Decisione AI riutilizzabile da una dry-run. Il claim è single-use: piano e
-- importi vengono comunque ricostruiti nella nuova run live.
CREATE TABLE IF NOT EXISTS decision_artifacts (
  source_run_id       TEXT PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  decision_revision   INTEGER NOT NULL,
  decision_hash       TEXT NOT NULL,
  binding_hash        TEXT NOT NULL,
  proposal_hash       TEXT NOT NULL,
  consumed_at         INTEGER,
  consumed_by_run_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_artifacts_expiry
  ON decision_artifacts (expires_at DESC, created_at DESC);

-- Idempotenza del click Live: un retry o doppio click con lo stesso ID non
-- crea una seconda run e non può generare request-id eToro differenti.
CREATE TABLE IF NOT EXISTS live_activation_requests (
  activation_id  TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  status         TEXT NOT NULL,
  source_run_id  TEXT,
  response_json  TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_activation_recovery
  ON live_activation_requests (status, updated_at DESC);
