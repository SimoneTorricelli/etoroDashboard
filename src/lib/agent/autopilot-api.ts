/**
 * Client dell'Autopilot server-side.
 *
 * Il token di controllo NON viene salvato su localStorage: vive solo in
 * sessionStorage, così si perde alla chiusura della scheda. È l'unica
 * credenziale che il browser conosce; chiavi eToro e OpenRouter restano nei
 * Worker Secrets e non transitano mai da qui.
 */

const TOKEN_KEY = 'torino.autopilot.control-token';
const BASE_KEY = 'torino.autopilot.base-url';

export type ExecutionMode = 'shadow' | 'dry-run' | 'live';
export type RunKind = 'heartbeat' | 'snapshot' | 'rebalance' | 'manual';

export interface WhitelistEntry {
  symbol: string;
  name: string;
  class: 'etf' | 'stock' | 'bond' | 'commodity' | 'crypto';
  maxWeight: number;
}

export interface StrategyProfileInfo {
  id: string;
  label: string;
  summary: string;
  targetVolPct: [number, number];
  horizon: string;
  maxHoldings: number;
  cryptoCap: number;
  drawdownStopPct: number;
  watcherEnabled: boolean;
}

export interface WatcherEvent {
  id: number;
  at: number;
  symbol: string;
  kind: string;
  classification: string | null;
  confidence: number | null;
  rationale: string | null;
  action: string;
  model: string | null;
  metrics: Record<string, number | boolean | null> | null;
}

export interface AutopilotConfig {
  executionMode: ExecutionMode;
  strategyProfile: string;
  strategySpecVersion?: number;
  strategySpec?: Record<string, unknown> | null;
  onboardingAnswers?: Record<string, unknown> | null;
  onboardingComplete?: boolean;
  strategyName?: string;
  strategyGeneratedBy?: string;
  strategyScenario?: Record<string, unknown> | null;
  strategyDraft?: Record<string, unknown> | null;
  strategyCollaboration?: StrategyCollaboration | null;
  guidedOnboardingAnswers?: Record<string, unknown> | null;
  policyUniverse?: Record<string, unknown> | null;
  shadowStartedAt?: number;
  shadowDays?: number;
  activeAgentPortfolioId?: string;
  activeAgentPortfolioName?: string;
  agentTokenVerifiedAt?: number;
  agentTokenHint?: string;
  universeMode: 'fixed' | 'dynamic';
  shortlistSize: number;
  maxHoldings: number;
  minHoldings: number;
  pool: WhitelistEntry[];
  minHoldingDays: number;
  reentryCooldownDays: number;
  substitutionEdge: number;
  transactionCostBps: number;
  watcherEnabled: boolean;
  watcherDropPct: number;
  watcherSpikePct: number;
  watcherVolSpike: number;
  opportunisticBudgetPct: number;
  maxOpportunisticPerWeek: number;
  maxAverageDown: number;
  stabilizationBars: number;
  watcherMinConfidence: number;
  frozen: boolean;
  frozenReason: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  rebalanceWeekday: number;
  rebalanceDayOfMonth: number;
  rebalanceHour: number;
  rebalanceMinute: number;
  snapshotHours: number[];
  budgetEur: number;
  fallbackEurUsd: number;
  whitelist: WhitelistEntry[];
  maxOrdersPerRun: number;
  maxOrdersPerDay: number;
  minOrderUsd: number;
  maxOrderUsd: number;
  maxOrderPctOfCapital?: number;
  maxTurnoverPct: number;
  minRebalanceBandAbs: number;
  minRebalanceBandRel: number;
  maxWeightPerClass: Record<string, number>;
  minCashPct: number;
  maxCashPct: number;
  targetDeploymentPct?: number;
  drawdownStopPct: number;
  reconcileTolerancePct: number;
  minConfidence: number;
  models: string[];
  llmProviders: string[];
  llmFallbackAcrossProviders?: boolean;
  llmModels: Record<string, string[]>;
  llmTemperature: number;
  llmMaxTokens: number;
  riskProfile: string;
}

export interface RunSummary {
  id: string;
  kind: RunKind;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'error' | 'blocked' | 'frozen';
  execution_mode: ExecutionMode;
  equity_usd: number | null;
  error: string | null;
}

export interface EquityPoint {
  at: number;
  equity_usd: number;
  invested_usd: number | null;
  cash_usd: number | null;
  hwm_usd: number | null;
}

export type CredentialKey =
  | 'etoroApiKey' | 'etoroUserKey' | 'etoroAgentToken'
  | 'openrouterApiKey' | 'geminiApiKey' | 'groqApiKey'
  | 'telegramBotToken' | 'telegramChatId' | 'notifyWebhookUrl'
  | 'finnhubKey' | 'marketauxKey' | 'fmpKey';

export interface LlmProvider {
  id: string;
  label: string;
  note: string;
  needsKey: string | false;
  defaultModels: string[];
}

export interface CredentialStatus {
  key: CredentialKey;
  label: string;
  required: boolean;
  configured: boolean;
  /** vault = salvata dalla dashboard, env = Worker Secret, null = assente. */
  origin: 'vault' | 'env' | null;
  hint: string;
}

export interface AutopilotState {
  config: AutopilotConfig;
  lastRun: RunSummary | null;
  recentRuns: RunSummary[];
  equityCurve: EquityPoint[];
  equityUsd: number;
  highWaterMarkUsd: number;
  drawdownPct: number;
  credentials: CredentialStatus[];
  agentBindingVerified: boolean;
  notificationsActive: boolean;
}

export interface PlanOrder {
  seq: number;
  symbol: string;
  instrumentId: number;
  side: 'buy' | 'sell';
  amountUsd: number;
  reason: string;
}

export interface RunBundle {
  run: RunSummary | null;
  snapshot: { equity_usd: number; cash_usd: number; invested_usd: number; positions: unknown[] } | null;
  features: {
    regime: { label: string; score: number; vix: number | null; spxVsSma200: number | null; yieldCurveBp: number | null; newsNet: number };
    allocationByClass: Record<string, number>;
    instruments: Array<Record<string, number | string | null>>;
    news: { net: number; top: Array<{ t: string; s: number; topic: string }> };
    sourceDiagnostics: Array<{ name: string; ok: boolean; error?: string; ms: number }>;
  } | null;
  proposal: { model: string | null; parsed: { targetWeights: Record<string, number>; confidence: number; rationale: string; risks: string[]; watch: string[] } | null; error: string | null; attempts: unknown[] } | null;
  validation: { ok: boolean; violations: Array<{ code: string; message: string; severity: string }>; plan: { orders: PlanOrder[]; targets: Record<string, number>; turnoverPct: number } | null } | null;
  orders: Array<{ symbol: string; side: string; amount_usd: number; state: string; message: string | null }>;
  logs: Array<{ at: number; level: string; stage: string; message: string }>;
}

export interface InstrumentHit {
  instrumentId: number;
  symbol: string;
  aliases: string[];
  name: string;
  assetClass: string;
  currency: string;
  price: number | null;
}

export interface AgentPortfolioSummary {
  id: string;
  name: string;
  virtualBalanceUsd: number;
  createdAt: string;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  /** true = ok, false = errore, null = non applicabile. */
  ok: boolean | null;
  detail?: string;
  error?: string;
  hint?: string;
  data?: unknown;
}

export interface DiagnosticsReport {
  checkedAt: number;
  ok: boolean;
  readyForShadow: boolean;
  readyForLive: boolean;
  checks: DiagnosticCheck[];
}

export interface GuidedStrategyBundle<TDraft = Record<string, unknown>> {
  draft: TDraft;
  strategySpec: Record<string, unknown>;
  onboardingAnswers: Record<string, unknown>;
  scenario: Record<string, unknown>;
  generation: {
    source: 'ai' | 'deterministic';
    model: string | null;
    attempts: Array<{ provider: string; model: string; ok: boolean; error?: string }>;
  };
  collaboration: StrategyCollaboration;
}

export type StrategyTraceStage = 'intake' | 'lead' | 'review' | 'synthesis' | 'deterministic' | 'complete';
export type StrategyTraceStatus = 'running' | 'passed' | 'warning' | 'failed';

export interface StrategyTraceEvent {
  id: string;
  at: number;
  stage: StrategyTraceStage;
  status: StrategyTraceStatus;
  title: string;
  model?: string | null;
  summary: string;
  handoff?: string[];
  details?: string[];
}

export interface StrategyModelReview {
  reviewer: string;
  verdict: 'approve' | 'revise';
  summary: string;
  strengths: string[];
  concerns: string[];
  requiredChanges: string[];
  confidence: number;
}

export interface StrategyCollaboration {
  version: 1;
  mode: 'multi-model-review';
  status: 'validated' | 'validated-with-warnings' | 'deterministic-fallback';
  leadModel: string | null;
  reviewerModels: string[];
  finalModel: string | null;
  reviews: StrategyModelReview[];
  trace: StrategyTraceEvent[];
}

/**
 * Il token vive prima di tutto in memoria: su Safari iOS e in navigazione
 * privata la scrittura su storage può fallire, e prima questo lasciava la
 * pagina muta senza alcun errore visibile.
 */
let memoryToken = '';
let memoryBaseUrl: string | null = null;

function readStorage(storage: Storage | null, key: string): string {
  try { return storage?.getItem(key) ?? ''; } catch { return ''; }
}

function writeStorage(storage: Storage | null, key: string, value: string): boolean {
  try {
    if (value) storage?.setItem(key, value); else storage?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const session = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };
const local = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

export function getControlToken(): string {
  if (memoryToken) return memoryToken;
  memoryToken = readStorage(session(), TOKEN_KEY) || readStorage(local(), TOKEN_KEY);
  return memoryToken;
}

/**
 * @param remember true = persiste su localStorage (sopravvive alla chiusura
 * della scheda, utile su mobile dove i browser scaricano le tab in background).
 * @returns false se nessuno storage era scrivibile: il token resta comunque
 * valido in memoria per questa sessione.
 */
export function setControlToken(token: string, remember = false): boolean {
  memoryToken = token;
  const target = remember ? local() : session();
  const other = remember ? session() : local();
  writeStorage(other, TOKEN_KEY, '');
  return writeStorage(target, TOKEN_KEY, token);
}

export function isTokenRemembered(): boolean {
  return Boolean(readStorage(local(), TOKEN_KEY));
}

/** Base URL del Worker. Vuota = stessa origine del sito. */
export function getBaseUrl(): string {
  if (memoryBaseUrl !== null) return memoryBaseUrl;
  memoryBaseUrl = readStorage(local(), BASE_KEY);
  return memoryBaseUrl;
}

export function setBaseUrl(url: string): void {
  memoryBaseUrl = url.replace(/\/+$/, '');
  writeStorage(local(), BASE_KEY, memoryBaseUrl);
}

export class AutopilotError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AutopilotError';
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getControlToken();
  if (!token) throw new AutopilotError('Token di controllo non impostato.', 401);
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new AutopilotError(message, response.status);
  }
  return body as T;
}

async function streamStrategyDraft<TDraft>(
  answers: Record<string, unknown>,
  onTrace: (event: StrategyTraceEvent) => void,
): Promise<GuidedStrategyBundle<TDraft>> {
  const token = getControlToken();
  if (!token) throw new AutopilotError('Token di controllo non impostato.', 401);
  const response = await fetch(`${getBaseUrl()}/agent/strategy/draft/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ answers }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new AutopilotError(payload.error ?? `HTTP ${response.status}`, response.status);
  }
  if (!response.body) throw new AutopilotError('Il browser non supporta la generazione progressiva.', 500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let complete: GuidedStrategyBundle<TDraft> | null = null;
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as {
      type: 'trace' | 'complete' | 'error';
      event?: StrategyTraceEvent;
      bundle?: GuidedStrategyBundle<TDraft>;
      error?: string;
    };
    if (message.type === 'trace' && message.event) onTrace(message.event);
    if (message.type === 'complete' && message.bundle) complete = message.bundle;
    if (message.type === 'error') throw new AutopilotError(message.error ?? 'Generazione strategia non riuscita.', 500);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  consumeLine(buffered);
  if (!complete) throw new AutopilotError('La generazione si è interrotta prima del risultato finale.', 500);
  return complete;
}

export const autopilot = {
  state: () => call<AutopilotState>('/agent/state'),
  runs: (limit = 30) => call<{ runs: RunSummary[] }>(`/agent/runs?limit=${limit}`),
  run: (id: string) => call<RunBundle>(`/agent/runs/${encodeURIComponent(id)}`),
  config: () => call<{ config: AutopilotConfig; defaults: AutopilotConfig }>('/agent/config'),
  updateConfig: (patch: Partial<AutopilotConfig>) =>
    call<{ config: AutopilotConfig; applied: string[]; rejected: string[] }>('/agent/config', { method: 'PUT', body: JSON.stringify(patch) }),
  setMode: (mode: ExecutionMode) =>
    call<{ config: AutopilotConfig }>('/agent/mode', {
      method: 'POST',
      body: JSON.stringify(mode === 'live' ? { mode, confirm: 'ATTIVA ORDINI REALI' } : { mode }),
    }),
  freeze: (reason: string) => call<{ config: AutopilotConfig }>('/agent/freeze', { method: 'POST', body: JSON.stringify({ reason }) }),
  unfreeze: () => call<{ config: AutopilotConfig }>('/agent/unfreeze', { method: 'POST', body: '{}' }),
  trigger: (kind: 'snapshot' | 'rebalance', mode?: ExecutionMode) =>
    call<{ runId: string; status: string; error?: string }>('/agent/trigger', {
      method: 'POST',
      body: JSON.stringify(mode === 'live' ? { kind, mode, confirm: 'ATTIVA ORDINI REALI' } : { kind, mode }),
    }),
  freeModels: () => call<{ models: Array<{ id: string; name: string; contextLength: number | null }>; providers: LlmProvider[] }>('/agent/models'),
  credentials: () => call<{ credentials: CredentialStatus[] }>('/agent/credentials'),
  saveCredentials: (patch: Partial<Record<CredentialKey, string>>) =>
    call<{ credentials: CredentialStatus[]; applied: string[]; rejected: string[] }>('/agent/credentials', { method: 'PUT', body: JSON.stringify(patch) }),
  clearCredentials: () => call<{ credentials: CredentialStatus[] }>('/agent/credentials', { method: 'DELETE' }),
  testNotifications: () => call<{ sent: number; attempted: number; checks: DiagnosticCheck[] }>('/agent/notify-test', { method: 'POST', body: '{}' }),
  diagnose: () => call<DiagnosticsReport>('/agent/diagnose', { method: 'POST', body: '{}' }),
  searchInstruments: (query: string) =>
    call<{ results: InstrumentHit[] }>(`/agent/instruments?q=${encodeURIComponent(query)}`),
  agentPortfolios: () => call<{ portfolios: AgentPortfolioSummary[] }>('/agent/agent-portfolios'),
  profiles: () => call<{ profiles: StrategyProfileInfo[]; current: string }>('/agent/profiles'),
  setProfile: (profile: string) =>
    call<{ config: AutopilotConfig }>('/agent/profile', { method: 'POST', body: JSON.stringify({ profile }) }),
  watcherEvents: (limit = 50) => call<{ events: WatcherEvent[] }>(`/agent/watcher?limit=${limit}`),
  strategyDraft: <TDraft = Record<string, unknown>>(answers: Record<string, unknown>) =>
    call<GuidedStrategyBundle<TDraft>>('/agent/strategy/draft', {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
  strategyDraftStream: <TDraft = Record<string, unknown>>(
    answers: Record<string, unknown>,
    onTrace: (event: StrategyTraceEvent) => void,
  ) => streamStrategyDraft<TDraft>(answers, onTrace),
  activateStrategy: <TDraft = Record<string, unknown>>(payload: {
    answers: Record<string, unknown>;
    strategySpec: Record<string, unknown>;
    portfolioId: string;
    generatedBy?: string;
    reviewMaxDrawdownPct?: number;
    collaboration?: StrategyCollaboration | null;
  }) => call<{ ok: true; config: AutopilotConfig; strategySpec: Record<string, unknown>; scenario: Record<string, unknown>; draft: TDraft }>('/agent/strategy/activate', {
    method: 'POST',
      body: JSON.stringify(payload),
  }),
  generateAgentToken: (agentPortfolioId: string, agentPortfolioName?: string) =>
    call<{
      ok: true;
      tokenName: string;
      hint: string;
      verified: true;
      portfolio: { id: string; name: string; equityUsd: number; positions: number };
      credentials: CredentialStatus[];
    }>('/agent/agent-token', {
      method: 'POST',
      body: JSON.stringify({ agentPortfolioId, agentPortfolioName }),
    }),
};
