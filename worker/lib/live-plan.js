/**
 * Contratto di promozione dry-run -> live.
 *
 * Una dry-run rende riutilizzabile soltanto la decisione AI (i target), mai
 * gli importi o gli order intent. Snapshot, piano, eligibility e reconcile
 * vengono sempre ricostruiti nella nuova run live.
 */

export const LIVE_DRY_RUN_TTL_MS = 2 * 60 * 60 * 1000;
export const LIVE_CONFIRMATION = 'ESEGUI LIVE';
export const LIVE_RECOVERY_CONFIRMATION = 'HO VERIFICATO GLI ORDINI SU ETORO';

const NON_DECISION_CONFIG_KEYS = new Set([
  'executionMode',
  'safetyRevision',
  'recoveryRequired',
  'recoveryReason',
  'recoveryRunIds',
  'recoveryUpdatedAt',
  'frozen',
  'frozenReason',
  'rebalanceWeekday',
  'rebalanceDayOfMonth',
  'rebalanceHour',
  'rebalanceMinute',
  'snapshotHours',
  'shadowStartedAt',
  'shadowDays',
  'watcherEnabled',
  'watcherDropPct',
  'watcherSpikePct',
  'watcherVolSpike',
  'opportunisticBudgetPct',
  'maxOpportunisticPerWeek',
  'maxAverageDown',
  'stabilizationBars',
  'watcherMinConfidence',
  'lastManagedCapitalUsd',
  'lastManagedCapitalEur',
  'lastManagedCapitalAt',
  'lastManagedEurUsd',
  'realCapitalTrackingStartedAt',
  'activeAgentPortfolioName',
  'activeAgentPortfolioMirrorId',
  'activeAgentPortfolioVirtualBalanceUsd',
  'agentTokenHint',
  'agentTokenOrigin',
]);

const TELEMETRY_OR_SCHEDULE_KEYS = new Set(NON_DECISION_CONFIG_KEYS);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

async function sha256(label, value) {
  const encoded = new TextEncoder().encode(`${label}:${stableStringify(value)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function decisionConfigProjection(config) {
  const source = { ...(config ?? {}) };
  if (source.strategySpec?.diversification) {
    const maximum = Math.max(1, Number(source.maxHoldings) || 1);
    const minimum = Math.max(1, Number(source.minHoldings) || 1);
    const preferredByPolicy = Number(source.strategySpec.diversification.preferredPositions) || 0;
    const preferredByRange = Math.round((Number(source.strategySpec.diversification.maxPositions) || maximum) * 0.75);
    source.preferredHoldings = Math.min(
      maximum,
      Math.max(minimum, Number(source.preferredHoldings) || 0, preferredByPolicy, preferredByRange),
    );
  }
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => !NON_DECISION_CONFIG_KEYS.has(key)));
}

export function bindingProjection(config) {
  return {
    activeAgentPortfolioId: String(config?.activeAgentPortfolioId ?? ''),
    agentTokenFingerprint: String(config?.agentTokenFingerprint ?? ''),
    agentTokenVerifiedAt: Number(config?.agentTokenVerifiedAt) || 0,
  };
}

export async function buildDecisionContext(config) {
  const decisionRevision = Math.max(0, Math.trunc(Number(config?.decisionRevision) || 0));
  const [decisionHash, bindingHash] = await Promise.all([
    sha256('torino-decision:v1', decisionConfigProjection(config)),
    sha256('torino-binding:v1', bindingProjection(config)),
  ]);
  return { decisionRevision, decisionHash, bindingHash };
}

export async function proposalHash(proposal) {
  return sha256('torino-proposal:v1', proposal ?? null);
}

/** Solo modifiche operative/di schedulazione non invalidano una decisione AI. */
export function isDecisionConfigPatch(patch) {
  return Object.keys(patch ?? {}).some((key) => !TELEMETRY_OR_SCHEDULE_KEYS.has(key));
}

function numberFrom(source, snake, camel) {
  const value = Number(source?.[snake] ?? source?.[camel]);
  return Number.isFinite(value) ? value : 0;
}

function weightsByInstrument(snapshot) {
  const equity = Math.max(0.01, numberFrom(snapshot, 'equity_usd', 'equityUsd'));
  const weights = new Map();
  for (const position of snapshot?.positions ?? []) {
    const instrumentId = Number(position.instrumentId ?? position.instrument_id);
    if (!Number.isFinite(instrumentId) || instrumentId <= 0) continue;
    const valueUsd = Number(position.valueUsd ?? position.value_usd) || 0;
    weights.set(instrumentId, (weights.get(instrumentId) ?? 0) + valueUsd / equity);
  }
  return weights;
}

/**
 * Tollera il normale mark-to-market, ma non depositi, prelievi o operazioni
 * manuali abbastanza grandi da cambiare il significato della dry-run.
 */
export function comparePortfolioForReuse(sourceBundle, currentSnapshot, config) {
  const sourceSnapshot = sourceBundle?.snapshot;
  if (!sourceSnapshot) return { ok: false, reason: 'snapshot dry-run assente' };

  const sourceEquity = numberFrom(sourceSnapshot, 'equity_usd', 'equityUsd');
  const currentEquity = numberFrom(currentSnapshot, 'equity_usd', 'equityUsd');
  if (sourceEquity <= 0 || currentEquity <= 0) return { ok: false, reason: 'capitale non confrontabile' };
  if (Math.abs(currentEquity - sourceEquity) / sourceEquity > 0.05) {
    return { ok: false, reason: 'capitale variato oltre il 5%' };
  }

  const sourceWeights = weightsByInstrument(sourceSnapshot);
  const currentWeights = weightsByInstrument(currentSnapshot);
  const sourceIds = [...sourceWeights.keys()].sort((a, b) => a - b);
  const currentIds = [...currentWeights.keys()].sort((a, b) => a - b);
  if (sourceIds.length !== currentIds.length || sourceIds.some((id, index) => id !== currentIds[index])) {
    return { ok: false, reason: 'composizione del portfolio modificata' };
  }

  const weightTolerance = Math.max(0.02, Number(config?.minRebalanceBandAbs) || 0);
  for (const id of sourceIds) {
    if (Math.abs((sourceWeights.get(id) ?? 0) - (currentWeights.get(id) ?? 0)) > weightTolerance) {
      return { ok: false, reason: `peso dello strumento ${id} variato oltre la tolleranza` };
    }
  }

  const sourceCash = numberFrom(sourceSnapshot, 'cash_usd', 'cashUsd');
  const currentCash = numberFrom(currentSnapshot, 'cash_usd', 'cashUsd');
  const cashTolerance = Math.max(Number(config?.minOrderUsd) || 0, currentEquity * 0.02);
  if (Math.abs(sourceCash - currentCash) > cashTolerance) {
    return { ok: false, reason: 'liquidità del portfolio modificata' };
  }

  const sourceScale = Number(sourceBundle?.features?.portfolio?.executionScale) || 1;
  const currentScale = Number(currentSnapshot?.executionScale) || 1;
  if (Math.abs(currentScale - sourceScale) / Math.max(sourceScale, 0.000001) > 0.02) {
    return { ok: false, reason: 'scala di esecuzione Agent modificata' };
  }
  return { ok: true, reason: '' };
}

export function classifyDryRunForReuse(row, context, now = Date.now()) {
  if (!row) return { reusable: false, reason: 'missing' };
  if (!['ok', 'blocked'].includes(row.status) || !row.finished_at) {
    return { reusable: false, reason: row.status || 'incomplete' };
  }
  if (Number(row.validation_ok) !== 1) return { reusable: false, reason: 'invalid-plan' };
  if (!row.artifact_source_run_id) return { reusable: false, reason: 'incompatible' };
  if (Number(row.consumed_at) > 0) return { reusable: false, reason: 'consumed' };
  if (Number(row.expires_at) <= now) return { reusable: false, reason: 'expired' };
  if (Number(row.decision_revision) !== Number(context.decisionRevision)) return { reusable: false, reason: 'config-changed' };
  if (row.decision_hash !== context.decisionHash) return { reusable: false, reason: 'config-changed' };
  if (row.binding_hash !== context.bindingHash) return { reusable: false, reason: 'portfolio-changed' };
  return { reusable: true, reason: 'fresh' };
}

export function summarizeExecution(result) {
  const orders = (result?.execution?.results ?? []).map((item) => ({
    symbol: String(item.symbol ?? ''),
    side: String(item.side ?? ''),
    amountUsd: Number(item.amountUsd ?? item.amount_usd) || 0,
    state: String(item.state ?? ''),
    message: item.message == null ? null : String(item.message),
  }));
  const counts = {
    planned: Number(result?.plan?.orders?.length) || 0,
    intent: 0,
    sent: 0,
    filled: 0,
    partial: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
    simulated: 0,
  };
  for (const order of orders) {
    if (Object.hasOwn(counts, order.state)) counts[order.state] += 1;
  }
  return { counts, orders };
}

export function compactLiveActivationResult(activationId, result) {
  const execution = summarizeExecution(result);
  const safetyPersisted = result?.safetyPersisted ?? result?.safety?.safetyPersisted;
  return {
    activationId,
    runId: result?.runId ?? null,
    status: result?.status ?? 'error',
    mode: result?.mode ?? null,
    action: result?.action ?? null,
    reason: result?.reason ?? null,
    error: result?.error ?? null,
    decisionSource: result?.decisionSource ?? 'fresh-analysis',
    reusedDryRunId: result?.reusedDryRunId ?? null,
    reuseFallbackReason: result?.reuseFallbackReason ?? null,
    ...(typeof safetyPersisted === 'boolean' ? { safetyPersisted } : {}),
    plan: result?.plan ? {
      orderCount: Number(result.plan.orders?.length) || 0,
      turnoverPct: Number(result.plan.turnoverPct) || 0,
      confidence: Number(result.plan.confidence) || 0,
    } : null,
    execution,
  };
}
