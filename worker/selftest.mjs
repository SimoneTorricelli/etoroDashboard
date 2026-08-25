/**
 * Smoke test del livello deterministico. Non tocca la rete né D1.
 * Esecuzione:  node worker/selftest.mjs
 *
 * Serve a verificare che i guardrail reggano contro proposte malformate o
 * ostili prima di abilitare qualunque modalità operativa.
 */
import assert from 'node:assert/strict';
import { buildFeatures, renderFeaturesPrompt, rsi, maxDrawdown, annualizedVol } from './lib/features.js';
import { validateProposal } from './lib/validator.js';
import { extractJson, normalizeProposal } from './lib/brain.js';
import { DEFAULT_CONFIG } from './lib/db.js';
import { PROFILES, applyProfile, describeProfile, listProfiles } from './lib/profiles.js';
import { checkChurnRules, filterMarginalSubstitutions, isWorthTheCost } from './lib/churn.js';
import { buildShortlist, scoreInstrument } from './lib/screening.js';
import { decideWatcherAction, detectAnomalies, isStabilized, relevantHeadlines } from './lib/watcher.js';
import { executePlan, reconcile } from './lib/executor.js';

const DAY = 24 * 60 * 60 * 1000;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function syntheticSeries(start, days, drift, noiseSeed = 1) {
  const rows = [];
  let price = start;
  let seed = noiseSeed;
  for (let i = 0; i < days; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const noise = (seed / 2147483648 - 0.5) * 0.02;
    price *= 1 + drift + noise;
    rows.push({ at: `2026-01-${(i % 28) + 1}`, close: Math.round(price * 100) / 100 });
  }
  return rows;
}

const universe = new Map([
  ['SPY', { symbol: 'SPY', class: 'etf', maxWeight: 0.4, instrumentId: 1001, name: 'SPY' }],
  ['GLD', { symbol: 'GLD', class: 'commodity', maxWeight: 0.25, instrumentId: 1002, name: 'GLD' }],
  ['BTC', { symbol: 'BTC', class: 'crypto', maxWeight: 0.15, instrumentId: 1003, name: 'BTC' }],
]);

const candles = new Map([
  ['SPY', syntheticSeries(400, 260, 0.0004, 7)],
  ['GLD', syntheticSeries(180, 260, 0.0002, 11)],
  ['BTC', syntheticSeries(60000, 260, -0.0008, 13)],
]);

const snapshot = {
  takenAt: Date.now(),
  cashUsd: 60,
  investedUsd: 200,
  positionsValueUsd: 210,
  equityUsd: 270,
  positions: [
    { positionId: 1, instrumentId: 1001, invested: 120, units: 0.3, openRate: 400, currentRate: 420, leverage: 1, isBuy: true, valueUsd: 126, grossValueUsd: 126, pnlUsd: 6, openedAt: '' },
    { positionId: 2, instrumentId: 1003, invested: 80, units: 0.001, openRate: 60000, currentRate: 52500, leverage: 1, isBuy: true, valueUsd: 84, grossValueUsd: 84, pnlUsd: -6, openedAt: '' },
  ],
};

const external = {
  eurUsd: { rate: 1.09, date: '2026-08-25' },
  crypto: { global: { marketCapChange24hPct: -1.2, btcDominancePct: 54 }, fearGreed: { value: 38, label: 'Fear' } },
  series: { spx: syntheticSeries(5000, 260, 0.0003, 3), vix: syntheticSeries(18, 260, 0, 5), us10y: syntheticSeries(4.2, 260, 0, 9), us2y: syntheticSeries(4.0, 260, 0, 17) },
  news: { items: [{ title: 'Stocks rally as inflation cools', score: 1, topic: 'markets' }], positiveHits: 4, negativeHits: 2, net: 0.33 },
  fundamentals: [],
  diagnostics: [],
};

const features = buildFeatures({ snapshot, universe, candles, external, config: DEFAULT_CONFIG, equityHistory: [] });
const config = { ...DEFAULT_CONFIG, whitelist: [...universe.values()] };

test('indicatori tecnici coerenti', () => {
  const flat = Array.from({ length: 40 }, () => 100);
  assert.equal(rsi(flat), 100, 'RSI su serie piatta senza perdite è 100');
  assert.equal(maxDrawdown([100, 120, 60]), -50);
  assert.ok(annualizedVol(candles.get('BTC').map((row) => row.close)) > 0);
});

test('feature: pesi e classi sommano correttamente', () => {
  const invested = features.instruments.reduce((sum, item) => sum + item.weight, 0);
  assert.ok(Math.abs(invested + features.allocationByClass.cash - 1) < 0.001);
  assert.equal(features.instruments.length, 3);
});

test('prompt compatto sotto i 6000 caratteri', () => {
  const prompt = renderFeaturesPrompt(features, config);
  assert.ok(prompt.length < 6000, `prompt di ${prompt.length} caratteri`);
  assert.ok(prompt.includes('STRUMENTI'));
});

test('estrazione JSON tollera testo attorno e code fence', () => {
  const parsed = extractJson('Ecco il piano:\n```json\n{"targetWeights":{"SPY":0.5,"CASH":0.5},"confidence":0.7,"rationale":"ok"}\n```\nFine.');
  assert.equal(parsed.confidence, 0.7);
});

test('normalizzazione rifiuta simboli fuori whitelist', () => {
  const result = normalizeProposal({ targetWeights: { TSLA: 1 }, confidence: 0.9, rationale: '' }, ['SPY', 'GLD', 'BTC']);
  assert.equal(result.ok, false);
  assert.match(result.error, /non ammessi/);
});

test('normalizzazione accetta pesi espressi in percentuale', () => {
  const result = normalizeProposal({ targetWeights: { SPY: 60, CASH: 40 }, confidence: 80, rationale: '' }, ['SPY']);
  assert.equal(result.ok, true);
  assert.equal(result.value.targetWeights.SPY, 0.6);
  assert.equal(result.value.confidence, 0.8);
});

test('guardrail: peso oltre il cap viene ridotto', () => {
  const proposal = { targetWeights: { BTC: 0.9, CASH: 0.1 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const { plan, violations } = validateProposal({ proposal, features, config });
  assert.ok(violations.some((item) => item.code === 'symbol_cap'));
  assert.ok(plan.targets.BTC <= config.whitelist.find((item) => item.symbol === 'BTC').maxWeight + 1e-6);
});

test('guardrail: confidence bassa blocca la run', () => {
  const proposal = { targetWeights: { SPY: 0.4, CASH: 0.6 }, confidence: 0.2, rationale: '', risks: [], watch: [] };
  const result = validateProposal({ proposal, features, config });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.code === 'low_confidence'));
});

test('guardrail: freeze blocca sempre', () => {
  const proposal = { targetWeights: { SPY: 0.4, CASH: 0.6 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const result = validateProposal({ proposal, features, config: { ...config, frozen: true, frozenReason: 'test' } });
  assert.equal(result.ok, false);
});

test('guardrail: turnover e numero ordini rispettati', () => {
  const proposal = { targetWeights: { SPY: 0.4, GLD: 0.25, BTC: 0.15, CASH: 0.2 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const { plan } = validateProposal({ proposal, features, config: { ...config, maxOrdersPerRun: 2 } });
  assert.ok(plan.orders.length <= 2);
  assert.ok(plan.turnoverPct <= config.maxTurnoverPct + 1e-6);
  for (const order of plan.orders) {
    assert.ok(order.amountUsd >= config.minOrderUsd);
    assert.ok(order.amountUsd <= config.maxOrderUsd);
  }
});

test('guardrail: gli acquisti non intaccano la riserva di cassa', () => {
  const proposal = { targetWeights: { SPY: 0.4, GLD: 0.25, BTC: 0.15, CASH: 0.2 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const { plan } = validateProposal({ proposal, features, config });
  const buys = plan.orders.filter((order) => order.side === 'buy').reduce((sum, order) => sum + order.amountUsd, 0);
  const sells = plan.orders.filter((order) => order.side === 'sell').reduce((sum, order) => sum + order.amountUsd, 0);
  const reserve = config.minCashPct * features.portfolio.equityUsd;
  assert.ok(buys <= features.portfolio.cashUsd + sells - reserve + 0.01, `acquisti ${buys} oltre la liquidità disponibile`);
});

test('nessuna azione quando i pesi sono già a target e rispettano i cap', () => {
  // I cap vengono allargati apposta: il portafoglio sintetico è sovrappesato su
  // BTC e SPY, e con i cap di default il validator dovrebbe (giustamente) agire.
  const permissive = { ...config, minHoldings: 1, whitelist: config.whitelist.map((item) => ({ ...item, maxWeight: 1 })), maxWeightPerClass: { etf: 1, bond: 1, commodity: 1, crypto: 1, cash: 1 } };
  const permissiveFeatures = buildFeatures({ snapshot, universe: new Map([...universe].map(([key, value]) => [key, { ...value, maxWeight: 1 }])), candles, external, config: permissive, equityHistory: [] });
  const targets = Object.fromEntries(permissiveFeatures.instruments.map((item) => [item.symbol, item.weight]));
  targets.CASH = permissiveFeatures.allocationByClass.cash;
  const proposal = { targetWeights: targets, confidence: 0.95, rationale: '', risks: [], watch: [] };
  const { ok, plan } = validateProposal({ proposal, features: permissiveFeatures, config: permissive });
  assert.equal(ok, true);
  assert.equal(plan.orders.length, 0);
});

test('un portafoglio che viola i cap genera vendite anche senza cambio di vista', () => {
  const targets = Object.fromEntries(features.instruments.map((item) => [item.symbol, item.weight]));
  targets.CASH = features.allocationByClass.cash;
  const proposal = { targetWeights: targets, confidence: 0.95, rationale: '', risks: [], watch: [] };
  const { plan, violations } = validateProposal({ proposal, features, config });
  assert.ok(violations.some((item) => item.code === 'symbol_cap'));
  assert.ok(plan.orders.every((order) => order.side === 'sell'));
});

// ------------------------------------------------- profili di strategia

test('profili: applicazione sovrascrive i guardrail correlati', () => {
  const applied = applyProfile({ ...DEFAULT_CONFIG }, 'defensive');
  assert.equal(applied.strategyProfile, 'defensive');
  assert.equal(applied.maxWeightPerClass.crypto, 0);
  assert.equal(applied.drawdownStopPct, PROFILES.defensive.drawdownStopPct);
  assert.ok(applied.minHoldingDays >= DEFAULT_CONFIG.minHoldingDays);
});

test('profili: aggressivo tollera più rischio del difensivo', () => {
  const defensive = applyProfile({ ...DEFAULT_CONFIG }, 'defensive');
  const aggressive = applyProfile({ ...DEFAULT_CONFIG }, 'aggressive');
  assert.ok(aggressive.drawdownStopPct > defensive.drawdownStopPct);
  assert.ok(aggressive.maxTurnoverPct > defensive.maxTurnoverPct);
  assert.ok(aggressive.maxHoldings > defensive.maxHoldings);
  assert.ok(listProfiles().length === 4);
  assert.match(describeProfile(aggressive), /Aggressivo/);
});

// ------------------------------------------------- disciplina anti-churn

test('churn: non si vende prima del periodo minimo di detenzione', () => {
  const ledger = new Map([['SPY', { symbol: 'SPY', last_bought_at: Date.now() - 3 * DAY }]]);
  const result = checkChurnRules({ symbol: 'SPY', side: 'sell', ledger, config: { ...DEFAULT_CONFIG, minHoldingDays: 21 } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /minimo 21/);
});

test('churn: lo stop loss ha la precedenza sul periodo minimo', () => {
  const ledger = new Map([['BTC', { symbol: 'BTC', last_bought_at: Date.now() - DAY }]]);
  const result = checkChurnRules({ symbol: 'BTC', side: 'sell', ledger, config: DEFAULT_CONFIG, isStopLoss: true });
  assert.equal(result.allowed, true);
});

test('churn: non si rientra prima della fine del cooldown', () => {
  const ledger = new Map([['GLD', { symbol: 'GLD', last_sold_at: Date.now() - 5 * DAY }]]);
  const result = checkChurnRules({ symbol: 'GLD', side: 'buy', ledger, config: { ...DEFAULT_CONFIG, reentryCooldownDays: 30 } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /dopo 30/);
});

test('churn: mediazione al ribasso limitata', () => {
  const ledger = new Map([['BTC', { symbol: 'BTC', average_down_count: 1 }]]);
  const result = checkChurnRules({ symbol: 'BTC', side: 'buy', ledger, config: { ...DEFAULT_CONFIG, maxAverageDown: 1 }, isOpportunistic: true });
  assert.equal(result.allowed, false);
});

test('churn: il beneficio atteso deve superare il costo', () => {
  const config = { ...DEFAULT_CONFIG, transactionCostBps: 20 };
  assert.equal(isWorthTheCost({ amountUsd: 100, expectedEdgePct: 0.1, config }).worth, false);
  assert.equal(isWorthTheCost({ amountUsd: 100, expectedEdgePct: 1.5, config }).worth, true);
});

test('churn: sostituzioni marginali vengono rifiutate', () => {
  const config = { ...DEFAULT_CONFIG, substitutionEdge: 18 };
  const marginal = filterMarginalSubstitutions({ entering: [{ symbol: 'QQQ', score: 62 }], exiting: [{ symbol: 'SPY', score: 55 }], config });
  assert.equal(marginal.entering.length, 0);
  assert.equal(marginal.exiting.length, 0);
  const decisive = filterMarginalSubstitutions({ entering: [{ symbol: 'QQQ', score: 85 }], exiting: [{ symbol: 'SPY', score: 55 }], config });
  assert.equal(decisive.entering.length, 1);
});

// ------------------------------------------------- screening

test('screening: punteggio nell’intervallo e serie corte scartate', () => {
  const strong = scoreInstrument(syntheticSeries(100, 260, 0.0012, 21).map((row) => row.close), { targetVolPct: [8, 14], benchmarkReturns: [] });
  assert.ok(strong.score >= 0 && strong.score <= 100);
  assert.equal(scoreInstrument([1, 2, 3], { targetVolPct: [8, 14], benchmarkReturns: [] }), null);
});

test('screening: il trend forte batte quello debole', () => {
  const target = { targetVolPct: [8, 20], benchmarkReturns: [] };
  const up = scoreInstrument(syntheticSeries(100, 260, 0.0015, 31).map((row) => row.close), target);
  const down = scoreInstrument(syntheticSeries(100, 260, -0.0015, 31).map((row) => row.close), target);
  assert.ok(up.score > down.score, `${up.score} deve superare ${down.score}`);
});

test('screening: le posizioni aperte entrano sempre in shortlist', () => {
  const bigUniverse = new Map(universe);
  for (let i = 0; i < 12; i += 1) {
    bigUniverse.set(`X${i}`, { symbol: `X${i}`, class: 'etf', maxWeight: 0.3, instrumentId: 2000 + i, name: `X${i}` });
  }
  const bigCandles = new Map(candles);
  for (let i = 0; i < 12; i += 1) bigCandles.set(`X${i}`, syntheticSeries(50 + i, 260, 0.001, 41 + i));
  const result = buildShortlist({
    universe: bigUniverse, candles: bigCandles, heldSymbols: new Set(['BTC']),
    config: { ...DEFAULT_CONFIG, shortlistSize: 6 }, profile: PROFILES.balanced,
  });
  assert.ok(result.shortlist.some((item) => item.symbol === 'BTC'), 'BTC è in portafoglio e deve restare valutabile');
  assert.ok(result.shortlist.length <= 7);
});

// ------------------------------------------------- watcher

test('watcher: stabilizzazione riconosciuta solo senza nuovi minimi', () => {
  assert.equal(isStabilized([...Array(10).fill(100), 90, 80, 70], 2), false);
  assert.equal(isStabilized([...Array(10).fill(100), 80, 81, 82], 2), true);
});

test('watcher: un crollo giornaliero genera un’anomalia', () => {
  const series = syntheticSeries(100, 200, 0.0002, 5);
  series.push({ at: '2026-08-25', close: series[series.length - 1].close * 0.88 });
  const anomalies = detectAnomalies({
    universe: new Map([['NVDA', { symbol: 'NVDA', class: 'stock', maxWeight: 0.2, instrumentId: 999, name: 'NVIDIA' }]]),
    candles: new Map([['NVDA', series]]),
    features: { instruments: [] },
    config: DEFAULT_CONFIG,
  });
  assert.ok(anomalies.some((item) => item.kind === 'crash'));
});

test('watcher: non compra durante il movimento', () => {
  const decision = decideWatcherAction({
    anomaly: { symbol: 'NVDA', kind: 'crash', held: false, metrics: { stabilized: false } },
    verdict: { classification: 'technical_overreaction', confidence: 0.9, suggestedAction: 'accumulate' },
    config: DEFAULT_CONFIG, ledger: new Map(), budgetUsd: 500, opportunisticThisWeek: 0, equityUsd: 1000,
  });
  assert.equal(decision.action, 'noop');
  assert.match(decision.reason, /stabilizzazione/);
});

test('watcher: non compra su rottura strutturale', () => {
  const decision = decideWatcherAction({
    anomaly: { symbol: 'NVDA', kind: 'crash', held: false, metrics: { stabilized: true } },
    verdict: { classification: 'structural_break', confidence: 0.95, suggestedAction: 'avoid' },
    config: DEFAULT_CONFIG, ledger: new Map(), budgetUsd: 500, opportunisticThisWeek: 0, equityUsd: 1000,
  });
  assert.equal(decision.action, 'noop');
});

test('watcher: confidence bassa non è operativa', () => {
  const decision = decideWatcherAction({
    anomaly: { symbol: 'NVDA', kind: 'crash', held: false, metrics: { stabilized: true } },
    verdict: { classification: 'technical_overreaction', confidence: 0.4, suggestedAction: 'accumulate' },
    config: DEFAULT_CONFIG, ledger: new Map(), budgetUsd: 500, opportunisticThisWeek: 0, equityUsd: 1000,
  });
  assert.equal(decision.action, 'noop');
  assert.match(decision.reason, /confidence/);
});

test('watcher: acquisto ammesso solo con tutte le condizioni soddisfatte', () => {
  const config = { ...DEFAULT_CONFIG, opportunisticBudgetPct: 0.1, maxOpportunisticPerWeek: 1, minOrderUsd: 10 };
  const decision = decideWatcherAction({
    anomaly: { symbol: 'NVDA', kind: 'crash', held: false, metrics: { stabilized: true } },
    verdict: { classification: 'technical_overreaction', confidence: 0.85, suggestedAction: 'accumulate' },
    config, ledger: new Map(), budgetUsd: 200, opportunisticThisWeek: 0, equityUsd: 2000,
  });
  assert.equal(decision.action, 'buy');
  assert.ok(decision.amountUsd >= config.minOrderUsd && decision.amountUsd <= config.maxOrderUsd);
});

test('watcher: tetto settimanale rispettato', () => {
  const decision = decideWatcherAction({
    anomaly: { symbol: 'NVDA', kind: 'crash', held: false, metrics: { stabilized: true } },
    verdict: { classification: 'technical_overreaction', confidence: 0.85, suggestedAction: 'accumulate' },
    config: { ...DEFAULT_CONFIG, maxOpportunisticPerWeek: 1 }, ledger: new Map(),
    budgetUsd: 500, opportunisticThisWeek: 1, equityUsd: 2000,
  });
  assert.equal(decision.action, 'noop');
  assert.match(decision.reason, /questa settimana/);
});

test('watcher: non apre una nuova posizione oltre il tetto del portafoglio', () => {
  const decision = decideWatcherAction({
    anomaly: { symbol: 'NVDA', class: 'stock', kind: 'crash', held: false, metrics: { stabilized: true } },
    verdict: { classification: 'technical_overreaction', confidence: 0.85, suggestedAction: 'accumulate' },
    config: { ...DEFAULT_CONFIG, maxHoldings: 20 }, ledger: new Map(),
    budgetUsd: 500, opportunisticThisWeek: 0, equityUsd: 2_000, holdingCount: 20,
  });
  assert.equal(decision.action, 'noop');
  assert.match(decision.reason, /massimo di 20 posizioni/);
});

test('watcher: le notizie vengono filtrate sullo strumento', () => {
  const news = { items: [
    { title: 'NVIDIA beats earnings expectations', score: 1, topic: 'markets' },
    { title: 'Oil prices steady in Asia', score: 0, topic: 'markets' },
  ] };
  const picked = relevantHeadlines({ symbol: 'NVDA', name: 'NVIDIA Corporation' }, news, 5);
  assert.equal(picked[0].title, 'NVIDIA beats earnings expectations');
});

// ------------------------------------------------- validator con nuove regole

test('validator: il periodo minimo di detenzione blocca la vendita', () => {
  const ledger = new Map(features.instruments.map((item) => [item.symbol, { symbol: item.symbol, last_bought_at: Date.now() - DAY }]));
  const proposal = { targetWeights: { SPY: 0.1, GLD: 0.2, CASH: 0.7 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const { plan, violations } = validateProposal({ proposal, features, config, ledger });
  assert.ok(violations.some((item) => item.code === 'churn'));
  assert.equal(plan.orders.filter((order) => order.side === 'sell' && order.symbol === 'SPY').length, 0);
});

test('validator: il numero massimo di posizioni viene rispettato', () => {
  const proposal = { targetWeights: { SPY: 0.3, GLD: 0.3, BTC: 0.2, CASH: 0.2 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const { plan, violations } = validateProposal({ proposal, features, config: { ...config, maxHoldings: 2 } });
  const invested = Object.entries(plan.targets).filter(([symbol, weight]) => symbol !== 'CASH' && weight > 0.001);
  assert.ok(invested.length <= 2);
  assert.ok(violations.some((item) => item.code === 'max_holdings'));
});

test('validator: il numero minimo di posizioni è un vincolo bloccante', () => {
  const proposal = { targetWeights: { SPY: 0.8, CASH: 0.2 }, confidence: 0.9, rationale: '', risks: [], watch: [] };
  const result = validateProposal({ proposal, features, config: { ...config, minHoldings: 4 } });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.code === 'min_holdings' && item.severity === 'blocking'));
});

test('reconcile: confronta gli ordini scalati, non il target teorico', async () => {
  const plan = {
    equityUsd: 1_000,
    deltas: [{
      symbol: 'SPY', instrumentId: 1001, currentWeight: 0.2,
      targetWeight: 0.5, skipped: null,
    }],
    // Il cap di turnover ha consentito solo 100 USD dei 300 USD teorici.
    orders: [{ symbol: 'SPY', instrumentId: 1001, side: 'buy', amountUsd: 100 }],
  };
  const result = await reconcile({
    client: { portfolio: async () => ({ equityUsd: 1_000, positions: [{ instrumentId: 1001, valueUsd: 300 }] }) },
    plan,
    config: { reconcileTolerancePct: 0.01 },
    portfolioUserKey: 'verified-agent-portfolio',
  });
  assert.equal(result.rows[0].expectedWeight, 0.3);
  assert.equal(result.rows[0].actualWeight, 0.3);
  assert.equal(result.ok, true);
});

test('executor: qualunque modalità non esatta fallisce senza ordini', async () => {
  for (const mode of [undefined, 'garbage', 'live ', 'LIVE']) {
    let calls = 0;
    const result = await executePlan({
      db: null,
      client: {
        eligibility: async () => { calls += 1; return new Map(); },
        openOrder: async () => { calls += 1; return {}; },
      },
      runId: 'invalid-mode',
      plan: { orders: [{ seq: 0, symbol: 'SPY', instrumentId: 1001, side: 'buy', amountUsd: 100 }] },
      mode,
      config: DEFAULT_CONFIG,
    });
    assert.equal(calls, 0, `nessuna chiamata per mode=${String(mode)}`);
    assert.equal(result.blocked, true);
    assert.equal(result.executed, false);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} test superati`);
process.exit(failed ? 1 : 0);
