/**
 * API di controllo dell'Autopilot. Tutte le rotte richiedono il bearer token
 * `CONTROL_TOKEN`; il passaggio a modalità `live` richiede una conferma
 * esplicita aggiuntiva.
 */
import { runPipeline } from './pipeline.js';
import { extractJson, listFreeModels } from './brain.js';
import { buildStrategyActivationNotification, notify, notifyTest } from './notify.js';
import {
  clearCredentials, describeCredentials, hasVerifiedAgentBinding, resolveCredentials,
  saveCredentials, saveVerifiedAgentToken,
} from './vault.js';
import { runDiagnostics } from './diagnose.js';
import { EtoroClient } from './etoro.js';
import { applyProfile, listProfiles } from './profiles.js';
import { PROVIDERS, buildAttemptPlan, callModel } from './llm.js';
import {
  buildDeterministicScenarioSummary, buildSafeStrategySpec, buildStrategyPrompt, checkStrategyFeasibility,
  createDefaultOnboardingAnswers, normalizeAiStrategySpec, normalizeOnboardingAnswers,
} from './strategy.js';
import { buildPolicyUniverse } from './universe-policy.js';
import {
  audit, equityHistory, getRunBundle, listRuns, listWatcherEvents, loadConfig,
  loadLedger, saveConfig, DEFAULT_CONFIG,
} from './db.js';

/** Confronto a tempo costante: evita di rivelare il token per timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

export function isAuthorized(request, env) {
  const token = env.CONTROL_TOKEN;
  if (!token) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match) && safeEqual(match[1].trim(), token);
}

const NUMERIC_BOUNDS = {
  budgetEur: [10, 100000],
  maxOrdersPerRun: [1, 20],
  maxOrdersPerDay: [1, 40],
  minOrderUsd: [1, 10000],
  maxOrderUsd: [5, 100000],
  maxOrderPctOfCapital: [0.01, 1],
  maxTurnoverPct: [0.01, 1],
  minRebalanceBandAbs: [0.001, 0.5],
  minRebalanceBandRel: [0.01, 2],
  minCashPct: [0, 0.9],
  maxCashPct: [0.05, 1],
  drawdownStopPct: [0.02, 0.6],
  reconcileTolerancePct: [0.005, 0.3],
  minConfidence: [0, 1],
  rebalanceWeekday: [1, 7],
  rebalanceDayOfMonth: [1, 28],
  rebalanceHour: [0, 23],
  rebalanceMinute: [0, 59],
  llmTemperature: [0, 1.5],
  llmMaxTokens: [256, 8000],
  fallbackEurUsd: [0.5, 2],
  shortlistSize: [5, 40],
  maxHoldings: [1, 30],
  minHoldings: [1, 20],
  preferredHoldings: [1, 30],
  minHoldingDays: [0, 365],
  reentryCooldownDays: [0, 365],
  substitutionEdge: [0, 100],
  transactionCostBps: [0, 500],
  watcherDropPct: [0.01, 0.5],
  watcherSpikePct: [0.01, 0.8],
  watcherVolSpike: [1, 10],
  opportunisticBudgetPct: [0, 0.5],
  maxOpportunisticPerWeek: [0, 10],
  maxAverageDown: [0, 5],
  stabilizationBars: [0, 10],
  watcherMinConfidence: [0, 1],
  targetDeploymentPct: [0.5, 1],
};

/** Ripulisce la patch di configurazione: chiavi ignote e valori fuori range vengono scartati. */
export function sanitizeConfigPatch(patch) {
  const out = {};
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_CONFIG)) { rejected.push(`${key}: chiave sconosciuta`); continue; }
    if (key === 'executionMode') { rejected.push('executionMode: usa POST /agent/mode'); continue; }
    if (key === 'frozen' || key === 'frozenReason') { rejected.push(`${key}: usa /agent/freeze o /agent/unfreeze`); continue; }
    if ([
      'activeAgentPortfolioId', 'activeAgentPortfolioName', 'activeAgentPortfolioMirrorId',
      'activeAgentPortfolioVirtualBalanceUsd', 'agentTokenVerifiedAt', 'agentTokenHint',
      'agentTokenFingerprint', 'agentTokenOrigin', 'lastManagedCapitalUsd', 'lastManagedCapitalEur',
      'lastManagedCapitalAt', 'lastManagedEurUsd', 'realCapitalTrackingStartedAt',
    ].includes(key)) {
      rejected.push(`${key}: gestito esclusivamente dal flusso token Agent`);
      continue;
    }

    if (key in NUMERIC_BOUNDS) {
      const numeric = Number(value);
      const [min, max] = NUMERIC_BOUNDS[key];
      if (!Number.isFinite(numeric) || numeric < min || numeric > max) { rejected.push(`${key}: fuori intervallo [${min}, ${max}]`); continue; }
      out[key] = numeric;
      continue;
    }
    if (key === 'universeMode') {
      if (!['fixed', 'dynamic'].includes(value)) { rejected.push('universeMode: valore non ammesso'); continue; }
      out[key] = value;
      continue;
    }
    if (key === 'strategyProfile') {
      rejected.push('strategyProfile: usa POST /agent/profile');
      continue;
    }
    if (key === 'watcherEnabled' || key === 'llmFallbackAcrossProviders') {
      out[key] = Boolean(value);
      continue;
    }
    if (key === 'pool') {
      if (!Array.isArray(value)) { rejected.push('pool: array richiesto'); continue; }
      out[key] = value
        .filter((item) => item && typeof item.symbol === 'string' && item.symbol.trim())
        .map((item) => ({
          symbol: String(item.symbol).trim().toUpperCase().slice(0, 16),
          name: String(item.name ?? item.symbol).slice(0, 80),
          class: ['etf', 'stock', 'bond', 'commodity', 'crypto'].includes(item.class) ? item.class : 'etf',
          maxWeight: Math.max(0.01, Math.min(1, Number(item.maxWeight) || 0.2)),
        }))
        .slice(0, 200);
      continue;
    }
    if (key === 'cadence') {
      if (!['daily', 'weekly', 'monthly'].includes(value)) { rejected.push('cadence: valore non ammesso'); continue; }
      out[key] = value;
      continue;
    }
    if (key === 'whitelist') {
      if (!Array.isArray(value) || !value.length) { rejected.push('whitelist: deve essere un array non vuoto'); continue; }
      const cleaned = value
        .filter((item) => item && typeof item.symbol === 'string')
        .map((item) => ({
          symbol: String(item.symbol).trim().toUpperCase().slice(0, 16),
          name: String(item.name ?? item.symbol).slice(0, 80),
          class: ['etf', 'stock', 'bond', 'commodity', 'crypto'].includes(item.class) ? item.class : 'etf',
          maxWeight: Math.max(0.01, Math.min(1, Number(item.maxWeight) || 0.2)),
        }));
      if (!cleaned.length) { rejected.push('whitelist: nessuna voce valida'); continue; }
      out[key] = cleaned;
      continue;
    }
    if (key === 'llmProviders') {
      if (!Array.isArray(value) || !value.length) { rejected.push('llmProviders: array non vuoto richiesto'); continue; }
      const allowed = Object.keys(PROVIDERS);
      const cleaned = value.map(String).filter((item) => allowed.includes(item));
      if (!cleaned.length) { rejected.push('llmProviders: nessun provider valido'); continue; }
      out[key] = [...new Set(cleaned)];
      continue;
    }
    if (key === 'llmModels') {
      if (!value || typeof value !== 'object') { rejected.push('llmModels: oggetto richiesto'); continue; }
      out[key] = Object.fromEntries(Object.entries(value)
        .filter(([provider]) => provider in PROVIDERS)
        .map(([provider, list]) => [provider, (Array.isArray(list) ? list : []).map(String).slice(0, 6)]));
      continue;
    }
    if (key === 'models') {
      if (!Array.isArray(value) || !value.length) { rejected.push('models: array non vuoto richiesto'); continue; }
      out[key] = value.map(String).slice(0, 8);
      continue;
    }
    if (key === 'snapshotHours') {
      if (!Array.isArray(value)) { rejected.push('snapshotHours: array richiesto'); continue; }
      out[key] = [...new Set(value.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))];
      continue;
    }
    if (key === 'maxWeightPerClass') {
      if (!value || typeof value !== 'object') { rejected.push('maxWeightPerClass: oggetto richiesto'); continue; }
      out[key] = Object.fromEntries(Object.entries(value)
        .map(([klass, weight]) => [klass, Math.max(0, Math.min(1, Number(weight) || 0))]));
      continue;
    }
    if (key === 'riskProfile') { out[key] = String(value).slice(0, 800); continue; }
    rejected.push(`${key}: tipo non gestito`);
  }
  return { patch: out, rejected };
}

const GUIDED_OBJECTIVE = {
  'balanced-growth': 'balanced-growth',
  dividends: 'income',
  'capital-preservation': 'capital-preservation',
  tactical: 'tactical',
};

/** Traduce il form umano nel contratto versionato e fail-closed del motore. */
function guidedAnswersToContract(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const macros = Array.isArray(source.macroPreferences) ? source.macroPreferences.map(String) : [];
  const objective = GUIDED_OBJECTIVE[source.objective] ?? 'balanced-growth';
  const drawdown = Math.max(2, Math.min(60, Number(source.maxDrawdownPct) || 20));
  const maxHoldings = Math.max(1, Math.min(20, Math.round(Number(source.maxHoldings) || 12)));
  const cashTarget = Math.max(0, Math.min(50, Number(source.cashTargetPct) || 0));
  const turnover = Math.max(1, Math.min(100, Number(source.maxTurnoverPct) || 25));
  const cryptoChoice = String(source.cryptoPreference ?? 'none');
  const cryptoEnabled = cryptoChoice !== 'none' && macros.includes('crypto-large-cap');

  const styles = objective === 'income'
    ? ['dividend', 'quality']
    : objective === 'capital-preservation'
      ? ['quality', 'value']
      : objective === 'tactical'
        ? ['momentum', 'thematic']
        : ['broad-market', 'quality'];
  if ((macros.includes('technology') || macros.includes('healthcare')) && !styles.includes('thematic')) styles.push('thematic');

  const assetClasses = [];
  if (macros.some((item) => ['global-equities', 'technology', 'healthcare'].includes(item))) assetClasses.push('etf', 'stock');
  if (macros.includes('bonds')) assetClasses.push('bond');
  if (macros.includes('commodities')) assetClasses.push('commodity');
  if (cryptoEnabled) assetClasses.push('crypto');
  if (!assetClasses.length) assetClasses.push('etf', 'stock');

  const preferredSectors = [];
  if (macros.includes('technology')) preferredSectors.push('technology');
  if (macros.includes('healthcare')) preferredSectors.push('healthcare');
  const preferredThemes = [];
  if (macros.includes('global-equities')) preferredThemes.push('broad-market');
  if (macros.includes('technology')) preferredThemes.push('artificial-intelligence', 'semiconductors');
  if (macros.includes('healthcare')) preferredThemes.push('healthcare-innovation');
  if (objective === 'income') preferredThemes.push('dividend-quality');

  const riskLevel = drawdown <= 12 ? 'low' : drawdown <= 24 ? 'moderate' : drawdown <= 36 ? 'high' : 'very-high';
  const contract = createDefaultOnboardingAnswers({
    objective,
    styles: [...new Set(styles)],
    horizonMonths: Math.max(3, Math.min(240, Math.round(Number(source.horizonMonths) || 12))),
    risk: { level: riskLevel, maxAcceptableDrawdownPct: drawdown },
    capital: {
      budgetMode: 'budget-envelope',
      budgetEur: Math.max(10, Math.min(100000, Number(source.budgetEur) || 1000)),
      targetDeploymentPct: 100 - cashTarget,
    },
    diversification: {
      preferredPositions: Math.min(maxHoldings, Math.max(3, Math.round(maxHoldings * 0.75))),
      maxPositions: maxHoldings,
    },
    sectors: { include: [], prefer: preferredSectors, exclude: [] },
    themes: { include: [], prefer: [...new Set(preferredThemes)], exclude: [] },
    assetClasses: [...new Set(assetClasses)],
    crypto: {
      enabled: cryptoEnabled,
      tiers: !cryptoEnabled ? [] : cryptoChoice === 'majors' ? ['large-cap'] : cryptoChoice === 'broad' ? ['large-cap', 'mid-cap', 'small-cap'] : ['large-cap', 'mid-cap', 'small-cap'],
      allowMeme: cryptoEnabled && cryptoChoice === 'meme-opt-in' && source.excludeMemeCoins !== true,
      maxWeightPct: cryptoEnabled ? Math.max(1, Math.min(50, Number(source.maxAssetPct) * 2 || 20)) : 0,
    },
    cash: {
      reserveFloorPct: cashTarget,
      allowTemporaryIntent: true,
      temporaryMaxPct: Math.max(cashTarget, Math.min(40, cashTarget + 15)),
      temporaryMaxDays: 30,
    },
    execution: {
      cadence: 'weekly',
      turnoverTolerance: turnover <= 12 ? 'low' : turnover <= 25 ? 'moderate' : 'high',
      minOrderEur: Math.max(1, Math.min(10000, Number(source.minOrderEur) || 10)),
      maxOrderPctOfCapital: Math.max(1, Math.min(100, Number(source.maxAssetPct) || 12)),
    },
  });
  const normalized = normalizeOnboardingAnswers(contract);
  if (!normalized.ok) throw new TypeError(`onboarding non valido: ${normalized.errors.join(' · ')}`);
  return { answers: normalized.value, guided: source };
}

function applyGuidedGuardrails(spec, guided) {
  const next = structuredClone(spec);
  if (guided.strategyName) next.name = String(guided.strategyName).trim().slice(0, 80) || next.name;
  const maxAssetPct = Number(guided.maxAssetPct);
  const maxSectorPct = Number(guided.maxSectorPct);
  const maxTurnoverPct = Number(guided.maxTurnoverPct);
  const maxDrawdownPct = Number(guided.maxDrawdownPct);
  if (Number.isFinite(maxAssetPct)) next.diversification.maxInstrumentWeightPct = Math.min(next.diversification.maxInstrumentWeightPct, maxAssetPct);
  if (Number.isFinite(maxSectorPct)) next.diversification.maxSectorWeightPct = Math.min(next.diversification.maxSectorWeightPct, maxSectorPct);
  if (Number.isFinite(maxTurnoverPct)) next.execution.maxTurnoverPct = Math.min(next.execution.maxTurnoverPct, maxTurnoverPct);
  if (Number.isFinite(maxDrawdownPct)) next.risk.maxDrawdownPct = Math.min(next.risk.maxDrawdownPct, maxDrawdownPct);
  const feasibility = checkStrategyFeasibility(next);
  if (!feasibility.ok) throw new TypeError(`strategia non fattibile: ${feasibility.errors.join(' · ')}`);
  return next;
}

function scenarioAssumptions(spec) {
  const annualReturnPct = {
    'capital-preservation': 4.5,
    'balanced-growth': 7,
    'capital-growth': 9,
    income: 5.5,
    tactical: 8,
  }[spec.objective.primary] ?? 6;
  return {
    annualReturnPct,
    annualVolatilityPct: (spec.risk.targetVolatilityPct.min + spec.risk.targetVolatilityPct.max) / 2,
  };
}

const ALLOCATION_META = {
  'global-equities': { label: 'Azioni globali', weight: 45, color: '#075d3b' },
  technology: { label: 'Tecnologia', weight: 25, color: '#75a58a' },
  healthcare: { label: 'Salute', weight: 15, color: '#6d9dd8' },
  'crypto-large-cap': { label: 'Crypto large cap', weight: 10, color: '#e8c36f' },
  bonds: { label: 'Obbligazionario', weight: 8, color: '#aa98ca' },
  commodities: { label: 'Materie prime', weight: 8, color: '#c47f61' },
};

function strategyPreview(spec, guided, scenario) {
  const selected = (Array.isArray(guided.macroPreferences) ? guided.macroPreferences : [])
    .map((key) => ({ key, ...ALLOCATION_META[key] }))
    .filter((item) => item.label);
  const cashPct = 100 - spec.capital.targetDeploymentPct;
  const rawTotal = selected.reduce((sum, item) => sum + item.weight, 0) || 1;
  const allocations = selected.map((item) => ({
    key: item.key,
    label: item.label,
    weightPct: Math.round(item.weight / rawTotal * spec.capital.targetDeploymentPct),
    color: item.color,
  }));
  if (allocations.length) {
    const invested = allocations.reduce((sum, item) => sum + item.weightPct, 0);
    allocations[0].weightPct += spec.capital.targetDeploymentPct - invested;
  }
  if (cashPct > 0) allocations.push({ key: 'cash', label: 'Liquidità', weightPct: cashPct, color: '#c8c9c7' });
  return {
    strategyName: spec.name,
    summary: spec.objective.description,
    allocations,
    scenario: {
      horizonMonths: scenario.horizonMonths,
      favorablePct: scenario.percentiles.p90ChangePct,
      medianPct: scenario.percentiles.p50ChangePct,
      adversePct: Math.min(scenario.percentiles.p10ChangePct, scenario.stress.changePct),
    },
    riskRangePct: spec.risk.maxDrawdownPct,
    guardrails: {
      maxDrawdownPct: spec.risk.maxDrawdownPct,
      maxAssetPct: spec.diversification.maxInstrumentWeightPct,
      maxSectorPct: spec.diversification.maxSectorWeightPct,
      minCashPct: spec.capital.cashFloorPct,
      maxTurnoverPct: spec.execution.maxTurnoverPct,
      minHoldingDays: Math.max(0, Math.round(Number(guided.minHoldingDays) || 0)),
      maxHoldings: spec.diversification.maxPositions,
    },
    reasons: [
      { title: 'Crescita con controllo del rischio', detail: spec.objective.description, kind: 'growth' },
      { title: 'Diversificazione intelligente', detail: `Fino a ${spec.diversification.maxPositions} posizioni, con tetto ${spec.diversification.maxInstrumentWeightPct}% per asset e ${spec.diversification.maxSectorWeightPct}% per settore.`, kind: 'diversification' },
      { title: 'Adattiva al mercato', detail: 'L’universo resta dinamico: segnali quantitativi, qualità e notizie ordinano i candidati entro le preferenze scelte.', kind: 'adaptive' },
    ],
    shadowDays: Math.max(1, Math.min(90, Math.round(Number(guided.shadowDays) || 14))),
  };
}

/** Ricostruisce la scheda leggibile per strategie create prima del salvataggio della review. */
function hydrateGuidedReview(config) {
  if (!config?.onboardingComplete || config.strategyDraft || !config.strategySpec || !config.strategyScenario) return config;
  const spec = config.strategySpec;
  const assetClasses = Array.isArray(spec.universePolicy?.assetClasses) ? spec.universePolicy.assetClasses : [];
  const sectors = [
    ...(Array.isArray(spec.universePolicy?.sectors?.include) ? spec.universePolicy.sectors.include : []),
    ...(Array.isArray(spec.universePolicy?.sectors?.prefer) ? spec.universePolicy.sectors.prefer : []),
  ];
  const themes = [
    ...(Array.isArray(spec.universePolicy?.themes?.include) ? spec.universePolicy.themes.include : []),
    ...(Array.isArray(spec.universePolicy?.themes?.prefer) ? spec.universePolicy.themes.prefer : []),
  ];
  const macroPreferences = [];
  if (assetClasses.some((item) => ['stock', 'etf'].includes(item))) macroPreferences.push('global-equities');
  if (sectors.includes('technology') || themes.some((item) => ['artificial-intelligence', 'semiconductors'].includes(item))) macroPreferences.push('technology');
  if (sectors.includes('healthcare') || themes.includes('healthcare-innovation')) macroPreferences.push('healthcare');
  if (assetClasses.includes('crypto') && spec.universePolicy?.crypto?.enabled) macroPreferences.push('crypto-large-cap');
  if (assetClasses.includes('bond')) macroPreferences.push('bonds');
  if (assetClasses.includes('commodity')) macroPreferences.push('commodities');
  if (!macroPreferences.length) macroPreferences.push('global-equities');
  const objective = {
    income: 'dividends',
    'capital-preservation': 'capital-preservation',
    tactical: 'tactical',
  }[spec.objective?.primary] ?? 'balanced-growth';
  const cryptoTiers = spec.universePolicy?.crypto?.tiers ?? [];
  const guided = {
    portfolioId: config.activeAgentPortfolioId,
    strategyName: spec.name,
    objective,
    horizonMonths: spec.objective?.horizonMonths ?? config.strategyScenario.horizonMonths ?? 12,
    budgetEur: spec.capital?.budgetEur ?? config.budgetEur,
    macroPreferences,
    cryptoPreference: !spec.universePolicy?.crypto?.enabled
      ? 'none'
      : spec.universePolicy.crypto.allowMeme
        ? 'meme-opt-in'
        : cryptoTiers.some((item) => item !== 'large-cap') ? 'broad' : 'majors',
    excludeMemeCoins: !spec.universePolicy?.crypto?.allowMeme,
    maxHoldings: spec.diversification?.maxPositions ?? config.maxHoldings,
    cashTargetPct: Math.max(0, 100 - Number(spec.capital?.targetDeploymentPct ?? 97)),
    maxDrawdownPct: spec.risk?.maxDrawdownPct ?? config.drawdownStopPct * 100,
    maxAssetPct: spec.diversification?.maxInstrumentWeightPct ?? 20,
    maxSectorPct: spec.diversification?.maxSectorWeightPct ?? 35,
    maxTurnoverPct: spec.execution?.maxTurnoverPct ?? config.maxTurnoverPct * 100,
    minHoldingDays: config.minHoldingDays,
    shadowDays: config.shadowDays,
  };
  return {
    ...config,
    strategyDraft: strategyPreview(spec, guided, config.strategyScenario),
    guidedOnboardingAnswers: guided,
  };
}

function safeTraceText(value, fallback = '') {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return text.slice(0, 360);
}

function normalizeReview(raw, reviewer) {
  const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const verdict = parsed.verdict === 'revise' ? 'revise' : parsed.verdict === 'approve' ? 'approve' : null;
  if (!verdict) return null;
  const list = (value) => (Array.isArray(value) ? value : [])
    .map((item) => safeTraceText(item))
    .filter(Boolean)
    .slice(0, 3);
  return {
    reviewer,
    verdict,
    summary: safeTraceText(parsed.summary, verdict === 'approve' ? 'Policy coerente con i vincoli dichiarati.' : 'Sono richieste correzioni prima della validazione.'),
    strengths: list(parsed.strengths),
    concerns: list(parsed.concerns),
    requiredChanges: list(parsed.requiredChanges),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
  };
}

function buildReviewMessages(answers, spec) {
  return [
    {
      role: 'system',
      content: [
        'Sei un revisore indipendente di policy di portafoglio.',
        'Valuta la StrategySpec rispetto al consenso dell’onboarding, diversificazione, rischio, liquidità ed eseguibilità con il budget.',
        'Non mostrare ragionamenti interni o chain-of-thought: restituisci soltanto un verdetto sintetico e verificabile.',
        'Non proporre ticker, ordini, leva, short o promesse di rendimento.',
        'Rispondi con JSON puro: {"verdict":"approve|revise","summary":"...","strengths":["..."],"concerns":["..."],"requiredChanges":["..."],"confidence":0.0}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `ONBOARDING_JSON_BEGIN\n${JSON.stringify(answers)}\nONBOARDING_JSON_END\n\nSTRATEGY_SPEC_JSON_BEGIN\n${JSON.stringify(spec)}\nSTRATEGY_SPEC_JSON_END`,
    },
  ];
}

function buildSynthesisMessages(prompt, spec, reviews) {
  return [
    { role: 'system', content: prompt.system },
    {
      role: 'user',
      content: [
        prompt.user,
        '',
        'STRATEGY_SPEC_DA_REVISIONARE_BEGIN',
        JSON.stringify(spec),
        'STRATEGY_SPEC_DA_REVISIONARE_END',
        '',
        'REVISIONI_INDIPENDENTI_BEGIN',
        JSON.stringify(reviews.map(({ reviewer, verdict, summary, concerns, requiredChanges }) => ({ reviewer, verdict, summary, concerns, requiredChanges }))),
        'REVISIONI_INDIPENDENTI_END',
        '',
        'Integra solo le correzioni compatibili con onboarding e schema. Restituisci la StrategySpec completa in JSON puro.',
      ].join('\n'),
    },
  ];
}

function sanitizeStrategyCollaboration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const trace = (Array.isArray(raw.trace) ? raw.trace : []).slice(0, 30).map((event, index) => ({
    id: safeTraceText(event?.id, `trace-${index + 1}`).slice(0, 80),
    at: Number(event?.at) || Date.now(),
    stage: ['intake', 'lead', 'review', 'synthesis', 'deterministic', 'complete'].includes(event?.stage) ? event.stage : 'review',
    status: ['running', 'passed', 'warning', 'failed'].includes(event?.status) ? event.status : 'warning',
    title: safeTraceText(event?.title, 'Passaggio di revisione'),
    model: event?.model ? safeTraceText(event.model).slice(0, 160) : null,
    summary: safeTraceText(event?.summary),
    handoff: (Array.isArray(event?.handoff) ? event.handoff : []).map((item) => safeTraceText(item)).filter(Boolean).slice(0, 5),
    details: (Array.isArray(event?.details) ? event.details : []).map((item) => safeTraceText(item)).filter(Boolean).slice(0, 5),
  }));
  const reviews = (Array.isArray(raw.reviews) ? raw.reviews : []).slice(0, 3)
    .map((review) => normalizeReview(review, safeTraceText(review?.reviewer, 'Revisore AI')))
    .filter(Boolean);
  return {
    version: 1,
    mode: 'multi-model-review',
    status: ['validated', 'validated-with-warnings', 'deterministic-fallback'].includes(raw.status)
      ? raw.status
      : 'validated-with-warnings',
    leadModel: raw.leadModel ? safeTraceText(raw.leadModel).slice(0, 160) : null,
    reviewerModels: (Array.isArray(raw.reviewerModels) ? raw.reviewerModels : []).map((item) => safeTraceText(item)).filter(Boolean).slice(0, 3),
    finalModel: raw.finalModel ? safeTraceText(raw.finalModel).slice(0, 160) : null,
    reviews,
    trace,
  };
}

async function generateGuidedStrategy({ rawAnswers, config, credentials, env, onTrace = () => {} }) {
  const { answers, guided } = guidedAnswersToContract(rawAnswers);
  const prompt = buildStrategyPrompt(answers);
  let spec = buildSafeStrategySpec(answers);
  let source = 'deterministic';
  let model = null;
  const attempts = [];
  const trace = [];
  const reviews = [];
  let traceIndex = 0;
  const emit = (stage, status, title, summary, extra = {}) => {
    const event = {
      id: `strategy-${++traceIndex}`,
      at: Date.now(),
      stage,
      status,
      title: safeTraceText(title),
      summary: safeTraceText(summary),
      ...(extra.model ? { model: safeTraceText(extra.model).slice(0, 160) } : {}),
      ...(extra.handoff ? { handoff: extra.handoff.map((item) => safeTraceText(item)).filter(Boolean).slice(0, 5) } : {}),
      ...(extra.details ? { details: extra.details.map((item) => safeTraceText(item)).filter(Boolean).slice(0, 5) } : {}),
    };
    trace.push(event);
    try { onTrace(event); } catch { /* la telemetria UI non deve fermare la strategia */ }
    return event;
  };

  emit('intake', 'passed', 'Preferenze tradotte in vincoli', 'Obiettivo, budget, rischio e macro-preferenze sono diventati un contratto strutturato.', {
    handoff: ['Onboarding normalizzato', 'Vincoli di consenso', 'Baseline prudenziale'],
  });

  const llmConfig = { ...config, llmTemperature: Math.min(0.2, config.llmTemperature), llmMaxTokens: Math.max(3200, config.llmMaxTokens) };
  const plan = buildAttemptPlan({ config: llmConfig, credentials, env });
  let leadAttempt = null;
  for (const attempt of plan.slice(0, 6)) {
    const attemptModel = `${attempt.provider}/${attempt.model}`;
    emit('lead', 'running', 'Modello guida al lavoro', 'Il modello migliore disponibile sta costruendo la StrategySpec entro i vincoli scelti.', {
      model: attemptModel,
      handoff: ['Onboarding normalizzato', 'Schema StrategySpec', 'Baseline prudenziale'],
    });
    try {
      const response = await callModel({ ...attempt, messages: prompt.messages, config: llmConfig, credentials, env, jsonMode: true, timeoutMs: 55_000 });
      const resolvedAttemptModel = `${attempt.provider}/${response.resolvedModel ?? attempt.model}`;
      const normalized = normalizeAiStrategySpec(response.content, answers);
      if (!normalized.ok) {
        attempts.push({ ...attempt, ok: false, error: normalized.error });
        emit('lead', 'failed', 'Proposta non conforme', 'La risposta non rispettava schema o consenso ed è stata scartata senza applicarla.', { model: attemptModel });
        continue;
      }
      spec = normalized.value;
      source = 'ai';
      model = resolvedAttemptModel;
      leadAttempt = attempt;
      attempts.push({ ...attempt, ok: true });
      emit('lead', 'passed', 'Prima proposta pronta', 'La policy è completa e può passare ai revisori indipendenti.', {
        model: resolvedAttemptModel,
        handoff: ['StrategySpec strutturata', 'Limiti di rischio', 'Regole di universo dinamico'],
      });
      break;
    } catch (error) {
      attempts.push({ ...attempt, ok: false, error: error instanceof Error ? error.message : String(error) });
      emit('lead', 'failed', 'Modello non disponibile', 'Il router passa al provider successivo senza interrompere la creazione.', {
        model: attemptModel,
        details: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  if (!leadAttempt) {
    emit('lead', 'warning', 'Baseline prudenziale utilizzata', 'Nessun modello ha restituito una policy valida: la strategia continua dalla baseline deterministica.', {
      handoff: ['Baseline prudenziale', 'Vincoli di consenso', 'Controlli di fattibilità'],
    });
  }

  const remaining = plan.filter((attempt) => !leadAttempt || attempt.provider !== leadAttempt.provider || attempt.model !== leadAttempt.model);
  const diverse = [
    ...remaining.filter((attempt, index, all) => all.findIndex((item) => item.provider === attempt.provider) === index),
    ...remaining.filter((attempt, index, all) => all.findIndex((item) => item.provider === attempt.provider) !== index),
  ];
  const reviewerModels = [];
  const reviewedRoutes = new Set();
  for (const attempt of diverse.slice(0, 6)) {
    if (reviews.length >= 2) break;
    const reviewer = `${attempt.provider}/${attempt.model}`;
    emit('review', 'running', `Revisione ${reviews.length + 1}`, 'Un modello indipendente controlla consenso, rischio, diversificazione e fattibilità.', {
      model: reviewer,
      handoff: ['StrategySpec candidata', 'Onboarding normalizzato', 'Checklist di validazione'],
    });
    try {
      const response = await callModel({ ...attempt, messages: buildReviewMessages(answers, spec), config: { ...llmConfig, llmMaxTokens: 1200 }, credentials, env, jsonMode: true, timeoutMs: 45_000 });
      const resolvedReviewer = `${attempt.provider}/${response.resolvedModel ?? attempt.model}`;
      const review = normalizeReview(response.content, resolvedReviewer);
      if (!review) {
        emit('review', 'failed', 'Revisione non leggibile', 'Il responso non aveva il formato richiesto; viene provato un altro modello.', { model: reviewer });
        continue;
      }
      reviews.push(review);
      reviewerModels.push(resolvedReviewer);
      reviewedRoutes.add(reviewer);
      emit('review', review.verdict === 'approve' ? 'passed' : 'warning', review.verdict === 'approve' ? 'Policy approvata' : 'Correzioni richieste', review.summary, {
        model: resolvedReviewer,
        details: [...review.strengths, ...review.concerns, ...review.requiredChanges].slice(0, 5),
        handoff: ['Verdetto sintetico', 'Punti di forza', 'Correzioni richieste'],
      });
    } catch (error) {
      emit('review', 'failed', 'Revisore non disponibile', 'La validazione prosegue con il modello successivo.', {
        model: reviewer,
        details: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  let finalModel = model;
  if (reviews.some((review) => review.verdict === 'revise')) {
    const synthesisAttempt = diverse.find((attempt) => !reviewedRoutes.has(`${attempt.provider}/${attempt.model}`));
    if (synthesisAttempt) {
      const synthesisModel = `${synthesisAttempt.provider}/${synthesisAttempt.model}`;
      emit('synthesis', 'running', 'Sintesi delle revisioni', 'Le correzioni compatibili vengono integrate senza ampliare il consenso iniziale.', {
        model: synthesisModel,
        handoff: ['StrategySpec candidata', 'Verdetti dei revisori', 'Vincoli originali'],
      });
      try {
        const response = await callModel({ ...synthesisAttempt, messages: buildSynthesisMessages(prompt, spec, reviews), config: llmConfig, credentials, env, jsonMode: true, timeoutMs: 55_000 });
        const resolvedSynthesisModel = `${synthesisAttempt.provider}/${response.resolvedModel ?? synthesisAttempt.model}`;
        const normalized = normalizeAiStrategySpec(response.content, answers);
        if (normalized.ok) {
          spec = normalized.value;
          source = 'ai';
          finalModel = resolvedSynthesisModel;
          emit('synthesis', 'passed', 'Revisioni integrate', 'La versione consolidata rispetta ancora schema e consenso dell’onboarding.', { model: resolvedSynthesisModel });
        } else {
          emit('synthesis', 'warning', 'Sintesi scartata', 'La versione consolidata ampliava o rompeva un vincolo: resta valida la proposta precedente.', { model: synthesisModel });
        }
      } catch (error) {
        emit('synthesis', 'warning', 'Sintesi non disponibile', 'Resta attiva la proposta precedente, già protetta dai controlli deterministici.', {
          model: synthesisModel,
          details: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
  }

  spec = applyGuidedGuardrails(spec, guided);
  const feasibility = checkStrategyFeasibility(spec);
  emit('deterministic', feasibility.ok ? 'passed' : 'failed', 'Controllo finale dei guardrail', feasibility.ok
    ? 'Budget, tetti, liquidità, consenso e fattibilità sono coerenti: nessun modello può oltrepassare questi limiti.'
    : 'La strategia non supera i controlli deterministici.', {
    details: feasibility.ok ? feasibility.warnings : feasibility.errors,
    handoff: ['StrategySpec validata', 'Scenario deterministico', 'Modalità shadow'],
  });
  const scenario = buildDeterministicScenarioSummary(spec, scenarioAssumptions(spec), {
    horizonMonths: Math.max(3, Math.min(120, Number(guided.horizonMonths) || 12)),
    startingCapitalEur: spec.capital.budgetEur,
  });
  const collaborationStatus = source === 'deterministic'
    ? 'deterministic-fallback'
    : reviews.some((review) => review.verdict === 'revise') || reviews.length < 2
      ? 'validated-with-warnings'
      : 'validated';
  emit('complete', collaborationStatus === 'validated' ? 'passed' : 'warning', 'Strategia pronta', collaborationStatus === 'validated'
    ? 'Più modelli hanno validato la policy; ora parte in shadow e resta sotto guardrail deterministici.'
    : 'La policy è pronta con protezioni deterministiche; alcune revisioni AI non erano disponibili o hanno segnalato attenzioni.');
  const collaboration = sanitizeStrategyCollaboration({
    version: 1,
    mode: 'multi-model-review',
    status: collaborationStatus,
    leadModel: model,
    reviewerModels,
    finalModel,
    reviews,
    trace,
  });
  return {
    answers,
    guided,
    spec,
    scenario,
    draft: strategyPreview(spec, guided, scenario),
    generation: { source, model: finalModel, attempts },
    collaboration,
  };
}

export async function handleAgentApi(request, env, ctx, pathname) {
  if (!env.DB) return json({ error: 'binding D1 "DB" non configurato' }, 500);
  if (!isAuthorized(request, env)) return json({ error: 'non autorizzato' }, 401);

  const db = env.DB;
  const route = pathname.replace(/^\/agent\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const body = ['POST', 'PUT', 'PATCH'].includes(method)
    ? await request.json().catch(() => ({}))
    : {};

  // GET /agent/state
  if (route === 'state' && method === 'GET') {
    const storedConfig = await loadConfig(db);
    const trackingSince = Number(storedConfig.realCapitalTrackingStartedAt) || Number.MAX_SAFE_INTEGER;
    const [runs, curve, resolved] = await Promise.all([
      listRuns(db, 12),
      equityHistory(db, 200, trackingSince),
      resolveCredentials(db, env),
    ]);
    const config = hydrateGuidedReview(storedConfig);
    const last = runs[0] ?? null;
    const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : 0;
    const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : 0;
    return json({
      config,
      lastRun: last,
      recentRuns: runs,
      equityCurve: curve,
      equityUsd: equity,
      highWaterMarkUsd: hwm,
      drawdownPct: hwm > 0 ? (hwm - equity) / hwm : 0,
      credentials: describeCredentials(resolved),
      agentBindingVerified: hasVerifiedAgentBinding(resolved, config),
      notificationsActive: Boolean((resolved.values.telegramBotToken && resolved.values.telegramChatId) || resolved.values.notifyWebhookUrl),
    });
  }

  // GET /agent/runs
  if (route === 'runs' && method === 'GET') {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 30);
    return json({ runs: await listRuns(db, Math.min(Math.max(limit, 1), 200)) });
  }

  // GET /agent/runs/:id
  if (route.startsWith('runs/') && method === 'GET') {
    const bundle = await getRunBundle(db, route.slice('runs/'.length));
    if (!bundle.run) return json({ error: 'run non trovata' }, 404);
    return json(bundle);
  }

  // POST /agent/runs/:id/improve — nuova revisione, sempre senza ordini reali.
  if (route.startsWith('runs/') && route.endsWith('/improve') && method === 'POST') {
    const sourceRunId = route.slice('runs/'.length, -'/improve'.length);
    const source = await getRunBundle(db, sourceRunId);
    if (!source.run) return json({ error: 'run di origine non trovata' }, 404);
    if (!source.proposal?.parsed || !source.validation || source.validation.ok) {
      return json({ error: 'si può migliorare soltanto un piano AI bloccato dai guardrail' }, 400);
    }
    const result = await runPipeline({ env, kind: 'rebalance', modeOverride: 'dry-run', improveFromRunId: sourceRunId });
    return json({ ...result, improvedFromRunId: sourceRunId });
  }

  // GET|PUT /agent/config
  if (route === 'config') {
    if (method === 'GET') return json({ config: await loadConfig(db), defaults: DEFAULT_CONFIG });
    if (method === 'PUT') {
      const { patch, rejected } = sanitizeConfigPatch(body);
      if (!Object.keys(patch).length) return json({ error: 'nessuna modifica valida', rejected }, 400);
      const config = await saveConfig(db, patch);
      await audit(db, null, 'info', 'config', 'Configurazione aggiornata', { patch, rejected });
      return json({ config, applied: Object.keys(patch), rejected });
    }
  }

  // POST /agent/strategy/draft/stream — stessa generazione, con una traccia
  // NDJSON progressiva pensata per l'interfaccia (mai chain-of-thought).
  if (route === 'strategy/draft/stream' && method === 'POST') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let open = true;
        const send = (value) => {
          if (!open) return;
          try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); } catch { open = false; }
        };
        try {
          const [config, { values: credentials }] = await Promise.all([loadConfig(db), resolveCredentials(db, env)]);
          const bundle = await generateGuidedStrategy({
            rawAnswers: body.answers ?? body,
            config,
            credentials,
            env,
            onTrace: (event) => send({ type: 'trace', event }),
          });
          await audit(db, null, 'info', 'strategy', `Bozza strategia multi-AI generata (${bundle.generation.source})`, {
            model: bundle.generation.model,
            reviewers: bundle.collaboration?.reviewerModels ?? [],
            collaborationStatus: bundle.collaboration?.status,
            attempts: bundle.generation.attempts.map(({ provider, model, ok, error }) => ({ provider, model, ok, error })),
            objective: bundle.spec.objective.primary,
            maxPositions: bundle.spec.diversification.maxPositions,
          });
          send({
            type: 'complete',
            bundle: {
              draft: bundle.draft,
              strategySpec: bundle.spec,
              onboardingAnswers: bundle.answers,
              scenario: bundle.scenario,
              generation: bundle.generation,
              collaboration: bundle.collaboration,
            },
          });
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (open) controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  // POST /agent/strategy/draft — genera una policy, mai ordini o ticker.
  if (route === 'strategy/draft' && method === 'POST') {
    try {
      const [config, { values: credentials }] = await Promise.all([loadConfig(db), resolveCredentials(db, env)]);
      const bundle = await generateGuidedStrategy({ rawAnswers: body.answers ?? body, config, credentials, env });
      await audit(db, null, 'info', 'strategy', `Bozza strategia generata (${bundle.generation.source})`, {
        model: bundle.generation.model,
        attempts: bundle.generation.attempts.map(({ provider, model, ok, error }) => ({ provider, model, ok, error })),
        objective: bundle.spec.objective.primary,
        maxPositions: bundle.spec.diversification.maxPositions,
      });
      return json({
        draft: bundle.draft,
        strategySpec: bundle.spec,
        onboardingAnswers: bundle.answers,
        scenario: bundle.scenario,
        generation: bundle.generation,
        collaboration: bundle.collaboration,
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // POST /agent/strategy/activate — persiste i guardrail e parte sempre in shadow.
  if (route === 'strategy/activate' && method === 'POST') {
    try {
      const { answers, guided } = guidedAnswersToContract(body.answers ?? {});
      const activationGuided = {
        ...guided,
        maxDrawdownPct: Number.isFinite(Number(body.reviewMaxDrawdownPct))
          ? Number(body.reviewMaxDrawdownPct)
          : guided.maxDrawdownPct,
      };
      const [current, resolved] = await Promise.all([loadConfig(db), resolveCredentials(db, env)]);
      const requestedPortfolioId = String(body.portfolioId ?? guided.portfolioId ?? '').trim();
      if (!requestedPortfolioId || requestedPortfolioId !== current.activeAgentPortfolioId || !hasVerifiedAgentBinding(resolved, current)) {
        return json({
          error: 'Il portfolio selezionato non ha un token verificato. Genera il token dalla selezione Agent Portfolio e riprova.',
          selectedPortfolioId: requestedPortfolioId || null,
          activePortfolioId: current.activeAgentPortfolioId || null,
        }, 409);
      }

      let spec;
      if (body.strategySpec) {
        const normalized = normalizeAiStrategySpec(body.strategySpec, answers);
        if (!normalized.ok) return json({ error: 'StrategySpec non valido', details: normalized.errors }, 400);
        spec = normalized.value;
      } else {
        spec = buildSafeStrategySpec(answers);
      }
      spec = applyGuidedGuardrails(spec, activationGuided);
      const scenario = buildDeterministicScenarioSummary(spec, scenarioAssumptions(spec), {
        horizonMonths: Math.max(3, Math.min(120, Number(activationGuided.horizonMonths) || 12)),
        startingCapitalEur: spec.capital.budgetEur,
      });
      const classCaps = Object.fromEntries(Object.entries(spec.universePolicy.assetClassCapsPct)
        .map(([klass, pct]) => [klass, Number(pct) / 100]));
      classCaps.cash = 1;
      const shadowDays = Math.max(1, Math.min(90, Math.round(Number(activationGuided.shadowDays) || 14)));
      const maxHoldings = spec.diversification.maxPositions;
      const minHoldingDays = Math.max(0, Math.min(365, Math.round(Number(activationGuided.minHoldingDays) || 0)));
      const policyPool = buildPolicyUniverse(spec, { limit: Math.min(60, Math.max(40, maxHoldings * 3)) });
      const persistedDraft = strategyPreview(spec, activationGuided, scenario);
      const next = await saveConfig(db, {
        strategySpecVersion: spec.schemaVersion,
        strategySpec: spec,
        onboardingAnswers: answers,
        onboardingComplete: true,
        strategyName: spec.name,
        strategyGeneratedBy: String(body.generatedBy ?? 'guided-onboarding').slice(0, 160),
        strategyScenario: scenario,
        strategyDraft: persistedDraft,
        strategyCollaboration: sanitizeStrategyCollaboration(body.collaboration),
        guidedOnboardingAnswers: activationGuided,
        policyUniverse: spec.universePolicy,
        universeMode: 'dynamic',
        pool: policyPool,
        budgetEur: spec.capital.budgetEur,
        targetDeploymentPct: spec.capital.targetDeploymentPct / 100,
        maxHoldings,
        minHoldings: spec.diversification.minPositions,
        preferredHoldings: Math.max(
          spec.diversification.preferredPositions,
          Math.min(maxHoldings, Math.round(maxHoldings * 0.75)),
        ),
        shortlistSize: Math.min(40, Math.max(24, maxHoldings * 2)),
        minHoldingDays,
        cadence: spec.execution.cadence,
        minOrderUsd: Math.max(1, spec.execution.minOrderEur * current.fallbackEurUsd),
        // L'assoluto diventa solo un fusibile molto alto; il validator usa il
        // tetto percentuale sul capitale reale del portfolio.
        maxOrderUsd: 100000,
        maxOrderPctOfCapital: spec.execution.maxOrderPctOfCapital / 100,
        maxTurnoverPct: spec.execution.maxTurnoverPct / 100,
        maxWeightPerClass: classCaps,
        minCashPct: spec.capital.cashFloorPct / 100,
        maxCashPct: spec.capital.cashCeilingPct / 100,
        drawdownStopPct: spec.risk.maxDrawdownPct / 100,
        maxOrdersPerRun: Math.min(16, maxHoldings),
        maxOrdersPerDay: Math.min(40, Math.max(maxHoldings, maxHoldings * 2)),
        watcherEnabled: true,
        riskProfile: `${spec.objective.description} Nessuna leva, nessuno short. Universo dinamico entro le preferenze e i cap della StrategySpec v${spec.schemaVersion}.`,
        shadowStartedAt: Date.now(),
        realCapitalTrackingStartedAt: 0,
        shadowDays,
        executionMode: 'shadow',
        frozen: false,
        frozenReason: '',
      });
      await audit(db, null, 'warn', 'strategy', `Strategia “${spec.name}” attivata in shadow per ${shadowDays} giorni`, {
        portfolioId: requestedPortfolioId,
        maxHoldings,
        targetDeploymentPct: spec.capital.targetDeploymentPct,
        cashFloorPct: spec.capital.cashFloorPct,
        policyCandidates: policyPool.length,
      });
      const telegramQueued = Boolean(resolved.values.telegramBotToken && resolved.values.telegramChatId);
      const notification = buildStrategyActivationNotification({
        spec,
        guided: activationGuided,
        draft: persistedDraft,
        portfolioId: requestedPortfolioId,
        portfolioName: current.activeAgentPortfolioName,
        collaboration: next.strategyCollaboration,
      });
      const notificationTask = notify(resolved.values, notification.level, notification.title, notification.lines)
        .then((result) => audit(db, null, result.sent > 0 || result.attempted === 0 ? 'info' : 'warn', 'notify',
          result.attempted === 0
            ? 'Riepilogo strategia non inviato: nessun canale configurato'
            : `Riepilogo strategia inviato su ${result.sent}/${result.attempted} canali`,
          { telegramQueued, results: result.results }));
      if (ctx?.waitUntil) ctx.waitUntil(notificationTask);
      else await notificationTask;
      return json({ ok: true, config: next, strategySpec: spec, scenario, draft: persistedDraft, telegramQueued });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // POST /agent/mode  { mode, confirm }
  if (route === 'mode' && method === 'POST') {
    const mode = String(body.mode ?? '');
    if (!['shadow', 'dry-run', 'live'].includes(mode)) return json({ error: 'modalità non ammessa' }, 400);
    if (mode === 'live' && body.confirm !== 'ATTIVA ORDINI REALI') {
      return json({ error: 'per la modalità live serve confirm = "ATTIVA ORDINI REALI"' }, 400);
    }
    const resolved = await resolveCredentials(db, env);
    const credentials = resolved.values;
    const current = await loadConfig(db);
    if (mode === 'live' && !hasVerifiedAgentBinding(resolved, current)) {
      return json({ error: 'Agent Portfolio non verificato: genera un nuovo token e attendi la verifica prima del live' }, 400);
    }
    const config = await saveConfig(db, { executionMode: mode });
    await audit(db, null, 'warn', 'config', `Modalità di esecuzione impostata su ${mode}`);
    await notify(credentials, mode === 'live' ? 'critical' : 'info', `Autopilot: modalità ${mode}`, [
      mode === 'live' ? 'Da ora gli ordini vengono inviati davvero su eToro.' : 'Nessun ordine reale verrà inviato.',
    ]);
    return json({ config });
  }

  // POST /agent/freeze | /agent/unfreeze
  if (route === 'freeze' && method === 'POST') {
    const reason = String(body.reason ?? 'freeze manuale').slice(0, 300);
    const config = await saveConfig(db, { frozen: true, frozenReason: reason });
    await audit(db, null, 'warn', 'config', `Agente congelato: ${reason}`);
    return json({ config });
  }
  if (route === 'unfreeze' && method === 'POST') {
    const config = await saveConfig(db, { frozen: false, frozenReason: '' });
    await audit(db, null, 'warn', 'config', 'Agente riattivato');
    return json({ config });
  }

  // POST /agent/trigger { kind, mode }
  if (route === 'trigger' && method === 'POST') {
    const kind = ['snapshot', 'rebalance', 'heartbeat'].includes(body.kind) ? body.kind : 'rebalance';
    const modeOverride = ['shadow', 'dry-run', 'live'].includes(body.mode) ? body.mode : undefined;
    if (modeOverride === 'live' && body.confirm !== 'ATTIVA ORDINI REALI') {
      return json({ error: 'override live richiede confirm = "ATTIVA ORDINI REALI"' }, 400);
    }
    if (modeOverride === 'live') {
      const [resolved, config] = await Promise.all([resolveCredentials(db, env), loadConfig(db)]);
      if (!hasVerifiedAgentBinding(resolved, config)) {
        return json({ error: 'Agent Portfolio non verificato: genera un nuovo token prima della run live' }, 400);
      }
    }
    const result = await runPipeline({ env, kind, modeOverride });
    return json(result);
  }

  // GET|PUT|DELETE /agent/credentials
  if (route === 'credentials') {
    if (method === 'GET') {
      return json({ credentials: describeCredentials(await resolveCredentials(db, env)) });
    }
    if (method === 'PUT') {
      const { applied, rejected } = await saveCredentials(db, env, body);
      if (applied.includes('etoroAgentToken')) {
        await saveConfig(db, {
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
      }
      await audit(db, null, 'warn', 'credentials', `Credenziali aggiornate: ${applied.join(', ') || 'nessuna'}`, { rejected });
      return json({ credentials: describeCredentials(await resolveCredentials(db, env)), applied, rejected });
    }
    if (method === 'DELETE') {
      await clearCredentials(db);
      await saveConfig(db, {
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
      await audit(db, null, 'warn', 'credentials', 'Vault credenziali svuotato');
      return json({ credentials: describeCredentials(await resolveCredentials(db, env)) });
    }
  }

  // GET /agent/profiles
  if (route === 'profiles' && method === 'GET') {
    return json({ profiles: listProfiles(), current: (await loadConfig(db)).strategyProfile });
  }

  // POST /agent/profile { profile }
  if (route === 'profile' && method === 'POST') {
    const profileId = String(body.profile ?? '');
    const known = listProfiles().some((item) => item.id === profileId);
    if (!known) return json({ error: 'profilo non riconosciuto' }, 400);
    const current = await loadConfig(db);
    const next = applyProfile(current, profileId);
    const config = await saveConfig(db, next);
    await audit(db, null, 'warn', 'config', `Profilo di strategia impostato su ${profileId}`);
    return json({ config });
  }

  // GET /agent/watcher — eventi rilevati e relative decisioni
  if (route === 'watcher' && method === 'GET') {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
    return json({ events: await listWatcherEvents(db, Math.min(Math.max(limit, 1), 200)) });
  }

  // GET /agent/ledger — vincoli temporali attivi sulle posizioni
  if (route === 'ledger' && method === 'GET') {
    const ledger = await loadLedger(db);
    return json({ ledger: [...ledger.values()] });
  }

  // GET /agent/instruments?q=...  — ricerca nel catalogo eToro
  if (route === 'instruments' && method === 'GET') {
    const term = new URL(request.url).searchParams.get('q') ?? '';
    const { values: credentials } = await resolveCredentials(db, env);
    if (!credentials.etoroApiKey || !credentials.etoroUserKey) return json({ error: 'credenziali eToro non configurate' }, 400);
    try {
      const client = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      return json({ results: (await client.searchInstruments(term)).slice(0, 25) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  // GET /agent/agent-portfolios
  if (route === 'agent-portfolios' && method === 'GET') {
    const { values: credentials } = await resolveCredentials(db, env);
    if (!credentials.etoroApiKey || !credentials.etoroUserKey) return json({ error: 'credenziali eToro non configurate' }, 400);
    try {
      const client = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      const portfolios = await client.agentPortfolios();
      return json({ portfolios: portfolios.map(({ raw, ...rest }) => { void raw; return rest; }) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  // POST /agent/agent-token { agentPortfolioId }
  // Genera un nuovo token operativo e lo salva nel vault senza mai restituirlo.
  if (route === 'agent-token' && method === 'POST') {
    const agentPortfolioId = String(body.agentPortfolioId ?? '').trim();
    if (!agentPortfolioId) return json({ error: 'agentPortfolioId obbligatorio' }, 400);
    const { values: credentials } = await resolveCredentials(db, env);
    if (!credentials.etoroApiKey || !credentials.etoroUserKey) return json({ error: 'credenziali eToro non configurate' }, 400);
    try {
      const client = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      const remote = (await client.agentPortfolios()).find((item) => item.id === agentPortfolioId);
      if (!remote) throw new Error(`Agent Portfolio ${agentPortfolioId} non trovato sul conto eToro`);
      if (!remote.mirrorId) throw new Error('eToro non ha restituito il mirrorId necessario a leggere il capitale reale');
      const realPortfolio = await client.mirrorPortfolio(remote.mirrorId);
      const { token, name } = await client.createAgentUserToken(agentPortfolioId);
      // eToro restituisce il segreto una sola volta. Lo collaudiamo prima di
      // sostituire l'eventuale token valido già nel vault.
      const verifier = new EtoroClient({
        apiKey: credentials.etoroApiKey,
        userKey: credentials.etoroUserKey,
        agentToken: token,
      });
      const portfolio = await verifier.portfolio(token);
      const currentConfig = await loadConfig(db);
      const { config } = await saveVerifiedAgentToken(db, env, {
        token,
        portfolioId: agentPortfolioId,
        portfolioName: body.agentPortfolioName || remote.name,
        mirrorId: remote.mirrorId,
        virtualBalanceUsd: remote.virtualBalanceUsd,
        verifiedAt: Date.now(),
        currentConfig: {
          ...currentConfig,
          lastManagedCapitalUsd: realPortfolio.equityUsd,
          lastManagedCapitalEur: realPortfolio.equityUsd / currentConfig.fallbackEurUsd,
          lastManagedCapitalAt: realPortfolio.takenAt,
          lastManagedEurUsd: currentConfig.fallbackEurUsd,
          realCapitalTrackingStartedAt: 0,
        },
      });
      const hint = config.agentTokenHint;
      await audit(db, null, 'warn', 'credentials', `Nuovo token Agent Portfolio verificato e salvato (${name})`, {
        agentPortfolioId,
        realEquityUsd: realPortfolio.equityUsd,
        virtualEquityUsd: portfolio.equityUsd,
        positions: portfolio.positions.length,
      });
      return json({
        ok: true,
        tokenName: name,
        hint,
        verified: true,
        portfolio: {
          id: agentPortfolioId,
          name: config.activeAgentPortfolioName,
          equityUsd: realPortfolio.equityUsd,
          virtualEquityUsd: portfolio.equityUsd,
          positions: portfolio.positions.length,
        },
        credentials: describeCredentials(await resolveCredentials(db, env)),
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  // POST /agent/diagnose
  if (route === 'diagnose' && method === 'POST') {
    const [config, resolved] = await Promise.all([loadConfig(db), resolveCredentials(db, env)]);
    const report = await runDiagnostics(resolved, config, env);
    await audit(db, null, report.ok ? 'info' : 'warn', 'diagnose',
      `Diagnostica: ${report.checks.filter((item) => item.ok === false).length} problemi`,
      report.checks.map(({ id, ok: state, error }) => ({ id, ok: state, error })));
    return json(report);
  }

  // POST /agent/notify-test
  if (route === 'notify-test' && method === 'POST') {
    const { values: credentials } = await resolveCredentials(db, env);
    try {
      return json(await notifyTest(credentials));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // GET /agent/models
  if (route === 'models' && method === 'GET') {
    try {
      const { values: credentials } = await resolveCredentials(db, env);
      return json({ models: await listFreeModels(credentials.openrouterApiKey), providers: Object.values(PROVIDERS) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  if (route === 'health' && method === 'GET') {
    return json({ ok: true, at: Date.now() });
  }

  return json({ error: 'rotta non trovata' }, 404);
}
