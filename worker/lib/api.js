/**
 * API di controllo dell'Autopilot. Tutte le rotte richiedono il bearer token
 * `CONTROL_TOKEN`; il passaggio a modalità `live` richiede una conferma
 * esplicita aggiuntiva.
 */
import { runPipeline } from './pipeline.js';
import { listFreeModels } from './brain.js';
import { notify, notifyTest } from './notify.js';
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
    if (['activeAgentPortfolioId', 'activeAgentPortfolioName', 'agentTokenVerifiedAt', 'agentTokenHint', 'agentTokenFingerprint', 'agentTokenOrigin'].includes(key)) {
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
    if (key === 'watcherEnabled') {
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
      preferredPositions: Math.min(maxHoldings, Math.max(3, Math.round(maxHoldings * 0.65))),
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

async function generateGuidedStrategy({ rawAnswers, config, credentials, env }) {
  const { answers, guided } = guidedAnswersToContract(rawAnswers);
  const prompt = buildStrategyPrompt(answers);
  let spec = buildSafeStrategySpec(answers);
  let source = 'deterministic';
  let model = null;
  const attempts = [];
  const llmConfig = { ...config, llmTemperature: Math.min(0.2, config.llmTemperature), llmMaxTokens: Math.max(3200, config.llmMaxTokens) };
  for (const attempt of buildAttemptPlan({ config: llmConfig, credentials, env }).slice(0, 3)) {
    try {
      const response = await callModel({ ...attempt, messages: prompt.messages, config: llmConfig, credentials, env, jsonMode: true, timeoutMs: 55_000 });
      const normalized = normalizeAiStrategySpec(response.content, answers);
      if (!normalized.ok) {
        attempts.push({ ...attempt, ok: false, error: normalized.error });
        continue;
      }
      spec = normalized.value;
      source = 'ai';
      model = `${attempt.provider}/${attempt.model}`;
      attempts.push({ ...attempt, ok: true });
      break;
    } catch (error) {
      attempts.push({ ...attempt, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  spec = applyGuidedGuardrails(spec, guided);
  const scenario = buildDeterministicScenarioSummary(spec, scenarioAssumptions(spec), {
    horizonMonths: Math.max(3, Math.min(120, Number(guided.horizonMonths) || 12)),
    startingCapitalEur: spec.capital.budgetEur,
  });
  return { answers, guided, spec, scenario, draft: strategyPreview(spec, guided, scenario), generation: { source, model, attempts } };
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
    const [config, runs, curve, resolved] = await Promise.all([loadConfig(db), listRuns(db, 12), equityHistory(db, 200), resolveCredentials(db, env)]);
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
      const next = await saveConfig(db, {
        strategySpecVersion: spec.schemaVersion,
        strategySpec: spec,
        onboardingAnswers: answers,
        onboardingComplete: true,
        strategyName: spec.name,
        strategyGeneratedBy: String(body.generatedBy ?? 'guided-onboarding').slice(0, 160),
        strategyScenario: scenario,
        policyUniverse: spec.universePolicy,
        universeMode: 'dynamic',
        pool: policyPool,
        budgetEur: spec.capital.budgetEur,
        targetDeploymentPct: spec.capital.targetDeploymentPct / 100,
        maxHoldings,
        minHoldings: spec.diversification.minPositions,
        shortlistSize: Math.min(40, Math.max(24, maxHoldings * 2)),
        minHoldingDays,
        cadence: spec.execution.cadence,
        minOrderUsd: Math.max(1, spec.execution.minOrderEur * current.fallbackEurUsd),
        // L'assoluto diventa solo un fusibile molto alto; il validator usa il
        // tetto percentuale sull'equity virtuale del portfolio.
        maxOrderUsd: 100000,
        maxOrderPctOfCapital: spec.execution.maxOrderPctOfCapital / 100,
        maxTurnoverPct: spec.execution.maxTurnoverPct / 100,
        maxWeightPerClass: classCaps,
        minCashPct: spec.capital.cashFloorPct / 100,
        maxCashPct: spec.capital.cashCeilingPct / 100,
        drawdownStopPct: spec.risk.maxDrawdownPct / 100,
        maxOrdersPerRun: Math.min(20, maxHoldings),
        maxOrdersPerDay: Math.min(40, Math.max(maxHoldings, maxHoldings * 2)),
        watcherEnabled: true,
        riskProfile: `${spec.objective.description} Nessuna leva, nessuno short. Universo dinamico entro le preferenze e i cap della StrategySpec v${spec.schemaVersion}.`,
        shadowStartedAt: Date.now(),
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
      return json({ ok: true, config: next, strategySpec: spec, scenario, draft: strategyPreview(spec, activationGuided, scenario) });
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
        portfolioName: body.agentPortfolioName,
        verifiedAt: Date.now(),
        currentConfig,
      });
      const hint = config.agentTokenHint;
      await audit(db, null, 'warn', 'credentials', `Nuovo token Agent Portfolio verificato e salvato (${name})`, {
        agentPortfolioId,
        equityUsd: portfolio.equityUsd,
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
          equityUsd: portfolio.equityUsd,
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
