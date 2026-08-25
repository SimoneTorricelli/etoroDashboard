/**
 * Orchestratore della run: raccolta → feature → cervello → validazione →
 * esecuzione → riconciliazione → audit. Ogni fase è isolata e persistita, così
 * una run interrotta resta comunque ispezionabile.
 */
import { EtoroClient } from './etoro.js';
import { collectExternalContext } from './sources.js';
import { buildFeatures, renderFeaturesPrompt } from './features.js';
import { askBrain } from './brain.js';
import { validateProposal } from './validator.js';
import { executePlan, reconcile } from './executor.js';
import { notify } from './notify.js';
import { missingRequired, resolveCredentials } from './vault.js';
import {
  audit, countOrdersToday, equityHistory, finishRun, loadConfig, recordEquity,
  saveConfig, saveFeatures, saveProposal, saveSnapshot, saveValidation, startRun,
} from './db.js';

const KV_UNIVERSE = 'universe:v1';
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
  const atRebalanceHour = parts.hour === config.rebalanceHour;
  if (atRebalanceHour) {
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

/** Risolve simbolo → instrumentId una volta sola, poi tiene in cache 30 giorni. */
async function resolveUniverse(client, env, config) {
  let cached = null;
  if (env.STATE) {
    try { cached = await env.STATE.get(KV_UNIVERSE, 'json'); } catch { cached = null; }
  }
  const universe = new Map();
  const resolved = { ...(cached ?? {}) };
  let dirty = false;

  for (const entry of config.whitelist) {
    const known = resolved[entry.symbol];
    if (known?.instrumentId) {
      universe.set(entry.symbol, { ...entry, instrumentId: known.instrumentId, name: known.name ?? entry.name });
      continue;
    }
    try {
      const found = await client.searchInstrument(entry.symbol);
      if (found?.instrumentId) {
        resolved[entry.symbol] = { instrumentId: found.instrumentId, name: found.name };
        universe.set(entry.symbol, { ...entry, instrumentId: found.instrumentId, name: found.name });
        dirty = true;
      }
    } catch { /* simbolo non risolvibile: escluso da questa run */ }
  }

  if (dirty && env.STATE) {
    try { await env.STATE.put(KV_UNIVERSE, JSON.stringify(resolved), { expirationTtl: 60 * 60 * 24 * 30 }); } catch { /* cache non disponibile */ }
  }
  return universe;
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

/**
 * @param {{env: object, kind: 'heartbeat'|'snapshot'|'rebalance'|'manual', modeOverride?: string}} options
 */
export async function runPipeline({ env, kind, modeOverride }) {
  const db = env.DB;
  const config = await loadConfig(db);
  const { values: credentials } = await resolveCredentials(db, env);
  const mode = modeOverride ?? config.executionMode;
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${kind}-${crypto.randomUUID().slice(0, 8)}`;

  await startRun(db, runId, kind, mode);
  await audit(db, runId, 'info', 'start', `Run ${kind} avviata in modalità ${mode}`);

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

    if (kind === 'heartbeat') {
      await finishRun(db, runId, 'ok', equityUsd);
      return { runId, status: 'ok', kind, equityUsd };
    }

    // --- 3. Contesto e feature --------------------------------------------
    const universe = await resolveUniverse(client, env, config);
    if (!universe.size) throw new Error('nessuno strumento della whitelist risolto su eToro');
    const [candles, external] = await Promise.all([
      loadCandles(client, env, universe),
      collectExternalContext({
        finnhubKey: credentials.finnhubKey,
        marketauxKey: credentials.marketauxKey,
        fmpKey: credentials.fmpKey,
        symbols: [...universe.keys()],
      }),
    ]);
    const history = await equityHistory(db, 400);
    const features = buildFeatures({ snapshot, universe, candles, external, config, equityHistory: history });
    await saveFeatures(db, runId, features);
    const failedSources = features.sourceDiagnostics.filter((item) => !item.ok);
    await audit(db, runId, 'info', 'features', `Feature calcolate su ${features.instruments.length} strumenti, regime ${features.regime.label}`, { failedSources: failedSources.map((item) => item.name) });

    if (kind === 'snapshot') {
      await finishRun(db, runId, 'ok', equityUsd);
      return { runId, status: 'ok', kind, equityUsd, regime: features.regime };
    }

    // --- 4. Cervello -------------------------------------------------------
    if (!credentials.openrouterApiKey) throw new Error('OpenRouter API key non configurata');
    const featuresPrompt = renderFeaturesPrompt(features, config);
    const brain = await askBrain({
      apiKey: credentials.openrouterApiKey,
      models: config.models,
      featuresPrompt,
      allowedSymbols: [...universe.keys()],
      config,
      referer: env.PUBLIC_URL,
    });
    await saveProposal(db, runId, brain);
    if (!brain.ok) {
      await audit(db, runId, 'error', 'brain', 'Nessuna proposta valida dai modelli', brain.attempts);
      await finishRun(db, runId, 'error', equityUsd, brain.error);
      await notify(credentials, 'warn', 'Autopilot: nessuna proposta', [brain.error ?? '', `Modelli provati: ${config.models.join(', ')}`]);
      return { runId, status: 'error', error: brain.error, attempts: brain.attempts };
    }
    await audit(db, runId, 'info', 'brain', `Proposta da ${brain.model} (confidence ${brain.parsed.confidence})`, { targets: brain.parsed.targetWeights });

    // --- 5. Validazione ----------------------------------------------------
    const ordersToday = await countOrdersToday(db);
    const validation = validateProposal({ proposal: brain.parsed, features, config, ordersToday });
    await saveValidation(db, runId, validation);
    await audit(db, runId, validation.ok ? 'info' : 'warn', 'validator',
      validation.ok ? `Piano valido: ${validation.plan.orders.length} ordini, turnover ${(validation.plan.turnoverPct * 100).toFixed(1)}%` : 'Piano bloccato dai guardrail',
      validation.violations);

    if (!validation.ok) {
      await finishRun(db, runId, 'blocked', equityUsd, validation.violations.filter((item) => item.severity === 'blocking').map((item) => item.message).join(' · '));
      return { runId, status: 'blocked', violations: validation.violations, plan: validation.plan };
    }

    if (!validation.plan.orders.length) {
      await audit(db, runId, 'info', 'executor', 'Nessuna azione: allocazione già entro le bande di tolleranza');
      await finishRun(db, runId, 'ok', equityUsd);
      return { runId, status: 'ok', action: 'none', plan: validation.plan };
    }

    // --- 6. Esecuzione -----------------------------------------------------
    const execution = await executePlan({ db, client, runId, plan: validation.plan, mode, config });
    await audit(db, runId, 'info', 'executor', `Esecuzione in modalità ${mode}: ${execution.results.length} ordini`, execution.results.map((item) => ({ symbol: item.symbol, side: item.side, amount: item.amountUsd, state: item.state })));

    // --- 7. Riconciliazione ------------------------------------------------
    let reconciliation = null;
    if (mode === 'live' && execution.executed) {
      reconciliation = await reconcile({ client, plan: validation.plan, config });
      await audit(db, runId, reconciliation.ok ? 'info' : 'error', 'reconcile', `Divergenza massima ${(reconciliation.worstDivergence * 100).toFixed(2)}%`, reconciliation.rows);
      if (!reconciliation.ok) {
        await saveConfig(db, { frozen: true, frozenReason: `riconciliazione fuori tolleranza (${(reconciliation.worstDivergence * 100).toFixed(2)}%)` });
        await notify(credentials, 'critical', 'Autopilot congelato dopo riconciliazione', [`Divergenza ${(reconciliation.worstDivergence * 100).toFixed(2)}%`, 'Verifica manualmente le posizioni su eToro.']);
      }
    }

    const summary = execution.results.map((item) => `${item.side === 'buy' ? '+' : '−'}${item.amountUsd} USD ${item.symbol} [${item.state}]`);
    await notify(credentials, mode === 'live' ? 'info' : 'info', `Autopilot ${mode} · ${validation.plan.orders.length} ordini`, [
      brain.parsed.rationale.slice(0, 400),
      ...summary,
    ]);

    await finishRun(db, runId, 'ok', equityUsd);
    return { runId, status: 'ok', mode, plan: validation.plan, execution, reconciliation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(db, runId, 'error', 'pipeline', message);
    await finishRun(db, runId, 'error', equityUsd, message);
    await notify(credentials, 'warn', 'Autopilot: run fallita', [message]);
    return { runId, status: 'error', error: message };
  }
}
