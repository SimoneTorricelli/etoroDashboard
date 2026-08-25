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
  const permissive = { ...config, whitelist: config.whitelist.map((item) => ({ ...item, maxWeight: 1 })), maxWeightPerClass: { etf: 1, bond: 1, commodity: 1, crypto: 1, cash: 1 } };
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

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} test superati`);
process.exit(failed ? 1 : 0);
