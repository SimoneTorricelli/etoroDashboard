/**
 * Orchestratore della run: raccolta → feature → screening → cervello →
 * validazione → esecuzione → riconciliazione → audit.
 *
 * Ospita anche il watcher orario, che vive nello stesso cron ma segue un
 * percorso separato e molto più economico.
 */
import { EtoroClient } from './etoro.js';
import { collectExternalContext } from './sources.js';
import { buildFeatures, renderFeaturesPrompt } from './features.js';
import { buildShortlist, renderShortlistPrompt } from './screening.js';
import { askBrain } from './brain.js';
import { validateProposal } from './validator.js';
import { executePlan, reconcile, deterministicId } from './executor.js';
import { describeLedger } from './churn.js';
import { classifyAnomaly, decideWatcherAction, detectAnomalies } from './watcher.js';
import { notify } from './notify.js';
import { PROFILES, describeProfile } from './profiles.js';
import { resolveCredentials, missingRequired } from './vault.js';
import {
  audit, cacheUniverse, countOpportunisticThisWeek, countOrdersToday, equityHistory,
  finishRun, listWatcherEvents, loadConfig, loadLedger, loadUniverseCache, recordEquity,
  recordLedgerTrade, saveConfig, saveFeatures, saveProposal, saveSnapshot, saveValidation,
  saveWatcherEvent, startRun, syncLedger, upsertOrder,
} from './db.js';

const KV_CANDLES = 'candles:v1:';

export function romeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    weekday: weekdayMap[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    day: Number(parts.day),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Decide che tipo di run eseguire in base a cadenza e ora locale italiana. */
export function decideKind(config, parts) {
  if (parts.hour === config.rebalanceHour) {
    if (config.cadence === 'daily' && parts.weekday <= 5) return 'rebalance';
    if (config.cadence === 'weekly' && parts.weekday === config.rebalanceWeekday) return 'rebalance';
    if (config.cadence === 'monthly' && parts.day === config.rebalanceDayOfMonth) return 'rebalance';
  }
  if ((config.snapshotHours ?? []).includes(parts.hour)) return 'snapshot';
  return 'heartbeat';
}

function buildClient(credentials) {
  const missing = missingRequired(credentials).filter((label) => label.startsWith('eToro'));
  if (missing.length) throw new Error(`credenziali mancanti: ${missing.join(', ')}`);
  return new EtoroClient({
    apiKey: credentials.etoroApiKey,
    // Sull'Agent Portfolio si legge e si opera con il suo token dedicato.
    userKey: credentials.etoroAgentToken || credentials.etoroUserKey,
    agentToken: credentials.etoroAgentToken || '',
  });
}

/** Elenco di strumenti da considerare: whitelist fissa oppure pool dinamico. */
function universeSource(config) {
  const entries = config.universeMode === 'dynamic' && config.pool?.length ? config.pool : config.whitelist;
  return entries ?? [];
}

/**
 * Risolve i simboli in instrumentId. La cache su D1 è permanente: un simbolo
 * risolto una volta non viene più cercato, così il pool può crescere senza
 * moltiplicare le chiamate a eToro.
 */
async function resolveUniverse(client, db, config) {
  const cache = await loadUniverseCache(db);
  const universe = new Map();
  const fresh = [];
  const unresolved = [];

  for (const entry of universeSource(config)) {
    const cached = cache.get(entry.symbol);
    if (cached?.instrument_id) {
      universe.set(entry.symbol, { ...entry, instrumentId: cached.instrument_id, name: cached.name || entry.name });
      continue;
    }
    try {
      const found = await client.searchInstrument(entry.symbol);
      if (found?.instrumentId) {
        const resolvedEntry = { ...entry, instrumentId: found.instrumentId, name: found.name || entry.name, matchedAs: found.matchedAs };
        universe.set(entry.symbol, resolvedEntry);
        fresh.push(resolvedEntry);
      } else {
        unresolved.push(entry.symbol);
      }
    } catch {
      unresolved.push(entry.symbol);
    }
  }

  if (fresh.length) await cacheUniverse(db, fresh);
  return { universe, unresolved };
}

/** Serie giornaliere con cache 12h: riduce di molto le chiamate a eToro. */
async function loadCandles(client, env, universe) {
  const candles = new Map();
  for (const [symbol, meta] of universe.entries()) {
    const key = `${KV_CANDLES}${meta.instrumentId}`;
    if (env.STATE) {
      try {
        const cached = await env.STATE.get(key, 'json');
        if (cached?.rows?.length) { candles.set(symbol, cached.rows); continue; }
      } catch { /* cache non disponibile */ }
    }
    try {
      const rows = await client.candles(meta.instrumentId, 'OneDay', 260);
      if (rows.length) {
        candles.set(symbol, rows);
        if (env.STATE) {
          try { await env.STATE.put(key, JSON.stringify({ rows }), { expirationTtl: 60 * 60 * 12 }); } catch { /* ignora */ }
        }
      }
    } catch { /* strumento senza storico: le feature saranno parziali */ }
  }
  return candles;
}

// ---------------------------------------------------------------- watcher

/**
 * Scan orario. Il gate deterministico fa sì che l'AI venga interpellata solo
 * per anomalie reali: nella stragrande maggioranza delle ore non costa nulla.
 */
async function runWatcher({ env, db, config, credentials, client, snapshot, features, universe, candles, external, runId, mode }) {
  const anomalies = detectAnomalies({ universe, candles, features, config });
  if (!anomalies.length) return { anomalies: 0, escalated: 0, actions: [] };

  await audit(db, runId, 'info', 'watcher', `${anomalies.length} anomalie rilevate`, anomalies.map((item) => ({ symbol: item.symbol, kind: item.kind, day: item.metrics.dayChangePct })));

  const ledger = await loadLedger(db);
  const opportunisticThisWeek = await countOpportunisticThisWeek(db);
  const budgetUsd = snapshot.equityUsd * config.opportunisticBudgetPct;
  const actions = [];
  let escalated = 0;

  // Solo le tre anomalie più gravi vengono classificate: limita il costo e il rumore.
  for (const anomaly of anomalies.slice(0, 3)) {
    const verdict = await classifyAnomaly({ config, credentials, env, anomaly, news: external.news });
    escalated += 1;

    const decision = decideWatcherAction({
      anomaly, verdict, config, ledger, budgetUsd,
      opportunisticThisWeek: opportunisticThisWeek + actions.filter((item) => item.action === 'buy').length,
      equityUsd: snapshot.equityUsd,
    });

    let executed = false;
    if (decision.action === 'buy' && mode === 'live' && !config.frozen) {
      const id = await deterministicId(runId, `watch-${anomaly.symbol}`, anomaly.symbol, 'buy');
      try {
        const response = await client.openOrder({ instrumentId: anomaly.instrumentId, amountUsd: decision.amountUsd, requestId: id });
        await upsertOrder(db, {
          id, runId, seq: 900, symbol: anomaly.symbol, instrumentId: anomaly.instrumentId,
          side: 'buy', amountUsd: decision.amountUsd, mode, state: 'sent',
          etoroOrderId: String(response?.orderId ?? '') || null,
          message: `opportunistico: ${decision.reason}`.slice(0, 500),
        });
        await recordLedgerTrade(db, anomaly.symbol, 'buy', { opportunistic: true, averagingDown: anomaly.held });
        executed = true;
      } catch (error) {
        await audit(db, runId, 'error', 'watcher', `Ordine opportunistico fallito su ${anomaly.symbol}`, { message: error.message });
      }
    }

    await saveWatcherEvent(db, {
      symbol: anomaly.symbol,
      instrumentId: anomaly.instrumentId,
      kind: anomaly.kind,
      metrics: anomaly.metrics,
      classification: verdict?.classification ?? null,
      confidence: verdict?.confidence ?? null,
      rationale: verdict?.rationale ?? decision.reason,
      action: executed ? 'executed' : decision.action,
      runId,
      model: verdict?.model ?? null,
    });

    actions.push({ symbol: anomaly.symbol, kind: anomaly.kind, ...decision, verdict, executed });

    if (decision.action !== 'noop') {
      await notify(credentials, decision.action === 'propose_exit' ? 'warn' : 'info',
        `Watcher · ${anomaly.symbol} ${anomaly.metrics.dayChangePct}%`, [
          `Classificazione: ${verdict?.classification} (confidence ${verdict?.confidence?.toFixed(2)})`,
          verdict?.rationale ?? '',
          executed ? `Acquisto opportunistico eseguito: ${decision.amountUsd} USD` : `Azione proposta: ${decision.action}${mode === 'live' ? '' : ' (modalità non live: nessun ordine)'}`,
        ]);
    }
  }

  return { anomalies: anomalies.length, escalated, actions };
}

// ---------------------------------------------------------------- pipeline

export async function runPipeline({ env, kind, modeOverride }) {
  const db = env.DB;
  const config = await loadConfig(db);
  const { values: credentials } = await resolveCredentials(db, env);
  const mode = modeOverride ?? config.executionMode;
  const profile = PROFILES[config.strategyProfile] ?? PROFILES.balanced;
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${kind}-${crypto.randomUUID().slice(0, 8)}`;

  await startRun(db, runId, kind, mode);
  await audit(db, runId, 'info', 'start', `Run ${kind} avviata in modalità ${mode} · profilo ${profile.label}`);

  let equityUsd = null;
  try {
    const client = buildClient(credentials);

    // --- 1. Snapshot -------------------------------------------------------
    const snapshot = await client.portfolio();
    equityUsd = snapshot.equityUsd;
    await saveSnapshot(db, runId, snapshot);
    const { hwm, drawdown } = await recordEquity(db, snapshot.equityUsd, snapshot.investedUsd, snapshot.cashUsd);
    await audit(db, runId, 'info', 'snapshot', `Equity ${snapshot.equityUsd} USD, cash ${snapshot.cashUsd} USD, ${snapshot.positions.length} posizioni`, { hwm, drawdown });

    // --- 2. Circuit breaker ------------------------------------------------
    if (drawdown > config.drawdownStopPct && !config.frozen) {
      const reason = `drawdown ${(drawdown * 100).toFixed(1)}% oltre la soglia ${(config.drawdownStopPct * 100).toFixed(0)}%`;
      await saveConfig(db, { frozen: true, frozenReason: reason });
      await audit(db, runId, 'error', 'circuit-breaker', `Agente congelato: ${reason}`);
      await notify(credentials, 'critical', 'Autopilot congelato', [reason, `Equity ${snapshot.equityUsd} USD · massimo storico ${hwm} USD`]);
      await finishRun(db, runId, 'frozen', equityUsd, reason);
      return { runId, status: 'frozen', reason };
    }

    // --- 3. Universo, storici e contesto -----------------------------------
    const { universe, unresolved } = await resolveUniverse(client, db, config);
    if (!universe.size) throw new Error(`nessuno strumento risolto su eToro${unresolved.length ? ` (falliti: ${unresolved.join(', ')})` : ''}`);
    if (unresolved.length) await audit(db, runId, 'warn', 'universe', `Simboli non risolti: ${unresolved.join(', ')}`);

    const [candles, external] = await Promise.all([
      loadCandles(client, env, universe),
      collectExternalContext({
        finnhubKey: credentials.finnhubKey,
        marketauxKey: credentials.marketauxKey,
        fmpKey: credentials.fmpKey,
        symbols: [...universe.keys()],
        kv: env.STATE,
        // Sul ribilanciamento serve il dato fresco, sugli heartbeat no.
        ttlSeconds: kind === 'rebalance' ? 60 : 3 * 60 * 60,
      }),
    ]);
    const history = await equityHistory(db, 400);
    const features = buildFeatures({ snapshot, universe, candles, external, config, equityHistory: history });
    await saveFeatures(db, runId, features);

    // Il registro va allineato prima di qualunque decisione.
    const heldSymbols = new Set(features.instruments.filter((item) => item.weight > 0.001).map((item) => item.symbol));
    const ledger = await syncLedger(db, [...heldSymbols]);

    await audit(db, runId, 'info', 'features', `Feature su ${features.instruments.length} strumenti · regime ${features.regime.label}`, {
      failedSources: features.sourceDiagnostics.filter((item) => !item.ok).map((item) => item.name),
    });

    // --- 4. Watcher (gira su heartbeat e snapshot) -------------------------
    if (kind !== 'rebalance' && config.watcherEnabled) {
      const result = await runWatcher({ env, db, config, credentials, client, snapshot, features, universe, candles, external, runId, mode });
      await finishRun(db, runId, 'ok', equityUsd);
      return { runId, status: 'ok', kind, equityUsd, watcher: result };
    }
    if (kind === 'heartbeat' || kind === 'snapshot') {
      await finishRun(db, runId, 'ok', equityUsd);
      return { runId, status: 'ok', kind, equityUsd, regime: features.regime };
    }

    // --- 5. Screening ------------------------------------------------------
    const dynamic = config.universeMode === 'dynamic';
    const screening = buildShortlist({ universe, candles, heldSymbols, config, profile });
    const scores = new Map(screening.ranked.map((item) => [item.symbol, item.score]));
    const shortlistSymbols = screening.shortlist.map((item) => item.symbol);
    if (dynamic) {
      await audit(db, runId, 'info', 'screening', `Shortlist di ${shortlistSymbols.length} su ${screening.ranked.length} candidati`, {
        top: screening.shortlist.slice(0, 10).map((item) => ({ symbol: item.symbol, score: item.score, held: item.held })),
      });
    }

    // --- 6. Cervello -------------------------------------------------------

    const shortlistWithWeights = screening.shortlist.map((item) => ({
      ...item,
      weight: features.instruments.find((row) => row.symbol === item.symbol)?.weight ?? 0,
    }));
    const featuresPrompt = dynamic
      ? [renderFeaturesPrompt(features, config).split('\nSTRUMENTI')[0], renderShortlistPrompt(shortlistWithWeights)].join('\n')
      : renderFeaturesPrompt(features, config);
    const ledgerNotes = describeLedger(ledger, config);

    const brain = await askBrain({
      config,
      credentials,
      env,
      featuresPrompt,
      allowedSymbols: dynamic ? shortlistSymbols : [...universe.keys()],
      dynamic,
      profileDescription: describeProfile(config),
      ledgerNotes,
    });
    await saveProposal(db, runId, brain);
    if (!brain.ok) {
      await audit(db, runId, 'error', 'brain', 'Nessuna proposta valida dai modelli', brain.attempts);
      await finishRun(db, runId, 'error', equityUsd, brain.error);
      await notify(credentials, 'warn', 'Autopilot: nessuna proposta', [brain.error ?? '']);
      return { runId, status: 'error', error: brain.error, attempts: brain.attempts };
    }
    await audit(db, runId, 'info', 'brain', `Proposta da ${brain.model} (confidence ${brain.parsed.confidence})`, { targets: brain.parsed.targetWeights });

    // --- 7. Validazione ----------------------------------------------------
    const ordersToday = await countOrdersToday(db);
    const validation = validateProposal({ proposal: brain.parsed, features, config, ordersToday, ledger, scores });
    await saveValidation(db, runId, validation);
    await audit(db, runId, validation.ok ? 'info' : 'warn', 'validator',
      validation.ok ? `Piano valido: ${validation.plan.orders.length} ordini, turnover ${(validation.plan.turnoverPct * 100).toFixed(1)}%` : 'Piano bloccato dai guardrail',
      validation.violations);

    if (!validation.ok) {
      await finishRun(db, runId, 'blocked', equityUsd, validation.violations.filter((item) => item.severity === 'blocking').map((item) => item.message).join(' · '));
      return { runId, status: 'blocked', violations: validation.violations, plan: validation.plan };
    }

    if (!validation.plan.orders.length) {
      await audit(db, runId, 'info', 'executor', 'Nessuna azione: allocazione già entro le bande e la disciplina di rotazione');
      await finishRun(db, runId, 'ok', equityUsd);
      return { runId, status: 'ok', action: 'none', plan: validation.plan };
    }

    // --- 8. Esecuzione -----------------------------------------------------
    const execution = await executePlan({ db, client, runId, plan: validation.plan, mode, config });
    if (mode === 'live') {
      for (const record of execution.results) {
        if (record.state === 'filled' || record.state === 'partial' || record.state === 'sent') {
          await recordLedgerTrade(db, record.symbol, record.side);
        }
      }
    }
    await audit(db, runId, 'info', 'executor', `Esecuzione in modalità ${mode}: ${execution.results.length} ordini`,
      execution.results.map((item) => ({ symbol: item.symbol, side: item.side, amount: item.amountUsd, state: item.state })));

    // --- 9. Riconciliazione ------------------------------------------------
    let reconciliation = null;
    if (mode === 'live' && execution.executed) {
      reconciliation = await reconcile({ client, plan: validation.plan, config });
      await audit(db, runId, reconciliation.ok ? 'info' : 'error', 'reconcile', `Divergenza massima ${(reconciliation.worstDivergence * 100).toFixed(2)}%`, reconciliation.rows);
      if (!reconciliation.ok) {
        await saveConfig(db, { frozen: true, frozenReason: `riconciliazione fuori tolleranza (${(reconciliation.worstDivergence * 100).toFixed(2)}%)` });
        await notify(credentials, 'critical', 'Autopilot congelato dopo riconciliazione', [
          `Divergenza ${(reconciliation.worstDivergence * 100).toFixed(2)}%`,
          'Verifica manualmente le posizioni su eToro.',
        ]);
      }
    }

    await notify(credentials, 'info', `Autopilot ${mode} · ${validation.plan.orders.length} ordini`, [
      brain.parsed.rationale.slice(0, 400),
      ...execution.results.map((item) => `${item.side === 'buy' ? '+' : '−'}${item.amountUsd} USD ${item.symbol} [${item.state}]`),
    ]);

    await finishRun(db, runId, 'ok', equityUsd);
    return { runId, status: 'ok', mode, plan: validation.plan, execution, reconciliation, screening: dynamic ? screening.shortlist.length : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(db, runId, 'error', 'pipeline', message);
    await finishRun(db, runId, 'error', equityUsd, message);
    await notify(credentials, 'warn', 'Autopilot: run fallita', [message]);
    return { runId, status: 'error', error: message };
  }
}

export { listWatcherEvents };
