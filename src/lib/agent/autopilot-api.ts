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
  maxTurnoverPct: number;
  minRebalanceBandAbs: number;
  minRebalanceBandRel: number;
  maxWeightPerClass: Record<string, number>;
  minCashPct: number;
  maxCashPct: number;
  drawdownStopPct: number;
  reconcileTolerancePct: number;
  minConfidence: number;
  models: string[];
  llmProviders: string[];
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

export function getControlToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function setControlToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* sessione non disponibile */ }
}

/** Base URL del Worker. Vuota = stessa origine del sito. */
export function getBaseUrl(): string {
  try { return localStorage.getItem(BASE_KEY) ?? ''; } catch { return ''; }
}

export function setBaseUrl(url: string): void {
  try {
    if (url) localStorage.setItem(BASE_KEY, url.replace(/\/+$/, ''));
    else localStorage.removeItem(BASE_KEY);
  } catch { /* storage non disponibile */ }
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
  generateAgentToken: (agentPortfolioId: string) =>
    call<{ ok: true; tokenName: string; hint: string; credentials: CredentialStatus[] }>('/agent/agent-token', {
      method: 'POST',
      body: JSON.stringify({ agentPortfolioId }),
    }),
};
