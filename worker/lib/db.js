/**
 * Accesso D1 per l'Autopilot: migrazione idempotente, configurazione tipizzata,
 * audit log e persistenza di run/proposte/ordini.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pipeline_lock (lock_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, lease_until INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, execution_mode TEXT NOT NULL, equity_usd REAL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL, equity_usd REAL NOT NULL, cash_usd REAL NOT NULL, invested_usd REAL NOT NULL, positions_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS features (run_id TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, payload_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS proposals (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, model TEXT, attempts_json TEXT, prompt_chars INTEGER, raw_text TEXT, parsed_json TEXT, confidence REAL, rationale TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS validations (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, ok INTEGER NOT NULL, violations_json TEXT NOT NULL, plan_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, symbol TEXT NOT NULL, instrument_id INTEGER NOT NULL, side TEXT NOT NULL, amount_usd REAL NOT NULL, position_id INTEGER, mode TEXT NOT NULL, state TEXT NOT NULL, etoro_order_id TEXT, position_ids TEXT, filled_usd REAL NOT NULL DEFAULT 0, message TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_run ON orders (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_live_recovery ON orders (mode, state, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, at INTEGER NOT NULL, level TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at DESC)`,
  `CREATE TABLE IF NOT EXISTS equity_curve (at INTEGER PRIMARY KEY, equity_usd REAL NOT NULL, invested_usd REAL, cash_usd REAL, hwm_usd REAL)`,
  `CREATE TABLE IF NOT EXISTS holdings_ledger (symbol TEXT PRIMARY KEY, instrument_id INTEGER, first_bought_at INTEGER, last_bought_at INTEGER, last_sold_at INTEGER, average_down_count INTEGER NOT NULL DEFAULT 0, opportunistic INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS watcher_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, symbol TEXT NOT NULL, instrument_id INTEGER, kind TEXT NOT NULL, metrics_json TEXT, classification TEXT, confidence REAL, rationale TEXT, action TEXT NOT NULL, run_id TEXT, model TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_watcher_at ON watcher_events (at DESC)`,
  `CREATE TABLE IF NOT EXISTS universe_cache (symbol TEXT PRIMARY KEY, instrument_id INTEGER NOT NULL, name TEXT, asset_class TEXT, matched_as TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS decision_artifacts (source_run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision_revision INTEGER NOT NULL, decision_hash TEXT NOT NULL, binding_hash TEXT NOT NULL, proposal_hash TEXT NOT NULL, consumed_at INTEGER, consumed_by_run_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_decision_artifacts_expiry ON decision_artifacts (expires_at DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS live_activation_requests (activation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL, source_run_id TEXT, response_json TEXT, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_live_activation_recovery ON live_activation_requests (status, updated_at DESC)`,
];

/**
 * Configurazione di default. Ogni valore è sovrascrivibile da `PUT /agent/config`
 * e viene fuso con questi default a ogni lettura, così l'aggiunta di nuovi
 * parametri non richiede migrazioni.
 */
export const DEFAULT_CONFIG = {
  /** shadow: nessun ordine. dry-run: ordini costruiti e simulati. live: invio reale. */
  executionMode: 'shadow',
  /** Epoch monotona: ogni stop/mode/freeze invalida le run già in corso. */
  safetyRevision: 0,
  /** Un esito Live ambiguo richiede verifica eToro prima dell'unfreeze. */
  recoveryRequired: false,
  recoveryReason: '',
  recoveryRunIds: [],
  recoveryUpdatedAt: 0,
  /** Revisione monotona delle sole impostazioni che cambiano una decisione. */
  decisionRevision: 0,

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
  /** Quota massima associata a una proposta opportunistica del Watcher. */
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
export const PIPELINE_LOCK_KEY = 'global';
export const PIPELINE_LOCK_LEASE_MS = 30 * 60 * 1000;

export async function migrate(db) {
  const statements = SCHEMA.map((statement) => db.prepare(statement));
  if (typeof db.batch === 'function') {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

/**
 * Prova ad acquisire il lease globale della pipeline con una singola scrittura.
 * La clausola WHERE dell'UPSERT fa sì che un lease ancora valido non possa
 * essere sottratto da una run concorrente; una run morta libera invece il lock
 * automaticamente alla scadenza.
 */
export async function acquirePipelineLock(db, ownerId, {
  now = Date.now(),
  leaseMs = PIPELINE_LOCK_LEASE_MS,
} = {}) {
  const owner = String(ownerId ?? '').trim().slice(0, 200);
  if (!owner) throw new TypeError('owner del lock pipeline mancante');
  const acquiredAt = Math.trunc(Number(now));
  const duration = Math.max(1_000, Math.trunc(Number(leaseMs)) || PIPELINE_LOCK_LEASE_MS);
  const leaseUntil = acquiredAt + duration;
  const row = await db.prepare(`INSERT INTO pipeline_lock (lock_key, owner_id, acquired_at, lease_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(lock_key) DO UPDATE SET
      owner_id = excluded.owner_id,
      acquired_at = excluded.acquired_at,
      lease_until = excluded.lease_until
    WHERE pipeline_lock.lease_until <= excluded.acquired_at
       OR pipeline_lock.owner_id = excluded.owner_id
    RETURNING owner_id, acquired_at, lease_until`)
    .bind(PIPELINE_LOCK_KEY, owner, acquiredAt, leaseUntil)
    .first();
  if (row?.owner_id === owner) {
    return {
      acquired: true,
      ownerId: owner,
      acquiredAt: Number(row.acquired_at),
      leaseUntil: Number(row.lease_until),
    };
  }
  const current = await db.prepare('SELECT owner_id, acquired_at, lease_until FROM pipeline_lock WHERE lock_key = ?')
    .bind(PIPELINE_LOCK_KEY)
    .first();
  return {
    acquired: false,
    ownerId: current?.owner_id ? String(current.owner_id) : null,
    acquiredAt: Number(current?.acquired_at) || null,
    leaseUntil: Number(current?.lease_until) || null,
  };
}

/** Estende il lease soltanto se appartiene ancora alla run chiamante. */
export async function renewPipelineLock(db, ownerId, {
  now = Date.now(),
  leaseMs = PIPELINE_LOCK_LEASE_MS,
} = {}) {
  const owner = String(ownerId ?? '').trim().slice(0, 200);
  if (!owner) return false;
  const renewedAt = Math.trunc(Number(now));
  const duration = Math.max(1_000, Math.trunc(Number(leaseMs)) || PIPELINE_LOCK_LEASE_MS);
  const row = await db.prepare(`UPDATE pipeline_lock
    SET lease_until = ?
    WHERE lock_key = ? AND owner_id = ? AND lease_until > ?
    RETURNING owner_id, lease_until`)
    .bind(renewedAt + duration, PIPELINE_LOCK_KEY, owner, renewedAt)
    .first();
  return row?.owner_id === owner;
}

/** Rilascia il lock soltanto se il lease appartiene ancora alla run chiamante. */
export async function releasePipelineLock(db, ownerId) {
  const owner = String(ownerId ?? '').trim().slice(0, 200);
  if (!owner) return false;
  const row = await db.prepare('DELETE FROM pipeline_lock WHERE lock_key = ? AND owner_id = ? RETURNING owner_id')
    .bind(PIPELINE_LOCK_KEY, owner)
    .first();
  return row?.owner_id === owner;
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

export async function saveConfig(db, patch, { decisionChange = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('patch configurazione non valida');
  }
  const safePatch = { ...patch };
  // Questi campi hanno endpoint atomici dedicati e non devono mai essere
  // ripristinati accidentalmente da una scrittura configurazione concorrente.
  delete safePatch.executionMode;
  delete safePatch.frozen;
  delete safePatch.frozenReason;
  delete safePatch.safetyRevision;
  delete safePatch.recoveryRequired;
  delete safePatch.recoveryReason;
  delete safePatch.recoveryRunIds;
  delete safePatch.recoveryUpdatedAt;
  delete safePatch.decisionRevision;

  const defaultsJson = JSON.stringify(DEFAULT_CONFIG);
  const patchJson = JSON.stringify(safePatch);
  const increment = decisionChange ? 1 : 0;
  const insertedRevision = Math.max(0, Math.trunc(Number(DEFAULT_CONFIG.decisionRevision) || 0)) + increment;
  const row = await db.prepare(`INSERT INTO config (key, value, updated_at)
    VALUES (
      ?,
      json_set(json_patch(json(?), json(?)), '$.decisionRevision', ?),
      ?
    )
    ON CONFLICT(key) DO UPDATE SET
      value = json_set(
        json_patch(
          CASE WHEN json_valid(config.value) THEN config.value ELSE json(?) END,
          json(?)
        ),
        '$.decisionRevision',
        CAST(COALESCE(json_extract(
          CASE WHEN json_valid(config.value) THEN config.value ELSE json(?) END,
          '$.decisionRevision'
        ), 0) AS INTEGER) + ?
      ),
      updated_at = excluded.updated_at
    RETURNING value`)
    .bind(
      CONFIG_KEY,
      defaultsJson,
      patchJson,
      insertedRevision,
      Date.now(),
      defaultsJson,
      patchJson,
      defaultsJson,
      increment,
    )
    .first();
  if (!row?.value) throw new Error('aggiornamento configurazione non confermato da D1');
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    throw new Error('D1 ha restituito una configurazione non valida');
  }
}

/**
 * Aggiorna esclusivamente lo stato di sicurezza con una singola istruzione SQL.
 *
 * Freeze, modalità e safe-stop usano JSON Merge Patch direttamente in SQLite:
 * i campi non di sicurezza restano intatti e la mutazione è atomica anche fra
 * richieste. `saveConfig()` ignora questi tre campi per lo stesso motivo.
 */
export async function mutateSafetyConfig(db, rawPatch) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'executionMode')) {
    if (!['shadow', 'dry-run', 'live'].includes(rawPatch.executionMode)) {
      throw new TypeError(`modalità di sicurezza non valida: ${String(rawPatch.executionMode)}`);
    }
    patch.executionMode = rawPatch.executionMode;
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'frozen')) {
    if (typeof rawPatch.frozen !== 'boolean') throw new TypeError('frozen deve essere booleano');
    patch.frozen = rawPatch.frozen;
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'frozenReason')) {
    if (typeof rawPatch.frozenReason !== 'string') throw new TypeError('frozenReason deve essere una stringa');
    patch.frozenReason = rawPatch.frozenReason.slice(0, 300);
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'recoveryRequired')) {
    if (typeof rawPatch.recoveryRequired !== 'boolean') throw new TypeError('recoveryRequired deve essere booleano');
    patch.recoveryRequired = rawPatch.recoveryRequired;
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'recoveryReason')) {
    if (typeof rawPatch.recoveryReason !== 'string') throw new TypeError('recoveryReason deve essere una stringa');
    patch.recoveryReason = rawPatch.recoveryReason.slice(0, 300);
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'recoveryRunIds')) {
    if (!Array.isArray(rawPatch.recoveryRunIds)) throw new TypeError('recoveryRunIds deve essere un array');
    patch.recoveryRunIds = [...new Set(rawPatch.recoveryRunIds
      .map((item) => String(item ?? '').trim().slice(0, 200))
      .filter(Boolean))].slice(0, 20);
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch ?? {}, 'recoveryUpdatedAt')) {
    const recoveryUpdatedAt = Math.max(0, Math.trunc(Number(rawPatch.recoveryUpdatedAt) || 0));
    patch.recoveryUpdatedAt = recoveryUpdatedAt;
  }
  if (!Object.keys(patch).length) throw new TypeError('nessuna mutazione di sicurezza valida');

  const defaultsJson = JSON.stringify(DEFAULT_CONFIG);
  const patchJson = JSON.stringify(patch);
  const insertedSafetyRevision = Math.max(0, Math.trunc(Number(DEFAULT_CONFIG.safetyRevision) || 0)) + 1;
  const row = await db.prepare(`INSERT INTO config (key, value, updated_at)
    VALUES (
      ?,
      json_set(json_patch(json(?), json(?)), '$.safetyRevision', ?),
      ?
    )
    ON CONFLICT(key) DO UPDATE SET
      value = json_set(
        json_patch(
          CASE WHEN json_valid(config.value) THEN config.value ELSE json(?) END,
          json(?)
        ),
        '$.safetyRevision',
        CAST(COALESCE(json_extract(
          CASE WHEN json_valid(config.value) THEN config.value ELSE json(?) END,
          '$.safetyRevision'
        ), 0) AS INTEGER) + 1
      ),
      updated_at = excluded.updated_at
    RETURNING value`)
    .bind(
      CONFIG_KEY,
      defaultsJson,
      patchJson,
      insertedSafetyRevision,
      Date.now(),
      defaultsJson,
      patchJson,
      defaultsJson,
    )
    .first();
  if (!row?.value) throw new Error('mutazione dello stato di sicurezza non confermata da D1');
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    throw new Error('D1 ha restituito uno stato di sicurezza non valido');
  }
}

/**
 * Rimuove un freeze soltanto dall'epoch esatta vista dall'utente. In questo
 * modo una richiesta mobile lenta non può cancellare un freeze più recente.
 */
export async function unfreezeSafetyConfig(db, { expectedSafetyRevision, recoveryConfirmed = false }) {
  const expected = Math.max(0, Math.trunc(Number(expectedSafetyRevision)));
  if (!Number.isFinite(Number(expectedSafetyRevision))) throw new TypeError('safetyRevision attesa non valida');
  const row = await db.prepare(`UPDATE config
    SET value = json_set(
          json_patch(value, json('{"executionMode":"shadow","frozen":false,"frozenReason":"","recoveryRequired":false,"recoveryReason":"","recoveryRunIds":[],"recoveryUpdatedAt":0}')),
          '$.safetyRevision',
          CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) + 1
        ),
        updated_at = ?
    WHERE key = ?
      AND json_valid(value)
      AND COALESCE(json_extract(value, '$.frozen'), 0) = 1
      AND CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) = ?
      AND (
        COALESCE(json_extract(value, '$.recoveryRequired'), 0) = 0
        OR ? = 1
      )
    RETURNING value`)
    .bind(Date.now(), CONFIG_KEY, expected, recoveryConfirmed ? 1 : 0)
    .first();
  if (!row?.value) return null;
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    throw new Error('D1 ha restituito uno stato di sblocco non valido');
  }
}

/**
 * Ritrova run Live recenti che erano state congelate dopo avere persistito
 * almeno un ordine reale. Il binding viene verificato sui dati dello snapshot
 * salvati nell'audit della run, così una run di un altro Agent Portfolio non
 * può essere riassociata per sola vicinanza temporale.
 */
export async function listDetachedLiveRecoveryRuns(db, {
  activeAgentPortfolioId,
  activeAgentPortfolioMirrorId = '',
  sinceAt = Date.now() - 30 * 24 * 60 * 60 * 1000,
  beforeAt = Date.now(),
  limit = 5,
} = {}) {
  const portfolioId = String(activeAgentPortfolioId ?? '').trim();
  const mirrorId = String(activeAgentPortfolioMirrorId ?? '').trim();
  if (!portfolioId) return [];
  const { results } = await db.prepare(`SELECT
      r.id, r.started_at, r.finished_at, r.status, r.error,
      lar.source_run_id,
      a.decision_revision AS artifact_decision_revision,
      a.decision_hash AS artifact_decision_hash,
      a.binding_hash AS artifact_binding_hash,
      COUNT(DISTINCT o.id) AS order_count,
      MAX(o.updated_at) AS last_order_updated_at
    FROM runs r
    JOIN proposals p ON p.run_id = r.id AND p.parsed_json IS NOT NULL
    JOIN validations v ON v.run_id = r.id AND v.ok = 1
    JOIN orders o ON o.run_id = r.id
      AND o.mode = 'live'
      AND o.state NOT IN ('simulated', 'skipped')
    JOIN audit snapshot_audit ON snapshot_audit.run_id = r.id
      AND snapshot_audit.stage = 'snapshot'
      AND json_valid(snapshot_audit.data_json)
    LEFT JOIN live_activation_requests lar ON lar.run_id = r.id
    LEFT JOIN decision_artifacts a ON a.source_run_id = lar.source_run_id
    WHERE r.kind = 'rebalance'
      AND r.execution_mode = 'live'
      AND r.status IN ('frozen', 'error')
      AND r.started_at >= ?
      AND r.started_at <= ?
      AND COALESCE(json_extract(snapshot_audit.data_json, '$.agentPortfolioId'), '') = ?
      AND (? = '' OR COALESCE(json_extract(snapshot_audit.data_json, '$.mirrorId'), '') = ?)
      AND EXISTS (
        SELECT 1
        FROM audit fail_safe
        WHERE fail_safe.run_id = r.id
          AND (
            fail_safe.stage IN (
              'reconcile-fail-safe',
              'executor-fail-safe',
              'pipeline-live-fail-safe',
              'live-response-final-fence',
              'live-recovery-barrier'
            )
            OR fail_safe.stage LIKE '%-cas-ambiguous'
          )
      )
    GROUP BY
      r.id, r.started_at, r.finished_at, r.status, r.error,
      lar.source_run_id,
      a.decision_revision, a.decision_hash, a.binding_hash
    ORDER BY r.started_at DESC
    LIMIT ?`)
    .bind(
      Math.max(0, Math.trunc(Number(sinceAt) || 0)),
      Math.max(0, Math.trunc(Number(beforeAt) || Date.now())),
      portfolioId,
      mirrorId,
      mirrorId,
      Math.min(Math.max(Number(limit) || 5, 1), 20),
    )
    .all();
  return results ?? [];
}

/**
 * Riassocia una run storica soltanto se lo stato osservato dall'utente è
 * ancora Shadow + Frozen, il binding è identico e nessun'altra recovery è già
 * collegata. L'incremento dell'epoch invalida anteprime concorrenti.
 */
export async function attachDetachedLiveRecoveryRunIfUnchanged(db, expected, runId) {
  const cleanRunId = String(runId ?? '').trim();
  if (!cleanRunId) throw new TypeError('runId Live da riassociare obbligatorio');
  const now = Date.now();
  const reason = `recovery Live riassociata dalla cronologia: ${cleanRunId}`.slice(0, 300);
  const row = await db.prepare(`UPDATE config
    SET value = json_set(
          value,
          '$.recoveryRunIds', json_array(?),
          '$.recoveryReason', ?,
          '$.recoveryUpdatedAt', ?,
          '$.safetyRevision',
          CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) + 1
        ),
        updated_at = ?
    WHERE key = ?
      AND json_valid(value)
      AND COALESCE(json_extract(value, '$.executionMode'), 'shadow') = 'shadow'
      AND COALESCE(json_extract(value, '$.frozen'), 0) = 1
      AND COALESCE(json_extract(value, '$.recoveryRequired'), 0) = 1
      AND COALESCE(json_array_length(value, '$.recoveryRunIds'), 0) = 0
      AND CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) = ?
      AND CAST(COALESCE(json_extract(value, '$.decisionRevision'), 0) AS INTEGER) = ?
      AND COALESCE(json_extract(value, '$.activeAgentPortfolioId'), '') = ?
      AND COALESCE(json_extract(value, '$.activeAgentPortfolioMirrorId'), '') = ?
      AND COALESCE(json_extract(value, '$.agentTokenFingerprint'), '') = ?
      AND CAST(COALESCE(json_extract(value, '$.agentTokenVerifiedAt'), 0) AS INTEGER) = ?
    RETURNING value`)
    .bind(
      cleanRunId,
      reason,
      now,
      now,
      CONFIG_KEY,
      Math.max(0, Math.trunc(Number(expected.safetyRevision) || 0)),
      Math.max(0, Math.trunc(Number(expected.decisionRevision) || 0)),
      String(expected.activeAgentPortfolioId ?? ''),
      String(expected.activeAgentPortfolioMirrorId ?? ''),
      String(expected.agentTokenFingerprint ?? ''),
      Math.max(0, Math.trunc(Number(expected.agentTokenVerifiedAt) || 0)),
    )
    .first();
  if (!row?.value) return null;
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    throw new Error('D1 ha restituito uno stato di recovery riassociata non valido');
  }
}

/**
 * Arma il Live con compare-and-swap sullo stato osservato a inizio run.
 * Un Safe stop, un freeze, un cambio strategia o un nuovo binding avvenuti
 * durante l'analisi fanno fallire l'UPDATE senza una finestra in cui inviare.
 */
export async function armLiveIfUnchanged(db, expected) {
  const row = await db.prepare(`UPDATE config
    SET value = json_set(
          json_patch(value, json('{"executionMode":"live"}')),
          '$.safetyRevision',
          CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) + 1
        ),
        updated_at = ?
    WHERE key = ?
      AND json_valid(value)
      AND COALESCE(json_extract(value, '$.frozen'), 0) = 0
      AND COALESCE(json_extract(value, '$.recoveryRequired'), 0) = 0
      AND COALESCE(json_extract(value, '$.executionMode'), 'shadow') = ?
      AND CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) = ?
      AND CAST(COALESCE(json_extract(value, '$.decisionRevision'), 0) AS INTEGER) = ?
      AND COALESCE(json_extract(value, '$.activeAgentPortfolioId'), '') = ?
      AND COALESCE(json_extract(value, '$.agentTokenFingerprint'), '') = ?
      AND CAST(COALESCE(json_extract(value, '$.agentTokenVerifiedAt'), 0) AS INTEGER) = ?
    RETURNING value`)
    .bind(
      Date.now(),
      CONFIG_KEY,
      String(expected.executionMode ?? 'shadow'),
      Math.max(0, Math.trunc(Number(expected.safetyRevision) || 0)),
      Math.max(0, Math.trunc(Number(expected.decisionRevision) || 0)),
      String(expected.activeAgentPortfolioId ?? ''),
      String(expected.agentTokenFingerprint ?? ''),
      Math.max(0, Math.trunc(Number(expected.agentTokenVerifiedAt) || 0)),
    )
    .first();
  if (!row?.value) return null;
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    throw new Error('D1 ha restituito uno stato Live non valido');
  }
}

/**
 * Arma esclusivamente una recovery esplicitamente confermata. A differenza
 * dell'attivazione Live ordinaria, lo stato di partenza deve essere proprio
 * Shadow + Frozen + recoveryRequired. La stessa CAS è usata sia prima del
 * residuo selezionato sia dalla presa d'atto manuale che non avvia alcuna run.
 */
export async function armRecoveryLiveIfUnchanged(db, expected) {
  const row = await db.prepare(`UPDATE config
    SET value = json_set(
          json_patch(value, json('{"executionMode":"live","frozen":false,"frozenReason":"","recoveryRequired":false,"recoveryReason":"","recoveryRunIds":[],"recoveryUpdatedAt":0}')),
          '$.safetyRevision',
          CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) + 1
        ),
        updated_at = ?
    WHERE key = ?
      AND json_valid(value)
      AND COALESCE(json_extract(value, '$.executionMode'), 'shadow') = 'shadow'
      AND COALESCE(json_extract(value, '$.frozen'), 0) = 1
      AND COALESCE(json_extract(value, '$.recoveryRequired'), 0) = 1
      AND CAST(COALESCE(json_extract(value, '$.safetyRevision'), 0) AS INTEGER) = ?
      AND CAST(COALESCE(json_extract(value, '$.decisionRevision'), 0) AS INTEGER) = ?
      AND COALESCE(json_extract(value, '$.activeAgentPortfolioId'), '') = ?
      AND COALESCE(json_extract(value, '$.agentTokenFingerprint'), '') = ?
      AND CAST(COALESCE(json_extract(value, '$.agentTokenVerifiedAt'), 0) AS INTEGER) = ?
    RETURNING value`)
    .bind(
      Date.now(),
      CONFIG_KEY,
      Math.max(0, Math.trunc(Number(expected.safetyRevision) || 0)),
      Math.max(0, Math.trunc(Number(expected.decisionRevision) || 0)),
      String(expected.activeAgentPortfolioId ?? ''),
      String(expected.agentTokenFingerprint ?? ''),
      Math.max(0, Math.trunc(Number(expected.agentTokenVerifiedAt) || 0)),
    )
    .first();
  if (!row?.value) return null;
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    throw new Error('D1 ha restituito uno stato Live di recovery non valido');
  }
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
  const row = await db.prepare("UPDATE runs SET finished_at = ?, status = ?, equity_usd = ?, error = ? WHERE id = ? AND status = 'running' RETURNING id, status")
    .bind(Date.now(), status, equityUsd ?? null, error ? String(error).slice(0, 1000) : null, id)
    .first();
  return row?.id === id;
}

/**
 * Terminalizza una run Live come `ok` soltanto nello stesso statement che
 * verifica mode, freeze, recovery ed epoch/binding attesi. Uno stop concorrente
 * vince prima o dopo questa CAS, ma non può inserirsi fra check e commit.
 */
export async function finishRunIfLiveFence(db, id, equityUsd, expected) {
  const row = await db.prepare(`UPDATE runs
    SET finished_at = ?, status = 'ok', equity_usd = ?, error = NULL
    WHERE id = ? AND status = 'running'
      AND EXISTS (
        SELECT 1 FROM config c
        WHERE c.key = ?
          AND json_valid(c.value)
          AND COALESCE(json_extract(c.value, '$.executionMode'), 'shadow') = 'live'
          AND COALESCE(json_extract(c.value, '$.frozen'), 0) = 0
          AND COALESCE(json_extract(c.value, '$.recoveryRequired'), 0) = 0
          AND CAST(COALESCE(json_extract(c.value, '$.safetyRevision'), 0) AS INTEGER) = ?
          AND CAST(COALESCE(json_extract(c.value, '$.decisionRevision'), 0) AS INTEGER) = ?
          AND COALESCE(json_extract(c.value, '$.activeAgentPortfolioId'), '') = ?
          AND COALESCE(json_extract(c.value, '$.agentTokenFingerprint'), '') = ?
          AND CAST(COALESCE(json_extract(c.value, '$.agentTokenVerifiedAt'), 0) AS INTEGER) = ?
      )
    RETURNING id`)
    .bind(
      Date.now(),
      equityUsd ?? null,
      id,
      CONFIG_KEY,
      Math.max(0, Math.trunc(Number(expected.safetyRevision) || 0)),
      Math.max(0, Math.trunc(Number(expected.decisionRevision) || 0)),
      String(expected.activeAgentPortfolioId ?? ''),
      String(expected.agentTokenFingerprint ?? ''),
      Math.max(0, Math.trunc(Number(expected.agentTokenVerifiedAt) || 0)),
    )
    .first();
  return row?.id === id;
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

/**
 * Barriera di recovery per crash/abort avvenuti durante una fase Live.
 *
 * Una activation in `arming-live`/`executing-live` senza risposta finale, o un
 * ordine rimasto in uno stato non riconciliato, impedisce qualunque nuova run
 * reale. Il chiamante deve portare l'agente in Shadow + Frozen e richiedere una
 * verifica manuale su eToro. La run corrente viene esclusa perché, mentre
 * possiede il lock, è legittimamente non terminale.
 */
export async function findLiveRecoveryBarrier(db, { excludeRunId = '' } = {}) {
  const excluded = String(excludeRunId ?? '');
  const [activation, order] = await Promise.all([
    db.prepare(`SELECT activation_id, run_id, status, source_run_id, updated_at
      FROM live_activation_requests
      WHERE response_json IS NULL
        AND status IN ('arming-live', 'executing-live')
        AND (? = '' OR run_id <> ?)
      ORDER BY updated_at DESC
      LIMIT 1`)
      .bind(excluded, excluded)
      .first(),
    db.prepare(`SELECT o.id, o.run_id, o.symbol, o.side, o.state, o.updated_at
      FROM orders o
      JOIN runs r ON r.id = o.run_id
      WHERE o.mode = 'live'
        AND r.status = 'running'
        AND o.state NOT IN ('simulated', 'skipped')
        AND (? = '' OR o.run_id <> ?)
      ORDER BY o.updated_at DESC
      LIMIT 1`)
      .bind(excluded, excluded)
      .first(),
  ]);
  if (!activation && !order) return null;
  return { activation: activation ?? null, order: order ?? null };
}

/**
 * Activation rimaste `running` non hanno ancora armato il Live. Dopo che un
 * nuovo owner ha acquisito il lock globale, possono essere chiuse senza
 * recovery eToro e i relativi claim dry-run possono essere rilasciati.
 */
export async function listStalePreArmActivations(db, { excludeActivationId = '', limit = 25 } = {}) {
  const { results } = await db.prepare(`SELECT activation_id, run_id, status, source_run_id, updated_at
    FROM live_activation_requests
    WHERE response_json IS NULL
      AND status = 'running'
      AND (? = '' OR activation_id <> ?)
    ORDER BY updated_at ASC
    LIMIT ?`)
    .bind(
      String(excludeActivationId ?? ''),
      String(excludeActivationId ?? ''),
      Math.min(Math.max(Number(limit) || 25, 1), 100),
    )
    .all();
  return results ?? [];
}

export async function listRuns(db, limit = 30) {
  const { results } = await db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').bind(limit).all();
  return results ?? [];
}

/** Piani recenti selezionabili durante una recovery, senza N+1 query D1. */
export async function listRecoveryPlanCandidates(db, limit = 12) {
  const { results } = await db.prepare(`SELECT
      r.id, r.started_at, r.finished_at, r.status, r.execution_mode,
      p.model, p.confidence, p.parsed_json,
      v.plan_json,
      s.equity_usd AS snapshot_equity_usd,
      s.cash_usd AS snapshot_cash_usd,
      s.positions_json AS snapshot_positions_json,
      a.decision_revision AS artifact_decision_revision,
      a.decision_hash AS artifact_decision_hash,
      a.binding_hash AS artifact_binding_hash
    FROM runs r
    JOIN proposals p ON p.run_id = r.id AND p.parsed_json IS NOT NULL
    JOIN validations v ON v.run_id = r.id AND v.ok = 1
    LEFT JOIN snapshots s ON s.run_id = r.id
    LEFT JOIN decision_artifacts a ON a.source_run_id = r.id
    WHERE r.kind = 'rebalance'
      AND r.execution_mode IN ('dry-run', 'live')
      AND r.status IN ('ok', 'blocked', 'frozen')
      AND r.finished_at IS NOT NULL
    ORDER BY r.started_at DESC
    LIMIT ?`)
    .bind(Math.min(Math.max(Number(limit) || 12, 1), 30))
    .all();
  const parse = (value) => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
  return (results ?? []).map((row) => ({
    ...row,
    proposal: parse(row.parsed_json),
    plan: parse(row.plan_json),
  }));
}

export async function saveDecisionArtifact(db, artifact) {
  await db.prepare(`INSERT INTO decision_artifacts (
    source_run_id, created_at, expires_at, decision_revision,
    decision_hash, binding_hash, proposal_hash, consumed_at, consumed_by_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  ON CONFLICT(source_run_id) DO NOTHING`)
    .bind(
      artifact.sourceRunId,
      artifact.createdAt,
      artifact.expiresAt,
      artifact.decisionRevision,
      artifact.decisionHash,
      artifact.bindingHash,
      artifact.proposalHash,
    )
    .run();
}

/** Ultima dry-run, anche fallita: una precedente non deve essere riusata di nascosto. */
export async function latestDryRunWithArtifact(db) {
  return db.prepare(`SELECT
      r.*,
      p.model AS proposal_model,
      p.confidence AS proposal_confidence,
      p.parsed_json,
      v.created_at AS validation_created_at,
      v.ok AS validation_ok,
      v.plan_json,
      a.source_run_id AS artifact_source_run_id,
      a.created_at AS artifact_created_at,
      a.expires_at,
      a.decision_revision,
      a.decision_hash,
      a.binding_hash,
      a.proposal_hash,
      a.consumed_at,
      a.consumed_by_run_id
    FROM runs r
    LEFT JOIN proposals p ON p.run_id = r.id
    LEFT JOIN validations v ON v.run_id = r.id
    LEFT JOIN decision_artifacts a ON a.source_run_id = r.id
    WHERE r.kind = 'rebalance' AND r.execution_mode = 'dry-run'
    ORDER BY r.started_at DESC
    LIMIT 1`).first();
}

/** Claim single-use dell'ultima dry-run, eseguito mentre il lock globale è posseduto. */
export async function claimLatestDecisionArtifact(db, {
  runId, now = Date.now(), decisionRevision, decisionHash, bindingHash,
}) {
  return db.prepare(`UPDATE decision_artifacts
    SET consumed_at = ?, consumed_by_run_id = ?
    WHERE source_run_id = (
      SELECT id FROM runs
      WHERE kind = 'rebalance' AND execution_mode = 'dry-run'
      ORDER BY started_at DESC LIMIT 1
    )
      AND consumed_at IS NULL
      AND expires_at > ?
      AND decision_revision = ?
      AND decision_hash = ?
      AND binding_hash = ?
      AND EXISTS (
        SELECT 1 FROM runs r
        WHERE r.id = decision_artifacts.source_run_id
          AND r.status IN ('ok', 'blocked') AND r.finished_at IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM proposals p
        WHERE p.run_id = decision_artifacts.source_run_id AND p.parsed_json IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM validations v
        WHERE v.run_id = decision_artifacts.source_run_id AND v.ok = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        WHERE o.run_id = decision_artifacts.source_run_id
          AND o.state NOT IN ('simulated', 'skipped')
      )
    RETURNING *`)
    .bind(now, runId, now, decisionRevision, decisionHash, bindingHash)
    .first();
}

/** Rilascia un claim soltanto se appartiene ancora alla run indicata. */
export async function releaseDecisionArtifactClaim(db, { sourceRunId, runId }) {
  const row = await db.prepare(`UPDATE decision_artifacts
    SET consumed_at = NULL, consumed_by_run_id = NULL
    WHERE source_run_id = ? AND consumed_by_run_id = ?
    RETURNING source_run_id`)
    .bind(String(sourceRunId ?? ''), String(runId ?? ''))
    .first();
  return row?.source_run_id === sourceRunId;
}

/** Recovery pre-arm: rilascia ogni claim posseduto dalla run abortita. */
export async function releaseDecisionArtifactClaimsByRun(db, runId) {
  const { results } = await db.prepare(`UPDATE decision_artifacts
    SET consumed_at = NULL, consumed_by_run_id = NULL
    WHERE consumed_by_run_id = ?
    RETURNING source_run_id`)
    .bind(String(runId ?? ''))
    .all();
  return (results ?? []).map((row) => String(row.source_run_id));
}

export async function getLiveActivation(db, activationId) {
  return db.prepare('SELECT * FROM live_activation_requests WHERE activation_id = ?')
    .bind(activationId)
    .first();
}

export async function reserveLiveActivation(db, activationId, runId, now = Date.now()) {
  const created = await db.prepare(`INSERT INTO live_activation_requests (
      activation_id, run_id, created_at, updated_at, status
    ) VALUES (?, ?, ?, ?, 'running')
    ON CONFLICT(activation_id) DO NOTHING
    RETURNING *`)
    .bind(activationId, runId, now, now)
    .first();
  if (created) return { created: true, row: created };
  return { created: false, row: await getLiveActivation(db, activationId) };
}

export async function setLiveActivationSource(db, activationId, sourceRunId) {
  const row = await db.prepare(`UPDATE live_activation_requests
    SET source_run_id = ?, updated_at = ?
    WHERE activation_id = ?
      AND response_json IS NULL
      AND status IN ('running', 'arming-live', 'executing-live')
    RETURNING activation_id`)
    .bind(sourceRunId, Date.now(), activationId)
    .first();
  if (row?.activation_id !== activationId) {
    throw new Error('provenienza dry-run non associata alla richiesta Live');
  }
}

export async function updateLiveActivationStatus(db, activationId, status) {
  const row = await db.prepare(`UPDATE live_activation_requests
    SET status = ?, updated_at = ?
    WHERE activation_id = ? AND response_json IS NULL
    RETURNING activation_id`)
    .bind(status, Date.now(), activationId)
    .first();
  if (row?.activation_id !== activationId) throw new Error('stato activation non aggiornato: richiesta già terminale');
}

export async function finishLiveActivation(db, activationId, status, response, error = null) {
  const row = await db.prepare(`UPDATE live_activation_requests
    SET status = ?, response_json = ?, error = ?, updated_at = ?
    WHERE activation_id = ? AND response_json IS NULL
    RETURNING *`)
    .bind(
      status,
      response == null ? null : JSON.stringify(response).slice(0, 100000),
      error == null ? null : String(error).slice(0, 1000),
      Date.now(),
      activationId,
    )
    .first();
  if (row) return { written: true, row };
  return { written: false, row: await getLiveActivation(db, activationId) };
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
  const row = await db.prepare("SELECT COUNT(*) AS n FROM watcher_events WHERE at > ? AND action IN ('buy', 'executed')").bind(since).first();
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
