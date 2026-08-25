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
import { askBrain, normalizeProposal } from './brain.js';
import { exposureGroupFor, uniqueExposureCount } from './exposure.js';
import { validateProposal } from './validator.js';
import { checkPlanEligibility, executePlan, readLiveSafetyFence, reconcile } from './executor.js';
import { describeLedger } from './churn.js';
import { classifyAnomaly, decideWatcherAction, detectAnomalies } from './watcher.js';
import { notify } from './notify.js';
import { PROFILES, describeProfile } from './profiles.js';
import { hasVerifiedAgentBinding, resolveCredentials, missingRequired, saveCredentials } from './vault.js';
import {
  acquirePipelineLock, armLiveIfUnchanged, armRecoveryLiveIfUnchanged, audit, cacheUniverse, countOpportunisticThisWeek, countOrdersToday, equityHistory,
  claimLatestDecisionArtifact, findLiveRecoveryBarrier, finishLiveActivation, finishRun, finishRunIfLiveFence,
  finishRecoveryToShadowIfUnchanged, getLiveActivation, getRunBundle,
  latestDryRunWithArtifact, listRecoveryPlanCandidates, listStalePreArmActivations, listWatcherEvents, loadConfig, loadLedger, loadUniverseCache,
  recordEquity, reserveLiveActivation,
  mutateSafetyConfig, recordLedgerTrade, releasePipelineLock, renewPipelineLock, saveConfig,
  releaseDecisionArtifactClaim, releaseDecisionArtifactClaimsByRun,
  saveDecisionArtifact, saveFeatures, saveProposal, saveSnapshot, saveValidation, saveWatcherEvent,
  setLiveActivationSource, startRun, syncLedger, updateLiveActivationStatus, upsertOrder,
} from './db.js';
import {
  LIVE_DRY_RUN_TTL_MS, buildDecisionContext, classifyDryRunForReuse, compactLiveActivationResult,
  comparePortfolioForReuse, proposalHash, summarizeExecution,
} from './live-plan.js';

const KV_CANDLES_BUNDLE = 'candles:v2:bundle';
const CANDLE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CANDLE_REFRESH_BATCH = 12;
const UNIVERSE_RESOLVE_BATCH = 12;
const UNRESOLVED_RETRY_MS = 24 * 60 * 60 * 1000;

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    reportedEquityUsd: realMirrorSnapshot.reportedEquityUsd ?? null,
    calculatedEquityUsd: realMirrorSnapshot.calculatedEquityUsd ?? realEquity,
    equitySource: realMirrorSnapshot.equitySource ?? 'calculated',
    executionScale: virtualEquity / realEquity,
    virtualEquityUsd: roundMoney(virtualEquity),
  };
}

/**
 * Il portfolio selezionato è l'identità stabile; il mirrorId è una relazione
 * remota che va ricontrollata a ogni run. In caso di divergenza non scegliamo
 * automaticamente uno dei due valori: il binding deve essere riverificato.
 */
export function resolveVerifiedAgentMirror(config, portfolios) {
  const fail = (message) => {
    const error = new Error(message);
    error.code = 'agent_mirror_binding';
    throw error;
  };
  const portfolioId = String(config?.activeAgentPortfolioId ?? '').trim();
  const configuredMirrorId = String(config?.activeAgentPortfolioMirrorId ?? '').trim();
  const remote = (portfolios ?? []).find((item) => String(item?.id ?? '') === portfolioId) ?? null;
  if (!remote) fail(`Agent Portfolio ${portfolioId || 'non configurato'} non trovato sul conto eToro`);
  const remoteMirrorId = String(remote.mirrorId ?? '').trim();
  if (!remoteMirrorId) fail('eToro non ha restituito il mirrorId del portfolio: impossibile leggere il capitale reale');
  if (!configuredMirrorId) {
    fail('binding mirror incompleto: rigenera il token dell’Agent Portfolio prima di eseguire una nuova run');
  }
  if (configuredMirrorId !== remoteMirrorId) {
    fail(`binding mirror eToro cambiato (${configuredMirrorId} → ${remoteMirrorId}): rigenera e verifica il token prima di continuare`);
  }
  return remote;
}

function aggregateRecoveryPositions(snapshot) {
  const positions = new Map();
  for (const position of snapshot?.positions ?? []) {
    const instrumentId = Number(position.instrumentId);
    if (!Number.isFinite(instrumentId) || instrumentId <= 0) continue;
    positions.set(instrumentId, (positions.get(instrumentId) ?? 0) + (Number(position.valueUsd) || 0));
  }
  return positions;
}

/** Due letture devono mostrare la stessa composizione e importi compatibili. */
export function recoverySnapshotsStable(first, second) {
  const firstEquity = Number(first?.equityUsd) || 0;
  const secondEquity = Number(second?.equityUsd) || 0;
  if (firstEquity <= 0 || secondEquity <= 0) return { stable: false, reason: 'equity non disponibile' };
  const firstPositions = aggregateRecoveryPositions(first);
  const secondPositions = aggregateRecoveryPositions(second);
  const firstIds = [...firstPositions.keys()].sort((a, b) => a - b);
  const secondIds = [...secondPositions.keys()].sort((a, b) => a - b);
  if (firstIds.length !== secondIds.length || firstIds.some((id, index) => id !== secondIds[index])) {
    return { stable: false, reason: 'le posizioni eToro stanno ancora cambiando' };
  }
  for (const instrumentId of firstIds) {
    const left = firstPositions.get(instrumentId) ?? 0;
    const right = secondPositions.get(instrumentId) ?? 0;
    if (Math.abs(left - right) > Math.max(1, Math.max(left, right) * 0.02)) {
      return { stable: false, reason: `il valore dello strumento ${instrumentId} non è ancora stabile` };
    }
  }
  if (Math.abs((Number(first.cashUsd) || 0) - (Number(second.cashUsd) || 0)) > Math.max(1, secondEquity * 0.002)) {
    return { stable: false, reason: 'la liquidità eToro sta ancora aggiornandosi' };
  }
  return { stable: true, reason: '' };
}

async function readRecoveryAgentSnapshot(client, config, remote) {
  const [virtualSnapshot, realMirrorSnapshot] = await Promise.all([
    client.portfolio(client.agentToken),
    client.mirrorPortfolio(String(remote.mirrorId)),
  ]);
  const snapshot = scaleAgentSnapshotToReal(virtualSnapshot, realMirrorSnapshot);
  snapshot.agentPortfolioId = remote.id;
  return { snapshot, virtualSnapshot };
}

function storedOrderRecord(row, patch = {}) {
  return {
    id: row.id,
    runId: row.run_id ?? row.runId,
    seq: Number(row.seq),
    symbol: row.symbol,
    instrumentId: Number(row.instrument_id ?? row.instrumentId),
    side: row.side,
    amountUsd: Number(row.amount_usd ?? row.amountUsd),
    positionId: row.position_id ?? row.positionId ?? null,
    mode: row.mode,
    state: row.state,
    etoroOrderId: row.etoro_order_id ?? row.etoroOrderId ?? null,
    positionIds: row.positionIds ?? [],
    filledUsd: Number(row.filled_usd ?? row.filledUsd) || 0,
    message: row.message ?? null,
    ...patch,
  };
}

export function recoveryResidualPreview(bundle, snapshot, config) {
  const plan = bundle?.validation?.plan;
  if (!plan?.targets || !Array.isArray(plan.deltas)) return [];
  const actual = aggregateRecoveryPositions(snapshot);
  const equity = Math.max(0.01, Number(snapshot.equityUsd) || 0.01);
  return plan.deltas
    .filter((delta) => Number(plan.targets[delta.symbol] ?? delta.targetWeight) > 0 || (actual.get(Number(delta.instrumentId)) ?? 0) > 0)
    .map((delta) => {
      const targetWeight = Number(plan.targets[delta.symbol] ?? delta.targetWeight) || 0;
      const actualUsd = roundMoney(actual.get(Number(delta.instrumentId)) ?? 0);
      const actualWeight = actualUsd / equity;
      const residualUsd = roundMoney((targetWeight - actualWeight) * equity);
      return {
        symbol: delta.symbol,
        instrumentId: Number(delta.instrumentId),
        side: residualUsd > 0 ? 'buy' : 'sell',
        residualUsd: Math.abs(residualUsd),
        actionable: Math.abs(residualUsd) >= Number(config.minOrderUsd || 0),
        actualUsd,
        actualWeight: Math.round(actualWeight * 10_000) / 10_000,
        targetWeight,
        targetUsd: roundMoney(targetWeight * equity),
      };
    });
}

function recoveryPlanCandidate(row, snapshot, config, recommendedRunIds, currentDecisionContext) {
  if (!row?.proposal || !row?.plan?.targets || !Array.isArray(row.plan.deltas)) return null;
  const recommended = recommendedRunIds.has(String(row.id));
  // Le dry-run selezionabili devono appartenere alla stessa strategia e allo
  // stesso Agent binding. La run Live congelata resta selezionabile perché è
  // proprio la fonte autorevole dell'esecuzione parziale da recuperare.
  if (!recommended && row.execution_mode !== 'dry-run') return null;
  if (!recommended && row.execution_mode === 'dry-run') {
    if (!row.artifact_decision_hash || !row.artifact_binding_hash) return null;
    if (
      Number(row.artifact_decision_revision) !== Number(currentDecisionContext.decisionRevision)
      || row.artifact_decision_hash !== currentDecisionContext.decisionHash
      || row.artifact_binding_hash !== currentDecisionContext.bindingHash
    ) return null;
  }
  const sourceSnapshotEquity = Number(row.snapshot_equity_usd) || Number(row.plan.equityUsd) || 0;
  const sourceSnapshotCash = Number(row.snapshot_cash_usd) || 0;
  let sourcePositions = [];
  try { sourcePositions = JSON.parse(row.snapshot_positions_json ?? '[]'); } catch { sourcePositions = []; }
  const initialConstruction = sourceSnapshotEquity > 0
    && sourceSnapshotCash >= sourceSnapshotEquity * 0.95
    && sourcePositions.length === 0;
  const bundle = { validation: { plan: row.plan } };
  const residualPreview = recoveryResidualPreview(bundle, snapshot, config);
  return {
    sourceRunId: String(row.id),
    sourceType: row.execution_mode,
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    status: String(row.status),
    model: row.model == null ? null : String(row.model),
    confidence: Number(row.confidence ?? row.proposal.confidence) || 0,
    recommended,
    initialConstruction,
    targetWeights: row.plan.targets,
    originalOrderCount: Array.isArray(row.plan.orders) ? row.plan.orders.length : 0,
    residualOrderCount: residualPreview.filter((item) => item.actionable && item.residualUsd > 0).length,
    residualUsd: roundMoney(residualPreview
      .filter((item) => item.actionable)
      .reduce((sum, item) => sum + item.residualUsd, 0)),
    residualPreview,
  };
}

/** Una nuova verifica dell'Agent inaugura sempre una nuova serie di capitale. */
export function capitalTrackingResetReason(config, hasVerifiedAgent) {
  const trackingStartedAt = Number(config?.realCapitalTrackingStartedAt) || 0;
  if (!trackingStartedAt) return 'baseline assente';
  const verifiedAt = Number(config?.agentTokenVerifiedAt) || 0;
  if (hasVerifiedAgent && verifiedAt > trackingStartedAt) return 'Agent Portfolio riverificato';
  return '';
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
    // Durante il ritorno all'ora solare le 02:xx locali esistono due volte.
    // Contrassegniamo la seconda occorrenza per evitare due run automatiche.
    fold: (() => {
      const previous = Object.fromEntries(formatter.formatToParts(new Date(date.getTime() - 60 * 60 * 1000)).map((part) => [part.type, part.value]));
      return previous.year === parts.year
        && previous.month === parts.month
        && previous.day === parts.day
        && previous.hour === parts.hour
        && previous.minute === parts.minute ? 1 : 0;
    })(),
  };
}

/** Decide che tipo di run eseguire in base a cadenza e ora locale italiana. */
export function decideKind(config, parts) {
  // Il cron scatta ogni quarto d'ora. La seconda occorrenza di un orario
  // duplicato dal ritorno all'ora solare non deve generare una seconda run.
  if (parts.fold === 1) return null;
  if (parts.hour === config.rebalanceHour && parts.minute === config.rebalanceMinute) {
    if (config.cadence === 'daily' && parts.weekday <= 5) return 'rebalance';
    if (config.cadence === 'weekly' && parts.weekday === config.rebalanceWeekday) return 'rebalance';
    if (config.cadence === 'monthly' && parts.day === config.rebalanceDayOfMonth) return 'rebalance';
  }
  // Snapshot e heartbeat restano orari: i tick :15, :30 e :45 che non
  // corrispondono a un ribilanciamento non devono avviare la pipeline.
  if (parts.minute !== 0) return null;
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
export async function runWatcher({ env, db, config, credentials, snapshot, features, universe, candles, external, runId }) {
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

    const decision = decideWatcherAction({
      anomaly, verdict, config, ledger, budgetUsd,
      opportunisticThisWeek: opportunisticThisWeek + actions.filter((item) => item.action === 'buy').length,
      equityUsd: snapshot.equityUsd,
      holdingCount,
      currentClassWeight: features.allocationByClass?.[anomaly.class] ?? 0,
      availableCashUsd: snapshot.cashUsd,
      ordersToday: ordersToday + actions.filter((item) => item.executed).length,
    });

    // Il Watcher resta deliberatamente propositivo: finché non passa dallo
    // stesso executor idempotente e dalla riconciliazione del rebalance, non
    // possiede alcun percorso capace di chiamare openOrder/closeOrder.
    const executed = false;

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
          `Azione proposta: ${decision.action} (Watcher solo propositivo: nessun ordine automatico)`,
        ]);
    }
  }

  return { anomalies: anomalies.length, escalated, actions };
}

/**
 * Chiusura fail-safe di qualunque esito ambiguo dopo l'ingresso nel live.
 * Ogni effetto è tentato indipendentemente: un webhook guasto non può impedire
 * né il freeze atomico né la chiusura della run come `frozen`.
 */
export async function freezeLiveRun({ db, runId, credentials = {}, equityUsd = null, reason, stage = 'live-fail-safe', data = null }) {
  const safeReason = String(reason || 'esito live ambiguo: verifica manuale richiesta').slice(0, 300);
  const failures = [];
  let config = null;

  // Un solo retry immediato copre un errore D1 transitorio senza trasformare
  // il fail-safe in un loop o prolungare in modo imprevedibile la run.
  for (let attempt = 1; attempt <= 2 && !config; attempt += 1) {
    try {
      config = await mutateSafetyConfig(db, {
        executionMode: 'shadow',
        frozen: true,
        frozenReason: safeReason,
        recoveryRequired: true,
        recoveryReason: safeReason,
        recoveryRunIds: runId ? [runId] : [],
        recoveryUpdatedAt: Date.now(),
      });
    } catch (error) {
      failures.push(`freeze D1 tentativo ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await audit(db, runId, 'error', stage, `Autopilot congelato: ${safeReason}`, {
      ...data,
      safetyPersisted: Boolean(config),
      failures,
    });
  } catch (error) {
    failures.push(`audit: ${error instanceof Error ? error.message : String(error)}`);
  }
  const safetyPersisted = Boolean(config);
  const status = safetyPersisted ? 'frozen' : 'error';
  try {
    await notify(credentials, 'critical', safetyPersisted
      ? 'Autopilot congelato: verifica eToro'
      : 'CRITICO: stato Autopilot non confermato', [
      safeReason,
      safetyPersisted
        ? 'La modalità è stata riportata in Shadow e congelata. Controlla manualmente ordini e posizioni prima di riattivare.'
        : 'D1 non ha confermato Shadow/Frozen. Blocca o verifica subito gli ordini direttamente su eToro e non riavviare il Live.',
    ]);
  } catch (error) {
    failures.push(`notifica: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Se Shadow + Frozen non è confermato, run e activation devono restare non
  // terminali: sono la barriera persistente che impedirà al prossimo cron di
  // inviare altri ordini mentre la config potrebbe essere ancora Live.
  if (safetyPersisted) {
    try {
      await finishRun(db, runId, status, equityUsd, safeReason);
    } catch (error) {
      failures.push(`finishRun: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    console.error(JSON.stringify({ message: 'fail-safe live completato con errori', runId, failures }));
  }
  return { config, safetyPersisted, status, failures, reason: safeReason };
}

/**
 * Verifica server-side una run Live parziale e costruisce l'anteprima dei
 * piani recuperabili. Non invia ordini, non riusa alcuna POST precedente e
 * mantiene Shadow + Frozen fino a una seconda conferma esplicita.
 */
export async function prepareLiveRecovery({ env, expectedSafetyRevision }) {
  const db = env.DB;
  const ownerId = `live-recovery-${crypto.randomUUID()}`;
  const lock = await acquirePipelineLock(db, ownerId);
  if (!lock.acquired) {
    return {
      status: 'blocked',
      busy: true,
      reason: `Pipeline già occupata dalla run ${lock.ownerId ?? 'sconosciuta'}`,
      config: await loadConfig(db),
    };
  }

  try {
    const config = await loadConfig(db);
    if (!config.frozen || !config.recoveryRequired) {
      return { status: 'blocked', reason: 'non esiste una recovery Live congelata da preparare', config };
    }
    if (Number(config.safetyRevision) !== Number(expectedSafetyRevision)) {
      return { status: 'blocked', reason: 'lo stato di sicurezza è cambiato: aggiorna la dashboard', config };
    }

    const resolved = await resolveCredentials(db, env);
    if (!hasVerifiedAgentBinding(resolved, config)) {
      return { status: 'blocked', reason: 'Agent Portfolio non verificato: impossibile controllare gli acquisti', config };
    }
    const client = buildClient(resolved, config);
    const recoveryRunIds = [...new Set((config.recoveryRunIds ?? []).map(String).filter(Boolean))];
    if (!recoveryRunIds.length) {
      return { status: 'blocked', reason: 'run Live da recuperare non identificata', config };
    }
    const bundles = await Promise.all(recoveryRunIds.map((runId) => getRunBundle(db, runId)));
    if (bundles.some((bundle) => !bundle.run || !bundle.validation?.plan)) {
      return { status: 'blocked', reason: 'piano originale della run Live non disponibile', config };
    }

    const orders = bundles.flatMap((bundle) => bundle.orders)
      .filter((order) => order.mode === 'live' && !['simulated', 'skipped'].includes(order.state))
      .map((order) => storedOrderRecord(order));
    const verifiedOrders = [];
    const unresolved = [];
    const summarizeVerifiedOrders = () => verifiedOrders.map(({
      symbol, instrumentId, side, state, amountUsd, filledUsd, positionIds,
    }) => ({
      symbol, instrumentId, side, state, amountUsd,
      filledUsd: roundMoney(filledUsd),
      positionIds: (positionIds ?? []).map(Number).filter(Boolean),
    }));
    for (const order of orders) {
      if (['filled', 'rejected'].includes(order.state)) {
        verifiedOrders.push(order);
        continue;
      }
      try {
        const lookup = await client.lookupOrder({
          orderId: order.etoroOrderId,
          referenceId: order.id,
        });
        const state = lookup.state === 'pending' ? 'sent' : lookup.state;
        const updated = storedOrderRecord(order, {
          state,
          etoroOrderId: lookup.orderId || order.etoroOrderId,
          positionIds: lookup.positionIds ?? order.positionIds,
          filledUsd: roundMoney(lookup.filledUsd || (state === 'filled' ? order.amountUsd : order.filledUsd)),
          message: lookup.error ? `${lookup.label} — ${lookup.error}` : lookup.label,
        });
        await upsertOrder(db, updated);
        verifiedOrders.push(updated);
        if (['sent', 'partial'].includes(state)) {
          unresolved.push(`${order.symbol}: ${state === 'sent' ? 'ordine ancora in elaborazione' : 'esecuzione parziale'}`);
        }
      } catch (error) {
        unresolved.push(`${order.symbol}: esito non verificabile (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    if (unresolved.length) {
      await audit(db, recoveryRunIds[0], 'warn', 'live-recovery-prepare', 'Recovery ancora bloccata: ordini non terminali', unresolved);
      return {
        status: 'blocked',
        reason: 'Alcuni ordini non hanno ancora un esito terminale. Nessun nuovo ordine è stato inviato.',
        unresolved,
        config,
        orderSummary: summarizeVerifiedOrders(),
      };
    }

    const remote = resolveVerifiedAgentMirror(config, await client.agentPortfolios());
    const first = await readRecoveryAgentSnapshot(client, config, remote);
    await delay(2_500);
    const second = await readRecoveryAgentSnapshot(client, config, remote);
    const stability = recoverySnapshotsStable(first.snapshot, second.snapshot);
    const visiblePositionIds = new Set((second.virtualSnapshot.positions ?? []).map((position) => Number(position.positionId)).filter(Boolean));
    const visibleInstruments = new Set((second.virtualSnapshot.positions ?? []).map((position) => Number(position.instrumentId)).filter(Boolean));
    const missingFilledBuys = verifiedOrders.filter((order) => {
      if (order.side !== 'buy' || order.state !== 'filled') return false;
      const positionIds = (order.positionIds ?? []).map(Number).filter(Boolean);
      return positionIds.length
        ? !positionIds.some((positionId) => visiblePositionIds.has(positionId))
        : !visibleInstruments.has(Number(order.instrumentId));
    });
    if (!stability.stable || missingFilledBuys.length) {
      const reasons = [
        ...(!stability.stable ? [stability.reason] : []),
        ...missingFilledBuys.map((order) => `${order.symbol}: acquisto filled non ancora visibile nel portfolio`),
      ];
      await audit(db, recoveryRunIds[0], 'warn', 'live-recovery-prepare', 'Recovery ancora bloccata: mirror non stabilizzato', reasons);
      return {
        status: 'blocked',
        reason: 'Il mirror eToro non è ancora stabilizzato. Riprova fra poco: l’agente resta congelato.',
        unresolved: reasons,
        config,
        orderSummary: summarizeVerifiedOrders(),
      };
    }

    const [candidateRows, decisionContext] = await Promise.all([
      listRecoveryPlanCandidates(db, 20),
      buildDecisionContext(config),
    ]);
    const recommendedRunIds = new Set(recoveryRunIds);
    const candidates = candidateRows
      .map((row) => recoveryPlanCandidate(row, second.snapshot, config, recommendedRunIds, decisionContext))
      .filter(Boolean)
      .sort((left, right) => Number(right.recommended) - Number(left.recommended) || right.startedAt - left.startedAt);
    if (!candidates.length) {
      return {
        status: 'blocked',
        reason: 'nessun piano validato e compatibile è disponibile per completare la recovery',
        config,
        orderSummary: summarizeVerifiedOrders(),
      };
    }
    const warnings = [];
    try {
      await audit(db, recoveryRunIds[0], 'warn', 'live-recovery-ready', 'Acquisti verificati; piani disponibili per il completamento del residuo', {
        recoveryRunIds,
        verifiedOrders: summarizeVerifiedOrders(),
        candidates: candidates.map(({ sourceRunId, sourceType, recommended, residualOrderCount, residualUsd }) => ({
          sourceRunId, sourceType, recommended, residualOrderCount, residualUsd,
        })),
        equityUsd: second.snapshot.equityUsd,
        positions: second.snapshot.positions.length,
        warnings,
      });
    } catch (error) {
      warnings.push(`audit: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: 'ready',
      mode: 'shadow',
      config,
      recoveryRunIds,
      alreadyAcquired: verifiedOrders.filter((order) => order.side === 'buy' && order.state === 'filled').length,
      orderSummary: summarizeVerifiedOrders(),
      snapshot: {
        takenAt: second.snapshot.takenAt,
        equityUsd: second.snapshot.equityUsd,
        cashUsd: second.snapshot.cashUsd,
        positions: second.snapshot.positions.length,
      },
      candidates,
      selectedSourceRunId: candidates.find((item) => item.recommended)?.sourceRunId ?? candidates[0].sourceRunId,
      warnings,
      message: 'Nessun ordine inviato e l’agente resta congelato. Scegli il piano: il Worker rileggerà il portfolio e calcolerà soltanto il residuo prima della conferma finale.',
    };
  } finally {
    try { await releasePipelineLock(db, ownerId); } catch { /* il lease scade comunque */ }
  }
}

/** Ultima verifica autoritativa prima di dichiarare una run Live riuscita. */
async function enforceFinalLiveFence({ db, runId, config, credentials, equityUsd, stage, data = null }) {
  const fence = await readLiveSafetyFence(db, config);
  if (fence.ok) return null;

  // Un Safe stop già persistito è autorevole: non serve riscriverlo, ma la run
  // non può più risultare `ok/live`.
  if (fence.current?.executionMode === 'shadow' && fence.current.frozen) {
    await audit(db, runId, 'warn', stage, `Run interrotta dallo stato finale: ${fence.reason}`, data ?? undefined);
    await finishRun(db, runId, 'frozen', equityUsd, fence.reason);
    return {
      status: 'frozen',
      mode: 'shadow',
      reason: fence.reason,
      safetyPersisted: true,
    };
  }

  const safety = await freezeLiveRun({
    db,
    runId,
    credentials,
    equityUsd,
    reason: `controllo finale Live fallito: ${fence.reason}`,
    stage,
    data: { ...data, finalFence: fence.reason },
  });
  return {
    status: safety.status,
    mode: safety.config?.executionMode ?? null,
    reason: safety.reason,
    safetyPersisted: safety.safetyPersisted,
    safety,
    error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
  };
}

/**
 * Commit atomico dell'esito Live. Se la CAS non riesce, distingue uno stop già
 * persistito da uno stato ambiguo; quest'ultimo viene congelato in modo
 * conservativo e non può essere presentato come successo.
 */
async function commitLiveRunSuccess({ db, runId, config, credentials, equityUsd, stage, data = null }) {
  if (await finishRunIfLiveFence(db, runId, equityUsd, config)) return null;

  const finalFence = await enforceFinalLiveFence({
    db,
    runId,
    config,
    credentials,
    equityUsd,
    stage: `${stage}-cas-recheck`,
    data,
  });
  if (finalFence) return finalFence;

  const safety = await freezeLiveRun({
    db,
    runId,
    credentials,
    equityUsd,
    reason: 'impossibile confermare atomicamente la conclusione della run Live; verifica manualmente ordini e posizioni su eToro',
    stage: `${stage}-cas-ambiguous`,
    data,
  });
  return {
    status: safety.status,
    mode: safety.config?.executionMode ?? null,
    reason: safety.reason,
    safetyPersisted: safety.safetyPersisted,
    safety,
    error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
  };
}

/**
 * La recovery non abilita la schedulazione Live permanente: dopo il residuo
 * torna in Shadow con una CAS sullo stesso fence usato dall'esecutore.
 */
async function completeRecoveryOneShot({ db, runId, config, credentials, equityUsd, data = null }) {
  const shadow = await finishRecoveryToShadowIfUnchanged(db, config);
  if (shadow) {
    const finished = await finishRun(db, runId, 'ok', equityUsd);
    if (!finished) throw new Error('run di recovery non terminalizzata dopo il ritorno in Shadow');
    try {
      await audit(db, runId, 'warn', 'live-recovery-complete', 'Residuo completato; modalità riportata automaticamente in Shadow', data ?? undefined);
    } catch { /* Shadow è già autorevole; l'audit resta best-effort */ }
    return { status: 'ok', mode: 'shadow', config: shadow };
  }

  const current = await loadConfig(db).catch(() => null);
  if (current?.executionMode === 'shadow') {
    const status = current.frozen ? 'frozen' : 'ok';
    await finishRun(db, runId, status, equityUsd, current.frozen ? current.frozenReason : null);
    return {
      status,
      mode: 'shadow',
      config: current,
      ...(current.frozen ? {
        safetyPersisted: true,
        reason: current.frozenReason || 'recovery interrotta da uno stop concorrente',
      } : {}),
    };
  }

  const safety = await freezeLiveRun({
    db,
    runId,
    credentials,
    equityUsd,
    reason: 'impossibile confermare il ritorno in Shadow dopo la recovery; verifica eToro',
    stage: 'live-recovery-final-fence',
    data,
  });
  return {
    status: safety.status,
    mode: safety.config?.executionMode ?? null,
    safetyPersisted: safety.safetyPersisted,
    reason: safety.reason,
    safety,
  };
}

// ---------------------------------------------------------------- pipeline

function createRunId(kind) {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Unico ingresso alla pipeline. Cron, API e MCP competono sulla stessa riga
 * D1; chi trova un lease valido torna busy senza creare una nuova run.
 */
export async function runPipeline(args) {
  const { env, kind } = args;
  const db = env.DB;
  const runId = createRunId(kind);
  let lock;
  try {
    lock = await acquirePipelineLock(db, runId);
  } catch (error) {
    const message = `lock pipeline non disponibile: ${error instanceof Error ? error.message : String(error)}`;
    console.error(JSON.stringify({ message, kind }));
    return { runId: null, status: 'blocked', busy: true, reason: 'lock-unavailable', error: message };
  }

  if (!lock.acquired) {
    const message = `Pipeline già occupata dalla run ${lock.ownerId ?? 'sconosciuta'}`;
    try {
      await audit(db, null, 'warn', 'lock', message, { leaseUntil: lock.leaseUntil, requestedKind: kind });
    } catch { /* il lock resta la fonte autorevole anche se l'audit non riesce */ }
    return {
      runId: null,
      status: 'blocked',
      busy: true,
      reason: 'busy',
      error: message,
      activeRunId: lock.ownerId,
      leaseUntil: lock.leaseUntil,
    };
  }

  try {
    return await runPipelineWithLock({ ...args, runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await finishRun(db, runId, 'error', null, message); } catch { /* best-effort */ }
    try { await audit(db, runId, 'error', 'pipeline-wrapper', message); } catch { /* best-effort */ }
    return { runId, status: 'error', mode: null, error: message };
  } finally {
    try {
      await releasePipelineLock(db, runId);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'rilascio lock pipeline fallito',
        runId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function replayLiveActivation(row, currentConfig = null) {
  if (!row) return null;
  if (row.response_json) {
    try {
      const parsed = JSON.parse(row.response_json);
      if (parsed?.recovery === true) return { ...parsed, replayed: true };
      const stoppedAfterResult = currentConfig
        && (parsed.status === 'ok' || parsed.mode === 'live')
        && (
          currentConfig.executionMode !== 'live'
          || currentConfig.frozen
          || currentConfig.recoveryRequired
        );
      if (stoppedAfterResult) {
        return {
          ...parsed,
          historicalStatus: parsed.status,
          historicalMode: parsed.mode,
          status: currentConfig.frozen ? 'frozen' : 'blocked',
          mode: currentConfig.executionMode,
          safetyPersisted: currentConfig.frozen ? true : parsed.safetyPersisted,
          reason: currentConfig.frozen
            ? `stato corrente congelato: ${currentConfig.frozenReason || currentConfig.recoveryReason || 'stop remoto'}`
            : `stato corrente ${currentConfig.executionMode}: il Live non è più attivo`,
          replayed: true,
        };
      }
      return { ...parsed, replayed: true };
    } catch { /* stato corrotto: fail closed sotto */ }
  }
  return {
    activationId: row.activation_id,
    runId: row.run_id ?? null,
    status: 'blocked',
    mode: null,
    busy: true,
    reason: 'activation-in-progress',
    error: 'Questa attivazione Live è già stata avviata. Controlla la run esistente: non verrà creato un secondo ciclo.',
    replayed: true,
  };
}

/**
 * Dopo aver persistito Shadow + Frozen, chiude anche le righe lasciate
 * `running` da un hard abort. Senza questo passo la barriera corretta
 * diventerebbe permanente anche dopo la verifica manuale e l'unfreeze.
 */
async function settleLiveRecoveryBarrier(db, barrier, safety) {
  if (!barrier || !safety?.safetyPersisted) return false;
  const runIds = new Set([
    barrier.activation?.run_id,
    barrier.order?.run_id,
  ].filter(Boolean));
  for (const staleRunId of runIds) {
    await finishRun(db, staleRunId, 'frozen', null, safety.reason);
  }
  if (barrier.activation?.activation_id) {
    const activationId = String(barrier.activation.activation_id);
    const response = compactLiveActivationResult(activationId, {
      runId: barrier.activation.run_id ?? barrier.order?.run_id ?? null,
      status: 'frozen',
      mode: safety.config?.executionMode ?? null,
      safetyPersisted: true,
      reason: safety.reason,
      decisionSource: barrier.activation.source_run_id ? 'reused-dry-run' : 'fresh-analysis',
      reusedDryRunId: barrier.activation.source_run_id ?? null,
    });
    const completion = await finishLiveActivation(db, activationId, 'frozen', response, safety.reason);
    if (!completion.written && !completion.row?.response_json) {
      throw new Error('activation di recovery non terminalizzata e risposta autorevole assente');
    }
    return {
      settled: true,
      canonicalResponse: completion.written
        ? response
        : replayLiveActivation(completion.row, safety.config),
    };
  }
  return { settled: true, canonicalResponse: null };
}

/**
 * Operazione atomica usata dal pulsante Live. Il lock viene acquisito prima
 * della prenotazione e la modalità persistente viene armata soltanto dopo che
 * snapshot, proposta e validator hanno prodotto un piano valido.
 */
export async function activateLiveAndRun({ env, activationId }) {
  const db = env.DB;
  const previous = await getLiveActivation(db, activationId);
  // Un risultato terminale è sempre riproducibile. Una riga non terminale,
  // invece, può appartenere a un Worker abortito: deve passare dal lock e
  // dalla recovery barrier, non restare `busy` per sempre.
  if (previous?.response_json) {
    const current = await loadConfig(db);
    return replayLiveActivation(previous, current);
  }

  const runId = createRunId('rebalance');
  let lock;
  try {
    lock = await acquirePipelineLock(db, runId);
  } catch (error) {
    const message = `lock pipeline non disponibile: ${error instanceof Error ? error.message : String(error)}`;
    return { activationId, runId: null, status: 'blocked', mode: null, busy: true, reason: 'lock-unavailable', error: message };
  }
  if (!lock.acquired) {
    return {
      activationId,
      runId: null,
      status: 'blocked',
      mode: null,
      busy: true,
      reason: 'busy',
      error: `Pipeline già occupata dalla run ${lock.ownerId ?? 'sconosciuta'}. Il Live non è stato attivato.`,
      activeRunId: lock.ownerId,
      leaseUntil: lock.leaseUntil,
    };
  }

  try {
    const duplicate = await getLiveActivation(db, activationId);
    const current = await loadConfig(db);
    let resolved = null;
    try {
      resolved = await resolveCredentials(db, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'credenziali notifiche/recovery non leggibili',
        activationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    if (duplicate) {
      if (duplicate.response_json) return replayLiveActivation(duplicate, current);
      const recoveryBarrier = await findLiveRecoveryBarrier(db);
      const enteredLive = ['arming-live', 'executing-live'].includes(String(duplicate.status))
        || recoveryBarrier?.order?.run_id === duplicate.run_id;
      if (enteredLive) {
        const barrier = {
          activation: {
            activation_id: duplicate.activation_id,
            run_id: duplicate.run_id,
            status: duplicate.status,
            source_run_id: duplicate.source_run_id ?? null,
            updated_at: duplicate.updated_at,
          },
          order: recoveryBarrier?.order ?? null,
        };
        const safety = await freezeLiveRun({
          db,
          runId: duplicate.run_id,
          credentials: resolved?.values ?? {},
          reason: 'una precedente richiesta Live si è interrotta senza esito terminale; verifica manualmente eToro',
          stage: 'live-recovery-barrier',
          data: barrier,
        });
        let settlement = null;
        try {
          settlement = await settleLiveRecoveryBarrier(db, barrier, safety);
        } catch (error) {
          safety.failures.push(`chiusura recovery: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (settlement?.canonicalResponse) {
          return { ...settlement.canonicalResponse, replayed: true };
        }
        return {
          activationId,
          runId: duplicate.run_id ?? null,
          status: safety.status,
          mode: safety.config?.executionMode ?? null,
          safetyPersisted: safety.safetyPersisted,
          reason: safety.reason,
          error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
          replayed: true,
        };
      }

      const reason = 'la precedente richiesta si è interrotta prima dell’attivazione Live; nessun ordine risulta avviato';
      let response = compactLiveActivationResult(activationId, {
        runId: duplicate.run_id ?? null,
        status: 'blocked',
        mode: current.executionMode,
        reason,
      });
      try {
        await releaseDecisionArtifactClaimsByRun(db, duplicate.run_id);
        await finishRun(db, duplicate.run_id, 'blocked', null, reason);
        const completion = await finishLiveActivation(db, activationId, 'blocked', response, reason);
        if (!completion.written && completion.row?.response_json) {
          response = replayLiveActivation(completion.row, current);
        } else if (!completion.written) {
          throw new Error('activation pre-Live non terminalizzata e risposta autorevole assente');
        }
      } catch (error) {
        response.persistenceWarning = `Recovery non persistita: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { ...response, replayed: true };
    }

    // Il lock appena acquisito rende autorevoli queste activation pre-arm: il
    // precedente Worker non possiede più il lease e non può arrivare alla CAS
    // Live. Ripuliamo run e claim anche quando il nuovo device usa un altro ID.
    try {
      const stalePreArm = await listStalePreArmActivations(db, { excludeActivationId: activationId });
      for (const stale of stalePreArm) {
        const reason = 'richiesta Live interrotta prima dell’armamento; nessun ordine risulta avviato';
        await releaseDecisionArtifactClaimsByRun(db, stale.run_id);
        await finishRun(db, stale.run_id, 'blocked', null, reason);
        const staleResponse = compactLiveActivationResult(stale.activation_id, {
          runId: stale.run_id,
          status: 'blocked',
          mode: current.executionMode,
          reason,
          decisionSource: stale.source_run_id ? 'reused-dry-run' : 'fresh-analysis',
          reusedDryRunId: stale.source_run_id ?? null,
        });
        await finishLiveActivation(db, stale.activation_id, 'blocked', staleResponse, reason);
      }
      if (stalePreArm.length) {
        await audit(db, null, 'warn', 'live-recovery-pre-arm', `${stalePreArm.length} richieste pre-Live interrotte sono state chiuse`);
      }
    } catch (error) {
      return {
        activationId,
        runId: null,
        status: 'blocked',
        mode: current.executionMode,
        reason: 'pre-arm-recovery-failed',
        error: `Recovery delle richieste Live precedenti non riuscita: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (current.frozen || current.recoveryRequired) {
      return {
        activationId,
        runId: null,
        status: 'blocked',
        mode: current.executionMode,
        reason: current.recoveryRequired ? 'recovery-required' : 'frozen',
        error: current.recoveryRequired
          ? `Recovery Live richiesta: ${current.recoveryReason || 'verifica ordini e posizioni su eToro'}. Conferma la verifica prima del Live.`
          : `Autopilot congelato: ${current.frozenReason || 'freeze attivo'}. Riattivalo prima del Live.`,
      };
    }
    if (current.executionMode === 'live') {
      const recoveryBarrier = await findLiveRecoveryBarrier(db);
      if (recoveryBarrier) {
        const safety = await freezeLiveRun({
          db,
          runId: null,
          credentials: resolved?.values ?? {},
          reason: 'rilevata una precedente attivazione o un ordine Live senza esito terminale; verifica manualmente eToro',
          stage: 'live-recovery-barrier',
          data: recoveryBarrier,
        });
        try {
          await settleLiveRecoveryBarrier(db, recoveryBarrier, safety);
        } catch (error) {
          safety.failures.push(`chiusura recovery: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
          activationId,
          runId: null,
          status: safety.status,
          mode: safety.config?.executionMode ?? null,
          safetyPersisted: safety.safetyPersisted,
          reason: safety.reason,
          error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
        };
      }
      return {
        activationId,
        runId: null,
        status: 'blocked',
        mode: 'live',
        reason: 'already-live',
        error: 'La modalità Live è già attiva. Nessuna seconda run reale è stata avviata.',
      };
    }
    if (!resolved) {
      return {
        activationId,
        runId: null,
        status: 'blocked',
        mode: current.executionMode,
        reason: 'credentials-unavailable',
        error: 'Credenziali non leggibili: il Live non è stato attivato.',
      };
    }
    if (!hasVerifiedAgentBinding(resolved, current)) {
      return {
        activationId,
        runId: null,
        status: 'blocked',
        mode: current.executionMode,
        reason: 'agent-not-verified',
        error: 'Agent Portfolio non verificato: genera un nuovo token e attendi la verifica prima del Live.',
      };
    }

    const reservation = await reserveLiveActivation(db, activationId, runId);
    if (!reservation.created) return replayLiveActivation(reservation.row, current);
    try {
      await audit(db, null, 'warn', 'live-activation', 'Attivazione Live immediata richiesta', {
        activationId,
        runId,
        dryRunTtlMinutes: LIVE_DRY_RUN_TTL_MS / 60000,
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: 'audit richiesta Live fallito',
        activationId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    let result;
    try {
      result = await runPipelineWithLock({
        env,
        kind: 'rebalance',
        modeOverride: 'live',
        runId,
        delayedLiveArm: true,
        reuseLatestDryRun: true,
        liveActivationId: activationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await finishRun(db, runId, 'error', null, message); } catch { /* best-effort */ }
      result = { runId, status: 'error', error: message, decisionSource: 'fresh-analysis' };
    }

    // Ultimo controllo multi-device dopo il ritorno della pipeline: un Safe
    // stop può essere arrivato fra il final fence interno e questa risposta.
    if (result.status === 'ok') {
      try {
        const authoritative = await loadConfig(db);
        if (authoritative.executionMode !== 'live' || authoritative.frozen || authoritative.recoveryRequired) {
          result = {
            ...result,
            status: authoritative.frozen ? 'frozen' : 'blocked',
            mode: authoritative.executionMode,
            safetyPersisted: authoritative.frozen ? true : undefined,
            reason: authoritative.frozen
              ? `stato finale congelato: ${authoritative.frozenReason || authoritative.recoveryReason || 'stop remoto'}`
              : `modalità finale ${authoritative.executionMode}: il Live è stato disattivato da un altro dispositivo`,
          };
        }
      } catch (error) {
        const safety = await freezeLiveRun({
          db,
          runId,
          credentials: resolved.values,
          reason: `stato finale Live non leggibile: ${error instanceof Error ? error.message : String(error)}`,
          stage: 'live-response-final-fence',
        });
        result = {
          ...result,
          status: safety.status,
          mode: safety.config?.executionMode ?? null,
          safetyPersisted: safety.safetyPersisted,
          reason: safety.reason,
          safety,
          error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
        };
      }
    }

    let response = compactLiveActivationResult(activationId, result);
    if (result.safetyPersisted === false) {
      response.persistenceWarning = 'Shadow + Frozen non confermati: activation e run restano aperte come barriera di recovery.';
    } else {
      try {
        const completion = await finishLiveActivation(
          db,
          activationId,
          result.status ?? 'error',
          response,
          result.error ?? result.reason ?? null,
        );
        if (!completion.written && completion.row?.response_json) {
          const authoritative = await loadConfig(db);
          response = replayLiveActivation(completion.row, authoritative);
        } else if (!completion.written) {
          throw new Error('richiesta Live non terminalizzata e risposta autorevole assente');
        }
      } catch (error) {
        console.error(JSON.stringify({
          message: 'persistenza esito attivazione Live fallita',
          activationId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        }));
        response.persistenceWarning = 'Esito della richiesta non persistito; non ripetere automaticamente l’attivazione.';
      }
    }

    // Linearizza la risposta utente dopo la persistenza dell'activation. Se un
    // Safe stop ha vinto fra il fence precedente e finishLiveActivation, la
    // run resta uno storico riuscito ma la risposta corrente non può dire Live.
    if (response.status === 'ok') {
      try {
        const currentAfterPersistence = await loadConfig(db);
        if (
          currentAfterPersistence.executionMode !== 'live'
          || currentAfterPersistence.frozen
          || currentAfterPersistence.recoveryRequired
        ) {
          response = {
            ...response,
            historicalStatus: response.status,
            historicalMode: response.mode,
            status: currentAfterPersistence.frozen ? 'frozen' : 'blocked',
            mode: currentAfterPersistence.executionMode,
            safetyPersisted: currentAfterPersistence.frozen ? true : response.safetyPersisted,
            reason: currentAfterPersistence.frozen
              ? `stato corrente congelato: ${currentAfterPersistence.frozenReason || currentAfterPersistence.recoveryReason || 'stop remoto'}`
              : `stato corrente ${currentAfterPersistence.executionMode}: il Live non è più attivo`,
          };
        }
      } catch (error) {
        response.persistenceWarning = [
          response.persistenceWarning,
          `Stato corrente non riconfermato dopo la persistenza: ${error instanceof Error ? error.message : String(error)}`,
        ].filter(Boolean).join(' ');
      }
    }
    return response;
  } finally {
    try {
      await releasePipelineLock(db, runId);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'rilascio lock attivazione Live fallito',
        runId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function compactRecoveryExecutionResult(activationId, sourceRunId, result) {
  return {
    ...compactLiveActivationResult(activationId, result),
    recovery: true,
    recoveryCompleted: result?.recoveryCompleted === true,
    recoverySourceRunId: sourceRunId,
    decisionSource: 'recovery-plan',
    reconciliation: result?.reconciliation ? {
      ok: Boolean(result.reconciliation.ok),
      worstDivergence: Number(result.reconciliation.worstDivergence) || 0,
      attempts: Number(result.reconciliation.attempts) || 0,
      rows: result.reconciliation.rows ?? [],
    } : null,
    execution: summarizeExecution(result),
  };
}

/**
 * Completa una recovery usando esattamente i target del piano scelto. È
 * idempotente per activationId e torna automaticamente in Shadow.
 */
export async function executeLiveRecovery({ env, activationId, sourceRunId, expectedSafetyRevision }) {
  const db = env.DB;
  const previous = await getLiveActivation(db, activationId);
  if (previous?.response_json) return replayLiveActivation(previous, await loadConfig(db));

  const runId = previous?.run_id ?? createRunId('rebalance');
  let lock;
  try {
    lock = await acquirePipelineLock(db, runId);
  } catch (error) {
    return {
      activationId, runId: null, status: 'blocked', mode: 'shadow', recovery: true,
      recoveryCompleted: false, recoverySourceRunId: sourceRunId, busy: true,
      reason: `lock pipeline non disponibile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!lock.acquired) {
    return {
      activationId, runId: null, status: 'blocked', mode: 'shadow', recovery: true,
      recoveryCompleted: false, recoverySourceRunId: sourceRunId, busy: true,
      reason: `Pipeline già occupata dalla run ${lock.ownerId ?? 'sconosciuta'}`,
      activeRunId: lock.ownerId,
      leaseUntil: lock.leaseUntil,
    };
  }

  let resolved = null;
  try {
    const current = await loadConfig(db);
    resolved = await resolveCredentials(db, env).catch(() => null);
    const duplicate = await getLiveActivation(db, activationId);
    if (duplicate) {
      if (duplicate.response_json) return replayLiveActivation(duplicate, current);
      if (['arming-live', 'executing-live'].includes(String(duplicate.status))) {
        const safety = await freezeLiveRun({
          db,
          runId: duplicate.run_id,
          credentials: resolved?.values ?? {},
          reason: 'una precedente ripresa Live si è interrotta senza esito terminale; verifica eToro prima di riprovare',
          stage: 'live-recovery-replay-barrier',
        });
        const response = compactRecoveryExecutionResult(activationId, sourceRunId, {
          runId: duplicate.run_id,
          status: safety.status,
          mode: safety.config?.executionMode ?? null,
          safetyPersisted: safety.safetyPersisted,
          reason: safety.reason,
        });
        if (safety.safetyPersisted) {
          await finishLiveActivation(db, activationId, response.status, response, response.reason);
        }
        return response;
      }
      const reason = 'la precedente richiesta di ripresa si è interrotta prima dell’armamento; nessun nuovo ordine risulta avviato';
      const response = compactRecoveryExecutionResult(activationId, sourceRunId, {
        runId: duplicate.run_id,
        status: 'blocked',
        mode: current.executionMode,
        reason,
      });
      await finishRun(db, duplicate.run_id, 'blocked', null, reason);
      await finishLiveActivation(db, activationId, 'blocked', response, reason);
      return response;
    }

    if (
      current.executionMode !== 'shadow'
      || !current.frozen
      || !current.recoveryRequired
    ) {
      return {
        activationId, runId: null, status: 'blocked', mode: current.executionMode,
        recovery: true, recoveryCompleted: false, recoverySourceRunId: sourceRunId,
        reason: 'la recovery non è più nello stato Shadow + Frozen richiesto',
      };
    }
    if (Number(current.safetyRevision) !== Number(expectedSafetyRevision)) {
      return {
        activationId, runId: null, status: 'blocked', mode: current.executionMode,
        recovery: true, recoveryCompleted: false, recoverySourceRunId: sourceRunId,
        reason: 'lo stato di sicurezza è cambiato dopo l’anteprima: aggiorna prima di confermare',
      };
    }
    if (!resolved || !hasVerifiedAgentBinding(resolved, current)) {
      return {
        activationId, runId: null, status: 'blocked', mode: current.executionMode,
        recovery: true, recoveryCompleted: false, recoverySourceRunId: sourceRunId,
        reason: 'Agent Portfolio non verificato: nessun nuovo ordine può essere inviato',
      };
    }

    const [candidateRows, decisionContext] = await Promise.all([
      listRecoveryPlanCandidates(db, 30),
      buildDecisionContext(current),
    ]);
    const selected = candidateRows.find((row) => String(row.id) === String(sourceRunId));
    const selectedIsRecoveryRun = (current.recoveryRunIds ?? []).map(String).includes(String(sourceRunId));
    const compatibleDryRun = selected?.execution_mode === 'dry-run'
      && Number(selected.artifact_decision_revision) === Number(decisionContext.decisionRevision)
      && selected.artifact_decision_hash === decisionContext.decisionHash
      && selected.artifact_binding_hash === decisionContext.bindingHash;
    if (!selected || (!selectedIsRecoveryRun && !compatibleDryRun)) {
      return {
        activationId, runId: null, status: 'blocked', mode: current.executionMode,
        recovery: true, recoveryCompleted: false, recoverySourceRunId: sourceRunId,
        reason: 'il piano scelto non è più disponibile o compatibile con strategia e Agent Portfolio correnti',
      };
    }

    const reservation = await reserveLiveActivation(db, activationId, runId);
    if (!reservation.created) return replayLiveActivation(reservation.row, current);
    await setLiveActivationSource(db, activationId, sourceRunId);
    await audit(db, null, 'warn', 'live-recovery-execute', 'Completamento one-shot del piano selezionato richiesto', {
      activationId, runId, sourceRunId,
    });

    let result;
    try {
      result = await runPipelineWithLock({
        env,
        kind: 'rebalance',
        modeOverride: 'live',
        runId,
        delayedLiveArm: true,
        liveActivationId: activationId,
        recoverySourceRunId: sourceRunId,
        recoveryExpectedSafetyRevision: expectedSafetyRevision,
        recoveryOneShot: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await finishRun(db, runId, 'error', null, message); } catch { /* best-effort */ }
      result = { runId, status: 'error', mode: null, error: message };
    }

    let response = compactRecoveryExecutionResult(activationId, sourceRunId, result);
    if (result.safetyPersisted === false) {
      response.persistenceWarning = 'Shadow + Frozen non confermati: non ripetere la recovery e verifica subito eToro.';
    } else {
      const completion = await finishLiveActivation(
        db,
        activationId,
        response.status,
        response,
        response.error ?? response.reason ?? null,
      );
      if (!completion.written && completion.row?.response_json) {
        response = replayLiveActivation(completion.row, await loadConfig(db));
      } else if (!completion.written) {
        response.persistenceWarning = 'Esito della recovery non persistito: non ripetere automaticamente l’operazione.';
      }
    }
    return response;
  } finally {
    try { await releasePipelineLock(db, runId); } catch { /* il lease scade comunque */ }
  }
}

async function runPipelineWithLock({
  env, kind, modeOverride, improveFromRunId = '', retryFromRunId = '', runId,
  delayedLiveArm = false, reuseLatestDryRun = false, liveActivationId = '',
  recoverySourceRunId = '', recoveryExpectedSafetyRevision = null, recoveryOneShot = false,
}) {
  const db = env.DB;
  const renewLease = async (stage) => {
    if (!await renewPipelineLock(db, runId)) {
      throw new Error(`lease pipeline perso prima della fase ${stage}`);
    }
  };
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
  const recoveryMode = Boolean(recoverySourceRunId);
  let persistentMode = config.executionMode;
  const baseProfile = PROFILES[config.strategyProfile] ?? PROFILES.balanced;
  const profile = config.strategySpec ? {
    ...baseProfile,
    targetVolPct: [
      config.strategySpec.risk?.targetVolatilityPct?.min ?? baseProfile.targetVolPct[0],
      config.strategySpec.risk?.targetVolatilityPct?.max ?? baseProfile.targetVolPct[1],
    ],
    maxHoldings: config.strategySpec.diversification?.maxPositions ?? baseProfile.maxHoldings,
  } : baseProfile;
  await startRun(db, runId, kind, mode);
  await audit(db, runId, 'info', 'start', `Run ${kind} avviata in modalità ${mode} · profilo ${profile.label}`);
  const sourceRunId = improveFromRunId || retryFromRunId;
  const previousBundle = sourceRunId ? await getRunBundle(db, sourceRunId) : null;
  const recoveryBundle = recoveryMode ? await getRunBundle(db, recoverySourceRunId) : null;
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
  if (recoveryMode && mode !== 'live') {
    const error = 'una recovery può essere eseguita soltanto come ciclo Live one-shot';
    await audit(db, runId, 'error', 'live-recovery', error);
    await finishRun(db, runId, 'blocked', null, error);
    return { runId, status: 'blocked', mode: config.executionMode, error };
  }

  let equityUsd = null;
  let credentials = {};
  let livePhaseEntered = false;
  let decisionSource = 'fresh-analysis';
  let reusedDryRunId = null;
  let reuseFallbackReason = null;
  let pendingDryRunClaim = null;
  const releasePendingDryRun = async () => {
    if (!pendingDryRunClaim) return true;
    const claimed = pendingDryRunClaim;
    const released = await releaseDecisionArtifactClaim(db, {
      sourceRunId: claimed.sourceRunId,
      runId,
    });
    if (released) pendingDryRunClaim = null;
    return released;
  };
  try {
    if (mode === 'live') {
      const recoveryBarrier = await findLiveRecoveryBarrier(db, { excludeRunId: runId });
      if (recoveryBarrier) {
        try {
          credentials = (await resolveCredentials(db, env)).values;
        } catch { /* il freeze D1 resta prioritario anche se il vault non è leggibile */ }
        const safety = await freezeLiveRun({
          db,
          runId,
          credentials,
          reason: 'rilevata una precedente attivazione o un ordine Live senza esito terminale; verifica manualmente eToro',
          stage: 'live-recovery-barrier',
          data: recoveryBarrier,
        });
        try {
          await settleLiveRecoveryBarrier(db, recoveryBarrier, safety);
        } catch (error) {
          safety.failures.push(`chiusura recovery: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
          runId,
          status: safety.status,
          mode: safety.config?.executionMode ?? null,
          safetyPersisted: safety.safetyPersisted,
          reason: safety.reason,
          safety,
          error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
          decisionSource,
          reusedDryRunId,
          reuseFallbackReason,
        };
      }
    }
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
        const remote = resolveVerifiedAgentMirror(config, await client.agentPortfolios());
        const mirrorId = String(remote.mirrorId);
        const realMirrorSnapshot = await client.mirrorPortfolio(mirrorId);
        snapshot = scaleAgentSnapshotToReal(virtualSnapshot, realMirrorSnapshot);
        snapshot.agentPortfolioId = remote.id;
        if (remote.virtualBalanceUsd) {
          config.activeAgentPortfolioVirtualBalanceUsd = remote?.virtualBalanceUsd || virtualSnapshot.equityUsd;
          await saveConfig(db, {
            activeAgentPortfolioVirtualBalanceUsd: config.activeAgentPortfolioVirtualBalanceUsd,
          });
        }
      } else {
        snapshot = virtualSnapshot;
      }
    } catch (error) {
      if (hasVerifiedAgent && !virtualSnapshot && Number(error?.status) === 401) {
        await saveCredentials(db, env, { etoroAgentToken: '' });
        await mutateSafetyConfig(db, { executionMode: 'shadow' });
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
        }, { decisionChange: true });
        await audit(db, runId, 'error', 'credentials', 'Token Agent revocato o non valido: binding rimosso e live disattivato');
      }
      throw error;
    }
    const baselineResetReason = capitalTrackingResetReason(config, hasVerifiedAgent);
    if (baselineResetReason) {
      config.realCapitalTrackingStartedAt = Date.now();
      await saveConfig(db, { realCapitalTrackingStartedAt: config.realCapitalTrackingStartedAt });
      await audit(db, runId, 'warn', 'capital-baseline', `Nuova baseline del capitale reale: ${baselineResetReason}`, {
        trackingStartedAt: config.realCapitalTrackingStartedAt,
        agentTokenVerifiedAt: Number(config.agentTokenVerifiedAt) || 0,
        mirrorId: snapshot.mirrorId,
      });
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
      hwm,
      drawdown,
      source: snapshot.source,
      agentPortfolioId: snapshot.agentPortfolioId ?? null,
      mirrorId: snapshot.mirrorId,
      equitySource: snapshot.equitySource ?? null,
      reportedEquityUsd: snapshot.reportedEquityUsd ?? null,
      calculatedEquityUsd: snapshot.calculatedEquityUsd ?? snapshot.equityUsd,
    });
    await renewLease('analisi');

    // --- 2. Circuit breaker ------------------------------------------------
    if (drawdown > config.drawdownStopPct && !config.frozen) {
      const reason = `drawdown ${(drawdown * 100).toFixed(1)}% oltre la soglia ${(config.drawdownStopPct * 100).toFixed(0)}%`;
      const frozenConfig = await mutateSafetyConfig(db, { executionMode: 'shadow', frozen: true, frozenReason: reason });
      await audit(db, runId, 'error', 'circuit-breaker', `Agente congelato: ${reason}`);
      await notify(credentials, 'critical', 'Autopilot congelato', [reason, `Capitale reale ${snapshot.equityUsd} USD · massimo storico reale ${hwm} USD`]);
      await finishRun(db, runId, 'frozen', equityUsd, reason);
      return { runId, status: 'frozen', mode: frozenConfig.executionMode, safetyPersisted: true, reason };
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
      const result = await runWatcher({ env, db, config, credentials, snapshot, features, universe, candles, external, runId });
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

    await renewLease('cervello');

    const shortlistWithWeights = screening.shortlist.map((item) => ({
      ...item,
      weight: features.instruments.find((row) => row.symbol === item.symbol)?.weight ?? 0,
    }));
    const featuresPrompt = dynamic
      ? [renderFeaturesPrompt(features, config, { includeInstruments: false }), renderShortlistPrompt(shortlistWithWeights)].join('\n')
      : renderFeaturesPrompt(features, config);
    const ledgerNotes = describeLedger(ledger, config);

    const recoveryTargetSymbols = recoveryMode
      ? Object.keys(recoveryBundle?.validation?.plan?.targets ?? {}).filter((symbol) => symbol !== 'CASH')
      : [];
    const allowedSymbols = [...new Set([
      ...(dynamic ? shortlistSymbols : [...universe.keys()]),
      ...recoveryTargetSymbols,
    ])];
    const decisionContext = await buildDecisionContext(config);
    const askFreshBrain = (fallbackFrom = null) => askBrain({
      config,
      credentials,
      env,
      featuresPrompt,
      allowedSymbols,
      dynamic,
      profileDescription: describeProfile(config),
      ledgerNotes,
      revisionContext,
      previousModel: fallbackFrom?.model ?? previousBundle?.proposal?.model ?? '',
      previousAttempts: fallbackFrom?.attempts ?? previousBundle?.proposal?.attempts ?? [],
    });

    let brain = null;
    if (recoveryMode) {
      if (
        !recoveryBundle?.run
        || !recoveryBundle?.validation?.ok
        || !recoveryBundle.validation.plan?.targets
        || !recoveryBundle?.proposal?.parsed
      ) {
        throw new Error(`il piano ${recoverySourceRunId} non è più disponibile o validato`);
      }
      const missingTargets = recoveryTargetSymbols.filter((symbol) => !features.instruments.some((item) => item.symbol === symbol));
      if (missingTargets.length) {
        throw new Error(`strumenti del piano originale non più risolvibili su eToro: ${missingTargets.join(', ')}`);
      }
      const normalized = normalizeProposal({
        ...recoveryBundle.proposal.parsed,
        targetWeights: recoveryBundle.validation.plan.targets,
      }, allowedSymbols);
      if (!normalized.ok) throw new Error(`piano originale non più normalizzabile: ${normalized.error}`);
      brain = {
        ok: true,
        model: recoveryBundle.proposal.model,
        attempts: recoveryBundle.proposal.attempts ?? [],
        rawText: recoveryBundle.proposal.raw_text ?? '',
        promptChars: recoveryBundle.proposal.prompt_chars ?? null,
        parsed: normalized.value,
      };
      decisionSource = 'recovery-plan';
      reusedDryRunId = recoverySourceRunId;
      await audit(db, runId, 'warn', 'live-recovery-plan', `Ripresa esatta del piano ${recoverySourceRunId}; nessuna nuova analisi AI`, {
        sourceRunId: recoverySourceRunId,
        sourceMode: recoveryBundle.run.execution_mode,
        targets: brain.parsed.targetWeights,
      });
    } else if (mode === 'live' && reuseLatestDryRun) {
      const candidate = await latestDryRunWithArtifact(db);
      const classification = classifyDryRunForReuse(candidate, decisionContext);
      if (classification.reusable) {
        const claimedDryRunId = candidate.artifact_source_run_id;
        const sourceBundle = await getRunBundle(db, claimedDryRunId);
        const normalized = normalizeProposal(sourceBundle?.proposal?.parsed, allowedSymbols);
        const [storedProposalHash, portfolioCheck] = await Promise.all([
          proposalHash(sourceBundle?.proposal?.parsed),
          Promise.resolve(comparePortfolioForReuse(sourceBundle, snapshot, config)),
        ]);
        let rejectedReason = '';
        if (storedProposalHash !== candidate.proposal_hash) rejectedReason = 'fingerprint della proposta dry-run non coerente';
        else if (!normalized.ok) rejectedReason = `proposta dry-run non più compatibile: ${normalized.error}`;
        else if (!portfolioCheck.ok) rejectedReason = portfolioCheck.reason;

        // Claim immediato: la validità viene fissata quando il Worker decide
        // davvero di usare la dry-run. Se nel frattempo è scaduta/consumata,
        // `brain` resta nullo e sotto parte automaticamente una nuova analisi.
        if (!rejectedReason) {
          const claimed = await claimLatestDecisionArtifact(db, {
            runId,
            ...decisionContext,
          });
          if (claimed?.source_run_id !== claimedDryRunId) {
            rejectedReason = 'decisione dry-run scaduta o già utilizzata durante l’attivazione';
          }
        }

        if (!rejectedReason) {
          reusedDryRunId = claimedDryRunId;
          pendingDryRunClaim = { sourceRunId: claimedDryRunId };
          brain = {
            ok: true,
            model: sourceBundle.proposal.model,
            attempts: sourceBundle.proposal.attempts ?? [],
            rawText: sourceBundle.proposal.raw_text ?? '',
            promptChars: sourceBundle.proposal.prompt_chars ?? null,
            parsed: normalized.value,
          };
          decisionSource = 'reused-dry-run';
          await audit(db, runId, 'info', 'decision-reuse', `Decisione AI riusata dalla dry-run ${reusedDryRunId}; snapshot, piano e ordini vengono ricalcolati`, {
            sourceRunId: reusedDryRunId,
            sourceModel: brain.model,
            artifactExpiresAt: candidate.expires_at,
          });
        } else {
          reuseFallbackReason = rejectedReason;
          await audit(db, runId, 'warn', 'decision-reuse', `Dry-run ${claimedDryRunId} non riutilizzabile sui dati correnti: ${rejectedReason}. Avvio una nuova analisi AI.`, {
            sourceRunId: claimedDryRunId,
          });
        }
      } else {
        reuseFallbackReason = classification.reason === 'expired'
          ? 'la dry-run più recente è scaduta'
          : 'nessuna dry-run valida e compatibile entro le ultime 2 ore';
        await audit(db, runId, 'info', 'decision-reuse', `${reuseFallbackReason}; avvio una nuova analisi AI`);
      }
    }

    if (!brain) brain = await askFreshBrain();
    await saveProposal(db, runId, brain);
    if (!brain.ok) {
      await audit(db, runId, 'error', 'brain', 'Nessuna proposta valida dai modelli', brain.attempts);
      await finishRun(db, runId, 'error', equityUsd, brain.error);
      await notify(credentials, 'warn', 'Autopilot: nessuna proposta', [brain.error ?? '']);
      return {
        runId,
        status: 'error',
        mode: persistentMode,
        error: brain.error,
        attempts: brain.attempts,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }
    await audit(db, runId, 'info', 'brain', `${decisionSource === 'recovery-plan' ? 'Piano recuperato da' : decisionSource === 'reused-dry-run' ? 'Proposta riusata da' : 'Proposta da'} ${brain.model} (confidence ${brain.parsed.confidence})`, { targets: brain.parsed.targetWeights });

    // --- 7. Validazione ----------------------------------------------------
    const ordersToday = await countOrdersToday(db);
    const sourceSnapshotEquity = Number(recoveryBundle?.snapshot?.equity_usd) || 0;
    const sourceSnapshotCash = Number(recoveryBundle?.snapshot?.cash_usd) || 0;
    const recoveryInitialConstruction = recoveryMode
      && sourceSnapshotEquity > 0
      && sourceSnapshotCash >= sourceSnapshotEquity * 0.95
      && (recoveryBundle?.snapshot?.positions ?? []).length === 0;
    const validateBrain = (proposal) => validateProposal({
      proposal,
      features,
      config: recoveryMode ? { ...config, frozen: false, frozenReason: '' } : config,
      ordersToday,
      ledger,
      scores,
      completionSymbols: allowedSymbols,
      initialConstructionOverride: recoveryInitialConstruction,
    });
    let validation = validateBrain(brain.parsed);
    await saveValidation(db, runId, validation);

    // Una decisione ancora entro TTL può comunque non superare i guardrail
    // sul nuovo snapshot. In quel caso il click Live mantiene la promessa:
    // nuova analisi nello stesso ciclo, poi una seconda validazione completa.
    if (!validation.ok && decisionSource === 'reused-dry-run') {
      const blocking = validation.violations
        .filter((item) => item.severity === 'blocking')
        .map((item) => item.message)
        .join(' · ');
      reuseFallbackReason = blocking || 'decisione dry-run non più valida sui dati correnti';
      await audit(db, runId, 'warn', 'decision-reuse', `Decisione dry-run non più valida: ${reuseFallbackReason}. Avvio una nuova analisi AI.`, validation.violations);
      const reusedBrain = brain;
      await releasePendingDryRun();
      brain = await askFreshBrain(reusedBrain);
      decisionSource = 'fresh-analysis';
      reusedDryRunId = null;
      await saveProposal(db, runId, brain);
      if (!brain.ok) {
        await audit(db, runId, 'error', 'brain', 'Nuova analisi AI fallita dopo il tentativo di riuso', brain.attempts);
        await finishRun(db, runId, 'error', equityUsd, brain.error);
        await notify(credentials, 'warn', 'Autopilot: nessuna proposta', [brain.error ?? '']);
        return {
          runId,
          status: 'error',
          mode: persistentMode,
          error: brain.error,
          attempts: brain.attempts,
          decisionSource,
          reusedDryRunId,
          reuseFallbackReason,
        };
      }
      await audit(db, runId, 'info', 'brain', `Nuova proposta da ${brain.model} (confidence ${brain.parsed.confidence})`, { targets: brain.parsed.targetWeights });
      validation = validateBrain(brain.parsed);
      await saveValidation(db, runId, validation);
    }

    await audit(db, runId, validation.ok ? 'info' : 'warn', 'validator',
      validation.ok ? `Piano valido: ${validation.plan.orders.length} ordini, turnover ${(validation.plan.turnoverPct * 100).toFixed(1)}%` : 'Piano bloccato dai guardrail',
      validation.violations);

    if (!validation.ok) {
      await releasePendingDryRun();
      await finishRun(db, runId, 'blocked', equityUsd, validation.violations.filter((item) => item.severity === 'blocking').map((item) => item.message).join(' · '));
      return {
        runId,
        status: 'blocked',
        mode: persistentMode,
        violations: validation.violations,
        plan: validation.plan,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }

    // La risposta AI appartiene alla dry-run appena supera proposta e
    // guardrail. L'eligibility eToro è volutamente separata e verrà sempre
    // rifatta in Live: un mercato temporaneamente chiuso non deve buttare via
    // due ore di decisione valida.
    if (mode === 'dry-run') {
      const createdAt = Date.now();
      await saveDecisionArtifact(db, {
        sourceRunId: runId,
        createdAt,
        expiresAt: createdAt + LIVE_DRY_RUN_TTL_MS,
        ...decisionContext,
        proposalHash: await proposalHash(brain.parsed),
      });
      await audit(db, runId, 'info', 'decision-artifact', `Decisione AI disponibile per il Live fino a ${new Date(createdAt + LIVE_DRY_RUN_TTL_MS).toISOString()}`, {
        expiresAt: createdAt + LIVE_DRY_RUN_TTL_MS,
      });
    }

    let precheckedLiveEligibility = null;
    if (delayedLiveArm) {
      await renewLease('attivazione Live');
      const latestConfig = await loadConfig(db);
      const latestContext = await buildDecisionContext(latestConfig);
      const latestResolved = await resolveCredentials(db, env);
      let armBlockReason = '';
      if (recoveryMode && (
        latestConfig.executionMode !== 'shadow'
        || !latestConfig.frozen
        || !latestConfig.recoveryRequired
      )) {
        armBlockReason = 'lo stato non è più Shadow + Frozen con recovery richiesta';
      } else if (
        recoveryMode
        && Number(latestConfig.safetyRevision) !== Number(recoveryExpectedSafetyRevision)
      ) {
        armBlockReason = 'lo stato di sicurezza è cambiato dopo l’anteprima';
      } else if (!recoveryMode && latestConfig.frozen) {
        armBlockReason = `Autopilot congelato: ${latestConfig.frozenReason || 'freeze attivo'}`;
      } else if (!recoveryMode && latestConfig.recoveryRequired) {
        armBlockReason = `Recovery Live richiesta: ${latestConfig.recoveryReason || 'verifica eToro necessaria'}`;
      } else if (!recoveryMode && latestConfig.executionMode !== persistentMode) {
        armBlockReason = `modalità modificata durante l’analisi (${persistentMode} → ${latestConfig.executionMode})`;
      } else if (!recoveryMode && Number(latestConfig.safetyRevision) !== Number(config.safetyRevision)) {
        armBlockReason = 'stato di sicurezza modificato durante l’analisi';
      } else if (
        latestContext.decisionRevision !== decisionContext.decisionRevision
        || latestContext.decisionHash !== decisionContext.decisionHash
      ) {
        armBlockReason = 'strategia o limiti modificati durante l’analisi';
      } else if (
        latestContext.bindingHash !== decisionContext.bindingHash
        || !hasVerifiedAgentBinding(latestResolved, latestConfig)
      ) {
        armBlockReason = 'binding del portfolio Agent modificato o non più verificato';
      }

      if (armBlockReason) {
        await releasePendingDryRun();
        await audit(db, runId, 'warn', 'live-activation', `Live non attivato: ${armBlockReason}`);
        await finishRun(db, runId, 'blocked', equityUsd, armBlockReason);
        return {
          runId,
          status: 'blocked',
          mode: persistentMode,
          reason: armBlockReason,
          plan: validation.plan,
          decisionSource,
          reusedDryRunId,
          reuseFallbackReason,
        };
      }

      // Il click Live non deve lasciare la modalità persistente attiva quando
      // eToro sa già che il piano non è eseguibile (mercato chiuso, strumento
      // non negoziabile o taglio minimo). Questo pre-check è una sola lettura:
      // la CAS di sicurezza avviene soltanto dopo il suo esito positivo.
      if (validation.plan.orders.length) {
        await renewLease('pre-check eToro prima del Live');
        const executionScale = Number(validation.plan.executionScale) > 0
          ? Number(validation.plan.executionScale)
          : 1;
        precheckedLiveEligibility = await checkPlanEligibility(
          client,
          validation.plan.orders,
          executionScale,
        ).catch((error) => ({
          ok: false,
          issues: [`pre-check ammissibilità fallito: ${error instanceof Error ? error.message : String(error)}`],
          checks: [],
        }));
        if (!precheckedLiveEligibility.ok) {
          const reason = precheckedLiveEligibility.issues.join(' · ') || 'piano non ammesso da eToro';
          await releasePendingDryRun();
          await audit(db, runId, 'warn', 'live-activation', `Live non attivato dal pre-check eToro: ${reason}`, precheckedLiveEligibility.checks);
          await finishRun(db, runId, 'blocked', equityUsd, reason);
          return {
            runId,
            status: 'blocked',
            mode: persistentMode,
            reason,
            plan: validation.plan,
            execution: {
              mode: 'live',
              executed: false,
              results: [],
              eligibility: precheckedLiveEligibility,
              blocked: true,
            },
            decisionSource,
            reusedDryRunId,
            reuseFallbackReason,
          };
        }
        await renewLease('armamento Live');
      }

      // Lo stato della richiesta viene scritto prima della mutazione: se D1
      // non è disponibile, il Live non viene armato.
      if (liveActivationId && pendingDryRunClaim) {
        await setLiveActivationSource(db, liveActivationId, pendingDryRunClaim.sourceRunId);
      }
      if (liveActivationId) await updateLiveActivationStatus(db, liveActivationId, 'arming-live');
      // Un'eccezione durante la CAS può arrivare anche dopo che D1 ha applicato
      // l'UPDATE ma prima che il Worker ne legga la risposta: da questo punto
      // il catch deve quindi congelare in modo conservativo.
      livePhaseEntered = true;
      const armExpected = {
        executionMode: persistentMode,
        safetyRevision: recoveryMode ? recoveryExpectedSafetyRevision : config.safetyRevision,
        decisionRevision: decisionContext.decisionRevision,
        activeAgentPortfolioId: config.activeAgentPortfolioId,
        agentTokenFingerprint: config.agentTokenFingerprint,
        agentTokenVerifiedAt: config.agentTokenVerifiedAt,
      };
      const armed = recoveryMode
        ? await armRecoveryLiveIfUnchanged(db, armExpected)
        : await armLiveIfUnchanged(db, armExpected);
      if (!armed) {
        livePhaseEntered = false;
        await releasePendingDryRun();
        const reason = recoveryMode
          ? 'stato cambiato mentre la recovery veniva armata; nessun nuovo ordine inviato'
          : 'stato cambiato mentre il Live veniva attivato; nessun ordine inviato';
        await audit(db, runId, 'warn', 'live-activation', reason);
        await finishRun(db, runId, 'blocked', equityUsd, reason);
        return {
          runId,
          status: 'blocked',
          mode: persistentMode,
          reason,
          plan: validation.plan,
          decisionSource,
          reusedDryRunId,
          reuseFallbackReason,
        };
      }
      persistentMode = 'live';
      Object.assign(config, armed);
      // Da qui ogni eccezione non classificata deve riportare l'agente in
      // Shadow + Frozen, anche se nessuna POST eToro è ancora partita.
      if (liveActivationId) await updateLiveActivationStatus(db, liveActivationId, 'executing-live');
      try {
        await audit(db, runId, 'warn', 'live-activation', recoveryMode
          ? 'Recovery armata in Live esclusivamente per completare il residuo del piano selezionato'
          : 'Modalità Live attivata; il piano appena rivalidato passa all’esecutore');
      } catch (error) {
        console.error(JSON.stringify({
          message: 'audit attivazione Live fallito',
          runId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    if (!validation.plan.orders.length) {
      if (mode === 'live') {
        const finalFence = await enforceFinalLiveFence({
          db,
          runId,
          config,
          credentials,
          equityUsd,
          stage: 'live-final-no-orders',
          data: { action: 'none' },
        });
        if (finalFence) {
          return {
            runId,
            ...finalFence,
            action: 'none',
            plan: validation.plan,
            decisionSource,
            reusedDryRunId,
            reuseFallbackReason,
          };
        }
      }
      await audit(db, runId, 'info', 'executor', 'Nessuna azione: allocazione già entro le bande e la disciplina di rotazione');
      if (mode === 'live') {
        const completion = recoveryMode && recoveryOneShot
          ? await completeRecoveryOneShot({
            db, runId, config, credentials, equityUsd,
            data: { action: 'none', sourceRunId: recoverySourceRunId },
          })
          : await commitLiveRunSuccess({
            db,
            runId,
            config,
            credentials,
            equityUsd,
            stage: 'live-final-no-orders',
            data: { action: 'none' },
          });
        if (completion && (recoveryMode || completion.status !== 'ok')) {
          return {
            runId,
            ...completion,
            action: 'none',
            plan: validation.plan,
            decisionSource,
            reusedDryRunId,
            reuseFallbackReason,
            ...(recoveryMode ? { recoveryCompleted: completion.status === 'ok', recoverySourceRunId } : {}),
          };
        }
      } else {
        await finishRun(db, runId, 'ok', equityUsd);
      }
      return {
        runId,
        status: 'ok',
        mode: persistentMode,
        action: 'none',
        plan: validation.plan,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }

    // --- 8. Esecuzione -----------------------------------------------------
    await renewLease('esecuzione');
    if (mode === 'live') livePhaseEntered = true;
    const execution = await executePlan({
      db,
      client,
      runId,
      plan: validation.plan,
      mode,
      config,
      eligibilityOverride: precheckedLiveEligibility,
    });
    if (mode === 'live') {
      for (const record of execution.results) {
        if (record.state === 'filled' || record.state === 'partial') {
          await recordLedgerTrade(db, record.symbol, record.side);
        }
      }
    }
    await audit(db, runId, execution.blocked ? 'warn' : 'info', 'executor', `Esecuzione in modalità ${mode}: ${execution.results.length} ordini`,
      execution.results.map((item) => ({ symbol: item.symbol, side: item.side, amount: item.amountUsd, state: item.state })));

    if (mode === 'dry-run' && execution.blocked) {
      const reason = execution.error
        || execution.eligibility?.issues?.join(' · ')
        || 'dry-run bloccata dal pre-check di ammissibilità';
      await finishRun(db, runId, 'blocked', equityUsd, reason);
      return {
        runId,
        status: 'blocked',
        mode,
        reason,
        plan: validation.plan,
        execution,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }

    let liveFailSafeReason = null;
    if (mode === 'live') {
      const incompleteOrders = execution.results.filter((item) => (
        ['intent', 'sent', 'partial', 'rejected', 'failed'].includes(item.state)
      ));
      if (incompleteOrders.length) {
        liveFailSafeReason = `esito live non terminale o non completato (${incompleteOrders.map((item) => `${item.symbol}:${item.state}`).join(', ')})`;
      } else if (/stato di sicurezza non leggibile|agente congelato/i.test(String(execution.error ?? ''))) {
        liveFailSafeReason = String(execution.error);
      }

      // Eligibility negata o cambio esplicito a shadow prima di qualunque POST
      // sono esiti noti e possono chiudere blocked. Un errore safety/read resta
      // invece ambiguo e congela anche se nessuna richiesta è stata tentata.
      if (execution.blocked && !execution.executed) {
        const reason = execution.error
          || execution.eligibility?.issues?.join(' · ')
          || 'esecuzione live bloccata prima dell’invio';
        if (liveFailSafeReason) {
          const safety = await freezeLiveRun({
            db, runId, credentials, equityUsd, reason: liveFailSafeReason,
            stage: 'executor-fail-safe', data: { execution },
          });
          return {
            runId, status: safety.status, reason: safety.reason, safety,
            mode: safety.config?.executionMode ?? null,
            safetyPersisted: safety.safetyPersisted,
            error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
            plan: validation.plan, execution,
            decisionSource, reusedDryRunId, reuseFallbackReason,
          };
        }
        await audit(db, runId, 'warn', 'executor', `Run live bloccata senza invii: ${reason}`);
        await finishRun(db, runId, 'blocked', equityUsd, reason);
        const authoritativeMode = await loadConfig(db)
          .then((current) => current.executionMode)
          .catch(() => null);
        return {
          runId, status: 'blocked', reason, mode: authoritativeMode,
          plan: validation.plan, execution,
          decisionSource, reusedDryRunId, reuseFallbackReason,
        };
      }
    }

    // --- 9. Riconciliazione ------------------------------------------------
    let reconciliation = null;
    if (mode === 'live' && execution.executed) {
      await renewLease('riconciliazione');
      reconciliation = await reconcile({ client, plan: validation.plan, config, portfolioUserKey });
      await audit(
        db,
        runId,
        reconciliation.ok ? 'info' : 'error',
        'reconcile',
        `Divergenza massima ${(reconciliation.worstDivergence * 100).toFixed(2)}% dopo ${reconciliation.attempts ?? 1} letture`,
        reconciliation.rows,
      );
      if (!reconciliation.ok) {
        liveFailSafeReason = `riconciliazione fuori tolleranza (${(reconciliation.worstDivergence * 100).toFixed(2)}%)`;
      }
    }

    if (mode === 'live' && liveFailSafeReason) {
      const safety = await freezeLiveRun({
        db, runId, credentials, equityUsd, reason: liveFailSafeReason,
        stage: 'reconcile-fail-safe', data: { execution, reconciliation },
      });
      return {
        runId,
        status: safety.status,
        reason: safety.reason,
        safety,
        mode: safety.config?.executionMode ?? null,
        safetyPersisted: safety.safetyPersisted,
        error: safety.safetyPersisted ? null : 'Impossibile confermare il blocco in D1: intervieni direttamente su eToro.',
        plan: validation.plan,
        execution,
        reconciliation,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }

    // Un safe-stop può arrivare dopo uno o più invii. In quel caso si tenta la
    // riconciliazione, ma la run non deve mai risultare ok.
    if (mode === 'live' && execution.blocked) {
      const reason = execution.error || 'esecuzione live interrotta da un controllo di sicurezza';
      await audit(db, runId, 'warn', 'executor', `Run live interrotta: ${reason}`);
      await finishRun(db, runId, 'blocked', equityUsd, reason);
      const authoritativeMode = await loadConfig(db)
        .then((current) => current.executionMode)
        .catch(() => null);
      return {
        runId, status: 'blocked', reason, mode: authoritativeMode,
        plan: validation.plan, execution, reconciliation,
        decisionSource, reusedDryRunId, reuseFallbackReason,
      };
    }

    await notify(credentials, 'info', `Autopilot ${mode} · ${validation.plan.orders.length} ordini`, [
      brain.parsed.rationale.slice(0, 400),
      ...execution.results.map((item) => `${item.side === 'buy' ? '+' : '−'}${item.amountUsd} USD ${item.symbol} [${item.state}]`),
    ]);

    if (mode === 'live') {
      const finalFence = await enforceFinalLiveFence({
        db,
        runId,
        config,
        credentials,
        equityUsd,
        stage: 'live-final-fence',
        data: { execution, reconciliation },
      });
      if (finalFence) {
        return {
          runId,
          ...finalFence,
          plan: validation.plan,
          execution,
          reconciliation,
          decisionSource,
          reusedDryRunId,
          reuseFallbackReason,
        };
      }
    }

    if (mode === 'live') {
      const completion = recoveryMode && recoveryOneShot
        ? await completeRecoveryOneShot({
          db, runId, config, credentials, equityUsd,
          data: { execution, reconciliation, sourceRunId: recoverySourceRunId },
        })
        : await commitLiveRunSuccess({
          db,
          runId,
          config,
          credentials,
          equityUsd,
          stage: 'live-final-fence',
          data: { execution, reconciliation },
        });
      if (completion && (recoveryMode || completion.status !== 'ok')) {
        return {
          runId,
          ...completion,
          plan: validation.plan,
          execution,
          reconciliation,
          decisionSource,
          reusedDryRunId,
          reuseFallbackReason,
          ...(recoveryMode ? { recoveryCompleted: completion.status === 'ok', recoverySourceRunId } : {}),
        };
      }
    } else {
      await finishRun(db, runId, 'ok', equityUsd);
    }
    return {
      runId,
      status: 'ok',
      mode: persistentMode,
      plan: validation.plan,
      execution,
      reconciliation,
      screening: dynamic ? screening.shortlist.length : null,
      decisionSource,
      reusedDryRunId,
      reuseFallbackReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!livePhaseEntered) {
      try { await releasePendingDryRun(); } catch { /* nessun effetto Live da compensare */ }
    }
    if (persistentMode === 'live' && error?.code === 'agent_mirror_binding' && !livePhaseEntered) {
      const safety = await freezeLiveRun({
        db,
        runId,
        credentials,
        equityUsd,
        reason: `binding del capitale reale non verificabile: ${message}`,
        stage: 'capital-binding',
        data: { error: message },
      });
      return {
        runId,
        status: safety.status,
        mode: safety.config?.executionMode ?? null,
        safetyPersisted: safety.safetyPersisted,
        reason: safety.reason,
        safety,
        error: message,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }
    if (mode === 'live' && livePhaseEntered) {
      const safety = await freezeLiveRun({
        db,
        runId,
        credentials,
        equityUsd,
        reason: `errore ambiguo dopo ingresso nella fase live: ${message}`,
        stage: 'pipeline-live-fail-safe',
        data: { error: message },
      });
      return {
        runId,
        status: safety.status,
        mode: safety.config?.executionMode ?? null,
        safetyPersisted: safety.safetyPersisted,
        reason: safety.reason,
        safety,
        error: message,
        decisionSource,
        reusedDryRunId,
        reuseFallbackReason,
      };
    }
    await audit(db, runId, 'error', 'pipeline', message);
    await finishRun(db, runId, 'error', equityUsd, message);
    await notify(credentials, 'warn', 'Autopilot: run fallita', [message]);
    return {
      runId,
      status: 'error',
      mode: persistentMode,
      error: message,
      decisionSource,
      reusedDryRunId,
      reuseFallbackReason,
    };
  }
}

export { listWatcherEvents };
