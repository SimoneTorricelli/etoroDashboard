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
import { exposureGroupFor, uniqueExposureCount } from './exposure.js';
import { validateProposal } from './validator.js';
import { executePlan, reconcile, deterministicId } from './executor.js';
import { describeLedger } from './churn.js';
import { classifyAnomaly, decideWatcherAction, detectAnomalies } from './watcher.js';
import { notify } from './notify.js';
import { PROFILES, describeProfile } from './profiles.js';
import { hasVerifiedAgentBinding, resolveCredentials, missingRequired, saveCredentials } from './vault.js';
import {
  audit, cacheUniverse, countOpportunisticThisWeek, countOrdersToday, equityHistory,
  finishRun, getRunBundle, listWatcherEvents, loadConfig, loadLedger, loadUniverseCache, recordEquity,
  recordLedgerTrade, saveConfig, saveFeatures, saveProposal, saveSnapshot, saveValidation,
  saveWatcherEvent, startRun, syncLedger, upsertOrder,
} from './db.js';

const KV_CANDLES_BUNDLE = 'candles:v2:bundle';
const CANDLE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CANDLE_REFRESH_BATCH = 12;
const UNIVERSE_RESOLVE_BATCH = 12;
const UNRESOLVED_RETRY_MS = 24 * 60 * 60 * 1000;

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Mantiene ID e posizioni del conto operativo Agent, ma converte tutti gli
 * importi nel capitale reale del mirror del proprietario. `executionScale`
 * resta interno e serve solo a tradurre gli ordini reali nei 10.000 virtuali
 * richiesti dall'API eToro.
 */
export function scaleAgentSnapshotToReal(virtualSnapshot, realMirrorSnapshot) {
  const virtualEquity = Number(virtualSnapshot?.equityUsd) || 0;
  const realEquity = Number(realMirrorSnapshot?.equityUsd) || 0;
  if (virtualEquity <= 0 || realEquity <= 0) throw new Error('Capitale Agent o mirror reale non disponibile');
  const globalScale = realEquity / virtualEquity;
  const realByInstrument = new Map();
  for (const position of realMirrorSnapshot.positions ?? []) {
    const current = realByInstrument.get(position.instrumentId) ?? { valueUsd: 0, invested: 0, pnlUsd: 0 };
    current.valueUsd += Number(position.valueUsd) || 0;
    current.invested += Number(position.invested) || 0;
    current.pnlUsd += Number(position.pnlUsd) || 0;
    realByInstrument.set(position.instrumentId, current);
  }
  const virtualByInstrument = new Map();
  for (const position of virtualSnapshot.positions ?? []) {
    virtualByInstrument.set(
      position.instrumentId,
      (virtualByInstrument.get(position.instrumentId) ?? 0) + (Number(position.valueUsd) || 0),
    );
  }
  const positions = (virtualSnapshot.positions ?? []).map((position) => {
    const realGroup = realByInstrument.get(position.instrumentId);
    const virtualGroupValue = virtualByInstrument.get(position.instrumentId) || 0;
    const share = realGroup && virtualGroupValue > 0 ? (Number(position.valueUsd) || 0) / virtualGroupValue : 0;
    const valueUsd = realGroup ? realGroup.valueUsd * share : (Number(position.valueUsd) || 0) * globalScale;
    const invested = realGroup ? realGroup.invested * share : (Number(position.invested) || 0) * globalScale;
    const pnlUsd = realGroup ? realGroup.pnlUsd * share : (Number(position.pnlUsd) || 0) * globalScale;
    return {
      ...position,
      invested: roundMoney(invested),
      valueUsd: roundMoney(valueUsd),
      grossValueUsd: roundMoney((Number(position.grossValueUsd) || 0) * globalScale),
      pnlUsd: roundMoney(pnlUsd),
    };
  });
  return {
    takenAt: Math.max(Number(virtualSnapshot.takenAt) || 0, Number(realMirrorSnapshot.takenAt) || 0, Date.now()),
    cashUsd: roundMoney(realMirrorSnapshot.cashUsd),
    investedUsd: roundMoney(positions.reduce((sum, item) => sum + item.invested, 0)),
    positionsValueUsd: roundMoney(positions.reduce((sum, item) => sum + item.valueUsd, 0)),
    equityUsd: roundMoney(realEquity),
    positions,
    source: 'owner-mirror',
    mirrorId: realMirrorSnapshot.mirrorId,
    executionScale: virtualEquity / realEquity,
    virtualEquityUsd: roundMoney(virtualEquity),
  };
}

/** Capacità massima investibile della shortlist entro cap per asset, classe e settore. */
export function shortlistDeploymentCapacity(shortlist, config) {
  const classUsed = {};
  const sectorUsed = {};
  const sectorCap = Number(config.maxSectorWeightPct) || 1;
  let total = 0;
  const maxPositions = Math.max(1, Number(config.maxHoldings) || shortlist.length);
  const bestByExposure = new Map();
  for (const item of shortlist) {
    if ((Number(item.maxWeight) || 0) <= 0) continue;
    const group = exposureGroupFor(item);
    const current = bestByExposure.get(group);
    if (!current || Number(item.maxWeight) > Number(current.maxWeight)) bestByExposure.set(group, item);
  }
  const remaining = [...bestByExposure.values()];
  for (let slot = 0; slot < maxPositions && remaining.length; slot += 1) {
    remaining.sort((a, b) => {
      const roomFor = (item) => Math.min(
        Number(item.maxWeight) || 0,
        Math.max(0, Number(config.maxWeightPerClass?.[item.class ?? 'other'] ?? 1) - (classUsed[item.class ?? 'other'] ?? 0)),
        item.sector ? Math.max(0, sectorCap - (sectorUsed[item.sector] ?? 0)) : 1,
      );
      return roomFor(b) - roomFor(a);
    });
    const item = remaining.shift();
    const klass = item.class ?? 'other';
    const classCap = Number(config.maxWeightPerClass?.[klass] ?? 1);
    const room = Math.min(
      Math.max(0, classCap - (classUsed[klass] ?? 0)),
      item.sector ? Math.max(0, sectorCap - (sectorUsed[item.sector] ?? 0)) : 1,
    );
    const allocation = Math.min(Number(item.maxWeight) || 0, room);
    classUsed[klass] = (classUsed[klass] ?? 0) + allocation;
    if (item.sector) sectorUsed[item.sector] = (sectorUsed[item.sector] ?? 0) + allocation;
    total += allocation;
  }
  return Math.min(1, total);
}

export function buildPlanRevisionContext(bundle) {
  const proposal = bundle?.proposal?.parsed;
  const violations = bundle?.validation?.violations ?? [];
  if (!proposal) return '';
  const targets = Object.entries(proposal.targetWeights ?? {})
    .map(([symbol, weight]) => `${symbol} ${(Number(weight) * 100).toFixed(1)}%`)
    .join(', ');
  const riskGroups = new Map();
  for (const [symbol, weight] of Object.entries(proposal.targetWeights ?? {})) {
    if (symbol === 'CASH' || Number(weight) <= 0.001) continue;
    const group = exposureGroupFor(symbol);
    if (group.startsWith('symbol:')) continue;
    riskGroups.set(group, [...(riskGroups.get(group) ?? []), symbol]);
  }
  const duplicateIssues = [...riskGroups.entries()]
    .filter(([, symbols]) => symbols.length > 1)
    .map(([group, symbols]) => `- Esposizione duplicata ${group}: scegli un solo ticker fra ${symbols.join(', ')}.`);
  const issueLines = [
    ...violations.map((item) => `- ${item.message}`),
    ...duplicateIssues,
  ];
  const issues = issueLines.length
    ? issueLines.join('\n')
    : '- Nessun errore deterministico registrato: aumenta la solidità e spiega meglio i rischi.';
  return [
    `La proposta precedente (${bundle.proposal.model ?? 'modello non noto'}, confidence ${Number(proposal.confidence).toFixed(2)}) è stata bloccata.`,
    `Allocazione precedente: ${targets}.`,
    'Correggi esplicitamente questi esiti del validatore:',
    issues,
    'Genera una nuova proposta autonoma, non limitarti a parafrasare la precedente. La confidence deve restare una stima onesta: non alzarla solo per superare la soglia.',
  ].join('\n').slice(0, 6000);
}

export function buildFailedProposalRetryContext(bundle) {
  const attempts = bundle?.proposal?.attempts ?? [];
  if (!attempts.length) return 'La run precedente non ha prodotto un JSON valido. Ricontrolla aritmeticamente la somma dei pesi prima di rispondere.';
  const failures = [];
  const seen = new Set();
  for (const attempt of attempts) {
    const message = String(attempt.error ?? 'risposta non valida');
    const key = `${attempt.provider}/${attempt.model}: ${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push(`- ${key}`);
  }
  return [
    'La run precedente non ha prodotto una proposta utilizzabile.',
    'Errori osservati:',
    ...failures.slice(0, 8),
    'Genera un nuovo JSON completo. Somma i pesi numericamente prima di rispondere; non omettere CASH e non aggiungere testo esterno al JSON.',
  ].join('\n').slice(0, 5000);
}

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

function buildClient(resolved, config) {
  const credentials = resolved.values;
  const missing = missingRequired(credentials).filter((label) => label.startsWith('eToro'));
  if (missing.length) throw new Error(`credenziali mancanti: ${missing.join(', ')}`);
  const verifiedAgentToken = hasVerifiedAgentBinding(resolved, config)
    ? credentials.etoroAgentToken
    : '';
  return new EtoroClient({
    apiKey: credentials.etoroApiKey,
    // La owner key resta sempre la credenziale predefinita per catalogo e dati.
    // Il token Agent viene abilitato solo dopo una verifica reale del portfolio.
    userKey: credentials.etoroUserKey,
    agentToken: verifiedAgentToken || '',
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
  const negative = [];
  const unresolved = [];
  const now = Date.now();
  let lookupAttempts = 0;

  for (const entry of universeSource(config)) {
    const cached = cache.get(entry.symbol);
    if (cached?.instrument_id) {
      universe.set(entry.symbol, { ...entry, instrumentId: cached.instrument_id, name: cached.name || entry.name });
      continue;
    }
    if (cached && now - Number(cached.updated_at ?? 0) < UNRESOLVED_RETRY_MS) {
      unresolved.push(entry.symbol);
      continue;
    }
    if (lookupAttempts >= UNIVERSE_RESOLVE_BATCH) {
      unresolved.push(entry.symbol);
      continue;
    }
    lookupAttempts += 1;
    try {
      const found = await client.searchInstrument(entry.symbol, {
        tryUsd: entry.class === 'crypto',
        // In pipeline la continuità viene prima della ricerca esaustiva: la
        // ricerca completa resta disponibile nella UI e nella diagnostica.
        maxQueriesPerVariant: 1,
      });
      if (found?.instrumentId) {
        const resolvedEntry = { ...entry, instrumentId: found.instrumentId, name: found.name || entry.name, matchedAs: found.matchedAs };
        universe.set(entry.symbol, resolvedEntry);
        fresh.push(resolvedEntry);
      } else {
        unresolved.push(entry.symbol);
        negative.push({ ...entry, instrumentId: 0, matchedAs: 'non disponibile su eToro' });
      }
    } catch {
      unresolved.push(entry.symbol);
      negative.push({ ...entry, instrumentId: 0, matchedAs: 'ricerca eToro fallita' });
    }
  }

  if (fresh.length || negative.length) await cacheUniverse(db, [...fresh, ...negative]);
  return { universe, unresolved };
}

function normalizeHeldAssetClass(label) {
  const value = String(label ?? '').toLowerCase();
  if (value.includes('crypto')) return 'crypto';
  if (value.includes('etf') || value.includes('fund')) return 'etf';
  if (value.includes('bond') || value.includes('fixed income')) return 'bond';
  if (value.includes('commod')) return 'commodity';
  return 'stock';
}

/**
 * Le posizioni reali restano nell'universo anche se non erano nel pool della
 * nuova strategia. In questo modo sono misurate, sottoposte ai cap e vendibili.
 */
async function mergeHeldPositions(client, db, universe, snapshot) {
  const knownIds = new Set([...universe.values()].map((item) => item.instrumentId));
  const missingIds = [...new Set(snapshot.positions.map((item) => item.instrumentId).filter((id) => id && !knownIds.has(id)))];
  if (!missingIds.length) return [];
  let metadata = [];
  try { metadata = await client.instruments(missingIds); } catch { /* fallback per ID sotto */ }
  const byId = new Map(metadata.map((item) => [item.instrumentId, item]));
  const added = [];
  for (const instrumentId of missingIds) {
    const item = byId.get(instrumentId) ?? {};
    const rawSymbol = String(item.symbol ?? '').trim().toUpperCase();
    const symbol = rawSymbol || `HELD_${instrumentId}`;
    const entry = {
      symbol,
      name: String(item.name ?? `Posizione eToro ${instrumentId}`),
      class: normalizeHeldAssetClass(item.assetClass),
      maxWeight: 0,
      instrumentId,
      heldOutsidePolicy: true,
      sellOnly: true,
      buyEligible: false,
    };
    universe.set(symbol, entry);
    added.push(entry);
  }
  if (added.length) await cacheUniverse(db, added);
  return added;
}

/**
 * Ordina gli storici da aggiornare: prima le posizioni aperte, poi gli strumenti
 * mai visti, infine quelli con cache più vecchia. Il tetto protegge il budget di
 * subrequest del Worker e permette alla cache di scaldarsi tra un ciclo e l'altro.
 */
export function buildCandleRefreshQueue(universe, instruments, {
  heldInstrumentIds = [], now = Date.now(), maxAgeMs = CANDLE_CACHE_MAX_AGE_MS,
  limit = CANDLE_REFRESH_BATCH,
} = {}) {
  const held = new Set(heldInstrumentIds.map(Number));
  return [...universe.entries()]
    .map(([symbol, meta]) => {
      const cached = instruments?.[String(meta.instrumentId)];
      const hasRows = Boolean(cached?.rows?.length);
      const updatedAt = Number(cached?.updatedAt ?? 0);
      return { symbol, meta, hasRows, updatedAt, stale: !hasRows || now - updatedAt >= maxAgeMs };
    })
    .filter((item) => item.stale)
    .sort((a, b) => {
      const heldDelta = Number(held.has(b.meta.instrumentId)) - Number(held.has(a.meta.instrumentId));
      if (heldDelta) return heldDelta;
      const missingDelta = Number(!b.hasRows) - Number(!a.hasRows);
      if (missingDelta) return missingDelta;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, Math.max(1, limit));
}

/** Serie giornaliere in un solo oggetto KV, con aggiornamento progressivo. */
export async function loadCandles(client, env, universe, options = {}) {
  const candles = new Map();
  let bundle = { version: 2, instruments: {} };
  if (env.STATE) {
    try {
      const cached = await env.STATE.get(KV_CANDLES_BUNDLE, 'json');
      if (cached?.version === 2 && cached?.instruments) bundle = cached;
    } catch { /* cache non disponibile */ }
  }

  for (const [symbol, meta] of universe.entries()) {
    const cached = bundle.instruments[String(meta.instrumentId)];
    if (cached?.rows?.length) candles.set(symbol, cached.rows);
  }

  const queue = buildCandleRefreshQueue(universe, bundle.instruments, options);
  let refreshed = 0;
  let changed = false;
  // Quattro richieste contemporanee restano sotto il limite di connessioni
  // aperte del runtime, mentre il tetto totale resta deterministico.
  for (let offset = 0; offset < queue.length; offset += 4) {
    const chunk = queue.slice(offset, offset + 4);
    const results = await Promise.all(chunk.map(async ({ symbol, meta }) => {
      try {
        const rows = await client.candles(meta.instrumentId, 'OneDay', 260);
        return { symbol, meta, rows };
      } catch {
        return { symbol, meta, rows: [] };
      }
    }));
    for (const { symbol, meta, rows } of results) {
      if (!rows.length) continue;
      candles.set(symbol, rows);
      bundle.instruments[String(meta.instrumentId)] = { rows, updatedAt: Date.now() };
      refreshed += 1;
      changed = true;
    }
  }

  if (env.STATE && changed) {
    try {
      bundle = { ...bundle, version: 2, updatedAt: Date.now() };
      await env.STATE.put(KV_CANDLES_BUNDLE, JSON.stringify(bundle), { expirationTtl: 30 * 24 * 60 * 60 });
    } catch { /* cache non disponibile */ }
  }
  return {
    candles,
    stats: {
      available: candles.size,
      total: universe.size,
      refreshed,
      pending: Math.max(0, universe.size - candles.size),
    },
  };
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
  const ordersToday = await countOrdersToday(db);
  const budgetUsd = snapshot.equityUsd * config.opportunisticBudgetPct;
  const holdingCount = features.instruments.filter((item) => item.weight > 0.001).length;
  const actions = [];
  let escalated = 0;

  // Solo le tre anomalie più gravi vengono classificate: limita il costo e il rumore.
  for (const anomaly of anomalies.slice(0, 3)) {
    const verdict = await classifyAnomaly({ config, credentials, env, anomaly, news: external.news });
    escalated += 1;

    let decision = decideWatcherAction({
      anomaly, verdict, config, ledger, budgetUsd,
      opportunisticThisWeek: opportunisticThisWeek + actions.filter((item) => item.action === 'buy').length,
      equityUsd: snapshot.equityUsd,
      holdingCount,
      currentClassWeight: features.allocationByClass?.[anomaly.class] ?? 0,
      availableCashUsd: snapshot.cashUsd,
      ordersToday: ordersToday + actions.filter((item) => item.executed).length,
    });

    let executed = false;
    if (decision.action === 'buy' && mode === 'live' && !config.frozen) {
      const id = await deterministicId(runId, `watch-${anomaly.symbol}`, anomaly.symbol, 'buy');
      try {
        const executionScale = Number(snapshot.executionScale) > 0 ? Number(snapshot.executionScale) : 1;
        const executionAmountUsd = roundMoney(decision.amountUsd * executionScale);
        const eligibility = await client.eligibility([anomaly.instrumentId]);
        const eligible = eligibility.get(anomaly.instrumentId);
        if (!eligible?.allowOpenPosition) {
          decision = { action: 'noop', reason: `${anomaly.symbol}: mercato chiuso o strumento non negoziabile` };
          await audit(db, runId, 'warn', 'watcher', decision.reason);
        } else if (executionAmountUsd + 0.005 < eligible.minPositionUsd) {
          decision = { action: 'noop', reason: `${anomaly.symbol}: importo sotto il minimo reale equivalente di ${roundMoney(eligible.minPositionUsd / executionScale)} USD` };
          await audit(db, runId, 'warn', 'watcher', decision.reason);
        } else {
          const response = await client.openOrder({ instrumentId: anomaly.instrumentId, amountUsd: executionAmountUsd, requestId: id });
          await upsertOrder(db, {
            id, runId, seq: 900, symbol: anomaly.symbol, instrumentId: anomaly.instrumentId,
            side: 'buy', amountUsd: decision.amountUsd, mode, state: 'sent',
            etoroOrderId: String(response?.orderId ?? '') || null,
            message: `opportunistico: ${decision.reason}`.slice(0, 500),
          });
          await recordLedgerTrade(db, anomaly.symbol, 'buy', { opportunistic: true, averagingDown: anomaly.held });
          executed = true;
        }
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

export async function runPipeline({ env, kind, modeOverride, improveFromRunId = '', retryFromRunId = '' }) {
  const db = env.DB;
  const config = await loadConfig(db);
  if (config.strategySpec?.diversification) {
    const preferredByPolicy = Number(config.strategySpec.diversification.preferredPositions) || 0;
    const preferredByRange = Math.round((Number(config.strategySpec.diversification.maxPositions) || config.maxHoldings) * 0.75);
    config.preferredHoldings = Math.min(
      Number(config.maxHoldings) || 1,
      Math.max(Number(config.minHoldings) || 1, Number(config.preferredHoldings) || 0, preferredByPolicy, preferredByRange),
    );
  }
  const mode = modeOverride ?? config.executionMode;
  const baseProfile = PROFILES[config.strategyProfile] ?? PROFILES.balanced;
  const profile = config.strategySpec ? {
    ...baseProfile,
    targetVolPct: [
      config.strategySpec.risk?.targetVolatilityPct?.min ?? baseProfile.targetVolPct[0],
      config.strategySpec.risk?.targetVolatilityPct?.max ?? baseProfile.targetVolPct[1],
    ],
    maxHoldings: config.strategySpec.diversification?.maxPositions ?? baseProfile.maxHoldings,
  } : baseProfile;
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${kind}-${crypto.randomUUID().slice(0, 8)}`;

  await startRun(db, runId, kind, mode);
  await audit(db, runId, 'info', 'start', `Run ${kind} avviata in modalità ${mode} · profilo ${profile.label}`);
  const sourceRunId = improveFromRunId || retryFromRunId;
  const previousBundle = sourceRunId ? await getRunBundle(db, sourceRunId) : null;
  const revisionContext = improveFromRunId
    ? buildPlanRevisionContext(previousBundle)
    : retryFromRunId ? buildFailedProposalRetryContext(previousBundle) : '';
  if (improveFromRunId) {
    await audit(db, runId, 'info', 'improvement', `Revisione del piano bloccato ${improveFromRunId}`, {
      sourceRunId: improveFromRunId,
      sourceModel: previousBundle?.proposal?.model ?? null,
      sourceConfidence: previousBundle?.proposal?.parsed?.confidence ?? null,
    });
  }
  if (retryFromRunId) {
    await audit(db, runId, 'info', 'retry', `Correzione della proposta non valida ${retryFromRunId}`, {
      sourceRunId: retryFromRunId,
      sourceAttempts: previousBundle?.proposal?.attempts?.length ?? 0,
    });
  }

  if (!['shadow', 'dry-run', 'live'].includes(mode)) {
    const error = `modalità di esecuzione non valida: ${String(mode)}`;
    await audit(db, runId, 'error', 'start', error);
    await finishRun(db, runId, 'blocked', null, error);
    return { runId, status: 'blocked', error };
  }

  let equityUsd = null;
  let credentials = {};
  try {
    const resolved = await resolveCredentials(db, env);
    credentials = resolved.values;
    const client = buildClient(resolved, config);
    const hasVerifiedAgent = hasVerifiedAgentBinding(resolved, config);
    if (mode === 'live' && !hasVerifiedAgent) {
      throw new Error('Agent Portfolio non verificato: genera e verifica un nuovo token prima di attivare il live');
    }
    const portfolioUserKey = hasVerifiedAgent ? client.agentToken : client.userKey;

    // --- 1. Snapshot -------------------------------------------------------
    let snapshot;
    let virtualSnapshot = null;
    try {
      virtualSnapshot = await client.portfolio(portfolioUserKey);
      if (hasVerifiedAgent) {
        let mirrorId = String(config.activeAgentPortfolioMirrorId ?? '');
        let remote = null;
        if (!mirrorId) {
          remote = (await client.agentPortfolios()).find((item) => item.id === config.activeAgentPortfolioId) ?? null;
          mirrorId = String(remote?.mirrorId ?? '');
        }
        if (!mirrorId) throw new Error('eToro non ha restituito il mirrorId del portfolio: impossibile leggere il capitale reale');
        const realMirrorSnapshot = await client.mirrorPortfolio(mirrorId);
        snapshot = scaleAgentSnapshotToReal(virtualSnapshot, realMirrorSnapshot);
        if (mirrorId !== config.activeAgentPortfolioMirrorId || remote?.virtualBalanceUsd) {
          config.activeAgentPortfolioMirrorId = mirrorId;
          config.activeAgentPortfolioVirtualBalanceUsd = remote?.virtualBalanceUsd || virtualSnapshot.equityUsd;
          await saveConfig(db, {
            activeAgentPortfolioMirrorId: mirrorId,
            activeAgentPortfolioVirtualBalanceUsd: config.activeAgentPortfolioVirtualBalanceUsd,
          });
        }
      } else {
        snapshot = virtualSnapshot;
      }
    } catch (error) {
      if (hasVerifiedAgent && !virtualSnapshot && Number(error?.status) === 401) {
        await saveCredentials(db, env, { etoroAgentToken: '' });
        await saveConfig(db, {
          executionMode: 'shadow',
          activeAgentPortfolioId: '',
          activeAgentPortfolioName: '',
          activeAgentPortfolioMirrorId: '',
          activeAgentPortfolioVirtualBalanceUsd: 0,
          lastManagedCapitalUsd: 0,
          lastManagedCapitalEur: 0,
          lastManagedCapitalAt: 0,
          lastManagedEurUsd: 0,
          realCapitalTrackingStartedAt: 0,
          agentTokenVerifiedAt: 0,
          agentTokenHint: '',
          agentTokenFingerprint: '',
          agentTokenOrigin: '',
        });
        await audit(db, runId, 'error', 'credentials', 'Token Agent revocato o non valido: binding rimosso e live disattivato');
      }
      throw error;
    }
    if (!Number(config.realCapitalTrackingStartedAt)) {
      config.realCapitalTrackingStartedAt = Date.now();
      await saveConfig(db, { realCapitalTrackingStartedAt: config.realCapitalTrackingStartedAt });
    }
    equityUsd = snapshot.equityUsd;
    await saveSnapshot(db, runId, snapshot);
    const { hwm, drawdown } = await recordEquity(
      db,
      snapshot.equityUsd,
      snapshot.investedUsd,
      snapshot.cashUsd,
      config.realCapitalTrackingStartedAt,
    );
    await audit(db, runId, 'info', 'snapshot', `Capitale reale eToro: equity ${snapshot.equityUsd} USD, cash ${snapshot.cashUsd} USD, ${snapshot.positions.length} posizioni`, {
      hwm, drawdown, source: snapshot.source, mirrorId: snapshot.mirrorId,
    });

    // --- 2. Circuit breaker ------------------------------------------------
    if (drawdown > config.drawdownStopPct && !config.frozen) {
      const reason = `drawdown ${(drawdown * 100).toFixed(1)}% oltre la soglia ${(config.drawdownStopPct * 100).toFixed(0)}%`;
      await saveConfig(db, { frozen: true, frozenReason: reason });
      await audit(db, runId, 'error', 'circuit-breaker', `Agente congelato: ${reason}`);
      await notify(credentials, 'critical', 'Autopilot congelato', [reason, `Capitale reale ${snapshot.equityUsd} USD · massimo storico reale ${hwm} USD`]);
      await finishRun(db, runId, 'frozen', equityUsd, reason);
      return { runId, status: 'frozen', reason };
    }

    // --- 3. Universo, storici e contesto -----------------------------------
    const { universe, unresolved } = await resolveUniverse(client, db, config);
    const heldOutsidePolicy = await mergeHeldPositions(client, db, universe, snapshot);
    if (!universe.size) throw new Error(`nessuno strumento risolto su eToro${unresolved.length ? ` (falliti: ${unresolved.join(', ')})` : ''}`);
    if (unresolved.length) await audit(db, runId, 'warn', 'universe', `Risoluzione progressiva: ${unresolved.length} simboli non ancora disponibili in questa run (${unresolved.join(', ')})`);
    if (heldOutsidePolicy.length) {
      await audit(db, runId, 'warn', 'universe', `${heldOutsidePolicy.length} posizioni esistenti aggiunte fuori policy`, heldOutsidePolicy.map((item) => item.symbol));
    }

    const [{ candles, stats: candleStats }, external] = await Promise.all([
      loadCandles(client, env, universe, {
        heldInstrumentIds: snapshot.positions.map((item) => item.instrumentId),
      }),
      collectExternalContext({
        finnhubKey: credentials.finnhubKey,
        marketauxKey: credentials.marketauxKey,
        fmpKey: credentials.fmpKey,
        symbols: [...universe.keys()],
        kv: env.STATE,
        // Anche nel ribilanciamento pochi minuti di cache evitano che due test
        // manuali consecutivi replichino tutte le fonti esterne.
        ttlSeconds: kind === 'rebalance' ? 15 * 60 : 3 * 60 * 60,
      }),
    ]);
    const history = await equityHistory(db, 400, config.realCapitalTrackingStartedAt);
    const features = buildFeatures({ snapshot, universe, candles, external, config, equityHistory: history });
    const eurUsd = Number(features.eurUsd) || config.fallbackEurUsd;
    config.lastManagedCapitalUsd = snapshot.equityUsd;
    config.lastManagedCapitalEur = roundMoney(snapshot.equityUsd / eurUsd);
    config.lastManagedCapitalAt = snapshot.takenAt;
    config.lastManagedEurUsd = eurUsd;
    await saveConfig(db, {
      lastManagedCapitalUsd: config.lastManagedCapitalUsd,
      lastManagedCapitalEur: config.lastManagedCapitalEur,
      lastManagedCapitalAt: config.lastManagedCapitalAt,
      lastManagedEurUsd: config.lastManagedEurUsd,
    });
    await saveFeatures(db, runId, features);

    // Il registro va allineato prima di qualunque decisione.
    const heldSymbols = new Set(features.instruments.filter((item) => item.weight > 0.001).map((item) => item.symbol));
    const ledger = await syncLedger(db, [...heldSymbols]);

    await audit(db, runId, candleStats.pending ? 'warn' : 'info', 'features', `Universo ${features.instruments.length} strumenti · storici disponibili ${candleStats.available}/${candleStats.total} · regime ${features.regime.label}${candleStats.pending ? ' · cache in riscaldamento' : ''}`, {
      candleCoverage: candleStats,
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
      await audit(db, runId, 'info', 'screening', `Shortlist di ${shortlistSymbols.length} su ${screening.ranked.length} strumenti con storico sufficiente (pool risolto: ${universe.size})`, {
        top: screening.shortlist.slice(0, 10).map((item) => ({ symbol: item.symbol, score: item.score, held: item.held })),
      });
    }

    if (dynamic && Number(features.portfolio.openPositions) === 0) {
      const preferred = Math.min(config.maxHoldings, Math.max(config.minHoldings, config.preferredHoldings));
      const capacity = shortlistDeploymentCapacity(screening.shortlist, config);
      const requiredDeployment = 1 - config.maxCashPct;
      const exposureCount = uniqueExposureCount(screening.shortlist);
      if (exposureCount < preferred || capacity + 0.0001 < requiredDeployment) {
        const reason = `Analisi rimandata: ${exposureCount} fonti di rischio con storico, ne servono almeno ${preferred}; capacità entro i cap ${(capacity * 100).toFixed(0)}% su ${(requiredDeployment * 100).toFixed(0)}% richiesto. Cache aggiornata ${candleStats.refreshed} strumenti in questo ciclo.`;
        await audit(db, runId, 'warn', 'readiness', reason, { candleStats, preferred, exposureCount, capacity, requiredDeployment });
        await finishRun(db, runId, 'blocked', equityUsd, reason);
        return { runId, status: 'blocked', reason, warming: true, candleStats };
      }
    }

    // --- 6. Cervello -------------------------------------------------------

    const shortlistWithWeights = screening.shortlist.map((item) => ({
      ...item,
      weight: features.instruments.find((row) => row.symbol === item.symbol)?.weight ?? 0,
    }));
    const featuresPrompt = dynamic
      ? [renderFeaturesPrompt(features, config, { includeInstruments: false }), renderShortlistPrompt(shortlistWithWeights)].join('\n')
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
      revisionContext,
      previousModel: previousBundle?.proposal?.model ?? '',
      previousAttempts: previousBundle?.proposal?.attempts ?? [],
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
    const validation = validateProposal({
      proposal: brain.parsed,
      features,
      config,
      ordersToday,
      ledger,
      scores,
      completionSymbols: dynamic ? shortlistSymbols : [...universe.keys()],
    });
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
      reconciliation = await reconcile({ client, plan: validation.plan, config, portfolioUserKey });
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
