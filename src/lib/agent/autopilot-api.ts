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

export const LIVE_CONFIRMATION = 'ESEGUI LIVE' as const;
export const LIVE_RECOVERY_CONFIRMATION = 'HO VERIFICATO GLI ORDINI SU ETORO' as const;

const EXECUTION_MODES = new Set<ExecutionMode>(['shadow', 'dry-run', 'live']);

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
  safetyRevision?: number;
  recoveryRequired?: boolean;
  recoveryReason?: string;
  recoveryRunIds?: string[];
  recoveryUpdatedAt?: number;
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
  activeAgentPortfolioMirrorId?: string;
  agentTokenVerifiedAt?: number;
  agentTokenHint?: string;
  lastManagedCapitalUsd?: number;
  lastManagedCapitalEur?: number;
  lastManagedCapitalAt?: number;
  lastManagedEurUsd?: number;
  realCapitalTrackingStartedAt?: number;
  universeMode: 'fixed' | 'dynamic';
  shortlistSize: number;
  maxHoldings: number;
  minHoldings: number;
  preferredHoldings?: number;
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
  maxSectorWeightPct?: number;
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

export interface ReusableDryRunPreview {
  runId: string;
  status: RunSummary['status'];
  finishedAt: number | null;
  artifactCreatedAt: number | null;
  expiresAt: number | null;
  reusable: boolean;
  reason: string;
  model: string | null;
  confidence: number | null;
  orderCount: number;
  turnoverPct: number | null;
}

export interface LiveActivationPreview {
  serverNow: number;
  ttlMs: number;
  dryRun: ReusableDryRunPreview | null;
}

export type LiveActivationStatus = 'ok' | 'blocked' | 'error' | 'frozen';

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

/**
 * Telemetria sicura e best-effort di un singolo tentativo LLM.
 *
 * Il Worker non inserisce qui prompt, body completi, header o credenziali. I
 * campi restano opzionali per mantenere leggibili anche le run precedenti.
 */
export interface LlmAttemptDebug {
  [key: string]: unknown;
  version?: number;
  attemptId?: string;
  category?: string;
  phase?: string;
  startedAt?: number;
  elapsedMs?: number;
  timeoutMs?: number;
  timerFired?: boolean;
  structuredMode?: boolean | string;
  messageCount?: number;
  promptChars?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  httpStatus?: number;
  statusText?: string;
  contentType?: string;
  bodyChars?: number;
  payloadKeys?: string[];
  payloadShape?: string | string[] | Record<string, unknown>;
  responseId?: string;
  requestId?: string;
  generationId?: string;
  cfRay?: string;
  retryAfter?: string | number;
  requestedModel?: string;
  resolvedModel?: string;
  choiceCount?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  incompleteReason?: string;
  contentPath?: string;
  contentChars?: number;
  contentKind?: string;
  candidateCount?: number;
  candidateKeys?: string[];
  reasoningChars?: number;
  usage?: Record<string, unknown> | null;
  router?: string | Record<string, unknown> | null;
  errorName?: string;
  errorCode?: string | number;
  errorMessage?: string;
  parseError?: string;
  validationError?: string;
}

export interface LlmAttempt {
  provider?: string;
  model: string;
  format?: string;
  ok: boolean;
  error?: string;
  details?: unknown;
  ms?: number;
  resolvedModel?: string;
  reasoningScore?: number;
  reasoningTier?: string;
  usage?: Record<string, unknown> | null;
  debug?: LlmAttemptDebug;
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
  /** Assente soltanto durante un aggiornamento graduale da un Worker precedente. */
  liveActivation?: LiveActivationPreview;
}

export interface LiveActivationResult {
  activationId: string;
  runId: string | null;
  status: LiveActivationStatus;
  mode: ExecutionMode | null;
  busy?: boolean;
  replayed?: boolean;
  persistenceWarning?: string;
  /** false = il Worker non ha potuto confermare Shadow + Frozen in D1. */
  safetyPersisted?: boolean;
  activeRunId?: string | null;
  leaseUntil?: number | null;
  action?: string | null;
  reason?: string | null;
  error?: string | null;
  decisionSource?: 'reused-dry-run' | 'fresh-analysis';
  reusedDryRunId?: string | null;
  reuseFallbackReason?: string | null;
  plan?: {
    orderCount: number;
    turnoverPct: number;
    confidence: number;
  } | null;
  execution?: {
    counts: Record<string, number>;
    orders: Array<{
      symbol: string;
      side: string;
      amountUsd: number;
      state: string;
      message: string | null;
    }>;
  };
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
  proposal: { model: string | null; parsed: { targetWeights: Record<string, number>; confidence: number; rationale: string; risks: string[]; watch: string[]; repairs?: Array<{ code: string; originalTotal: number; message: string }> } | null; error: string | null; attempts: LlmAttempt[] } | null;
  validation: { ok: boolean; violations: Array<{ code: string; message: string; severity: string }>; plan: { orders: PlanOrder[]; targets: Record<string, number>; turnoverPct: number } | null } | null;
  orders: Array<{ symbol: string; side: string; amount_usd: number; state: string; message: string | null }>;
  logs: Array<{ at: number; level: string; stage: string; message: string }>;
  improvement: { sourceRunId: string; sourceModel: string | null; sourceConfidence: number | null } | null;
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
  mirrorId?: string;
  createdAt: string;
}

export type DiagnosticData = LlmAttempt[] | Record<string, unknown> | Array<Record<string, unknown>>;

export interface DiagnosticCheck {
  id: string;
  label: string;
  /** true = ok, false = errore, null = non applicabile. */
  ok: boolean | null;
  detail?: string;
  error?: string;
  hint?: string;
  data?: DiagnosticData;
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
    attempts: LlmAttempt[];
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
  if (!storage) return false;
  try {
    if (value) storage.setItem(key, value); else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const session = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };
const local = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

function browserOrigin(): string {
  try { return window.location.origin; } catch { return ''; }
}

/**
 * L'API Autopilot vive sempre alla radice del Worker. Accettiamo quindi soltanto
 * origini HTTP(S): un URL copiato dalla barra del browser (per esempio con
 * `/autopilot`) viene ricondotto alla sua origin invece di generare richieste a
 * `/autopilot/agent/*`, che il fallback SPA potrebbe rispondere con HTML 200.
 */
export function normalizeBaseUrl(value: string, sameOrigin = browserOrigin()): string {
  const candidate = String(value ?? '').trim() || String(sameOrigin ?? '').trim();
  if (!candidate) return '';

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('URL del Worker non valido: usa un indirizzo completo che inizi con http:// o https://.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL del Worker non valido: sono ammessi soltanto indirizzi http:// o https://.');
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (parsed.protocol === 'http:' && !loopbackHosts.has(parsed.hostname)) {
    throw new Error('URL del Worker non sicuro: fuori dal computer locale è obbligatorio usare https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL del Worker non valido: non inserire credenziali nell’indirizzo.');
  }
  return parsed.origin;
}

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

/** Base URL del Worker. Un valore vuoto viene risolto sulla stessa origine. */
export function getBaseUrl(): string {
  if (memoryBaseUrl !== null) return memoryBaseUrl;
  const stored = readStorage(local(), BASE_KEY);
  try {
    memoryBaseUrl = normalizeBaseUrl(stored);
  } catch {
    // Recupero da valori storici/corrotti: la stessa origine resta la scelta più
    // sicura e permette alla schermata di connessione di essere riaperta.
    memoryBaseUrl = normalizeBaseUrl('');
    writeStorage(local(), BASE_KEY, memoryBaseUrl);
  }
  return memoryBaseUrl;
}

export function setBaseUrl(url: string): string {
  memoryBaseUrl = normalizeBaseUrl(url);
  writeStorage(local(), BASE_KEY, memoryBaseUrl);
  return memoryBaseUrl;
}

export class AutopilotError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AutopilotError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidApiPayload(path: string, detail: string): never {
  throw new AutopilotError(
    `Risposta non valida da ${path}: ${detail}. Controlla l’URL del Worker e assicurati che backend e dashboard siano aggiornati.`,
    502,
  );
}

function isRunSummary(value: unknown): value is RunSummary {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.started_at === 'number'
    && (value.finished_at === null || typeof value.finished_at === 'number')
    && typeof value.status === 'string'
    && EXECUTION_MODES.has(value.execution_mode as ExecutionMode);
}

function validateStatePayload(value: unknown): AutopilotState {
  if (!isRecord(value)) invalidApiPayload('/agent/state', 'era atteso un oggetto JSON');
  if (!isRecord(value.config)) invalidApiPayload('/agent/state', 'manca la configurazione Autopilot');
  if (!EXECUTION_MODES.has(value.config.executionMode as ExecutionMode)) {
    invalidApiPayload('/agent/state', 'la modalità di esecuzione è assente o sconosciuta');
  }
  if (value.lastRun !== null && !isRunSummary(value.lastRun)) {
    invalidApiPayload('/agent/state', 'il campo lastRun non è compatibile');
  }
  if (!Array.isArray(value.recentRuns) || !value.recentRuns.every(isRunSummary)) {
    invalidApiPayload('/agent/state', 'il campo recentRuns non è un elenco valido');
  }
  if (!Array.isArray(value.equityCurve)) invalidApiPayload('/agent/state', 'manca la curva del capitale');
  if (!Array.isArray(value.credentials)) invalidApiPayload('/agent/state', 'manca lo stato delle credenziali');
  for (const key of ['equityUsd', 'highWaterMarkUsd', 'drawdownPct'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      invalidApiPayload('/agent/state', `il campo ${key} non è numerico`);
    }
  }
  if (typeof value.agentBindingVerified !== 'boolean' || typeof value.notificationsActive !== 'boolean') {
    invalidApiPayload('/agent/state', 'mancano gli indicatori di collegamento Agent');
  }
  return value as unknown as AutopilotState;
}

function validateRunsPayload(value: unknown): { runs: RunSummary[] } {
  if (!isRecord(value) || !Array.isArray(value.runs)) {
    invalidApiPayload('/agent/runs', 'manca l’elenco delle esecuzioni');
  }
  if (!value.runs.every(isRunSummary)) invalidApiPayload('/agent/runs', 'una o più esecuzioni hanno un formato incompatibile');
  return { runs: value.runs } as { runs: RunSummary[] };
}

const LIVE_ACTIVATION_STATUSES = new Set<LiveActivationStatus>(['ok', 'blocked', 'error', 'frozen']);

function validateLiveActivationPayload(value: unknown, expectedActivationId: string): LiveActivationResult {
  const path = '/agent/live/activate-and-run';
  if (!isRecord(value)) invalidApiPayload(path, 'era atteso un oggetto JSON');
  if (value.activationId !== expectedActivationId) {
    invalidApiPayload(path, 'activationId assente o diverso dalla richiesta');
  }
  if (!LIVE_ACTIVATION_STATUSES.has(value.status as LiveActivationStatus)) {
    invalidApiPayload(path, 'lo stato della run Live è assente o sconosciuto');
  }
  if (!(value.mode === null || EXECUTION_MODES.has(value.mode as ExecutionMode))) {
    invalidApiPayload(path, 'la modalità finale è assente o sconosciuta');
  }
  if (!(value.runId === null || (typeof value.runId === 'string' && value.runId.trim()))) {
    invalidApiPayload(path, 'runId deve essere una stringa non vuota oppure null');
  }

  const status = value.status as LiveActivationStatus;
  if (status === 'ok' && typeof value.runId !== 'string') {
    invalidApiPayload(path, `runId manca per lo stato ${status}`);
  }
  if (status === 'ok' && value.mode !== 'live') {
    invalidApiPayload(path, 'una run riuscita non conferma la modalità Live');
  }

  for (const field of ['busy', 'replayed', 'safetyPersisted'] as const) {
    if (field in value && typeof value[field] !== 'boolean') {
      invalidApiPayload(path, `${field} deve essere booleano`);
    }
  }
  if (value.busy === true && status !== 'blocked') {
    invalidApiPayload(path, 'busy è compatibile soltanto con uno stato blocked');
  }
  if (status === 'frozen' && typeof value.safetyPersisted !== 'boolean') {
    invalidApiPayload(path, 'un fail-safe frozen deve dichiarare safetyPersisted');
  }
  if (value.safetyPersisted === false && !['frozen', 'error'].includes(status)) {
    invalidApiPayload(path, 'safetyPersisted=false è incompatibile con lo stato dichiarato');
  }
  if (value.safetyPersisted === true && status === 'frozen' && value.mode !== 'shadow') {
    invalidApiPayload(path, 'il fail-safe persistito non conferma la modalità Shadow');
  }

  for (const field of ['action', 'reason', 'error', 'reusedDryRunId', 'reuseFallbackReason'] as const) {
    if (field in value && value[field] !== null && typeof value[field] !== 'string') {
      invalidApiPayload(path, `${field} deve essere una stringa oppure null`);
    }
  }
  if (
    'decisionSource' in value
    && !['reused-dry-run', 'fresh-analysis'].includes(String(value.decisionSource))
  ) {
    invalidApiPayload(path, 'decisionSource è sconosciuto');
  }
  if ('persistenceWarning' in value && (typeof value.persistenceWarning !== 'string' || !value.persistenceWarning.trim())) {
    invalidApiPayload(path, 'persistenceWarning deve essere una stringa non vuota');
  }
  if (
    'activeRunId' in value
    && value.activeRunId !== null
    && (typeof value.activeRunId !== 'string' || !value.activeRunId.trim())
  ) {
    invalidApiPayload(path, 'activeRunId deve essere una stringa oppure null');
  }
  if (
    'leaseUntil' in value
    && value.leaseUntil !== null
    && (typeof value.leaseUntil !== 'number' || !Number.isFinite(value.leaseUntil))
  ) {
    invalidApiPayload(path, 'leaseUntil deve essere numerico oppure null');
  }

  const plan = value.plan;
  if (plan !== undefined && plan !== null) {
    if (!isRecord(plan)) invalidApiPayload(path, 'plan deve essere un oggetto oppure null');
    if (typeof plan.orderCount !== 'number' || !Number.isInteger(plan.orderCount) || plan.orderCount < 0) {
      invalidApiPayload(path, 'plan.orderCount non è valido');
    }
    for (const field of ['turnoverPct', 'confidence'] as const) {
      if (typeof plan[field] !== 'number' || !Number.isFinite(plan[field]) || plan[field] < 0 || plan[field] > 1) {
        invalidApiPayload(path, `plan.${field} non è una percentuale valida`);
      }
    }
  }

  const execution = value.execution;
  if (execution !== undefined) {
    if (!isRecord(execution) || !isRecord(execution.counts) || !Array.isArray(execution.orders)) {
      invalidApiPayload(path, 'execution non contiene counts e orders validi');
    }
    if (Object.values(execution.counts).some((count) => (
      typeof count !== 'number' || !Number.isInteger(count) || count < 0
    ))) {
      invalidApiPayload(path, 'execution.counts contiene valori non validi');
    }
    for (const order of execution.orders) {
      if (
        !isRecord(order)
        || typeof order.symbol !== 'string'
        || !order.symbol.trim()
        || typeof order.side !== 'string'
        || !order.side.trim()
        || typeof order.amountUsd !== 'number'
        || !Number.isFinite(order.amountUsd)
        || order.amountUsd < 0
        || typeof order.state !== 'string'
        || !order.state.trim()
        || !(order.message === null || typeof order.message === 'string')
      ) {
        invalidApiPayload(path, 'execution.orders contiene un ordine non valido');
      }
    }
  }
  if (status === 'ok' && (plan === undefined || plan === null || execution === undefined)) {
    invalidApiPayload(path, 'una run riuscita non contiene il riepilogo di piano ed esecuzione');
  }

  return value as unknown as LiveActivationResult;
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
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
  if (!isJsonContentType(response.headers.get('content-type'))) {
    const received = response.headers.get('content-type')?.split(';', 1)[0] || 'contenuto senza Content-Type';
    const message = response.ok
      ? `L’URL configurato non punta all’API Autopilot: ricevuto ${received} invece di JSON. Usa solo l’origine del Worker, senza /autopilot o /agent.`
      : `Il server ha risposto HTTP ${response.status} con ${received} invece di JSON. Controlla l’URL del Worker.`;
    throw new AutopilotError(message, response.ok ? 502 : response.status);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new AutopilotError(`Il Worker ha restituito JSON non leggibile per ${path}. Riprova o aggiorna il deployment.`, 502);
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new AutopilotError(message, response.status);
  }
  if (!isRecord(body)) invalidApiPayload(path, 'era atteso un oggetto JSON');
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
  state: async () => validateStatePayload(await call<unknown>('/agent/state')),
  runs: async (limit = 30) => validateRunsPayload(await call<unknown>(`/agent/runs?limit=${limit}`)),
  run: (id: string) => call<RunBundle>(`/agent/runs/${encodeURIComponent(id)}`),
  improveRun: (id: string) => call<{ runId: string; status: string; error?: string; reason?: string; improvedFromRunId: string }>(`/agent/runs/${encodeURIComponent(id)}/improve`, { method: 'POST', body: '{}' }),
  retryRun: (id: string) => call<{ runId: string; status: string; error?: string; reason?: string; retriedFromRunId: string }>(`/agent/runs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  config: () => call<{ config: AutopilotConfig; defaults: AutopilotConfig }>('/agent/config'),
  updateConfig: (patch: Partial<AutopilotConfig>) =>
    call<{ config: AutopilotConfig; applied: string[]; rejected: string[] }>('/agent/config', { method: 'PUT', body: JSON.stringify(patch) }),
  setMode: (mode: Exclude<ExecutionMode, 'live'>) =>
    call<{ config: AutopilotConfig }>('/agent/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  activateLive: async (request: {
    activationId: string;
    confirmation: typeof LIVE_CONFIRMATION;
    acknowledgePersistentLive: true;
  }) => validateLiveActivationPayload(
    await call<unknown>('/agent/live/activate-and-run', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
    request.activationId,
  ),
  freeze: (reason: string) => call<{ config: AutopilotConfig }>('/agent/freeze', { method: 'POST', body: JSON.stringify({ reason }) }),
  safeStop: (reason: string) => call<{ config: AutopilotConfig }>('/agent/safe-stop', { method: 'POST', body: JSON.stringify({ reason }) }),
  unfreeze: (request: { safetyRevision: number; confirmation?: typeof LIVE_RECOVERY_CONFIRMATION }) =>
    call<{ config: AutopilotConfig }>('/agent/unfreeze', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  trigger: (kind: 'snapshot' | 'rebalance', mode?: Exclude<ExecutionMode, 'live'>) =>
    call<{ runId: string; status: string; error?: string }>('/agent/trigger', {
      method: 'POST',
      body: JSON.stringify({ kind, mode }),
    }),
  freeModels: () => call<{ models: Array<{ id: string; name: string; contextLength: number | null; recommendedRank?: number | null; fit?: string | null; reasoning?: boolean; structuredOutput?: boolean }>; providers: LlmProvider[] }>('/agent/models'),
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
  }) => call<{ ok: true; config: AutopilotConfig; strategySpec: Record<string, unknown>; scenario: Record<string, unknown>; draft: TDraft; telegramQueued: boolean }>('/agent/strategy/activate', {
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
