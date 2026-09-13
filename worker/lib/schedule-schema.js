export const SCHEDULE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schedule_state (
    id TEXT PRIMARY KEY, config_key TEXT NOT NULL, version INTEGER NOT NULL,
    effective_at INTEGER NOT NULL, cursor_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
    scheduled_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_occurrences (
    id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, schedule_version INTEGER NOT NULL,
    kind TEXT NOT NULL, due_at_utc INTEGER NOT NULL, local_due TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Rome', expires_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason_code TEXT,
    reason TEXT, run_id TEXT, run_status TEXT,
    UNIQUE(strategy_id, schedule_version, kind, due_at_utc)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_pending ON schedule_occurrences(status, due_at_utc)`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_recent ON schedule_occurrences(kind, due_at_utc DESC)`,
];
