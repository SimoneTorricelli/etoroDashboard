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
  `CREATE TABLE IF NOT EXISTS holdings_ledger (symbol TEXT PRIMARY KEY, instrument_id INTEGER, first_bought_at INTEGER, last_bought_at INTEGER, last_sold_at INTEGER, average_down_count INTEGER NOT NULL DEFAULT 0, opportunistic INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS watcher_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, symbol TEXT NOT NULL, instrument_id INTEGER, kind TEXT NOT NULL, metrics_json TEXT, classification TEXT, confidence REAL, rationale TEXT, action TEXT NOT NULL, run_id TEXT, model TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_watcher_at ON watcher_events (at DESC)`,
  `CREATE TABLE IF NOT EXISTS universe_cache (symbol TEXT PRIMARY KEY, instrument_id INTEGER NOT NULL, name TEXT, asset_class TEXT, matched_as TEXT, updated_at INTEGER NOT NULL)`,
];

/**
 * Configurazione di default. Ogni valore è sovrascrivibile da `PUT /agent/config`
 * e viene fuso con questi default a ogni lettura, così l'aggiunta di nuovi
 * parametri non richiede migrazioni.
 */
export const DEFAULT_CONFIG = {
  /** shadow: nessun ordine. dry-run: ordini costruiti e simulati. live: invio reale. */
  executionMode: 'shadow',

  /** defensive | balanced | dynamic | aggressive — vedi profiles.js */
  strategyProfile: 'balanced',
  /** Contratto generato dall'onboarding guidato; null mantiene compatibilità con le configurazioni storiche. */
  strategySpecVersion: 0,
  strategySpec: null,
  onboardingAnswers: null,
  onboardingComplete: false,
  strategyName: '',
  strategyGeneratedBy: '',
  strategyScenario: null,
  strategyDraft: null,
  strategyCollaboration: null,
  guidedOnboardingAnswers: null,
  policyUniverse: null,
  shadowStartedAt: 0,
  shadowDays: 14,
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
  /**
   * Binding verificato tra Autopilot e uno specifico Agent Portfolio.
   * Il segreto resta nel vault: qui persistono solo identità e verifica.
   */
  activeAgentPortfolioId: '',
  activeAgentPortfolioName: '',
  activeAgentPortfolioMirrorId: '',
  activeAgentPortfolioVirtualBalanceUsd: 0,
  agentTokenVerifiedAt: 0,
  agentTokenHint: '',
  agentTokenFingerprint: '',
  agentTokenOrigin: '',
  /** Cambio EUR→USD di fallback se le fonti FX non rispondono. */
  fallbackEurUsd: 1.08,
  /** Ultimo capitale reale del mirror eToro, mai il saldo virtuale dell'Agent. */
  lastManagedCapitalUsd: 0,
  lastManagedCapitalEur: 0,
  lastManagedCapitalAt: 0,
  lastManagedEurUsd: 0,
  /** Inizio della serie v2 basata esclusivamente sul mirror reale. */
  realCapitalTrackingStartedAt: 0,

  /**
   * fixed: l'AI riceve la whitelist e decide solo i pesi.
   * dynamic: l'AI sceglie gli strumenti da una shortlist estratta dal pool.
   */
  universeMode: 'fixed',
  /** Numero di candidati che superano lo screening e arrivano al modello. */
  shortlistSize: 18,
  /** Quanti strumenti al massimo/minimo tenere contemporaneamente. */
  maxHoldings: 8,
  minHoldings: 4,
  preferredHoldings: 6,
  /** Pool di candidati per la modalità dinamica. */
  pool: [],

  /** --- Disciplina anti-churn --- */
  /** Giorni minimi di detenzione prima di poter vendere (salvo stop). */
  minHoldingDays: 21,
  /** Giorni di attesa prima di ricomprare uno strumento venduto. */
  reentryCooldownDays: 30,
  /** Vantaggio di momentum richiesto per sostituire una posizione con un'altra. */
  substitutionEdge: 18,
  /** Costo stimato di andata e ritorno, in punti base. Sotto questa soglia non si opera. */
  transactionCostBps: 20,

  /** --- Watcher orario --- */
  watcherEnabled: false,
  /** Variazione giornaliera che fa scattare l'analisi contestuale. */
  watcherDropPct: 0.07,
  watcherSpikePct: 0.10,
  /** Moltiplicatore di volatilità che segnala un regime anomalo. */
  watcherVolSpike: 2.0,
  /** Quota di portafoglio riservata alle operazioni opportunistiche. */
  opportunisticBudgetPct: 0.08,
  maxOpportunisticPerWeek: 1,
  /** Quante volte al massimo si può mediare al ribasso sullo stesso strumento. */
  maxAverageDown: 1,
  /** Chiusure consecutive senza nuovi minimi richieste prima di entrare. */
  stabilizationBars: 2,
  /** Confidenza minima perché una classificazione del watcher sia operativa. */
  watcherMinConfidence: 0.65,

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
  /** Tetto dinamico per ordine rispetto al capitale reale gestito. */
  maxOrderPctOfCapital: 0.20,
  maxTurnoverPct: 0.20,         // quota max di portafoglio movimentata per run
  minRebalanceBandAbs: 0.03,    // scostamento assoluto minimo per agire
  minRebalanceBandRel: 0.15,    // scostamento relativo minimo per agire
  maxWeightPerClass: { etf: 0.80, bond: 0.40, commodity: 0.25, crypto: 0.20, cash: 1.0 },
  /** Tetto aggregato sulle esposizioni con settore esplicito nel catalogo. */
  maxSectorWeightPct: 0.30,
  minCashPct: 0.05,
  maxCashPct: 0.60,
  /** Quota che la strategia mira a mantenere investita in condizioni normali. */
  targetDeploymentPct: 0.95,
  /** Drawdown dal massimo storico che congela l'agente. */
  drawdownStopPct: 0.15,
  /** Divergenza tollerata in riconciliazione prima del freeze. */
  reconcileTolerancePct: 0.05,
  /** Confidenza minima della proposta perché sia eseguibile. */
  minConfidence: 0.55,

  /**
   * Provider AI abilitati. L'ordine non determina più la qualità: il router
   * costruisce una graduatoria globale dei modelli per capacità di reasoning.
   */
  llmProviders: ['workers-ai', 'gemini', 'groq', 'openrouter'],
  /** Include automaticamente nella cascata gli altri provider con credenziali disponibili. */
  llmFallbackAcrossProviders: true,
  /** Modelli per provider. Vuoto = si usano i default del provider. */
  llmModels: {
    'workers-ai': ['@cf/openai/gpt-oss-120b', '@cf/nvidia/nemotron-3-120b-a12b', '@cf/qwen/qwen3-30b-a3b-fp8'],
    gemini: ['gemini-3.7-flash', 'gemini-3.6-flash'],
    groq: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
    openrouter: [],
  },
  /** Mantiene l'ordine dichiarato: modelli migliori prima, fallback solo in caso di errore. */
  llmRoutingPolicy: 'quality-first',
  llmTemperature: 0.2,
  llmMaxTokens: 1600,
  /** Politica di rischio in linguaggio naturale, iniettata nel prompt. */
  riskProfile: 'Bilanciato. Priorità alla protezione del capitale, crescita moderata, nessuna leva, nessuno short.',
};

export const CONFIG_KEY = 'autopilot';

export async function migrate(db) {
  const statements = SCHEMA.map((statement) => db.prepare(statement));
  if (typeof db.batch === 'function') {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
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

export async function recordEquity(db, equityUsd, investedUsd, cashUsd, since = 0) {
  const previous = since > 0
    ? await db.prepare('SELECT hwm_usd FROM equity_curve WHERE at >= ? ORDER BY at DESC LIMIT 1').bind(since).first()
    : await db.prepare('SELECT hwm_usd FROM equity_curve ORDER BY at DESC LIMIT 1').first();
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
  const parsedLogs = (logs?.results ?? []).map((row) => ({ ...row, data: parse(row.data_json, null) }));
  const improvementLog = parsedLogs.find((row) => row.stage === 'improvement');
  return {
    run: run ?? null,
    snapshot: snapshot ? { ...snapshot, positions: parse(snapshot.positions_json, []) } : null,
    features: features ? parse(features.payload_json, null) : null,
    proposal: proposal ? { ...proposal, parsed: parse(proposal.parsed_json, null), attempts: parse(proposal.attempts_json, []) } : null,
    validation: validation ? { ok: !!validation.ok, violations: parse(validation.violations_json, []), plan: parse(validation.plan_json, null) } : null,
    orders: (orders?.results ?? []).map((row) => ({ ...row, positionIds: parse(row.position_ids, []) })),
    logs: parsedLogs,
    improvement: improvementLog?.data ?? null,
  };
}

// ------------------------------------------------------ registro posizioni

export async function loadLedger(db) {
  const { results } = await db.prepare('SELECT * FROM holdings_ledger').all();
  return new Map((results ?? []).map((row) => [row.symbol, row]));
}

/**
 * Allinea il registro alle posizioni realmente aperte: registra le prime
 * aperture e marca le uscite, così le regole di holding e cooldown lavorano
 * su dati veri anche se un ordine è stato fatto a mano su eToro.
 */
export async function syncLedger(db, openSymbols) {
  const now = Date.now();
  const ledger = await loadLedger(db);
  const open = new Set(openSymbols);
  const statements = [];

  for (const symbol of open) {
    const row = ledger.get(symbol);
    if (!row) {
      statements.push(db.prepare('INSERT OR REPLACE INTO holdings_ledger (symbol, first_bought_at, last_bought_at, last_sold_at, average_down_count, opportunistic, updated_at) VALUES (?, ?, ?, NULL, 0, 0, ?)')
        .bind(symbol, now, now, now));
      ledger.set(symbol, {
        symbol, first_bought_at: now, last_bought_at: now, last_sold_at: null,
        average_down_count: 0, opportunistic: 0, updated_at: now,
      });
    }
  }
  for (const [symbol, row] of ledger.entries()) {
    if (!open.has(symbol) && !row.last_sold_at) {
      statements.push(db.prepare('UPDATE holdings_ledger SET last_sold_at = ?, updated_at = ? WHERE symbol = ?')
        .bind(now, now, symbol));
      ledger.set(symbol, { ...row, last_sold_at: now, updated_at: now });
    }
    if (open.has(symbol) && row.last_sold_at) {
      statements.push(db.prepare('UPDATE holdings_ledger SET last_sold_at = NULL, last_bought_at = ?, updated_at = ? WHERE symbol = ?')
        .bind(now, now, symbol));
      ledger.set(symbol, { ...row, last_sold_at: null, last_bought_at: now, updated_at: now });
    }
  }
  if (statements.length) {
    if (typeof db.batch === 'function') await db.batch(statements);
    else for (const statement of statements) await statement.run();
  }
  return ledger;
}

export async function recordLedgerTrade(db, symbol, side, { opportunistic = false, averagingDown = false } = {}) {
  const now = Date.now();
  const existing = await db.prepare('SELECT * FROM holdings_ledger WHERE symbol = ?').bind(symbol).first();
  if (side === 'buy') {
    await db.prepare(`INSERT INTO holdings_ledger (symbol, first_bought_at, last_bought_at, last_sold_at, average_down_count, opportunistic, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET last_bought_at = excluded.last_bought_at, last_sold_at = NULL,
        average_down_count = holdings_ledger.average_down_count + ?, opportunistic = MAX(holdings_ledger.opportunistic, excluded.opportunistic), updated_at = excluded.updated_at`)
      .bind(symbol, existing?.first_bought_at ?? now, now, averagingDown ? 1 : 0, opportunistic ? 1 : 0, now, averagingDown ? 1 : 0)
      .run();
  } else {
    await db.prepare('UPDATE holdings_ledger SET last_sold_at = ?, average_down_count = 0, opportunistic = 0, updated_at = ? WHERE symbol = ?')
      .bind(now, now, symbol).run();
  }
}

// ------------------------------------------------------ eventi del watcher

export async function saveWatcherEvent(db, event) {
  await db.prepare(`INSERT INTO watcher_events (at, symbol, instrument_id, kind, metrics_json, classification, confidence, rationale, action, run_id, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      Date.now(), event.symbol, event.instrumentId ?? null, event.kind,
      JSON.stringify(event.metrics ?? {}),
      event.classification ?? null, event.confidence ?? null,
      (event.rationale ?? '').slice(0, 2000), event.action,
      event.runId ?? null, event.model ?? null,
    )
    .run();
}

export async function listWatcherEvents(db, limit = 50) {
  const { results } = await db.prepare('SELECT * FROM watcher_events ORDER BY at DESC LIMIT ?').bind(limit).all();
  return (results ?? []).map((row) => {
    let metrics = null;
    try { metrics = row.metrics_json ? JSON.parse(row.metrics_json) : null; } catch { metrics = null; }
    return { ...row, metrics };
  });
}

export async function countOpportunisticThisWeek(db) {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM watcher_events WHERE at > ? AND action = 'executed'").bind(since).first();
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------ cache universo

export async function cacheUniverse(db, entries) {
  if (!entries.length) return;
  const now = Date.now();
  const statements = entries.map((entry) => db.prepare('INSERT OR REPLACE INTO universe_cache (symbol, instrument_id, name, asset_class, matched_as, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(entry.symbol, entry.instrumentId, entry.name ?? '', entry.class ?? '', entry.matchedAs ?? entry.symbol, now));
  if (typeof db.batch === 'function') await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

export async function loadUniverseCache(db) {
  const { results } = await db.prepare('SELECT * FROM universe_cache').all();
  return new Map((results ?? []).map((row) => [row.symbol, row]));
}

export async function equityHistory(db, limit = 400, since = 0) {
  const query = since > 0
    ? db.prepare('SELECT * FROM equity_curve WHERE at >= ? ORDER BY at DESC LIMIT ?').bind(since, limit)
    : db.prepare('SELECT * FROM equity_curve ORDER BY at DESC LIMIT ?').bind(limit);
  const { results } = await query.all();
  return (results ?? []).reverse();
}
