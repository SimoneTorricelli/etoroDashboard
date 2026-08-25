/**
 * Accesso D1 per l'Autopilot: migrazione idempotente, configurazione tipizzata,
 * audit log e persistenza di run/proposte/ordini.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, execution_mode TEXT NOT NULL, equity_usd REAL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL, equity_usd REAL NOT NULL, cash_usd REAL NOT NULL, invested_usd REAL NOT NULL, positions_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS features (run_id TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, payload_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS proposals (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, model TEXT, attempts_json TEXT, prompt_chars INTEGER, raw_text TEXT, parsed_json TEXT, confidence REAL, rationale TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS validations (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, ok INTEGER NOT NULL, violations_json TEXT NOT NULL, plan_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, symbol TEXT NOT NULL, instrument_id INTEGER NOT NULL, side TEXT NOT NULL, amount_usd REAL NOT NULL, position_id INTEGER, mode TEXT NOT NULL, state TEXT NOT NULL, etoro_order_id TEXT, position_ids TEXT, filled_usd REAL NOT NULL DEFAULT 0, message TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_run ON orders (run_id)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, at INTEGER NOT NULL, level TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at DESC)`,
  `CREATE TABLE IF NOT EXISTS equity_curve (at INTEGER PRIMARY KEY, equity_usd REAL NOT NULL, invested_usd REAL, cash_usd REAL, hwm_usd REAL)`,
];

/**
 * Configurazione di default. Ogni valore è sovrascrivibile da `PUT /agent/config`
 * e viene fuso con questi default a ogni lettura, così l'aggiunta di nuovi
 * parametri non richiede migrazioni.
 */
export const DEFAULT_CONFIG = {
  /** shadow: nessun ordine. dry-run: ordini costruiti e simulati. live: invio reale. */
  executionMode: 'shadow',
  /** Blocco totale attivato da circuit breaker o dall'utente. */
  frozen: false,
  frozenReason: '',

  cadence: 'weekly',            // daily | weekly | monthly
  rebalanceWeekday: 1,          // 1 = lunedì (solo per cadence weekly)
  rebalanceDayOfMonth: 1,       // solo per cadence monthly
  rebalanceHour: 9,             // ora locale Europe/Rome
  rebalanceMinute: 30,
  snapshotHours: [8, 14, 22],   // ore locali per lo snapshot giornaliero

  /** Capitale nominale gestito dall'agente, in EUR. */
  budgetEur: 250,
  /** Cambio EUR→USD di fallback se le fonti FX non rispondono. */
  fallbackEurUsd: 1.08,

  /** Universo ammesso: nessun ordine fuori da questa lista. */
  whitelist: [
    { symbol: 'SPY',  name: 'SPDR S&P 500 ETF',    class: 'etf',    maxWeight: 0.40 },
    { symbol: 'QQQ',  name: 'Invesco QQQ Trust',   class: 'etf',    maxWeight: 0.30 },
    { symbol: 'IWDA.L', name: 'iShares Core MSCI World', class: 'etf', maxWeight: 0.40 },
    { symbol: 'GLD',  name: 'SPDR Gold Shares',    class: 'commodity', maxWeight: 0.25 },
    { symbol: 'TLT',  name: 'iShares 20+ Treasury', class: 'bond',  maxWeight: 0.25 },
    { symbol: 'BTC',  name: 'Bitcoin',             class: 'crypto', maxWeight: 0.15 },
    { symbol: 'ETH',  name: 'Ethereum',            class: 'crypto', maxWeight: 0.10 },
  ],

  /** Guardrail non negoziabili. */
  maxOrdersPerRun: 6,
  maxOrdersPerDay: 8,
  minOrderUsd: 10,
  maxOrderUsd: 120,
  maxTurnoverPct: 0.20,         // quota max di portafoglio movimentata per run
  minRebalanceBandAbs: 0.03,    // scostamento assoluto minimo per agire
  minRebalanceBandRel: 0.15,    // scostamento relativo minimo per agire
  maxWeightPerClass: { etf: 0.80, bond: 0.40, commodity: 0.25, crypto: 0.20, cash: 1.0 },
  minCashPct: 0.05,
  maxCashPct: 0.60,
  /** Drawdown dal massimo storico che congela l'agente. */
  drawdownStopPct: 0.15,
  /** Divergenza tollerata in riconciliazione prima del freeze. */
  reconcileTolerancePct: 0.05,
  /** Confidenza minima della proposta perché sia eseguibile. */
  minConfidence: 0.55,

  /** Cascata modelli OpenRouter: il primo che risponde valido vince. */
  models: [
    'deepseek/deepseek-chat-v3-0324:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'qwen/qwen3-235b-a22b:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
    'google/gemma-3-27b-it:free',
  ],
  llmTemperature: 0.2,
  llmMaxTokens: 1600,
  /** Politica di rischio in linguaggio naturale, iniettata nel prompt. */
  riskProfile: 'Bilanciato. Priorità alla protezione del capitale, crescita moderata, nessuna leva, nessuno short.',
};

const CONFIG_KEY = 'autopilot';

export async function migrate(db) {
  for (const statement of SCHEMA) {
    await db.prepare(statement).run();
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = current && typeof current === 'object' && !Array.isArray(current)
      ? deepMerge(current, value)
      : value;
  }
  return out;
}

export async function loadConfig(db) {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(CONFIG_KEY).first();
  if (!row?.value) return { ...DEFAULT_CONFIG };
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(db, patch) {
  const current = await loadConfig(db);
  const next = deepMerge(current, patch);
  await db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(CONFIG_KEY, JSON.stringify(next), Date.now())
    .run();
  return next;
}

export async function audit(db, runId, level, stage, message, data) {
  await db.prepare('INSERT INTO audit (run_id, at, level, stage, message, data_json) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(runId ?? null, Date.now(), level, stage, String(message).slice(0, 2000), data === undefined ? null : JSON.stringify(data).slice(0, 20000))
    .run();
}

export async function startRun(db, id, kind, executionMode) {
  await db.prepare('INSERT INTO runs (id, kind, started_at, status, execution_mode) VALUES (?, ?, ?, ?, ?)')
    .bind(id, kind, Date.now(), 'running', executionMode)
    .run();
}

export async function finishRun(db, id, status, equityUsd, error) {
  await db.prepare('UPDATE runs SET finished_at = ?, status = ?, equity_usd = ?, error = ? WHERE id = ?')
    .bind(Date.now(), status, equityUsd ?? null, error ? String(error).slice(0, 1000) : null, id)
    .run();
}

export async function saveSnapshot(db, runId, snapshot) {
  await db.prepare('INSERT OR REPLACE INTO snapshots (run_id, taken_at, equity_usd, cash_usd, invested_usd, positions_json) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(runId, snapshot.takenAt, snapshot.equityUsd, snapshot.cashUsd, snapshot.investedUsd, JSON.stringify(snapshot.positions))
    .run();
}

export async function saveFeatures(db, runId, payload) {
  await db.prepare('INSERT OR REPLACE INTO features (run_id, computed_at, payload_json) VALUES (?, ?, ?)')
    .bind(runId, Date.now(), JSON.stringify(payload))
    .run();
}

export async function saveProposal(db, runId, proposal) {
  await db.prepare('INSERT OR REPLACE INTO proposals (run_id, created_at, model, attempts_json, prompt_chars, raw_text, parsed_json, confidence, rationale, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      runId,
      Date.now(),
      proposal.model ?? null,
      JSON.stringify(proposal.attempts ?? []),
      proposal.promptChars ?? null,
      (proposal.rawText ?? '').slice(0, 20000),
      proposal.parsed ? JSON.stringify(proposal.parsed) : null,
      proposal.parsed?.confidence ?? null,
      (proposal.parsed?.rationale ?? '').slice(0, 4000),
      proposal.error ? String(proposal.error).slice(0, 1000) : null,
    )
    .run();
}

export async function saveValidation(db, runId, validation) {
  await db.prepare('INSERT OR REPLACE INTO validations (run_id, created_at, ok, violations_json, plan_json) VALUES (?, ?, ?, ?, ?)')
    .bind(runId, Date.now(), validation.ok ? 1 : 0, JSON.stringify(validation.violations), JSON.stringify(validation.plan))
    .run();
}

export async function recordEquity(db, equityUsd, investedUsd, cashUsd) {
  const previous = await db.prepare('SELECT hwm_usd FROM equity_curve ORDER BY at DESC LIMIT 1').first();
  const hwm = Math.max(Number(previous?.hwm_usd ?? 0), equityUsd);
  await db.prepare('INSERT OR REPLACE INTO equity_curve (at, equity_usd, invested_usd, cash_usd, hwm_usd) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), equityUsd, investedUsd ?? null, cashUsd ?? null, hwm)
    .run();
  return { hwm, drawdown: hwm > 0 ? (hwm - equityUsd) / hwm : 0 };
}

export async function countOrdersToday(db) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at > ? AND state NOT IN ('simulated','skipped')").bind(since).first();
  return Number(row?.n ?? 0);
}

export async function upsertOrder(db, order) {
  await db.prepare(`INSERT INTO orders (id, run_id, seq, created_at, updated_at, symbol, instrument_id, side, amount_usd, position_id, mode, state, etoro_order_id, position_ids, filled_usd, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, state = excluded.state, etoro_order_id = excluded.etoro_order_id, position_ids = excluded.position_ids, filled_usd = excluded.filled_usd, message = excluded.message`)
    .bind(
      order.id, order.runId, order.seq, order.createdAt ?? Date.now(), Date.now(),
      order.symbol, order.instrumentId, order.side, order.amountUsd,
      order.positionId ?? null, order.mode, order.state,
      order.etoroOrderId ?? null,
      order.positionIds ? JSON.stringify(order.positionIds) : null,
      order.filledUsd ?? 0,
      order.message ? String(order.message).slice(0, 1000) : null,
    )
    .run();
}

export async function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
}

export async function listRuns(db, limit = 30) {
  const { results } = await db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').bind(limit).all();
  return results ?? [];
}

export async function getRunBundle(db, runId) {
  const [run, snapshot, features, proposal, validation, orders, logs] = await Promise.all([
    db.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first(),
    db.prepare('SELECT * FROM snapshots WHERE run_id = ?').bind(runId).first(),
    db.prepare('SELECT * FROM features WHERE run_id = ?').bind(runId).first(),
    db.prepare('SELECT * FROM proposals WHERE run_id = ?').bind(runId).first(),
    db.prepare('SELECT * FROM validations WHERE run_id = ?').bind(runId).first(),
    db.prepare('SELECT * FROM orders WHERE run_id = ? ORDER BY seq').bind(runId).all(),
    db.prepare('SELECT * FROM audit WHERE run_id = ? ORDER BY at').bind(runId).all(),
  ]);
  const parse = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
  return {
    run: run ?? null,
    snapshot: snapshot ? { ...snapshot, positions: parse(snapshot.positions_json, []) } : null,
    features: features ? parse(features.payload_json, null) : null,
    proposal: proposal ? { ...proposal, parsed: parse(proposal.parsed_json, null), attempts: parse(proposal.attempts_json, []) } : null,
    validation: validation ? { ok: !!validation.ok, violations: parse(validation.violations_json, []), plan: parse(validation.plan_json, null) } : null,
    orders: (orders?.results ?? []).map((row) => ({ ...row, positionIds: parse(row.position_ids, []) })),
    logs: (logs?.results ?? []).map((row) => ({ ...row, data: parse(row.data_json, null) })),
  };
}

export async function equityHistory(db, limit = 400) {
  const { results } = await db.prepare('SELECT * FROM equity_curve ORDER BY at DESC LIMIT ?').bind(limit).all();
  return (results ?? []).reverse();
}
