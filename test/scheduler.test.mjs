import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  acquirePipelineLock, DEFAULT_CONFIG, loadConfig, migrate, releasePipelineLock, saveConfig,
} from '../worker/lib/db.js';
import { calendarOccurrences, nextRebalance, MINUTE } from '../worker/lib/schedule-calendar.js';
import { claimScheduleOccurrence, dispatchSchedule, scheduleKey, schedulerState } from '../worker/lib/scheduler.js';
import { runPipeline } from '../worker/lib/pipeline.js';
import { handleAgentApi, sanitizeConfigPatch } from '../worker/lib/api.js';

// SQL reale, adapter della sola superficie D1 usata qui. Batch con rollback.
class D1 {
  sqlite = new DatabaseSync(':memory:');
  prepare(sql) {
    const stmt = () => this.sqlite.prepare(sql);
    const wrap = values => ({
      bind: (...args) => wrap(args),
      first: async () => stmt().get(...values) ?? null,
      all: async () => ({ results: stmt().all(...values) }),
      run: async () => ({ meta: stmt().run(...values) }),
    });
    return wrap([]);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = []; for (const stmt of statements) result.push(await stmt.all()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const time = value => Date.parse(value);
const monday = time('2026-09-14T07:00:00Z'); // 09:00 Roma
const config = { ...DEFAULT_CONFIG, rebalanceMinute: 0 };
const rebalances = (c, from, to) => calendarOccurrences(c, from, to, { rebalanceOnly: true });
async function setup(t, patch = {}) {
  const db = new D1(); t.after(() => db.sqlite.close()); await migrate(db);
  await saveConfig(db, { ...config, ...patch });
  return db;
}
const rows = db => db.sqlite.prepare("SELECT * FROM schedule_occurrences WHERE kind = 'rebalance' ORDER BY due_at_utc").all();
const tick = (db, now, run, scheduledAt = now) => dispatchSchedule({ env: { DB: db }, now, scheduledAt, run });
const noRun = async () => { throw new Error('Pipeline inattesa'); };
function successfulRun(db, now, effects) {
  return async args => {
    const runId = crypto.randomUUID();
    const lock = await acquirePipelineLock(db, runId, { now });
    if (!lock.acquired) return { runId: null, busy: true, reason: 'busy' };
    try {
      if (!await claimScheduleOccurrence(db, args.scheduleOccurrence, runId, now)) return { runId: null, status: 'blocked' };
      effects.push(runId);
      db.sqlite.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(runId, args.kind, now, now + 100, 'ok', 'shadow', 0, null);
      return { runId, status: 'ok' };
    } finally { await releasePipelineLock(db, runId); }
  };
}
test('orari 09:00, 09:30 e minuto fuori griglia, con UTC estivo/invernale', () => {
  for (const minute of [0, 17, 30, 59]) {
    const c = { ...config, rebalanceMinute: minute };
    assert.equal(rebalances(c, monday - MINUTE, monday + 60 * MINUTE)[0].dueAt, monday + minute * MINUTE);
    assert.equal(nextRebalance(c, time('2026-01-04T12:00Z')).dueAt, time('2026-01-05T08:00Z') + minute * MINUTE);
  }
});
test('DST: fold una sola volta, gap esplicitamente saltato', () => {
  const c = { ...config, rebalanceWeekday: 7, rebalanceHour: 2, rebalanceMinute: 30 };
  const autumn = rebalances(c, time('2026-10-24T22:00Z'), time('2026-10-25T04:00Z'));
  assert.equal(autumn.length, 1); assert.equal(autumn[0].dueAt, time('2026-10-25T00:30Z'));
  const spring = rebalances(c, time('2026-03-28T23:00Z'), time('2026-03-29T04:00Z'));
  assert.equal(spring.length, 1); assert.equal(spring[0].skipReason, 'dst_nonexistent');
  assert.equal(spring[0].localDue, '2026-03-29 02:30');
});
test('mesi corti: 31 diventa ultimo giorno, incluso febbraio bisestile', () => {
  const c = { ...config, cadence: 'monthly', rebalanceDayOfMonth: 31 };
  assert.equal(nextRebalance(c, time('2026-02-01T00:00Z')).localDue, '2026-02-28 09:00');
  assert.equal(nextRebalance(c, time('2028-02-01T00:00Z')).localDue, '2028-02-29 09:00');
  assert.equal(nextRebalance(c, time('2026-04-01T00:00Z')).localDue, '2026-04-30 09:00');
});
test('weekend escluso dal daily, festività non inventate: decide il mercato nella pipeline', () => {
  const c = { ...config, cadence: 'daily' };
  assert.equal(rebalances(c, time('2026-09-11T22:00Z'), time('2026-09-13T21:59Z')).length, 0);
  assert.equal(rebalances(c, time('2026-04-05T22:00Z'), time('2026-04-06T21:59Z')).length, 1);
});
test('snapshot/heartbeat restano orari e il rebalance sostituisce lo stesso slot', () => {
  const slots = calendarOccurrences(config, monday - MINUTE, monday + 59 * MINUTE);
  assert.deepEqual(slots.map(x => x.kind), ['rebalance']);
  const heartbeat = calendarOccurrences({ ...config, cadence: 'monthly' }, monday - MINUTE, monday + 59 * MINUTE);
  assert.deepEqual(heartbeat.map(x => x.kind), ['heartbeat']);
});
test('validazione calendario rifiuta frazioni, booleani e fuori intervallo', () => {
  for (const [key, bad] of [['rebalanceHour', 9.5], ['rebalanceDayOfMonth', 32], ['rebalanceWeekday', 0], ['scheduleRecoveryMinutes', 181], ['rebalanceMinute', true]]) {
    assert.ok(sanitizeConfigPatch({ [key]: bad }).rejected.length);
  }
  assert.deepEqual(sanitizeConfigPatch({ rebalanceMinute: 17, rebalanceDayOfMonth: 31, scheduleRecoveryMinutes: 90 }).rejected, []);
});
test('primo avvio non recupera scadenze anteriori all’attivazione', async t => {
  const db = await setup(t); await tick(db, monday + 10 * MINUTE, noRun);
  assert.equal(rows(db).length, 0);
  assert.equal((await schedulerState(db, await loadConfig(db), monday)).initialized, true);
});
test('tick mancanti e consegna tardiva recuperano la scadenza una sola volta', async t => {
  const db = await setup(t); const effects = [];
  await tick(db, monday - MINUTE, noRun);
  await tick(db, monday + 20 * MINUTE, successfulRun(db, monday + 20 * MINUTE, effects), monday);
  await tick(db, monday + 21 * MINUTE, noRun, monday);
  assert.equal(effects.length, 1); assert.equal(rows(db)[0].status, 'completed');
  assert.equal(rows(db)[0].due_at_utc, monday);
});
test('busy resta pendente; il riavvio può recuperare senza perdere la scadenza', async t => {
  const db = await setup(t); const effects = [];
  await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ runId: null, busy: true, reason: 'busy' }));
  assert.equal(rows(db)[0].status, 'pending'); assert.equal(rows(db)[0].reason_code, 'pipeline_busy');
  await tick(db, monday + MINUTE, successfulRun(db, monday + MINUTE, effects));
  assert.equal(rows(db)[0].attempts, 2); assert.equal(effects.length, 1);
});
test('scadenza troppo vecchia viene registrata ma non avvia la pipeline', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday + 61 * MINUTE, async args => {
    assert.notEqual(args.kind, 'rebalance'); return { runId: null, busy: true };
  });
  assert.equal(rows(db)[0].status, 'expired'); assert.equal(rows(db)[0].attempts, 0);
});
test('due claim concorrenti: un solo vincitore anche con lo stesso lock', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ busy: true }));
  await acquirePipelineLock(db, 'one', { now: monday });
  const occurrence = { id: rows(db)[0].id, configKey: scheduleKey(await loadConfig(db)) };
  const claims = await Promise.all([claimScheduleOccurrence(db, occurrence, 'one', monday), claimScheduleOccurrence(db, occurrence, 'one', monday)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(rows(db)[0].run_id, 'one');
});
test('il vero ingresso pipeline rifiuta un’occorrenza già acquisita prima di ogni fetch', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ busy: true }));
  const row = rows(db)[0];
  db.sqlite.prepare("UPDATE schedule_occurrences SET status = 'completed' WHERE id = ?").run(row.id);
  const result = await runPipeline({ env: { DB: db }, kind: 'rebalance', scheduleOccurrence: { id: row.id, configKey: scheduleKey(await loadConfig(db)) } });
  assert.equal(result.reason, 'occurrence_unavailable'); assert.equal(result.runId, null);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
});
test('claim richiede lock vivo, versione attiva e deadline non superata', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ busy: true }));
  const occurrence = { id: rows(db)[0].id, configKey: scheduleKey(await loadConfig(db)) };
  assert.equal(await claimScheduleOccurrence(db, occurrence, 'no-lock', monday), false);
  await acquirePipelineLock(db, 'one', { now: monday + 61 * MINUTE });
  assert.equal(await claimScheduleOccurrence(db, occurrence, 'one', monday + 61 * MINUTE), false);
});
test('crash prima del claim: la scadenza resta recuperabile', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await assert.rejects(tick(db, monday, async () => { throw new Error('isolate interrupted'); }));
  const effects = []; await tick(db, monday + MINUTE, successfulRun(db, monday + MINUTE, effects));
  assert.equal(effects.length, 1);
});
test('crash dopo claim e dopo POST/parziale: nessun secondo invio automatico', async t => {
  for (const withOrder of [false, true]) {
    const db = await setup(t); await tick(db, monday - MINUTE, noRun);
    await assert.rejects(tick(db, monday, async args => {
      await acquirePipelineLock(db, 'crashed', { now: monday, leaseMs: 1000 });
      assert.ok(await claimScheduleOccurrence(db, args.scheduleOccurrence, 'crashed', monday));
      if (withOrder) {
        db.sqlite.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('crashed', 'rebalance', monday, null, 'running', 'live', null, null);
        db.sqlite.prepare(`INSERT INTO orders (id, run_id, seq, created_at, updated_at, symbol, instrument_id, side, amount_usd, mode, state, filled_usd)
          VALUES ('post-1', 'crashed', 1, ?, ?, 'TEST', 1, 'buy', 100, 'live', 'partial', 50)`).run(monday, monday);
      }
      throw new Error('crash');
    }));
    await tick(db, monday + MINUTE, noRun);
    assert.equal(rows(db)[0].status, 'needs_review'); assert.equal(rows(db)[0].attempts, 1);
    assert.equal((await schedulerState(db, await loadConfig(db), monday)).unresolved.length, 1);
  }
});
test('crash dopo finishRun: esito riconciliato senza ripetere la run', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await assert.rejects(tick(db, monday, async args => {
    await successfulRun(db, monday, [])(args); throw new Error('journal write interrupted');
  }));
  assert.equal(rows(db)[0].status, 'claimed');
  await tick(db, monday + MINUTE, noRun);
  assert.equal(rows(db)[0].status, 'completed'); assert.equal(rows(db)[0].reason_code, 'run_reconciled');
});
test('cambio calendario invalida le scadenze pendenti e i vecchi claim', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ busy: true }));
  const old = { id: rows(db)[0].id, configKey: scheduleKey(await loadConfig(db)) };
  await saveConfig(db, { rebalanceMinute: 30 });
  await acquirePipelineLock(db, 'old', { now: monday + MINUTE });
  assert.equal(await claimScheduleOccurrence(db, old, 'old', monday + MINUTE), false);
  await releasePipelineLock(db, 'old');
  await tick(db, monday + MINUTE, noRun);
  assert.equal(rows(db)[0].status, 'cancelled');
  const effects = []; await tick(db, monday + 30 * MINUTE, successfulRun(db, monday + 30 * MINUTE, effects));
  assert.equal(effects.length, 1); assert.equal(rows(db)[1].schedule_version, 2);
});
test('freeze e blocco mercato sono registrati senza attenuare i guardrail', async t => {
  const frozenDb = await setup(t, { frozen: true });
  // saveConfig esclude i campi safety: simuliamo la mutazione atomica dell’endpoint.
  frozenDb.sqlite.prepare("UPDATE config SET value = json_set(value, '$.frozen', json('true'))").run();
  await tick(frozenDb, monday - MINUTE, noRun); await tick(frozenDb, monday, noRun);
  assert.equal(rows(frozenDb)[0].reason_code, 'autopilot_frozen');
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async args => {
    await acquirePipelineLock(db, 'closed', { now: monday });
    await claimScheduleOccurrence(db, args.scheduleOccurrence, 'closed', monday);
    await releasePipelineLock(db, 'closed');
    return { runId: 'closed', status: 'blocked', error: 'Mercato chiuso' };
  });
  await tick(db, monday + MINUTE, noRun);
  assert.equal(rows(db)[0].reason, 'Mercato chiuso'); assert.equal(rows(db)[0].status, 'blocked');
});
test('schema manuale e migrazione runtime includono lo stesso scheduler', async t => {
  const db = await setup(t);
  db.sqlite.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('schedule_state','schedule_occurrences')").get().n, 2);
});

test('errore nel batch: nessun avanzamento cursore, recupero integro al tick seguente', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  const original = db.batch.bind(db);
  db.batch = statements => original([...statements, db.prepare('INSERT INTO missing_table VALUES (1)')]);
  await assert.rejects(tick(db, monday, noRun));
  assert.equal(rows(db).length, 0);
  assert.equal(db.sqlite.prepare('SELECT cursor_at FROM schedule_state').get().cursor_at, monday - MINUTE);
  db.batch = original;
  const effects = []; await tick(db, monday + MINUTE, successfulRun(db, monday + MINUTE, effects));
  assert.equal(effects.length, 1);
});
test('lettura configurazione sorpassata non può installare un calendario obsoleto', async t => {
  const db = await setup(t); const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (sql.startsWith('INSERT INTO schedule_state')) {
      db.sqlite.prepare("UPDATE config SET value = json_set(value, '$.rebalanceMinute', 30)").run();
    }
    return prepare(sql);
  };
  assert.equal((await tick(db, monday, noRun)).status, 'configuration_changed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM schedule_state').get().n, 0);
});
test('outage oltre un giorno: il cursore avanza per lotti senza perdere scadenze', async t => {
  const db = await setup(t, { cadence: 'daily' }); await tick(db, monday - MINUTE, noRun);
  const now = monday + 2 * 24 * 60 * MINUTE + 30 * MINUTE;
  await tick(db, now, noRun);
  assert.equal(rows(db).length, 1); assert.equal(rows(db)[0].status, 'expired');
  await tick(db, now, noRun);
  assert.equal(rows(db).length, 2); assert.equal(rows(db)[1].status, 'expired');
  const effects = []; await tick(db, now, successfulRun(db, now, effects));
  assert.equal(rows(db).length, 3); assert.equal(effects.length, 1);
});
test('claim consentito esattamente al termine, rifiutato subito dopo', async t => {
  for (const extraMs of [0, 1]) {
    const db = await setup(t); await tick(db, monday - MINUTE, noRun);
    await tick(db, monday, async () => ({ busy: true }));
    const now = monday + 60 * MINUTE + extraMs;
    await acquirePipelineLock(db, 'boundary', { now });
    assert.equal(await claimScheduleOccurrence(db, { id: rows(db)[0].id, configKey: scheduleKey(await loadConfig(db)) }, 'boundary', now), extraMs === 0);
  }
});
test('slot inesistente e heartbeat delle 03:00 hanno identità distinte', async t => {
  const db = await setup(t, { rebalanceWeekday: 7, rebalanceHour: 2, rebalanceMinute: 30 });
  const start = time('2026-03-29T00:59Z');
  await tick(db, start, noRun);
  await tick(db, time('2026-03-29T01:31Z'), noRun);
  assert.equal(rows(db)[0].status, 'skipped');
  const hourly = db.sqlite.prepare("SELECT * FROM schedule_occurrences WHERE kind = 'heartbeat'").all();
  assert.equal(hourly.length, 2);
  assert.notEqual(hourly[0].due_at_utc, hourly[1].due_at_utc);
});

test('stato API autenticato espone calendario e motivo persistito', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ runId: null, busy: true, reason: 'busy', error: 'Pipeline occupata' }));
  const env = { DB: db, CONTROL_TOKEN: 'test-only-token' };
  const response = await handleAgentApi(new Request('https://example.test/agent/state', {
    headers: { authorization: 'Bearer test-only-token' },
  }), env, {}, '/agent/state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.scheduler.recentRebalances[0].reason_code, 'pipeline_busy');
  assert.equal(state.scheduler.timezone, 'Europe/Rome');
  assert.equal(state.scheduler.recoveryMinutes, 60);
  assert.equal(JSON.stringify(state.scheduler).includes('config_key'), false);
  const unauthorized = await handleAgentApi(new Request('https://example.test/agent/state'), env, {}, '/agent/state');
  assert.equal(unauthorized.status, 401);
});

test('A→B→A fra due tick invalida comunque il lavoro pendente', async t => {
  const db = await setup(t); await tick(db, monday - MINUTE, noRun);
  await tick(db, monday, async () => ({ busy: true }));
  const before = await loadConfig(db);
  await saveConfig(db, { rebalanceMinute: 30 }); await saveConfig(db, { rebalanceMinute: 0 });
  const after = await loadConfig(db);
  assert.equal(after.scheduleRevision, before.scheduleRevision + 2);
  await tick(db, monday + MINUTE, noRun);
  assert.equal(rows(db)[0].status, 'cancelled'); assert.equal(rows(db).length, 1);
  await saveConfig(db, { lastManagedCapitalAt: 123 });
  assert.equal((await loadConfig(db)).scheduleRevision, after.scheduleRevision);
});
test('modifica salvata prima delle 09:00 non perde la scadenza al tick delle 09:00', async t => {
  const db = await setup(t, { rebalanceMinute: 30 }); await tick(db, monday - 2 * MINUTE, noRun);
  await saveConfig(db, { rebalanceMinute: 0 });
  db.sqlite.prepare("UPDATE config SET value = json_set(value, '$.scheduleChangedAt', ?)").run(monday - MINUTE);
  const effects = []; await tick(db, monday, successfulRun(db, monday, effects));
  assert.equal(effects.length, 1); assert.equal(rows(db)[0].due_at_utc, monday);
});
