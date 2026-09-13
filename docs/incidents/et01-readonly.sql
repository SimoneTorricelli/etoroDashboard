-- Solo lettura. 31 agosto 2026 è una data candidata DA CONFERMARE.
-- Finestra candidata: 08:30–11:00 Europe/Rome = 06:30–09:00 UTC.
-- La configurazione corrente NON dimostra quella storica.
SELECT updated_at,
  json_extract(value, '$.executionMode') AS execution_mode,
  json_extract(value, '$.frozen') AS frozen,
  json_extract(value, '$.frozenReason') AS frozen_reason,
  json_extract(value, '$.cadence') AS cadence,
  json_extract(value, '$.rebalanceWeekday') AS weekday,
  json_extract(value, '$.rebalanceHour') AS hour_rome,
  json_extract(value, '$.rebalanceMinute') AS minute_rome,
  json_extract(value, '$.watcherEnabled') AS watcher_enabled
FROM config WHERE key = 'autopilot' AND json_valid(value);

SELECT id, kind, started_at, finished_at, status, execution_mode, error
FROM runs
WHERE started_at BETWEEN unixepoch('2026-08-31T06:30:00Z') * 1000
  AND unixepoch('2026-08-31T09:00:00Z') * 1000
ORDER BY started_at LIMIT 100;

SELECT at, run_id, level, stage, message
FROM audit
WHERE at BETWEEN unixepoch('2026-08-31T06:30:00Z') * 1000
  AND unixepoch('2026-08-31T09:00:00Z') * 1000
ORDER BY at LIMIT 300;

SELECT run_id, mode, state, COUNT(*) AS order_count
FROM orders
WHERE created_at BETWEEN unixepoch('2026-08-31T06:30:00Z') * 1000
  AND unixepoch('2026-08-31T09:00:00Z') * 1000
GROUP BY run_id, mode, state;
