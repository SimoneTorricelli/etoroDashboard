/**
 * Smoke test del livello deterministico. Non tocca la rete né D1.
 * Esecuzione:  node worker/selftest.mjs
 *
 * Serve a verificare che i guardrail reggano contro proposte malformate o
 * ostili prima di abilitare qualunque modalità operativa.
 */
import assert from 'node:assert/strict';
import { buildFeatures, renderFeaturesPrompt, rsi, maxDrawdown, annualizedVol } from './lib/features.js';
import { clampWeights, collapseEquivalentTargets, validateProposal } from './lib/validator.js';
import {
  askBrain, extractJson, extractJsonResult, findNormalizedProposal, normalizeProposal, prioritizeAlternativeProvider,
  prioritizeUntriedPlan, selectDiverseAttemptPlan,
} from './lib/brain.js';
import {
  acquirePipelineLock, armLiveIfUnchanged, DEFAULT_CONFIG, findLiveRecoveryBarrier,
  finishRunIfLiveFence, listStalePreArmActivations, mutateSafetyConfig, releasePipelineLock, renewPipelineLock,
} from './lib/db.js';
import { PROFILES, applyProfile, describeProfile, listProfiles } from './lib/profiles.js';
import { checkChurnRules, filterMarginalSubstitutions, isWorthTheCost } from './lib/churn.js';
import { buildShortlist, scoreInstrument } from './lib/screening.js';
import { decideWatcherAction, detectAnomalies, isStabilized, relevantHeadlines } from './lib/watcher.js';
import { executePlan, reconcile } from './lib/executor.js';
import {
  LIVE_DRY_RUN_TTL_MS,
  buildDecisionContext,
  classifyDryRunForReuse,
  comparePortfolioForReuse,
  isDecisionConfigPatch,
  LIVE_RECOVERY_CONFIRMATION,
} from './lib/live-plan.js';
import {
  buildAttemptPlan, callModel, extractModelText, listFreeModels, prioritizeReviewPlan,
  llmErrorDebug, safeModelOutputPreview, supportsNativeJson,
} from './lib/llm.js';
import {
  buildCandleRefreshQueue, buildFailedProposalRetryContext, decideKind, romeParts,
  freezeLiveRun, runPipeline, runWatcher, scaleAgentSnapshotToReal, shortlistDeploymentCapacity,
} from './lib/pipeline.js';
import { buildStrategyActivationNotification } from './lib/notify.js';
import { EtoroClient } from './lib/etoro.js';
import { serveStaticAsset } from './index.js';
import {
  applyGuidedGuardrailsWithChanges, handleAgentApi, sanitizeConfigPatch, validateReviewArithmetic,
} from './lib/api.js';
import { buildSafeStrategySpec, createDefaultOnboardingAnswers } from './lib/strategy.js';

const DAY = 24 * 60 * 60 * 1000;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('live-plan: la dry-run scade esattamente dopo due ore', () => {
  const now = 1_800_000_000_000;
  const context = {
    decisionRevision: 7,
    decisionHash: 'decision-hash',
    bindingHash: 'binding-hash',
  };
  const row = {
    status: 'ok',
    finished_at: now - 1,
    artifact_source_run_id: 'dry-run-1',
    consumed_at: null,
    expires_at: now + 1,
    decision_revision: 7,
    decision_hash: 'decision-hash',
    binding_hash: 'binding-hash',
    validation_ok: 1,
  };

  assert.equal(LIVE_DRY_RUN_TTL_MS, 2 * 60 * 60 * 1000);
  assert.deepEqual(classifyDryRunForReuse(row, context, now), { reusable: true, reason: 'fresh' });
  assert.deepEqual(
    classifyDryRunForReuse({ ...row, expires_at: now }, context, now),
    { reusable: false, reason: 'expired' },
  );
});

test('live-plan: modalità e orario non cambiano il fingerprint, la cadenza sì', async () => {
  const base = {
    ...DEFAULT_CONFIG,
    decisionRevision: 11,
    strategySpec: { objective: 'crescita prudente', version: 1 },
    activeAgentPortfolioId: 'portfolio-a',
    agentTokenFingerprint: 'fingerprint-a',
    agentTokenVerifiedAt: 1_800_000_000_000,
  };
  const operationalOnly = {
    ...base,
    executionMode: 'live',
    frozen: true,
    frozenReason: 'stop manuale',
    rebalanceWeekday: 5,
    rebalanceDayOfMonth: 23,
    rebalanceHour: 17,
    rebalanceMinute: 45,
    snapshotHours: [7, 19],
  };

  assert.deepEqual(await buildDecisionContext(operationalOnly), await buildDecisionContext(base));
  assert.equal(isDecisionConfigPatch({ executionMode: 'live' }), false);
  assert.equal(isDecisionConfigPatch({ rebalanceDayOfMonth: 23 }), false);
  assert.notDeepEqual(
    await buildDecisionContext({ ...base, cadence: 'monthly' }),
    await buildDecisionContext(base),
  );
  assert.equal(isDecisionConfigPatch({ cadence: 'monthly' }), true);
});

test('live-plan: strategia, guardrail e binding invalidano la decisione', async () => {
  const base = {
    ...DEFAULT_CONFIG,
    decisionRevision: 3,
    strategySpec: { objective: 'balanced', version: 1 },
    activeAgentPortfolioId: 'portfolio-a',
    agentTokenFingerprint: 'fingerprint-a',
    agentTokenVerifiedAt: 1_800_000_000_000,
  };
  const baseline = await buildDecisionContext(base);
  const strategyChanged = await buildDecisionContext({
    ...base,
    strategySpec: { objective: 'defensive', version: 2 },
  });
  const guardrailChanged = await buildDecisionContext({
    ...base,
    maxTurnoverPct: Number(base.maxTurnoverPct) + 0.01,
  });
  const bindingChanged = await buildDecisionContext({
    ...base,
    activeAgentPortfolioId: 'portfolio-b',
    agentTokenFingerprint: 'fingerprint-b',
  });

  assert.notEqual(strategyChanged.decisionHash, baseline.decisionHash);
  assert.notEqual(guardrailChanged.decisionHash, baseline.decisionHash);
  assert.notEqual(bindingChanged.bindingHash, baseline.bindingHash);
  assert.equal(isDecisionConfigPatch({ strategySpec: strategyChanged }), true);
  assert.equal(isDecisionConfigPatch({ maxTurnoverPct: 0.2 }), true);
  assert.equal(isDecisionConfigPatch({ activeAgentPortfolioId: 'portfolio-b' }), true);
});

test('live-plan: riusa solo un portfolio materialmente equivalente', () => {
  const sourceBundle = {
    snapshot: {
      equity_usd: 1_000,
      cash_usd: 100,
      positions: [
        { instrumentId: 101, valueUsd: 500 },
        { instrumentId: 102, valueUsd: 400 },
      ],
    },
    features: { portfolio: { executionScale: 1 } },
  };
  const compatible = {
    equityUsd: 1_020,
    cashUsd: 110,
    executionScale: 1,
    positions: [
      { instrument_id: 101, value_usd: 510 },
      { instrument_id: 102, value_usd: 400 },
    ],
  };
  const config = { minOrderUsd: 10, minRebalanceBandAbs: 0.03 };

  assert.deepEqual(comparePortfolioForReuse(sourceBundle, compatible, config), { ok: true, reason: '' });
  assert.match(
    comparePortfolioForReuse(sourceBundle, { ...compatible, equityUsd: 1_051 }, config).reason,
    /capitale variato oltre il 5%/,
  );
  assert.match(
    comparePortfolioForReuse(sourceBundle, {
      ...compatible,
      positions: [{ instrumentId: 101, valueUsd: 510 }, { instrumentId: 103, valueUsd: 400 }],
    }, config).reason,
    /composizione del portfolio modificata/,
  );
  assert.match(
    comparePortfolioForReuse(sourceBundle, {
      equityUsd: 1_000,
      cashUsd: 100,
      executionScale: 1,
      positions: [{ instrumentId: 101, valueUsd: 550 }, { instrumentId: 102, valueUsd: 350 }],
    }, config).reason,
    /peso dello strumento 101 variato oltre la tolleranza/,
  );
  assert.match(
    comparePortfolioForReuse(sourceBundle, { ...compatible, equityUsd: 1_000, cashUsd: 130 }, config).reason,
    /liquidità del portfolio modificata/,
  );
  assert.match(
    comparePortfolioForReuse(sourceBundle, { ...compatible, executionScale: 1.03 }, config).reason,
    /scala di esecuzione Agent modificata/,
  );
});

function createSafetyDb(initialConfig = {}, {
  safetyReads = [], pipelineLock = null, mutationFailures = 0, orderWriteFailures = [],
} = {}) {
  const state = {
    config: { ...DEFAULT_CONFIG, ...initialConfig },
    configReads: 0,
    mutationQueries: [],
    orders: new Map(),
    audits: [],
    pipelineLock: pipelineLock ? { ...pipelineLock } : null,
    vaultValue: null,
    vaultUpdatedAt: 0,
    runs: new Map(),
    runStarts: 0,
    finishedRuns: [],
    mutationFailures,
    orderWrites: 0,
    orderWriteFailures: new Set(orderWriteFailures),
  };
  const db = {
    state,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.startsWith('INSERT INTO pipeline_lock')) {
            const [lockKey, ownerId, acquiredAt, leaseUntil] = this.args;
            const current = state.pipelineLock;
            if (!current || current.lease_until <= acquiredAt || current.owner_id === ownerId) {
              state.pipelineLock = {
                lock_key: lockKey,
                owner_id: ownerId,
                acquired_at: acquiredAt,
                lease_until: leaseUntil,
              };
              return { ...state.pipelineLock };
            }
            return null;
          }
          if (sql.startsWith('SELECT owner_id, acquired_at, lease_until FROM pipeline_lock')) {
            return state.pipelineLock ? { ...state.pipelineLock } : null;
          }
          if (sql.startsWith('UPDATE pipeline_lock')) {
            const [leaseUntil, lockKey, ownerId, renewedAt] = this.args;
            if (state.pipelineLock?.lock_key === lockKey
              && state.pipelineLock.owner_id === ownerId
              && state.pipelineLock.lease_until > renewedAt) {
              state.pipelineLock.lease_until = leaseUntil;
              return { owner_id: ownerId, lease_until: leaseUntil };
            }
            return null;
          }
          if (sql.startsWith('DELETE FROM pipeline_lock')) {
            const [lockKey, ownerId] = this.args;
            if (state.pipelineLock?.lock_key === lockKey && state.pipelineLock.owner_id === ownerId) {
              state.pipelineLock = null;
              return { owner_id: ownerId };
            }
            return null;
          }
          if (sql.startsWith('INSERT INTO config') && sql.includes('RETURNING value, updated_at')) {
            const [, value, nextUpdatedAt,,, expectedExists,, expectedValue, expectedUpdatedAt] = this.args;
            const exists = state.vaultValue != null;
            if (exists !== Boolean(expectedExists)) return null;
            if (exists && (state.vaultValue !== expectedValue || state.vaultUpdatedAt !== expectedUpdatedAt)) return null;
            state.vaultValue = value;
            state.vaultUpdatedAt = nextUpdatedAt;
            return { value, updated_at: nextUpdatedAt };
          }
          if (sql.startsWith('UPDATE config') && sql.includes('recoveryRequired":false') && sql.includes('RETURNING value')) {
            const [,, expectedSafetyRevision, recoveryConfirmed] = this.args;
            if (
              !state.config.frozen
              || Number(state.config.safetyRevision) !== Number(expectedSafetyRevision)
              || (state.config.recoveryRequired && recoveryConfirmed !== 1)
            ) return null;
            state.config = {
              ...state.config,
              executionMode: 'shadow',
              frozen: false,
              frozenReason: '',
              recoveryRequired: false,
              recoveryReason: '',
              recoveryRunIds: [],
              recoveryUpdatedAt: 0,
              safetyRevision: Number(state.config.safetyRevision ?? 0) + 1,
            };
            state.mutationQueries.push({ sql, args: this.args });
            return { value: JSON.stringify(state.config) };
          }
          if (sql.startsWith('UPDATE config') && sql.includes('RETURNING value')) {
            const [,, expectedMode, expectedSafetyRevision, expectedDecisionRevision, portfolioId, fingerprint, verifiedAt] = this.args;
            if (
              state.config.frozen
              || state.config.recoveryRequired
              || state.config.executionMode !== expectedMode
              || Number(state.config.safetyRevision) !== Number(expectedSafetyRevision)
              || Number(state.config.decisionRevision) !== Number(expectedDecisionRevision)
              || String(state.config.activeAgentPortfolioId ?? '') !== String(portfolioId)
              || String(state.config.agentTokenFingerprint ?? '') !== String(fingerprint)
              || Number(state.config.agentTokenVerifiedAt ?? 0) !== Number(verifiedAt)
            ) return null;
            state.config = {
              ...state.config,
              executionMode: 'live',
              safetyRevision: Number(state.config.safetyRevision ?? 0) + 1,
            };
            state.mutationQueries.push({ sql, args: this.args });
            return { value: JSON.stringify(state.config) };
          }
          if (sql.includes('json_patch') && sql.includes('RETURNING value')) {
            if (state.mutationFailures > 0) {
              state.mutationFailures -= 1;
              throw new Error('D1 mutazione non disponibile');
            }
            const patch = JSON.parse(this.args[2]);
            state.config = {
              ...state.config,
              ...patch,
              safetyRevision: Number(state.config.safetyRevision ?? 0) + 1,
            };
            state.mutationQueries.push({ sql, args: this.args });
            return { value: JSON.stringify(state.config) };
          }
          if (sql.startsWith('SELECT value') && sql.includes('FROM config')) {
            if (this.args[0] === 'vault') {
              return state.vaultValue == null ? null : { value: state.vaultValue, updated_at: state.vaultUpdatedAt };
            }
            const planned = safetyReads[state.configReads];
            state.configReads += 1;
            if (planned instanceof Error) throw planned;
            if (planned) state.config = { ...state.config, ...planned };
            return { value: JSON.stringify(state.config) };
          }
          if (sql.startsWith('SELECT * FROM orders WHERE id = ?')) {
            return state.orders.get(this.args[0]) ?? null;
          }
          if (sql.startsWith('UPDATE runs') && sql.includes("status = 'ok'") && sql.includes('AND EXISTS')) {
            const [, equityUsd, runId,, expectedSafetyRevision, expectedDecisionRevision,
              portfolioId, fingerprint, verifiedAt] = this.args;
            const fenceMatches = state.config.executionMode === 'live'
              && !state.config.frozen
              && !state.config.recoveryRequired
              && Number(state.config.safetyRevision) === Number(expectedSafetyRevision)
              && Number(state.config.decisionRevision) === Number(expectedDecisionRevision)
              && String(state.config.activeAgentPortfolioId ?? '') === String(portfolioId)
              && String(state.config.agentTokenFingerprint ?? '') === String(fingerprint)
              && Number(state.config.agentTokenVerifiedAt ?? 0) === Number(verifiedAt);
            if (state.runs.get(runId) !== 'running' || !fenceMatches) return null;
            state.runs.set(runId, 'ok');
            state.finishedRuns.push({ status: 'ok', equityUsd, runId });
            return { id: runId };
          }
          if (sql.startsWith('UPDATE runs SET finished_at')) {
            state.finishedRuns.push({
              finishedAt: this.args[0],
              status: this.args[1],
              equityUsd: this.args[2],
              error: this.args[3],
              runId: this.args[4],
            });
            return { id: this.args[4], status: this.args[1] };
          }
          throw new Error(`first() non gestito nel fake D1: ${sql.slice(0, 80)}`);
        },
        async run() {
          if (sql.startsWith('INSERT INTO config') && this.args[0] === 'vault') {
            state.vaultValue = this.args[1];
            state.vaultUpdatedAt = this.args[2];
            return { success: true, meta: { changes: 1 }, results: [] };
          }
          if (sql.startsWith('INSERT INTO orders')) {
            state.orderWrites += 1;
            if (state.orderWriteFailures.has(state.orderWrites)) {
              throw new Error(`D1 ordine non disponibile alla scrittura ${state.orderWrites}`);
            }
            const [
              id, runId, seq, createdAt, updatedAt, symbol, instrumentId, side,
              amountUsd, positionId, mode, orderState, etoroOrderId, positionIds,
              filledUsd, message,
            ] = this.args;
            const previous = state.orders.get(id) ?? {};
            state.orders.set(id, {
              ...previous,
              id,
              run_id: runId,
              runId,
              seq,
              created_at: previous.created_at ?? createdAt,
              updated_at: updatedAt,
              symbol,
              instrument_id: instrumentId,
              instrumentId,
              side,
              amount_usd: amountUsd,
              amountUsd,
              position_id: positionId,
              positionId,
              mode,
              state: orderState,
              etoro_order_id: etoroOrderId,
              etoroOrderId,
              position_ids: positionIds,
              filled_usd: filledUsd,
              filledUsd,
              message,
            });
            return { success: true, meta: { changes: 1 }, results: [] };
          }
          if (sql.startsWith('INSERT INTO audit')) {
            state.audits.push(this.args);
            return { success: true, meta: { changes: 1 }, results: [] };
          }
          if (sql.startsWith('INSERT INTO runs')) {
            state.runStarts += 1;
            state.runs.set(this.args[0], 'running');
            return { success: true, meta: { changes: 1 }, results: [] };
          }
          if (sql.startsWith('UPDATE runs SET finished_at')) {
            state.finishedRuns.push({
              finishedAt: this.args[0],
              status: this.args[1],
              equityUsd: this.args[2],
              error: this.args[3],
              runId: this.args[4],
            });
            return { success: true, meta: { changes: 1 }, results: [] };
          }
          throw new Error(`run() non gestito nel fake D1: ${sql.slice(0, 80)}`);
        },
      };
    },
  };
  return db;
}

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
  ['SPY', { symbol: 'SPY', class: 'etf', sector: null, maxWeight: 0.4, instrumentId: 1001, name: 'SPY' }],
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

test('scheduler: il rebalance scatta soltanto al quarto d’ora configurato', () => {
  const weekly = {
    ...DEFAULT_CONFIG,
    cadence: 'weekly',
    rebalanceWeekday: 1,
    rebalanceHour: 9,
    rebalanceMinute: 30,
    snapshotHours: [8, 9],
  };
  assert.equal(decideKind(weekly, { weekday: 1, day: 24, hour: 9, minute: 30, fold: 0 }), 'rebalance');
  assert.equal(decideKind(weekly, { weekday: 1, day: 24, hour: 9, minute: 15, fold: 0 }), null);
  assert.equal(decideKind(weekly, { weekday: 1, day: 24, hour: 9, minute: 45, fold: 0 }), null);
  assert.equal(decideKind(weekly, { weekday: 2, day: 25, hour: 9, minute: 30, fold: 0 }), null);
});

test('scheduler: snapshot e heartbeat partono soltanto al minuto zero', () => {
  const scheduled = { ...DEFAULT_CONFIG, rebalanceHour: 9, rebalanceMinute: 30, snapshotHours: [8] };
  assert.equal(decideKind(scheduled, { weekday: 2, day: 25, hour: 8, minute: 0, fold: 0 }), 'snapshot');
  assert.equal(decideKind(scheduled, { weekday: 2, day: 25, hour: 8, minute: 15, fold: 0 }), null);
  assert.equal(decideKind(scheduled, { weekday: 2, day: 25, hour: 10, minute: 0, fold: 0 }), 'heartbeat');
  assert.equal(decideKind(scheduled, { weekday: 2, day: 25, hour: 10, minute: 45, fold: 0 }), null);
});

test('scheduler: Europe/Rome segue ora legale e sopprime il secondo orario duplicato', () => {
  const beforeSpring = romeParts(new Date('2026-03-29T00:30:00.000Z'));
  const afterSpring = romeParts(new Date('2026-03-29T01:30:00.000Z'));
  assert.deepEqual(
    [beforeSpring.dateKey, beforeSpring.hour, beforeSpring.minute],
    ['2026-03-29', 1, 30],
  );
  assert.deepEqual(
    [afterSpring.dateKey, afterSpring.hour, afterSpring.minute],
    ['2026-03-29', 3, 30],
  );

  const firstAutumn = romeParts(new Date('2026-10-25T00:30:00.000Z'));
  const secondAutumn = romeParts(new Date('2026-10-25T01:30:00.000Z'));
  assert.deepEqual(
    [firstAutumn.dateKey, firstAutumn.hour, firstAutumn.minute, firstAutumn.fold],
    ['2026-10-25', 2, 30, 0],
  );
  assert.deepEqual(
    [secondAutumn.dateKey, secondAutumn.hour, secondAutumn.minute, secondAutumn.fold],
    ['2026-10-25', 2, 30, 1],
  );
  const sundayAtTwoThirty = {
    ...DEFAULT_CONFIG,
    cadence: 'weekly',
    rebalanceWeekday: 7,
    rebalanceHour: 2,
    rebalanceMinute: 30,
  };
  assert.equal(decideKind(sundayAtTwoThirty, firstAutumn), 'rebalance');
  assert.equal(decideKind(sundayAtTwoThirty, secondAutumn), null);
});

test('config: rebalanceMinute accetta soltanto i quarti d’ora del cron', () => {
  for (const minute of [0, 15, 30, 45]) {
    const result = sanitizeConfigPatch({ rebalanceMinute: minute });
    assert.equal(result.patch.rebalanceMinute, minute);
    assert.deepEqual(result.rejected, []);
  }
  for (const minute of [-1, 1, 14, 31, 59, 15.5, 'non valido']) {
    const result = sanitizeConfigPatch({ rebalanceMinute: minute });
    assert.equal(result.patch.rebalanceMinute, undefined);
    assert.ok(result.rejected.some((item) => item.startsWith('rebalanceMinute:')));
  }
});

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

test('feature: aggrega soltanto le esposizioni settoriali dirette', () => {
  assert.deepEqual(features.allocationBySector, {});
});

test('prompt compatto sotto i 6000 caratteri', () => {
  const prompt = renderFeaturesPrompt(features, config);
  assert.ok(prompt.length < 6000, `prompt di ${prompt.length} caratteri`);
  assert.ok(prompt.includes('STRUMENTI'));
  assert.ok(prompt.includes('fascia_capitale='));
  assert.ok(!prompt.includes(`equity=${features.portfolio.equityUsd}`), 'non espone il capitale esatto ai provider AI');
});

test('router AI: ordina globalmente per reasoning, non per provider', () => {
  const plan = buildAttemptPlan({
    config: {
      ...DEFAULT_CONFIG,
      llmProviders: ['workers-ai'],
      llmModels: {
        'workers-ai': ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'workers-legacy'],
        gemini: ['gemini-custom'],
        groq: ['groq-custom'],
        openrouter: ['openrouter/custom'],
      },
    },
    credentials: { geminiApiKey: 'x', groqApiKey: 'x', openrouterApiKey: 'x' },
    env: { AI: {} },
  });
  assert.deepEqual(plan.slice(0, 5).map((entry) => entry.model), [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'z-ai/glm-5.2:free',
    '@cf/openai/gpt-oss-120b',
    'nvidia/nemotron-3-super-120b-a12b:free',
    '@cf/nvidia/nemotron-3-120b-a12b',
  ]);
  assert.ok(plan.findIndex((entry) => entry.model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast') > 4);
  assert.ok(plan.some((entry) => entry.model === 'workers-legacy'));
});

test('router AI: una vecchia preferenza provider non può escludere modelli reasoning migliori', () => {
  const plan = buildAttemptPlan({
    config: {
      ...DEFAULT_CONFIG,
      llmProviders: ['workers-ai'],
      llmFallbackAcrossProviders: false,
      llmModels: { ...DEFAULT_CONFIG.llmModels, openrouter: [] },
    },
    credentials: { openrouterApiKey: 'x' },
    env: { AI: {} },
  });
  assert.equal(plan[0].model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(plan[0].reasoningTier, 'advanced');
});

test('router AI: OpenRouter resta un fallback anche senza modello scelto', () => {
  const plan = buildAttemptPlan({
    config: {
      ...DEFAULT_CONFIG,
      llmProviders: ['workers-ai'],
      llmModels: { ...DEFAULT_CONFIG.llmModels, openrouter: [] },
    },
    credentials: { openrouterApiKey: 'x' },
    env: { AI: {} },
  });
  assert.ok(plan.some((entry) => entry.provider === 'openrouter' && entry.model === 'openrouter/free'));
});

test('router AI: usa solo endpoint OpenRouter gratuiti e mette i reasoning model prima', () => {
  const plan = buildAttemptPlan({
    config: {
      ...DEFAULT_CONFIG,
      llmProviders: ['openrouter'],
      llmFallbackAcrossProviders: false,
      llmModels: { openrouter: ['anthropic/claude-paid', 'thinkingmachines/inkling:free'] },
    },
    credentials: { openrouterApiKey: 'x' },
    env: {},
  });
  assert.equal(plan[0].model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.ok(!plan.some((entry) => entry.model === 'anthropic/claude-paid'));
  assert.ok(plan.some((entry) => entry.model === 'thinkingmachines/inkling:free'));
});

test('router AI: Groq esclude i modelli ritirati anche da configurazioni salvate', () => {
  const plan = buildAttemptPlan({
    config: {
      ...DEFAULT_CONFIG,
      llmModels: { ...DEFAULT_CONFIG.llmModels, groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
    },
    credentials: { groqApiKey: 'x' },
    env: {},
  });
  assert.ok(plan.some((entry) => entry.provider === 'groq' && entry.model === 'openai/gpt-oss-120b'));
  assert.ok(!plan.some((entry) => entry.provider === 'groq' && entry.model.startsWith('llama-3.')));
});

test('router AI: i revisori privilegiano reasoning forte e laboratori diversi', () => {
  const plan = [
    { provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    { provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
    { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
  ];
  const ordered = prioritizeReviewPlan(plan, { provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b' });
  assert.deepEqual(ordered.slice(0, 2).map((entry) => entry.model), [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'z-ai/glm-5.2:free',
  ]);
});

test('router AI: il budget iniziale include provider diversi', () => {
  const diverse = selectDiverseAttemptPlan([
    { provider: 'openrouter', model: 'nvidia/ultra' },
    { provider: 'openrouter', model: 'z-ai/glm' },
    { provider: 'workers-ai', model: '@cf/openai/gpt' },
    { provider: 'openrouter', model: 'nvidia/super' },
    { provider: 'gemini', model: 'gemini-flash' },
    { provider: 'groq', model: 'llama-fast' },
  ], 4);
  assert.deepEqual(diverse.map((entry) => entry.provider), ['openrouter', 'workers-ai', 'gemini', 'groq']);
});

test('router AI: un retry porta davanti le route mai provate', () => {
  const retried = prioritizeUntriedPlan([
    { provider: 'openrouter', model: 'nvidia/ultra' },
    { provider: 'workers-ai', model: '@cf/openai/gpt' },
    { provider: 'gemini', model: 'gemini-flash' },
  ], [
    { provider: 'openrouter', model: 'nvidia/ultra', ok: false },
    { provider: 'workers-ai', model: '@cf/openai/gpt', ok: false },
  ]);
  assert.equal(retried[0].provider, 'gemini');
});

test('catalogo AI: esclude musica e safety anche quando il prezzo token è zero', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Ultra', context_length: 1_000_000, pricing: { prompt: '0', completion: '0' }, architecture: { modality: 'text->text', output_modalities: ['text'] }, supported_parameters: ['reasoning'] },
    { id: 'google/lyria-3-pro-preview', name: 'Lyria', context_length: 1_000_000, pricing: { prompt: '0', completion: '0' }, architecture: { modality: 'text+image->text+audio', output_modalities: ['text', 'audio'] }, supported_parameters: [] },
    { id: 'nvidia/nemotron-3.5-content-safety:free', name: 'Safety', context_length: 128_000, pricing: { prompt: '0', completion: '0' }, architecture: { modality: 'text->text', output_modalities: ['text'] }, supported_parameters: ['reasoning'] },
  ] }), { status: 200 });
  try {
    const models = await listFreeModels('x');
    assert.deepEqual(models.map((model) => model.id), ['nvidia/nemotron-3-ultra-550b-a55b:free']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('revisione strategia: un confronto percentuale falso viene scartato', () => {
  const errors = validateReviewArithmetic({
    summary: 'Il peso massimo per strumento (18%) è leggermente superiore al peso massimo per settore (30%).',
    strengths: [], concerns: [], requiredChanges: [],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /18%.*30%/);
  assert.equal(validateReviewArithmetic({
    summary: 'Il tetto settoriale del 30% è superiore al tetto per asset del 18%.',
    strengths: [], concerns: [], requiredChanges: [],
  }).length, 0);
});

test('revisione strategia: i limiti onboarding sono applicati prima dei revisori e tracciati', () => {
  const answers = createDefaultOnboardingAnswers();
  const spec = buildSafeStrategySpec(answers);
  const synced = applyGuidedGuardrailsWithChanges(spec, {
    maxAssetPct: 12,
    maxSectorPct: 24,
    maxTurnoverPct: 20,
    maxDrawdownPct: 16,
  });
  assert.equal(synced.value.diversification.maxInstrumentWeightPct, 12);
  assert.equal(synced.value.diversification.maxSectorWeightPct, 24);
  assert.ok(synced.changes.some((item) => item.includes('Tetto per asset')));
});

test('guardrail: il tetto settoriale aggrega i ticker con settore noto', () => {
  const violations = [];
  const weights = clampWeights(
    { TECH_A: 0.24, TECH_B: 0.22, CORE: 0.51, CASH: 0.03 },
    {
      instruments: [
        { symbol: 'TECH_A', class: 'stock', sector: 'technology', maxWeight: 0.30 },
        { symbol: 'TECH_B', class: 'stock', sector: 'technology', maxWeight: 0.30 },
        { symbol: 'CORE', class: 'etf', sector: null, maxWeight: 0.70 },
      ],
    },
    {
      maxWeightPerClass: { stock: 1, etf: 1 },
      maxSectorWeightPct: 0.30,
      minCashPct: 0.03,
      maxCashPct: 0.03,
    },
    violations,
  );
  assert.ok(weights.TECH_A + weights.TECH_B <= 0.3001);
  assert.ok(weights.CASH <= 0.0301, 'la cassa eccedente viene riallocata solo dove resta capacità settoriale');
  assert.ok(violations.some((item) => item.code === 'sector_cap'));
});

test('Telegram: riepilogo strategia include allocazione, scenari e guardrail', () => {
  const message = buildStrategyActivationNotification({
    spec: {
      name: 'Dinamico consapevole',
      objective: { description: 'Crescita bilanciata con controllo del rischio' },
      capital: { budgetEur: 200, targetDeploymentPct: 97 },
      risk: { maxDrawdownPct: 24 },
      diversification: { minPositions: 4, maxPositions: 20, maxInstrumentWeightPct: 12, maxSectorWeightPct: 35 },
      execution: { maxTurnoverPct: 28 },
    },
    guided: { macroPreferences: ['global-equities', 'technology'], cryptoPreference: 'majors' },
    draft: {
      strategyName: 'Dinamico consapevole',
      summary: 'Crescita bilanciata',
      shadowDays: 14,
      allocations: [{ label: 'Azioni globali', weightPct: 55 }, { label: 'Liquidità', weightPct: 3 }],
      scenario: { horizonMonths: 12, favorablePct: 18, medianPct: 8, adversePct: -24 },
    },
    portfolioId: '0405bc2a-2bd1-443b-9000-8e6846fe6d10',
    portfolioName: 'Portfolio 0405bc2a',
    collaboration: { status: 'validated', reviewerModels: ['gemini/x', 'openrouter/y'] },
  });
  const text = [message.title, ...message.lines].join('\n');
  assert.match(text, /Capitale reale gestito: 200,00/);
  assert.match(text, /Azioni globali: 55%/);
  assert.match(text, /Favorevole: \+18\.0%/);
  assert.match(text, /Drawdown massimo: −24%/);
  assert.match(text, /validata da 3 modelli/);
  assert.ok(text.length < 3500);
});

test('cache storici: priorità alle posizioni e tetto di refresh', () => {
  const largeUniverse = new Map(Array.from({ length: 12 }, (_, index) => [
    `T${index}`,
    { instrumentId: 3000 + index },
  ]));
  const queue = buildCandleRefreshQueue(largeUniverse, {}, { heldInstrumentIds: [3009], limit: 4, now: 1_000 });
  assert.equal(queue.length, 4);
  assert.equal(queue[0].meta.instrumentId, 3009);
});

test('capitale Agent: i 10.000 tecnici vengono scalati sul mirror reale', () => {
  const managed = scaleAgentSnapshotToReal(
    {
      takenAt: 1, equityUsd: 10_000, cashUsd: 6_000, investedUsd: 4_000,
      positions: [{ positionId: 91, instrumentId: 1001, invested: 4_000, valueUsd: 4_000, grossValueUsd: 4_000, pnlUsd: 0 }],
    },
    {
      takenAt: 2, mirrorId: '77', equityUsd: 428.45, cashUsd: 257.07,
      positions: [{ positionId: 501, instrumentId: 1001, invested: 171.38, valueUsd: 171.38, pnlUsd: 0 }],
    },
  );
  assert.equal(managed.equityUsd, 428.45);
  assert.equal(managed.cashUsd, 257.07);
  assert.equal(managed.positions[0].positionId, 91, 'serve l’ID operativo dell’Agent');
  assert.equal(managed.positions[0].valueUsd, 171.38);
  assert.ok(Math.abs(managed.executionScale - (10_000 / 428.45)) < 1e-6);
});

test('eToro: il mirrorId collega l’Agent Portfolio al capitale reale del proprietario', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/agent-portfolios')) {
      return new Response(JSON.stringify({
        agentPortfolios: [{
          agentPortfolioId: '0405bc2a-2bd1-443b-9000-8e6846fe6d10',
          agentPortfolioName: '0405bc2a',
          agentPortfolioVirtualBalance: 10_000,
          mirrorId: 771,
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      clientPortfolio: {
        Mirrors: [{ MirrorID: 771, AvailableAmount: 428.45, Positions: [] }],
      },
    }), { status: 200 });
  };
  try {
    const client = new EtoroClient({ apiKey: 'api', userKey: 'owner' });
    const remote = (await client.agentPortfolios())[0];
    const real = await client.mirrorPortfolio(remote.mirrorId);
    assert.equal(remote.name, '0405bc2a');
    assert.equal(remote.virtualBalanceUsd, 10_000);
    assert.equal(remote.mirrorId, '771');
    assert.equal(real.equityUsd, 428.45);
    assert.equal(real.source, 'owner-mirror');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('eToro: la chiusura legacy non viene ritentata dopo timeout o errori ambigui', async () => {
  const client = new EtoroClient({ apiKey: 'api', userKey: 'owner', agentToken: 'agent' });
  const calls = [];
  client.request = async (version) => {
    calls.push(version);
    throw new Error('timeout ambiguo');
  };
  await assert.rejects(
    client.closeOrder({ positionId: 42, amountUsd: null, requestId: 'request-1' }),
    /timeout ambiguo/,
  );
  assert.deepEqual(calls, ['v2']);
});

test('eToro: la chiusura legacy è usata solo se v2 dichiara la rotta incompatibile', async () => {
  const client = new EtoroClient({ apiKey: 'api', userKey: 'owner', agentToken: 'agent' });
  const calls = [];
  client.request = async (version) => {
    calls.push(version);
    if (version === 'v2') throw Object.assign(new Error('not found'), { status: 404 });
    return { orderId: 'legacy-order' };
  };
  const result = await client.closeOrder({ positionId: 42, amountUsd: null, requestId: 'request-2' });
  assert.equal(result.orderId, 'legacy-order');
  assert.deepEqual(calls, ['v2', 'v1']);
});

test('readiness: misura la capacità della shortlist entro i cap di classe', () => {
  const shortlist = [
    ...Array.from({ length: 8 }, (_, index) => ({ symbol: `S${index}`, class: 'stock', maxWeight: 0.1 })),
    ...Array.from({ length: 3 }, (_, index) => ({ symbol: `E${index}`, class: 'etf', maxWeight: 0.1 })),
  ];
  const capacity = shortlistDeploymentCapacity(shortlist, {
    maxHoldings: 20,
    maxWeightPerClass: { stock: 0.6, etf: 0.4 },
  });
  assert.ok(Math.abs(capacity - 0.9) < 1e-9);
});

test('asset statici: un fallback HTML su URL JavaScript diventa 404 recuperabile', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('<!doctype html><title>SPA</title>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    },
  };
  const response = await serveStaticAsset(new Request('https://example.test/assets/index-obsoleto.js'), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /Ricarica/i);
});

test('asset statici: i bundle validi mantengono MIME e cache immutabile', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('console.log("ok")', {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      }),
    },
  };
  const response = await serveStaticAsset(new Request('https://example.test/assets/index-corrente.js'), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(response.headers.get('cache-control'), /immutable/);
});

test('readiness: ticker equivalenti contano come una sola capacità di rischio', () => {
  const capacity = shortlistDeploymentCapacity([
    { symbol: 'GLD', class: 'commodity', maxWeight: 0.22 },
    { symbol: 'IAU', class: 'commodity', maxWeight: 0.22 },
    { symbol: 'BND', class: 'bond', maxWeight: 0.35 },
    { symbol: 'AGG', class: 'bond', maxWeight: 0.35 },
  ], {
    maxHoldings: 20,
    maxWeightPerClass: { commodity: 0.5, bond: 0.5 },
  });
  assert.equal(capacity, 0.57);
});

test('costruzione iniziale consolida le esposizioni duplicate sul ticker con score migliore', () => {
  const violations = [];
  const targets = collapseEquivalentTargets(
    { GLD: 0.08, IAU: 0.07, BND: 0.06, AGG: 0.05, CASH: 0.74 },
    {
      portfolio: { openPositions: 0 },
      instruments: [
        { symbol: 'GLD' }, { symbol: 'IAU' }, { symbol: 'BND' }, { symbol: 'AGG' },
      ],
    },
    new Map([['IAU', 70], ['GLD', 60], ['AGG', 55], ['BND', 50]]),
    violations,
  );
  assert.equal(targets.IAU, 0.15);
  assert.equal(targets.GLD, 0);
  assert.equal(targets.AGG, 0.11);
  assert.equal(targets.BND, 0);
  assert.equal(violations.filter((item) => item.code === 'equivalent_exposure').length, 2);
});

test('revisione prova prima un provider diverso da quello del piano bloccato', () => {
  const plan = [
    { provider: 'openrouter', model: 'minimax/minimax-m3:free' },
    { provider: 'openrouter', model: 'openrouter/free' },
    { provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
  ];
  const reordered = prioritizeAlternativeProvider(plan, 'openrouter/minimax/minimax-m3:free');
  assert.deepEqual(reordered.slice(0, 2).map((item) => item.provider), ['workers-ai', 'gemini']);
  assert.equal(reordered.at(-1).model, 'minimax/minimax-m3:free');
});

test('estrazione JSON tollera testo attorno e code fence', () => {
  const parsed = extractJson('Ecco il piano:\n```json\n{"targetWeights":{"SPY":0.5,"CASH":0.5},"confidence":0.7,"rationale":"ok"}\n```\nFine.');
  assert.equal(parsed.confidence, 0.7);
});

test('estrazione JSON salta un primo blocco invalido e conserva il parse error', () => {
  const result = extractJsonResult('bozza {non-json} finale {"targetWeights":{"CASH":1},"confidence":0.4,"rationale":"prudente"}');
  assert.equal(result.error, null);
  assert.equal(result.value.targetWeights.CASH, 1);
  const truncated = extractJsonResult('{"targetWeights":{"CASH":1}');
  assert.equal(truncated.value, null);
  assert.match(truncated.error, /incompleto|troncato/);
});

test('estrazione proposta salta esempi validi e preamboli con graffe tronche', () => {
  const allocation = '{"targetWeights":{"CASH":1},"confidence":0.4,"rationale":"prudente"}';
  const afterExample = findNormalizedProposal(`esempio {"foo":1} risposta ${allocation}`, ['SPY']);
  assert.equal(afterExample.ok, true);
  assert.equal(afterExample.value.targetWeights.CASH, 1);
  const afterBrokenPreamble = findNormalizedProposal(`premessa {mai chiusa risposta ${allocation}`, ['SPY']);
  assert.equal(afterBrokenPreamble.ok, true);
  assert.equal(afterBrokenPreamble.value.targetWeights.CASH, 1);
  const truncatedOuter = findNormalizedProposal('{"targetWeights":{"CASH":1}', ['SPY']);
  assert.equal(truncatedOuter.ok, false);
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

test('GPT-OSS: estrae il testo finale dal formato Responses API', () => {
  const text = extractModelText({
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'ragionamento non operativo' }] },
      { type: 'message', content: [{ type: 'output_text', text: '{"targetWeights":{"SPY":1}}' }] },
    ],
  });
  assert.equal(text, '{"targetWeights":{"SPY":1}}');
});

test('JSON mode: estrae oggetti Workers AI, message.parsed e choices text', () => {
  const allocation = { targetWeights: { SPY: 0.6, CASH: 0.4 }, confidence: 0.7, rationale: 'ok' };
  assert.deepEqual(JSON.parse(extractModelText({ response: allocation })), allocation);
  assert.deepEqual(JSON.parse(extractModelText({ result: { response: allocation } })), allocation);
  assert.deepEqual(JSON.parse(extractModelText({ choices: [{ message: { parsed: allocation } }] })), allocation);
  assert.equal(extractModelText({ choices: [{ text: '{"ok":true}' }] }), '{"ok":true}');
});

test('GPT-OSS Workers: usa JSON via prompt e restituisce output Responses API', async () => {
  let input;
  const result = await callModel({
    provider: 'workers-ai',
    model: '@cf/openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'test' }],
    config: { llmTemperature: 0.1, llmMaxTokens: 200 },
    credentials: {},
    env: { AI: { run: async (_model, payload) => { input = payload; return { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }; } } },
    jsonMode: true,
  });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(input.response_format, undefined);
  assert.equal(result.debug.structuredMode, 'prompt_only');
});

test('Nemotron Workers: usa i parametri reasoning documentati e il minimo richiesto dal flusso', async () => {
  let input;
  const result = await callModel({
    provider: 'workers-ai',
    model: '@cf/nvidia/nemotron-3-120b-a12b',
    messages: [{ role: 'user', content: 'test' }],
    config: { llmTemperature: 0.1, llmMaxTokens: 700 },
    credentials: {},
    env: { AI: { run: async (_model, payload) => {
      input = payload;
      return { response: '{"ok":true}' };
    } } },
    jsonMode: true,
    minimumMaxTokens: 3_200,
  });
  assert.equal(input.max_tokens, undefined);
  assert.equal(input.max_completion_tokens, 3_200);
  assert.equal(input.reasoning_effort, 'low');
  assert.equal(result.debug.maxTokens, 3_200);
  assert.equal(result.debug.reasoningEffort, 'low');
});

test('Workers AI: JSON nativo è limitato ai modelli documentati', async () => {
  assert.equal(supportsNativeJson('workers-ai', '@cf/openai/gpt-oss-120b'), false);
  assert.equal(supportsNativeJson('workers-ai', '@cf/nvidia/nemotron-3-120b-a12b'), false);
  assert.equal(supportsNativeJson('workers-ai', '@cf/qwen/qwen3-30b-a3b-fp8'), false);
  assert.equal(supportsNativeJson('workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'), true);
  let input;
  const result = await callModel({
    provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    messages: [{ role: 'user', content: 'test' }],
    config: { llmTemperature: 0.1, llmMaxTokens: 1600 }, credentials: {},
    env: { AI: { run: async (_model, payload) => {
      input = payload;
      return { response: { ok: true } };
    } } },
    jsonMode: true,
  });
  assert.equal(input.response_format.type, 'json_object');
  assert.equal(result.debug.structuredMode, 'json_object');
});

test('cascata Workers: reasoning model prompt-only una volta e fallback JSON selettivo', async () => {
  const calls = [];
  const llama = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const allocation = { targetWeights: { CASH: 1 }, confidence: 0.4, rationale: 'attesa', risks: [], watch: [] };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await askBrain({
      config: {
        ...DEFAULT_CONFIG,
        llmModels: {
          ...DEFAULT_CONFIG.llmModels,
          'workers-ai': [...DEFAULT_CONFIG.llmModels['workers-ai'], llama],
        },
      },
      credentials: {},
      env: { AI: { run: async (model, payload) => {
        calls.push({ model, nativeJson: Boolean(payload.response_format), maxTokens: payload.max_tokens ?? payload.max_completion_tokens });
        if (model === llama && payload.response_format) throw new Error("JSON Mode couldn't be met");
        if (model === llama) return { response: allocation };
        return { response: '' };
      } } },
      featuresPrompt: 'STRUMENTI\nCASH', allowedSymbols: [],
    });
    assert.equal(result.ok, true);
    for (const model of ['@cf/openai/gpt-oss-120b', '@cf/nvidia/nemotron-3-120b-a12b', '@cf/qwen/qwen3-30b-a3b-fp8']) {
      assert.equal(calls.filter((call) => call.model === model).length, 1);
      assert.equal(calls.find((call) => call.model === model).nativeJson, false);
      assert.ok(calls.find((call) => call.model === model).maxTokens >= 3_200);
    }
    assert.deepEqual(calls.filter((call) => call.model === llama).map((call) => call.nativeJson), [true, false]);
    assert.equal(result.attempts.at(-1).ok, true);
  } finally {
    console.warn = originalWarn;
  }
});

test('Workers AI: un response oggetto non viene classificato come vuoto', async () => {
  const allocation = { targetWeights: { CASH: 1 }, confidence: 0.4, rationale: 'attesa' };
  const result = await callModel({
    provider: 'workers-ai',
    model: '@cf/nvidia/nemotron-3-120b-a12b',
    messages: [{ role: 'user', content: 'test' }],
    config: { llmTemperature: 0.1, llmMaxTokens: 1600 },
    credentials: {},
    env: { AI: { run: async () => ({ response: allocation }) } },
    jsonMode: true,
  });
  assert.deepEqual(JSON.parse(result.content), allocation);
  assert.equal(result.debug.contentPath, 'response');
  assert.equal(result.debug.category, 'ok');
});

test('Workers AI: conserva e classifica i codici operativi Cloudflare', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(callModel({
      provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'test' }],
      config: { llmTemperature: 0.1, llmMaxTokens: 1600 }, credentials: {},
      env: { AI: { run: async () => { throw sdkError; } } }, jsonMode: true,
    }), (error) => {
      const serialized = JSON.stringify(error.debug);
      assert.ok(!serialized.includes('secret-token-123'));
      assert.ok(!serialized.includes('dato riservato'));
      assert.equal(error.debug.authorization, undefined);
      assert.equal(error.debug.prompt, undefined);
      return true;
    });

    await assert.rejects(callModel({
      provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'test' }],
      config: { llmTemperature: 0.1, llmMaxTokens: 1600 }, credentials: {},
      env: { AI: { run: async () => ({ error: { code: 3040, message: 'out of capacity' } }) } },
      jsonMode: true,
    }), (error) => {
      assert.equal(error.debug.category, 'capacity');
      assert.equal(error.debug.errorCode, 3040);
      return true;
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('OpenRouter: GLM usa effort high, budget adeguato e metadata/healing', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return new Response(JSON.stringify({
      id: 'gen-test',
      model: 'z-ai/glm-5.2:free',
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' } });
  };
  try {
    const result = await callModel({
      provider: 'openrouter', model: 'z-ai/glm-5.2:free',
      messages: [{ role: 'user', content: 'test' }],
      config: { llmTemperature: 0.1, llmMaxTokens: 1600 },
      credentials: { openrouterApiKey: 'test-key' }, env: {}, jsonMode: true,
    });
    const body = JSON.parse(request.body);
    assert.equal(body.reasoning.effort, 'high');
    assert.ok(body.max_tokens >= 5120);
    assert.equal(body.response_format.type, 'json_object');
    assert.deepEqual(body.plugins, [{ id: 'response-healing' }]);
    assert.equal(request.headers['X-OpenRouter-Metadata'], 'enabled');
    assert.equal(result.debug.structuredMode, 'json_object');
    assert.equal(result.debug.requestId, 'req-test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenRouter: Ultra usa un solo prompt JSON senza fingere supporto nativo', async () => {
  assert.equal(supportsNativeJson('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free'), false);
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const result = await callModel({
      provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      messages: [{ role: 'user', content: 'test' }],
      config: { llmTemperature: 0.1, llmMaxTokens: 1600 },
      credentials: { openrouterApiKey: 'test-key' }, env: {}, jsonMode: true,
    });
    assert.equal(body.response_format, undefined);
    assert.equal(body.plugins, undefined);
    assert.equal(result.debug.structuredMode, 'prompt_only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Groq: i reasoning model usano parametri compatibili con JSON e budget finale', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const base = {
      provider: 'groq', messages: [{ role: 'user', content: 'test' }],
      config: { llmTemperature: 0.1, llmMaxTokens: 1600 },
      credentials: { groqApiKey: 'test-key' }, env: {}, jsonMode: true,
    };
    const gpt = await callModel({ ...base, model: 'openai/gpt-oss-120b' });
    const qwen = await callModel({ ...base, model: 'qwen/qwen3.6-27b' });
    assert.equal(bodies[0].max_tokens, undefined);
    assert.ok(bodies[0].max_completion_tokens >= 2048);
    assert.equal(bodies[0].reasoning_effort, 'low');
    assert.equal(bodies[0].include_reasoning, false);
    assert.equal(bodies[0].reasoning_format, undefined);
    assert.equal(gpt.debug.reasoningEffort, 'low');
    assert.equal(bodies[1].reasoning_effort, 'none');
    assert.equal(bodies[1].reasoning_format, 'hidden');
    assert.equal(bodies[1].response_format.type, 'json_object');
    assert.equal(qwen.debug.reasoningEffort, 'none');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telemetria AI: timeout esplicito e anteprime senza credenziali', async () => {
  const preview = safeModelOutputPreview('Bearer secret-token-123 sk-or-v1-supersegreta123 gsk_supersegreta123456 AIzaSuperSegreta123456789012345 eyJabcdefghijklmno.abcdefgh.abcdefgh');
  assert.ok(!preview.includes('secret-token-123'));
  assert.ok(!preview.includes('supersegreta123'));
  assert.ok(!preview.includes('AIzaSuperSegreta'));
  assert.ok(!preview.includes('eyJabcdefghijklmno'));
  assert.equal(safeModelOutputPreview(undefined), '');
  assert.match(safeModelOutputPreview(() => {}), /=>/);

  const hostileDebug = { authorization: 'Bearer secret-token-123', prompt: 'dato riservato' };
  hostileDebug.self = hostileDebug;
  const sdkError = new Error('errore SDK');
  sdkError.debug = hostileDebug;
  assert.equal(llmErrorDebug(sdkError), undefined);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(callModel({
      provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'test' }],
      config: { llmTemperature: 0.1, llmMaxTokens: 1600 }, credentials: {},
      env: { AI: { run: async () => new Promise(() => {}) } }, jsonMode: true, timeoutMs: 15,
    }), (error) => {
      assert.equal(error.message, 'timeout dopo 15 ms');
      assert.equal(error.debug.category, 'timeout');
      assert.equal(error.debug.timerFired, true);
      assert.equal(error.debug.errorName, 'TimeoutError');
      return true;
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('normalizzazione completa in cassa una proposta all’83%', () => {
  const result = normalizeProposal({ targetWeights: { SPY: 0.5, GLD: 0.33 }, confidence: 0.7, rationale: '' }, ['SPY', 'GLD']);
  assert.equal(result.ok, true);
  assert.equal(result.value.targetWeights.CASH, 0.17);
  assert.equal(result.value.repairs[0].code, 'missing_weight_to_cash');
});

test('normalizzazione riscala proporzionalmente una proposta al 110%', () => {
  const result = normalizeProposal({ targetWeights: { SPY: 0.7, GLD: 0.4 }, confidence: 0.7, rationale: '' }, ['SPY', 'GLD']);
  assert.equal(result.ok, true);
  assert.equal(result.value.repairs[0].code, 'weights_rescaled');
  assert.equal(Object.values(result.value.targetWeights).reduce((sum, value) => sum + value, 0), 1);
});

test('normalizzazione blocca ancora somme troppo lontane dal 100%', () => {
  const result = normalizeProposal({ targetWeights: { SPY: 0.4 }, confidence: 0.7, rationale: '' }, ['SPY']);
  assert.equal(result.ok, false);
  assert.match(result.error, /manca il 60.0%/);
  assert.equal(result.details.repairable, false);
});

test('retry AI passa al nuovo modello gli errori della run precedente', () => {
  const context = buildFailedProposalRetryContext({ proposal: { attempts: [
    { provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b', error: 'risposta senza contenuto' },
    { provider: 'workers-ai', model: '@cf/meta/llama', error: 'somma pesi 0.830 fuori tolleranza' },
  ] } });
  assert.match(context, /risposta senza contenuto/);
  assert.match(context, /somma pesi 0.830/);
  assert.match(context, /Somma i pesi numericamente/);
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

test('guardrail: il portafoglio iniziale mira alle posizioni preferite e rispetta i cap', () => {
  const instruments = Array.from({ length: 15 }, (_, index) => ({
    symbol: `A${index + 1}`,
    instrumentId: 2_000 + index,
    class: index < 10 ? 'stock' : 'etf',
    maxWeight: index === 0 ? 0.10 : index === 1 ? 0.11 : index === 2 ? 0.08 : 0.10,
    weight: 0,
    valueUsd: 0,
    investedUsd: 0,
    pnlUsd: 0,
    pnlPct: null,
    positionIds: [],
  }));
  const initialFeatures = {
    portfolio: { equityUsd: 500, cashUsd: 500, openPositions: 0, cashWeight: 1, executionScale: 20 },
    instruments,
  };
  const initialConfig = {
    ...DEFAULT_CONFIG,
    frozen: false,
    minConfidence: 0.5,
    minHoldings: 3,
    preferredHoldings: 15,
    maxHoldings: 20,
    minCashPct: 0.03,
    maxCashPct: 0.03,
    targetDeploymentPct: 0.97,
    maxTurnoverPct: 0.28,
    maxOrdersPerRun: 16,
    maxOrdersPerDay: 20,
    minOrderUsd: 1,
    maxOrderUsd: 100_000,
    maxOrderPctOfCapital: 0.2,
    minRebalanceBandAbs: 0.001,
    minRebalanceBandRel: 0.01,
    transactionCostBps: 1,
    maxWeightPerClass: { stock: 0.75, etf: 0.4, cash: 1 },
  };
  const proposal = {
    targetWeights: { A1: 0.4, A2: 0.3, A3: 0.25, CASH: 0.05 },
    confidence: 0.8,
    rationale: '', risks: [], watch: [],
  };
  const scores = new Map(instruments.map((item, index) => [item.symbol, 80 - index]));
  const result = validateProposal({
    proposal,
    features: initialFeatures,
    config: initialConfig,
    scores,
    completionSymbols: instruments.map((item) => item.symbol),
  });
  const invested = Object.entries(result.plan.targets).filter(([symbol, weight]) => symbol !== 'CASH' && weight > 0.001);
  assert.equal(result.ok, true);
  assert.equal(invested.length, 15);
  assert.ok(result.plan.targets.CASH <= 0.0301);
  assert.ok(result.plan.targets.A1 <= 0.1001);
  assert.ok(result.violations.some((item) => item.code === 'diversification_completed'));
  assert.ok(result.plan.turnoverPct > 0.28, 'la costruzione iniziale non usa il cap dei ribilanciamenti');
  assert.equal(result.plan.executionScale, 20);
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

test('pipeline lock: acquire, renew e release rispettano owner e lease', async () => {
  const db = createSafetyDb();
  const first = await acquirePipelineLock(db, 'run-a', { now: 1_000, leaseMs: 2_000 });
  assert.equal(first.acquired, true);
  assert.equal(first.leaseUntil, 3_000);

  const busy = await acquirePipelineLock(db, 'run-b', { now: 1_500, leaseMs: 2_000 });
  assert.equal(busy.acquired, false);
  assert.equal(busy.ownerId, 'run-a');
  assert.equal(await releasePipelineLock(db, 'run-b'), false, 'un owner concorrente non può rilasciare il lease');
  assert.equal(await renewPipelineLock(db, 'run-a', { now: 2_000, leaseMs: 3_000 }), true);
  assert.equal(db.state.pipelineLock.lease_until, 5_000);
  assert.equal(await releasePipelineLock(db, 'run-a'), true);
  assert.equal(db.state.pipelineLock, null);
});

test('pipeline lock: un lease scaduto può essere acquisito senza che il vecchio owner lo cancelli', async () => {
  const db = createSafetyDb();
  await acquirePipelineLock(db, 'run-old', { now: 1_000, leaseMs: 1_000 });
  const takeover = await acquirePipelineLock(db, 'run-new', { now: 2_000, leaseMs: 1_000 });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.ownerId, 'run-new');
  assert.equal(await releasePipelineLock(db, 'run-old'), false);
  assert.equal(db.state.pipelineLock.owner_id, 'run-new');
});

test('pipeline: una seconda richiesta torna busy senza creare una run', async () => {
  const db = createSafetyDb({}, {
    pipelineLock: {
      lock_key: 'global',
      owner_id: 'cron-attivo',
      acquired_at: Date.now() - 1_000,
      lease_until: Date.now() + 60_000,
    },
  });
  const result = await runPipeline({ env: { DB: db }, kind: 'rebalance' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.busy, true);
  assert.equal(result.reason, 'busy');
  assert.equal(result.activeRunId, 'cron-attivo');
  assert.equal(db.state.runStarts, 0);
  assert.equal(db.state.configReads, 0);
});

test('live fail-safe: congela in shadow e chiude la run frozen', async () => {
  const db = createSafetyDb({ executionMode: 'live', frozen: false });
  const result = await freezeLiveRun({
    db,
    runId: 'live-ambiguo',
    credentials: {},
    equityUsd: 1_234,
    reason: 'riconciliazione fuori tolleranza (8.00%)',
    stage: 'reconcile-fail-safe',
    data: { worstDivergence: 0.08 },
  });
  assert.equal(result.safetyPersisted, true);
  assert.equal(db.state.config.executionMode, 'shadow');
  assert.equal(db.state.config.frozen, true);
  assert.match(db.state.config.frozenReason, /riconciliazione fuori tolleranza/);
  assert.equal(db.state.finishedRuns.at(-1).status, 'frozen');
  assert.equal(db.state.finishedRuns.at(-1).runId, 'live-ambiguo');
  assert.ok(db.state.audits.some((args) => args[3] === 'reconcile-fail-safe'));
});

test('live fail-safe: se D1 non conferma il freeze non dichiara falsamente Shadow', async () => {
  const db = createSafetyDb({ executionMode: 'live', frozen: false }, { mutationFailures: 2 });
  const result = await freezeLiveRun({
    db,
    runId: 'live-safety-unknown',
    credentials: {},
    reason: 'timeout ambiguo dopo invio',
  });
  assert.equal(result.safetyPersisted, false);
  assert.equal(result.status, 'error');
  assert.equal(result.config, null);
  assert.equal(db.state.config.executionMode, 'live');
  assert.equal(db.state.finishedRuns.length, 0, 'la run resta running come barriera di recovery');
});

test('watcher: il percorso propositivo non contiene chiamate dirette agli ordini', () => {
  const source = runWatcher.toString();
  assert.doesNotMatch(source, /client\.(?:openOrder|closeOrder)\s*\(/);
});

test('safety config: safe-stop aggiorna i tre campi in una sola query atomica', async () => {
  const db = createSafetyDb({
    executionMode: 'live',
    frozen: false,
    frozenReason: '',
    strategyName: 'Strategia da preservare',
  });
  const config = await mutateSafetyConfig(db, {
    executionMode: 'shadow',
    frozen: true,
    frozenReason: 'stop remoto di test',
  });
  assert.equal(config.executionMode, 'shadow');
  assert.equal(config.frozen, true);
  assert.equal(config.frozenReason, 'stop remoto di test');
  assert.equal(config.strategyName, 'Strategia da preservare');
  assert.equal(db.state.mutationQueries.length, 1);
  assert.match(db.state.mutationQueries[0].sql, /json_patch/);
  assert.equal(db.state.configReads, 0, 'nessun read-modify-write separato');
});

test('safety config: ogni stop/unfreeze invalida una vecchia attivazione tramite epoch', async () => {
  const db = createSafetyDb({
    executionMode: 'shadow',
    safetyRevision: 4,
    decisionRevision: 9,
  });
  const observed = { ...db.state.config };
  const stopped = await mutateSafetyConfig(db, {
    executionMode: 'shadow',
    frozen: true,
    frozenReason: 'stop concorrente',
  });
  assert.equal(stopped.safetyRevision, 5);
  const unfrozen = await mutateSafetyConfig(db, {
    executionMode: 'shadow',
    frozen: false,
    frozenReason: '',
  });
  assert.equal(unfrozen.safetyRevision, 6);
  assert.equal(await armLiveIfUnchanged(db, observed), null, 'l’epoch osservata prima dello stop non può armare');
  const armed = await armLiveIfUnchanged(db, unfrozen);
  assert.equal(armed.executionMode, 'live');
  assert.equal(armed.safetyRevision, 7);
});

test('live final CAS: una run diventa ok solo con fence e binding ancora identici', async () => {
  const db = createSafetyDb({
    executionMode: 'live',
    frozen: false,
    recoveryRequired: false,
    safetyRevision: 12,
    decisionRevision: 4,
    activeAgentPortfolioId: 'portfolio-live',
    agentTokenFingerprint: 'token-fingerprint',
    agentTokenVerifiedAt: 456,
  });
  const expected = { ...db.state.config };
  db.state.runs.set('live-success', 'running');
  assert.equal(await finishRunIfLiveFence(db, 'live-success', 2_500, expected), true);
  assert.equal(db.state.runs.get('live-success'), 'ok');

  db.state.runs.set('live-stopped', 'running');
  await mutateSafetyConfig(db, {
    executionMode: 'shadow',
    frozen: true,
    frozenReason: 'safe-stop concorrente',
    recoveryRequired: true,
    recoveryReason: 'verifica eToro',
  });
  assert.equal(await finishRunIfLiveFence(db, 'live-stopped', 2_500, expected), false);
  assert.equal(db.state.runs.get('live-stopped'), 'running');

  const bindingDb = createSafetyDb({ ...expected, activeAgentPortfolioId: 'portfolio-ruotato' });
  bindingDb.state.runs.set('live-rebound', 'running');
  assert.equal(await finishRunIfLiveFence(bindingDb, 'live-rebound', 2_500, expected), false);
  assert.equal(bindingDb.state.runs.get('live-rebound'), 'running');
});

test('recovery barrier: considera soltanto ordini di run ancora running', async () => {
  const queries = [];
  const db = {
    prepare(sql) {
      queries.push(sql);
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM live_activation_requests')) return null;
          return { id: 'order-1', run_id: 'stale-run', symbol: 'SPY', side: 'buy', state: 'sent', updated_at: 123 };
        },
      };
    },
  };
  const barrier = await findLiveRecoveryBarrier(db);
  assert.equal(barrier.order.run_id, 'stale-run');
  const orderSql = queries.find((sql) => sql.includes('FROM orders o'));
  assert.match(orderSql, /JOIN runs r ON r\.id = o\.run_id/);
  assert.match(orderSql, /r\.status = 'running'/);
});

test('recovery pre-arm: cerca activation running orfane e non quelle già armate', async () => {
  let captured = null;
  const db = {
    prepare(sql) {
      captured = { sql, args: [] };
      return {
        bind(...args) { captured.args = args; return this; },
        async all() {
          return { results: [{ activation_id: 'old-id', run_id: 'old-run', status: 'running' }] };
        },
      };
    },
  };
  const rows = await listStalePreArmActivations(db, { excludeActivationId: 'current-id' });
  assert.equal(rows[0].run_id, 'old-run');
  assert.match(captured.sql, /status = 'running'/);
  assert.doesNotMatch(captured.sql, /arming-live|executing-live/);
  assert.deepEqual(captured.args.slice(0, 2), ['current-id', 'current-id']);
});

test('control API: safe-stop congela e torna in shadow atomicamente', async () => {
  const db = createSafetyDb({ executionMode: 'live', frozen: false });
  const request = new Request('https://example.test/agent/safe-stop', {
    method: 'POST',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'telefono offline' }),
  });
  const response = await handleAgentApi(request, { DB: db, CONTROL_TOKEN: 'control-test' }, null, '/agent/safe-stop');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.config.executionMode, 'shadow');
  assert.equal(body.config.frozen, true);
  assert.equal(body.config.frozenReason, 'telefono offline');
  assert.equal(body.config.recoveryRequired, true);
  assert.equal(db.state.mutationQueries.length, 1);
});

test('control API: freeze forza shadow oltre a congelare', async () => {
  const db = createSafetyDb({ executionMode: 'live', frozen: false });
  const request = new Request('https://example.test/agent/freeze', {
    method: 'POST',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'stop dal telefono' }),
  });
  const response = await handleAgentApi(request, { DB: db, CONTROL_TOKEN: 'control-test' }, null, '/agent/freeze');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.config.executionMode, 'shadow');
  assert.equal(body.config.frozen, true);
  assert.equal(body.config.frozenReason, 'stop dal telefono');
  assert.equal(db.state.mutationQueries.length, 1);
});

test('control API: unfreeze resta in shadow e non riattiva il live', async () => {
  const db = createSafetyDb({ executionMode: 'live', frozen: true, frozenReason: 'stop dal telefono' });
  const request = new Request('https://example.test/agent/unfreeze', {
    method: 'POST',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify({ safetyRevision: 0 }),
  });
  const response = await handleAgentApi(request, { DB: db, CONTROL_TOKEN: 'control-test' }, null, '/agent/unfreeze');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.config.executionMode, 'shadow');
  assert.equal(body.config.frozen, false);
  assert.equal(body.config.frozenReason, '');
  assert.equal(db.state.mutationQueries.length, 1);
});

test('control API: una recovery richiede conferma e revision esatta prima dello sblocco', async () => {
  const db = createSafetyDb({
    executionMode: 'shadow',
    frozen: true,
    frozenReason: 'ordine sent da verificare',
    recoveryRequired: true,
    recoveryReason: 'ordine sent da verificare',
    safetyRevision: 7,
  });
  const request = (body) => new Request('https://example.test/agent/unfreeze', {
    method: 'POST',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const missingConfirmation = await handleAgentApi(
    request({ safetyRevision: 7 }),
    { DB: db, CONTROL_TOKEN: 'control-test' },
    null,
    '/agent/unfreeze',
  );
  assert.equal(missingConfirmation.status, 409);
  assert.equal(db.state.config.frozen, true);

  const stale = await handleAgentApi(
    request({ safetyRevision: 6, confirmation: LIVE_RECOVERY_CONFIRMATION }),
    { DB: db, CONTROL_TOKEN: 'control-test' },
    null,
    '/agent/unfreeze',
  );
  assert.equal(stale.status, 409);
  assert.equal(db.state.config.frozen, true);

  const confirmed = await handleAgentApi(
    request({ safetyRevision: 7, confirmation: LIVE_RECOVERY_CONFIRMATION }),
    { DB: db, CONTROL_TOKEN: 'control-test' },
    null,
    '/agent/unfreeze',
  );
  const body = await confirmed.json();
  assert.equal(confirmed.status, 200);
  assert.equal(body.config.executionMode, 'shadow');
  assert.equal(body.config.frozen, false);
  assert.equal(body.config.recoveryRequired, false);
  assert.equal(body.config.safetyRevision, 8);
});

test('control API: ruotare qualunque credenziale eToro forza Shadow e invalida il binding', async () => {
  const db = createSafetyDb({
    executionMode: 'live',
    safetyRevision: 9,
    activeAgentPortfolioId: 'portfolio-live',
    activeAgentPortfolioName: 'Portfolio Live',
    activeAgentPortfolioMirrorId: 'mirror-live',
    agentTokenVerifiedAt: 123,
    agentTokenHint: '••••test',
    agentTokenFingerprint: 'old-fingerprint',
    agentTokenOrigin: 'vault',
  });
  const request = new Request('https://example.test/agent/credentials', {
    method: 'PUT',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify({ etoroApiKey: 'rotated-api-key' }),
  });
  const response = await handleAgentApi(request, {
    DB: db,
    CONTROL_TOKEN: 'control-test',
    VAULT_KEY: 'vault-test-key',
    ETORO_USER_KEY: 'owner-user-key',
    ETORO_AGENT_TOKEN: 'agent-token',
  }, null, '/agent/credentials');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.applied, ['etoroApiKey']);
  assert.equal(db.state.config.executionMode, 'shadow');
  assert.ok(db.state.config.safetyRevision > 9);
  assert.equal(db.state.config.activeAgentPortfolioId, '');
  assert.equal(db.state.config.agentTokenVerifiedAt, 0);
  assert.equal(db.state.config.agentTokenFingerprint, '');
  assert.equal(db.state.mutationQueries[0].args[2], JSON.stringify({ executionMode: 'shadow' }));
});

test('control API: il live viene rifiutato quando il freeze è attivo', async () => {
  const db = createSafetyDb({ executionMode: 'shadow', frozen: true, frozenReason: 'verifica manuale' });
  const request = new Request('https://example.test/agent/mode', {
    method: 'POST',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'live', confirm: 'ATTIVA ORDINI REALI' }),
  });
  const response = await handleAgentApi(request, { DB: db, CONTROL_TOKEN: 'control-test' }, null, '/agent/mode');
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /congelato/i);
  assert.equal(db.state.mutationQueries.length, 0);
});

test('control API: il trigger generico non può avviare una run Live', async () => {
  const db = createSafetyDb({ executionMode: 'live', frozen: false });
  const request = new Request('https://example.test/agent/trigger', {
    method: 'POST',
    headers: { authorization: 'Bearer control-test', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'rebalance', mode: 'live' }),
  });
  const response = await handleAgentApi(request, { DB: db, CONTROL_TOKEN: 'control-test' }, null, '/agent/trigger');
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /attivazione atomica/i);
  assert.equal(db.state.runStarts, 0);
});

function liveExecutorPlan() {
  return {
    executionScale: 1,
    orders: [
      { seq: 1, symbol: 'AAA', instrumentId: 101, side: 'buy', amountUsd: 20 },
      { seq: 2, symbol: 'BBB', instrumentId: 102, side: 'buy', amountUsd: 20 },
      { seq: 3, symbol: 'CCC', instrumentId: 103, side: 'buy', amountUsd: 20 },
    ],
  };
}

function liveExecutorClient(onSend, onEligibility = () => {}) {
  return {
    eligibility: async (ids) => {
      onEligibility(ids);
      return new Map(ids.map((id) => [id, { allowOpenPosition: true, minPositionUsd: 1 }]));
    },
    openOrder: async ({ instrumentId }) => {
      onSend(instrumentId);
      return { orderId: `order-${instrumentId}` };
    },
    lookupOrder: async () => ({ state: 'filled', filledUsd: 20, positionIds: [1], label: 'Filled' }),
  };
}

test('executor live: il pre-check già completato prima della CAS non viene duplicato', async () => {
  const db = createSafetyDb();
  let eligibilityCalls = 0;
  const result = await executePlan({
    db,
    client: {
      ...liveExecutorClient(() => {}),
      eligibility: async () => { eligibilityCalls += 1; throw new Error('non deve essere richiamato'); },
    },
    runId: 'prechecked-dry-run',
    plan: liveExecutorPlan(),
    mode: 'dry-run',
    config: DEFAULT_CONFIG,
    eligibilityOverride: { ok: true, issues: [], checks: [] },
  });
  assert.equal(eligibilityCalls, 0);
  assert.ok(result.results.every((item) => item.state === 'simulated'));
});

test('executor live: un filled non persistito resta sent e quindi ambiguo', async () => {
  const db = createSafetyDb({}, {
    safetyReads: [
      { executionMode: 'live', frozen: false },
      { executionMode: 'live', frozen: false },
    ],
    orderWriteFailures: [3, 4],
  });
  const oneOrderPlan = { ...liveExecutorPlan(), orders: [liveExecutorPlan().orders[0]] };
  const result = await executePlan({
    db,
    client: liveExecutorClient(() => {}),
    runId: 'verify-write-failed',
    plan: oneOrderPlan,
    mode: 'live',
    config: DEFAULT_CONFIG,
  });
  assert.equal(result.results[0].state, 'sent');
  assert.match(result.results[0].message, /verifica non riuscita/);
  assert.equal([...db.state.orders.values()][0].state, 'sent');
});

test('executor live: un cambio a shadow interrompe gli invii successivi', async () => {
  const db = createSafetyDb({}, {
    safetyReads: [
      { executionMode: 'live', frozen: false, frozenReason: '' },
      { executionMode: 'live', frozen: false, frozenReason: '' },
      { executionMode: 'shadow', frozen: false, frozenReason: '' },
    ],
  });
  const sent = [];
  const result = await executePlan({
    db,
    client: liveExecutorClient((instrumentId) => sent.push(instrumentId)),
    runId: 'safe-mode-change',
    plan: liveExecutorPlan(),
    mode: 'live',
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual(sent, [101]);
  assert.deepEqual(result.results.map((item) => item.state), ['filled', 'skipped', 'skipped']);
  assert.match(result.results[1].message, /modalità corrente shadow/);
  assert.equal(result.blocked, true);
  assert.match(result.error, /modalità corrente shadow/);
  assert.equal(db.state.configReads, 3, 'controlla prima dell’eligibility e subito prima di ciascun invio');
});

test('executor live: freeze prima del primo ordine blocca l’intero piano', async () => {
  const db = createSafetyDb({}, {
    safetyReads: [{ executionMode: 'live', frozen: true, frozenReason: 'safe-stop mobile' }],
  });
  const sent = [];
  let eligibilityCalls = 0;
  const result = await executePlan({
    db,
    client: liveExecutorClient((instrumentId) => sent.push(instrumentId), () => { eligibilityCalls += 1; }),
    runId: 'safe-frozen',
    plan: liveExecutorPlan(),
    mode: 'live',
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual(sent, []);
  assert.equal(eligibilityCalls, 0, 'il freeze blocca anche il pre-check remoto');
  assert.ok(result.results.every((item) => item.state === 'skipped'));
  assert.ok(result.results.every((item) => /safe-stop mobile/.test(item.message)));
});

test('executor live: freeze dopo intent converte current e remaining in skipped senza duplicati', async () => {
  const db = createSafetyDb({}, {
    safetyReads: [
      { executionMode: 'live', frozen: false, frozenReason: '' },
      { executionMode: 'live', frozen: true, frozenReason: 'race safe-stop' },
    ],
  });
  const sent = [];
  const result = await executePlan({
    db,
    client: liveExecutorClient((instrumentId) => sent.push(instrumentId)),
    runId: 'safe-after-intent',
    plan: liveExecutorPlan(),
    mode: 'live',
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual(sent, []);
  assert.equal(result.executed, false);
  assert.equal(result.results.length, 3);
  assert.equal(new Set(result.results.map((item) => item.id)).size, 3);
  assert.ok(result.results.every((item) => item.state === 'skipped'));
  assert.ok([...db.state.orders.values()].every((item) => item.state === 'skipped'));
  assert.ok(result.results.every((item) => /race safe-stop/.test(item.message)));
  assert.equal(result.blocked, true);
  assert.match(result.error, /race safe-stop/);
  assert.equal(db.state.configReads, 2);
});

test('executor live: read D1 fallito dopo intent converte il piano in skipped', async () => {
  const db = createSafetyDb({}, {
    safetyReads: [
      { executionMode: 'live', frozen: false, frozenReason: '' },
      new Error('D1 perso dopo intent'),
    ],
  });
  const sent = [];
  const result = await executePlan({
    db,
    client: liveExecutorClient((instrumentId) => sent.push(instrumentId)),
    runId: 'safe-read-after-intent',
    plan: liveExecutorPlan(),
    mode: 'live',
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual(sent, []);
  assert.equal(result.executed, false);
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every((item) => item.state === 'skipped'));
  assert.ok(result.results.every((item) => /D1 perso dopo intent/.test(item.message)));
  assert.equal(result.blocked, true);
  assert.match(result.error, /D1 perso dopo intent/);
});

test('executor live: errore di lettura D1 fallisce chiuso senza chiamare eToro', async () => {
  const db = createSafetyDb({}, { safetyReads: [new Error('D1 temporaneamente indisponibile')] });
  const sent = [];
  let eligibilityCalls = 0;
  const result = await executePlan({
    db,
    client: liveExecutorClient((instrumentId) => sent.push(instrumentId), () => { eligibilityCalls += 1; }),
    runId: 'safe-read-error',
    plan: liveExecutorPlan(),
    mode: 'live',
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual(sent, []);
  assert.equal(eligibilityCalls, 0, 'un read fallito non raggiunge eToro');
  assert.ok(result.results.every((item) => item.state === 'skipped'));
  assert.ok(result.results.every((item) => /stato di sicurezza non leggibile/.test(item.message)));
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
