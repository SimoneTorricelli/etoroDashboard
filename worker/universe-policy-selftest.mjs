import assert from 'node:assert/strict';
import { buildSafeStrategySpec } from './lib/strategy.js';
import {
  POLICY_CANDIDATE_CATALOG,
  buildPolicyUniverse,
  mergeHeldEntries,
  rankPolicyUniverse,
} from './lib/universe-policy.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const clone = (value) => JSON.parse(JSON.stringify(value));

const baseAnswers = {
  schemaVersion: 1,
  objective: 'balanced-growth',
  styles: ['broad-market', 'quality'],
  horizonMonths: 60,
  risk: { level: 'moderate', maxAcceptableDrawdownPct: 20 },
  capital: { budgetMode: 'budget-envelope', budgetEur: 5000, targetDeploymentPct: 97 },
  diversification: { preferredPositions: 14, maxPositions: 20 },
  sectors: { include: [], prefer: [], exclude: [] },
  themes: { include: [], prefer: [], exclude: [] },
  assetClasses: ['etf', 'stock', 'bond', 'commodity', 'crypto'],
  crypto: { enabled: true, tiers: ['large-cap', 'mid-cap', 'small-cap'], allowMeme: false, maxWeightPct: 12 },
  cash: { reserveFloorPct: 2, allowTemporaryIntent: true, temporaryMaxPct: 15, temporaryMaxDays: 30 },
  execution: { cadence: 'weekly', turnoverTolerance: 'moderate', minOrderEur: 10, maxOrderPctOfCapital: 20 },
};

function makeSpec(mutator = () => {}) {
  const spec = clone(buildSafeStrategySpec(baseAnswers));
  mutator(spec);
  return spec;
}

test('catalogo ampio, diversificato e immutabile', () => {
  assert.ok(POLICY_CANDIDATE_CATALOG.length >= 90);
  assert.equal(Object.isFrozen(POLICY_CANDIDATE_CATALOG), true);
  assert.equal(new Set(POLICY_CANDIDATE_CATALOG.map((entry) => entry.symbol)).size, POLICY_CANDIDATE_CATALOG.length);
  assert.deepEqual(new Set(POLICY_CANDIDATE_CATALOG.map((entry) => entry.class)), new Set(['etf', 'stock', 'bond', 'commodity', 'crypto']));
});

test('universo predefinito supera 20 candidati e rappresenta tutte le classi consentite', () => {
  const universe = buildPolicyUniverse(makeSpec());
  assert.ok(universe.length > 20);
  assert.deepEqual(new Set(universe.map((entry) => entry.class)), new Set(['etf', 'stock', 'bond', 'commodity', 'crypto']));
  assert.ok(new Set(universe.map((entry) => entry.sector).filter(Boolean)).size >= 6);
  assert.ok(universe.every((entry) => entry.requiresAvailabilityResolution && entry.policyStatus === 'candidate-unverified'));
});

test('risultato deterministico senza mutare StrategySpec', () => {
  const spec = makeSpec();
  const before = clone(spec);
  const first = buildPolicyUniverse(spec, { limit: 27 });
  const second = buildPolicyUniverse(spec, { limit: 27 });
  assert.deepEqual(first, second);
  assert.deepEqual(spec, before);
});

test('meme coin vietate salvo opt-in esplicito', () => {
  const blocked = rankPolicyUniverse(makeSpec());
  assert.equal(blocked.some((entry) => entry.meme), false);

  const allowed = rankPolicyUniverse(makeSpec((spec) => { spec.universePolicy.crypto.allowMeme = true; }));
  const memes = allowed.filter((entry) => entry.meme).map((entry) => entry.symbol);
  assert.ok(memes.includes('DOGE'));
  assert.ok(memes.includes('SHIB'));
  assert.ok(memes.includes('PEPE'));
});

test('fasce crypto sono un filtro hard', () => {
  const largeOnly = rankPolicyUniverse(makeSpec((spec) => { spec.universePolicy.crypto.tiers = ['large-cap']; }))
    .filter((entry) => entry.class === 'crypto');
  assert.ok(largeOnly.length >= 3);
  assert.ok(largeOnly.every((entry) => entry.cryptoTier === 'large-cap'));
  assert.equal(largeOnly.some((entry) => ['ADA', 'LINK', 'UNI'].includes(entry.symbol)), false);

  const midOnly = rankPolicyUniverse(makeSpec((spec) => { spec.universePolicy.crypto.tiers = ['mid-cap']; }))
    .filter((entry) => entry.class === 'crypto');
  assert.ok(midOnly.length >= 4);
  assert.ok(midOnly.every((entry) => entry.cryptoTier === 'mid-cap' && !entry.meme));
});

test('disabilitare crypto o una classe con cap zero la rimuove completamente', () => {
  const spec = makeSpec((value) => {
    value.universePolicy.crypto = { enabled: false, tiers: [], allowMeme: false, maxWeightPct: 0 };
    value.universePolicy.assetClasses = value.universePolicy.assetClasses.filter((item) => item !== 'crypto');
    value.universePolicy.assetClassCapsPct.crypto = 0;
    value.universePolicy.assetClassCapsPct.stock = 0;
  });
  const universe = rankPolicyUniverse(spec);
  assert.equal(universe.some((entry) => entry.class === 'crypto'), false);
  assert.equal(universe.some((entry) => entry.class === 'stock'), false);
});

test('esclusioni settore e tema prevalgono su ranking e preferenze', () => {
  const spec = makeSpec((value) => {
    value.universePolicy.sectors.prefer = ['technology'];
    value.universePolicy.sectors.exclude = ['technology'];
    value.universePolicy.themes.prefer = ['semiconductors'];
    value.universePolicy.themes.exclude = ['semiconductors'];
  });
  const universe = rankPolicyUniverse(spec);
  assert.ok(universe.length > 20);
  assert.equal(universe.some((entry) => entry.sector === 'technology'), false);
  assert.equal(universe.some((entry) => entry.themes.includes('semiconductors')), false);
  assert.equal(universe.some((entry) => ['NVDA', 'SMH', 'SOXX'].includes(entry.symbol)), false);
});

test('include filtra gli elementi tassonomicamente applicabili e prefer ordina', () => {
  const spec = makeSpec((value) => {
    value.universePolicy.sectors.include = ['healthcare'];
    value.universePolicy.themes.include = ['healthcare-innovation'];
    value.universePolicy.sectors.prefer = ['healthcare'];
  });
  const universe = rankPolicyUniverse(spec);
  const sectorSpecific = universe.filter((entry) => entry.sector);
  const themeTagged = universe.filter((entry) => entry.themes.length);
  assert.ok(sectorSpecific.length >= 5);
  assert.ok(sectorSpecific.every((entry) => entry.sector === 'healthcare'));
  assert.ok(themeTagged.every((entry) => entry.themes.includes('healthcare-innovation')));
  assert.equal(universe[0].sector, 'healthcare');
});

test('cap di classe, cap crypto e cap per strumento limitano maxWeight', () => {
  const spec = makeSpec((value) => {
    value.diversification.maxInstrumentWeightPct = 7;
    value.universePolicy.assetClassCapsPct.etf = 5;
    value.universePolicy.assetClassCapsPct.crypto = 4;
    value.universePolicy.crypto.maxWeightPct = 3;
  });
  const universe = rankPolicyUniverse(spec);
  assert.ok(universe.every((entry) => entry.maxWeight <= 0.07));
  assert.ok(universe.filter((entry) => entry.class === 'etf').every((entry) => entry.maxWeight <= 0.05));
  assert.ok(universe.filter((entry) => entry.class === 'crypto').every((entry) => entry.maxWeight <= 0.03));
  assert.ok(universe.every((entry) => Math.abs(entry.maxWeight * 100 - entry.maxWeightPct) < 1e-9));
});

test('shortlist limitata mantiene diversità e copertura delle preferenze', () => {
  const spec = makeSpec((value) => {
    value.universePolicy.sectors.prefer = ['technology', 'healthcare', 'industrials'];
    value.universePolicy.themes.prefer = ['artificial-intelligence', 'infrastructure'];
  });
  const universe = buildPolicyUniverse(spec, { limit: 24 });
  assert.equal(universe.length, 24);
  assert.deepEqual(new Set(universe.map((entry) => entry.class)), new Set(['etf', 'stock', 'bond', 'commodity', 'crypto']));
  assert.ok(['technology', 'healthcare', 'industrials'].every((sector) => universe.some((entry) => entry.sector === sector)));
  assert.ok(['artificial-intelligence', 'infrastructure'].every((theme) => universe.some((entry) => entry.themes.includes(theme))));
});

test('holding fuori policy resta visibile ma sell-only', () => {
  const policyEntries = buildPolicyUniverse(makeSpec((value) => {
    value.universePolicy.sectors.exclude = ['technology'];
  }), { limit: 24 });
  const before = clone(policyEntries);
  const merged = mergeHeldEntries(policyEntries, [
    { symbol: 'nvda', name: 'NVIDIA', class: 'stock', instrumentId: 42 },
    { symbol: policyEntries[0].symbol, instrumentId: 9 },
  ]);
  const outside = merged.find((entry) => entry.symbol === 'NVDA');
  assert.equal(outside.held, true);
  assert.equal(outside.sellOnly, true);
  assert.equal(outside.buyEligible, false);
  assert.equal(outside.maxWeight, 0);
  assert.equal(outside.outsidePolicy, true);
  assert.equal(merged.filter((entry) => entry.symbol === policyEntries[0].symbol).length, 1);
  assert.equal(merged.find((entry) => entry.symbol === policyEntries[0].symbol).held, true);
  assert.deepEqual(policyEntries, before);
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

console.log(`\n${passed}/${tests.length} test universo policy superati.`);
