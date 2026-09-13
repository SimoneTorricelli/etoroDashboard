import { loadConfigSnapshot } from './db.js';
import { calendarOccurrences, MINUTE, nextRebalance } from './schedule-calendar.js';

const CONFIG_MATCH = `COALESCE((SELECT value FROM config WHERE key = 'autopilot'), '') = ?`;
const STATE_ID = 'primary'; // L'executor attuale gestisce una sola strategia attiva.
export function scheduleKey(config) {
  return JSON.stringify({ revision: config.scheduleRevision ?? 0, fields: [
    config.cadence, config.rebalanceWeekday, config.rebalanceDayOfMonth,
    config.rebalanceHour, config.rebalanceMinute, config.snapshotHours,
    config.scheduleRecoveryMinutes ?? 60, config.activeAgentPortfolioId ?? '',
    config.activeAgentPortfolioMirrorId ?? '', config.decisionRevision ?? 0,
    config.safetyRevision ?? 0,
  ] });
}
export function recoveryMinutes(config) {
  const value = config.scheduleRecoveryMinutes ?? 60;
  return Number.isInteger(value) && value >= 1 && value <= 180 ? value : 60;
}
function outcome(status) {
  if (status === 'error') return 'failed';
  if (['blocked', 'frozen'].includes(status)) return 'blocked';
  return 'completed';
}
async function synchronize(db, snapshot, now, scheduledAt) {
  // Le revisioni registrano anche A→B→A fra due tick. Un calendario salvato
  // prima della scadenza vale subito; non si retrodata prima dell'ultimo cursore.
  const changedAt = Number(snapshot.config.scheduleChangedAt) || now;
  const cutover = `CASE WHEN json_extract(schedule_state.config_key, '$.revision') <> json_extract(excluded.config_key, '$.revision')
    THEN MAX(schedule_state.cursor_at, MIN(?, excluded.received_at)) ELSE excluded.received_at END`;
  return db.prepare(`INSERT INTO schedule_state
    (id, config_key, version, effective_at, cursor_at, received_at, scheduled_at)
    SELECT ?, ?, 1, ?, ?, ?, ? WHERE ${CONFIG_MATCH}
    ON CONFLICT(id) DO UPDATE SET
      version = schedule_state.version + CASE WHEN schedule_state.config_key <> excluded.config_key THEN 1 ELSE 0 END,
      effective_at = CASE WHEN schedule_state.config_key <> excluded.config_key THEN ${cutover} ELSE schedule_state.effective_at END,
      cursor_at = CASE WHEN schedule_state.config_key <> excluded.config_key THEN ${cutover} ELSE schedule_state.cursor_at END,
      config_key = excluded.config_key,
      received_at = MAX(schedule_state.received_at, excluded.received_at),
      scheduled_at = MAX(schedule_state.scheduled_at, excluded.scheduled_at)
    RETURNING *`)
    .bind(STATE_ID, scheduleKey(snapshot.config), now, now, now, scheduledAt, snapshot.raw, changedAt, changedAt).first();
}
async function materialize(db, state, config, now) {
  // Lotti di 24 ore; il cursore persistito conserva anche interruzioni più lunghe.
  const until = Math.min(now, state.cursor_at + 24 * 60 * MINUTE);
  const occurrences = calendarOccurrences(config, state.cursor_at, until);
  const statements = occurrences.map(row => {
    const ttl = row.kind === 'rebalance' ? recoveryMinutes(config) : row.kind === 'snapshot' ? 5 : 2;
    const expired = row.dueAt + ttl * MINUTE < now;
    const status = row.skipReason ? 'skipped' : expired ? 'expired' : 'pending';
    const reason = row.skipReason ?? (expired ? 'recovery_expired' : null);
    return db.prepare(`INSERT OR IGNORE INTO schedule_occurrences
      (id, strategy_id, schedule_version, kind, due_at_utc, local_due, expires_at, received_at, status, reason_code, finished_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM schedule_state WHERE id = ? AND version = ?)`)
      .bind(`${STATE_ID}:${state.version}:${row.kind}:${row.dueAt}`, STATE_ID, state.version, row.kind,
        row.dueAt, row.localDue, row.dueAt + ttl * MINUTE, now, status, reason,
        status === 'pending' ? null : now, STATE_ID, state.version);
  });
  statements.push(db.prepare(`UPDATE schedule_state SET cursor_at = MAX(cursor_at, ?)
    WHERE id = ? AND version = ?`).bind(until, STATE_ID, state.version));
  // D1 batch è transazionale: non si avanza il cursore senza salvare le scadenze.
  await db.batch(statements);
}
async function settle(db, row, result, now) {
  const status = outcome(result.status);
  await db.prepare(`UPDATE schedule_occurrences SET status = ?, run_status = ?,
    reason_code = ?, reason = ?, finished_at = ? WHERE id = ? AND status = 'claimed' AND run_id = ?`)
    .bind(status, result.status ?? 'unknown', status === 'completed' ? 'pipeline_finished' : `pipeline_${status}`,
      String(result.error || result.reason || '').slice(0, 1000) || null, now, row.id, result.runId).run();
}
/** Claim solo dentro il lock globale e prima di qualsiasi I/O della pipeline. */
export async function claimScheduleOccurrence(db, occurrence, runId, now = Date.now()) {
  const snapshot = await loadConfigSnapshot(db);
  if (scheduleKey(snapshot.config) !== occurrence.configKey) return false;
  const row = await db.prepare(`UPDATE schedule_occurrences SET status = 'claimed',
    run_id = ?, claimed_at = ?, reason_code = 'pipeline_started', reason = NULL
    WHERE id = ? AND status = 'pending' AND due_at_utc <= ? AND expires_at >= ?
      AND EXISTS (SELECT 1 FROM schedule_state WHERE id = ? AND version = schedule_occurrences.schedule_version AND config_key = ?)
      AND EXISTS (SELECT 1 FROM pipeline_lock WHERE lock_key = 'global' AND owner_id = ? AND lease_until > ?)
      AND ${CONFIG_MATCH}
    RETURNING id`)
    .bind(runId, now, occurrence.id, now, now, STATE_ID, occurrence.configKey, runId, now, snapshot.raw).first();
  return Boolean(row);
}
async function reconcileClaims(db, now) {
  const rows = await db.prepare(`SELECT o.*, r.status AS actual_status, r.finished_at AS run_finished_at, r.error AS run_error,
    l.lease_until FROM schedule_occurrences o
    LEFT JOIN runs r ON r.id = o.run_id
    LEFT JOIN pipeline_lock l ON l.lock_key = 'global' AND l.owner_id = o.run_id
    WHERE o.status IN ('claimed', 'needs_review') ORDER BY CASE o.status WHEN 'claimed' THEN 0 ELSE 1 END, o.due_at_utc DESC LIMIT 50`).all();
  for (const row of rows.results ?? []) {
    if (row.run_finished_at != null) {
      await db.prepare(`UPDATE schedule_occurrences SET status = ?, run_status = ?, reason_code = ?, reason = ?, finished_at = ?
        WHERE id = ? AND status IN ('claimed', 'needs_review')`)
        .bind(outcome(row.actual_status), row.actual_status, 'run_reconciled', row.run_error ?? null, row.run_finished_at, row.id).run();
    } else if (!(row.lease_until > now) && row.status === 'claimed') {
      await db.prepare(`UPDATE schedule_occurrences SET status = 'needs_review', reason_code = 'execution_unknown',
        reason = 'Run interrotta: verificare lo storico e gli ordini eToro. Nessun rilancio automatico.', run_status = ?, finished_at = ?
        WHERE id = ? AND status = 'claimed'`).bind(row.actual_status ?? 'not_recorded', now, row.id).run();
    }
  }
}
/** Un tick cerca lavoro persistito. Il solo callback run può avviare la pipeline. */
export async function dispatchSchedule({ env, scheduledAt, now = Date.now(), run }) {
  const db = env.DB;
  const snapshot = await loadConfigSnapshot(db);
  const state = await synchronize(db, snapshot, now, scheduledAt ?? now);
  if (!state) return { status: 'configuration_changed' };
  await materialize(db, state, snapshot.config, now);
  await db.batch([
    db.prepare(`UPDATE schedule_occurrences SET status = 'cancelled', reason_code = 'schedule_changed', finished_at = ?
      WHERE status = 'pending' AND schedule_version <> (SELECT version FROM schedule_state WHERE id = ?)`)
      .bind(now, STATE_ID),
    db.prepare(`UPDATE schedule_occurrences SET status = 'expired', reason_code = 'recovery_expired', finished_at = ?
      WHERE status = 'pending' AND expires_at < ?`).bind(now, now),
  ]);
  await reconcileClaims(db, now);
  const row = await db.prepare(`SELECT * FROM schedule_occurrences WHERE status = 'pending'
    AND schedule_version = ? AND due_at_utc <= ? AND expires_at >= ?
    ORDER BY CASE kind WHEN 'rebalance' THEN 0 WHEN 'snapshot' THEN 1 ELSE 2 END, due_at_utc LIMIT 1`)
    .bind(state.version, now, now).first();
  if (!row) return { status: 'idle' };
  if (snapshot.config.frozen && row.kind !== 'snapshot') {
    await db.prepare(`UPDATE schedule_occurrences SET status = 'blocked', reason_code = 'autopilot_frozen', reason = ?, finished_at = ?
      WHERE id = ? AND status = 'pending'`).bind(snapshot.config.frozenReason || 'Autopilot congelato', now, row.id).run();
    return { status: 'blocked', reason: 'autopilot_frozen' };
  }
  await db.prepare(`UPDATE schedule_occurrences SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'`).bind(row.id).run();
  // La deadline è ricontrollata sotto lock, con l'ora effettiva al momento del claim.
  const result = await run({ env, kind: row.kind, scheduleOccurrence: { id: row.id, configKey: state.config_key } });
  if (result.busy && !result.runId) {
    await db.prepare(`UPDATE schedule_occurrences SET reason_code = ?, reason = ? WHERE id = ? AND status = 'pending'`)
      .bind(result.reason === 'lock-unavailable' ? 'lock_unavailable' : 'pipeline_busy', result.error ?? null, row.id).run();
  } else if (result.runId) {
    await settle(db, row, result, Date.now());
  }
  return result;
}
export async function schedulerState(db, config, now = Date.now()) {
  const [state, occurrences, issues] = await Promise.all([
    db.prepare('SELECT * FROM schedule_state WHERE id = ?').bind(STATE_ID).first(),
    db.prepare(`SELECT * FROM schedule_occurrences WHERE kind = 'rebalance' ORDER BY due_at_utc DESC LIMIT 12`).all(),
    db.prepare(`SELECT * FROM schedule_occurrences WHERE status = 'needs_review' ORDER BY due_at_utc DESC LIMIT 10`).all(),
  ]);
  return {
    checkedAt: now, timezone: 'Europe/Rome', recoveryMinutes: recoveryMinutes(config),
    initialized: Boolean(state), configurationPending: Boolean(state && state.config_key !== scheduleKey(config)),
    lastReceivedAt: state?.received_at ?? null, lastScheduledAt: state?.scheduled_at ?? null,
    scannedThrough: state?.cursor_at ?? null, version: state?.version ?? null,
    nextRebalance: nextRebalance(config, now), recentRebalances: occurrences.results ?? [], unresolved: issues.results ?? [],
  };
}
