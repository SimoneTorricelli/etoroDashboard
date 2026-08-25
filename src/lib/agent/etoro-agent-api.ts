import type { LiveSettings } from '../settings';
import type { StrategyOrderPlan, StrategyOrderReceipt, StrategyPortfolioConfig } from './strategy-portfolios';

export interface RemoteAgentPortfolio {
  id: string;
  name: string;
  virtualBalanceUsd?: number;
  mirrorId?: string;
  createdAt?: string;
  tokenAvailable: boolean;
}

export interface CreateRemoteAgentPortfolioResult extends RemoteAgentPortfolio {
  tokenName?: string;
  /** Segreto restituito una sola volta da eToro. Non deve finire in localStorage. */
  userToken?: string;
}

export interface AgentOrderExecutionResult {
  ok: boolean;
  submitted: number;
  filled: number;
  partial: number;
  pending: number;
  failed: number;
  residualVirtualUsd: number;
  residualMirrorUsd: number;
  receipts: StrategyOrderReceipt[];
  messages: string[];
}

export interface AgentOrderEligibilityCheck {
  symbol: string;
  instrumentId: number;
  allowOpenPosition: boolean;
  minPositionExposureUsd: number;
  smallestOrderUsd: number;
  eligible: boolean;
  detail: string;
}

export interface AgentPlanValidation {
  ok: boolean;
  checks: AgentOrderEligibilityCheck[];
  blockingIssues: string[];
  checkedAt: number;
}

const SESSION_TOKEN_PREFIX = 'torino.agent-session-token.';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function unwrap(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const nested = record.data ?? record.result ?? record.agentPortfolio ?? record.AgentPortfolio;
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? asRecord(nested) : record;
}

function apiHeaders(settings: LiveSettings, userKey = settings.userKey, requestId = crypto.randomUUID()): Record<string, string> {
  return {
    'x-api-key': settings.apiKey,
    'x-user-key': userKey,
    'x-request-id': requestId,
    'Content-Type': 'application/json',
  };
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item) => Object.keys(item).length > 0)
    : [];
}

function tokenSecretFrom(value: unknown): string {
  const record = unwrap(value);
  const direct = firstValue(record, 'userTokenValue', 'UserTokenValue', 'tokenValue', 'TokenValue', 'userToken', 'UserToken', 'token', 'Token', 'value', 'Value');
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const nested = asRecord(firstValue(record, 'userToken', 'UserToken', 'token', 'Token'));
  const nestedValue = firstValue(nested, 'userTokenValue', 'UserTokenValue', 'tokenValue', 'TokenValue', 'userToken', 'UserToken', 'token', 'Token', 'value', 'Value');
  return typeof nestedValue === 'string' ? nestedValue.trim() : '';
}

function apiUrl(settings: LiveSettings, path: string): string {
  return `${settings.proxyUrl.replace(/\/+$/, '')}${path}`;
}

export function saveAgentSessionToken(agentPortfolioId: string, token: string): void {
  if (!agentPortfolioId || !token) return;
  try { sessionStorage.setItem(`${SESSION_TOKEN_PREFIX}${agentPortfolioId}`, token); } catch { /* sessione non disponibile */ }
}

export function loadAgentSessionToken(agentPortfolioId: string): string | null {
  try { return sessionStorage.getItem(`${SESSION_TOKEN_PREFIX}${agentPortfolioId}`); } catch { return null; }
}

export function clearAgentSessionToken(agentPortfolioId: string): void {
  try { sessionStorage.removeItem(`${SESSION_TOKEN_PREFIX}${agentPortfolioId}`); } catch { /* sessione non disponibile */ }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) as unknown : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const record = asRecord(body);
    const nestedError = asRecord(firstValue(record, 'error', 'Error', 'data', 'Data'));
    const rawError = firstValue(record, 'error', 'Error');
    const code = firstValue(record, 'errorCode', 'ErrorCode', 'code', 'Code')
      ?? firstValue(nestedError, 'errorCode', 'ErrorCode', 'code', 'Code');
    const detail = firstValue(record, 'errorMessage', 'ErrorMessage', 'message', 'Message', 'detail', 'Detail')
      ?? firstValue(nestedError, 'errorMessage', 'ErrorMessage', 'message', 'Message', 'detail', 'Detail')
      ?? (typeof rawError === 'string' ? rawError : undefined);
    const codeText = code == null ? '' : String(code).trim();
    const detailText = detail == null ? '' : String(detail).trim();
    const message = codeText && detailText && codeText.toLowerCase() !== detailText.toLowerCase()
      ? `${codeText}: ${detailText}`
      : detailText || codeText || `Errore HTTP ${response.status}`;
    throw new Error(`${response.status} — ${message}`);
  }
  return body;
}

const REQUIRED_AGENT_SCOPES = [
  'etoro-public:trade.real:read',
  'etoro-public:trade.real:write',
] as const;

async function assertAgentPortfolioV2Available(settings: LiveSettings): Promise<void> {
  let body: unknown;
  try {
    const response = await fetch(apiUrl(settings, '/api/v2/agent-portfolios/user-tokens/scopes'), {
      method: 'GET',
      headers: apiHeaders(settings),
      cache: 'no-store',
    });
    body = await parseResponse(response);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Pre-verifica Agent Portfolio v2 non riuscita. Aggiorna il Worker v1/v2 e controlla i permessi eToro. Dettaglio: ${detail}`);
  }

  const record = asRecord(body);
  const nested = asRecord(firstValue(record, 'data', 'Data'));
  const scopes = firstValue(record, 'scopes', 'Scopes') ?? firstValue(nested, 'scopes', 'Scopes');
  const allowed = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .map((scope) => {
        if (typeof scope === 'string') return scope;
        const scopeRecord = asRecord(scope);
        return String(firstValue(scopeRecord, 'name', 'Name') ?? '');
      })
      .filter(Boolean),
  );
  const missing = REQUIRED_AGENT_SCOPES.filter((scope) => !allowed.has(scope));
  if (missing.length > 0) {
    throw new Error(`eToro non consente gli scope richiesti per questo Agent Portfolio: ${missing.join(', ')}.`);
  }
}

function normalizeRemote(value: unknown): RemoteAgentPortfolio | null {
  const record = unwrap(value);
  const id = firstValue(record, 'agentPortfolioId', 'AgentPortfolioId', 'id', 'Id');
  if (id === undefined || id === null) return null;
  const tokens = firstValue(record, 'userTokens', 'UserTokens');
  return {
    id: String(id),
    name: String(firstValue(record, 'agentPortfolioName', 'AgentPortfolioName', 'name', 'Name') ?? 'Agent Portfolio'),
    virtualBalanceUsd: Number(firstValue(record, 'agentPortfolioVirtualBalance', 'AgentPortfolioVirtualBalance', 'virtualBalance') ?? 0) || undefined,
    mirrorId: firstValue(record, 'mirrorId', 'MirrorId') ? String(firstValue(record, 'mirrorId', 'MirrorId')) : undefined,
    createdAt: firstValue(record, 'createdAt', 'CreatedAt') ? String(firstValue(record, 'createdAt', 'CreatedAt')) : undefined,
    tokenAvailable: Array.isArray(tokens) && tokens.length > 0,
  };
}

export async function listAgentPortfolios(settings: LiveSettings): Promise<RemoteAgentPortfolio[]> {
  const response = await fetch(apiUrl(settings, '/api/v1/agent-portfolios'), {
    method: 'GET',
    headers: apiHeaders(settings),
    cache: 'no-store',
  });
  const body = await parseResponse(response);
  const record = asRecord(body);
  const nested = asRecord(firstValue(record, 'data', 'Data'));
  const list = Array.isArray(body)
    ? body
    : firstValue(record, 'agentPortfolios', 'AgentPortfolios', 'items', 'Items')
      ?? firstValue(nested, 'agentPortfolios', 'AgentPortfolios', 'items', 'Items');
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRemote).filter((item): item is RemoteAgentPortfolio => item !== null);
}

export async function createAgentPortfolio(
  settings: LiveSettings,
  config: StrategyPortfolioConfig,
): Promise<CreateRemoteAgentPortfolioResult> {
  // GET di sicurezza: verifica routing v2 e scope prima della POST che muove fondi reali.
  await assertAgentPortfolioV2Available(settings);
  const tokenName = `${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-token`.slice(0, 32);
  const response = await fetch(apiUrl(settings, '/api/v2/agent-portfolios'), {
    method: 'POST',
    headers: apiHeaders(settings),
    cache: 'no-store',
    body: JSON.stringify({
      investmentAmountInUsd: Math.round(config.budgetUsd * 100) / 100,
      agentPortfolioName: config.name.trim(),
      userTokenName: tokenName,
      scopeNames: [...REQUIRED_AGENT_SCOPES],
      agentPortfolioDescription: `Torri — strategia ${config.templateId}; max ${config.maxPositions} posizioni; ${config.cashReservePct}% liquidità.`,
    }),
  });
  const body = await parseResponse(response);
  const normalized = normalizeRemote(body);
  if (!normalized) throw new Error('eToro non ha restituito l’identificativo del nuovo Agent Portfolio.');
  const record = unwrap(body);
  const tokens = firstValue(record, 'userTokens', 'UserTokens');
  const tokenRecord = Array.isArray(tokens) ? asRecord(tokens[0]) : {};
  const userToken = tokenSecretFrom(Object.keys(tokenRecord).length > 0 ? tokenRecord : record);
  if (userToken) saveAgentSessionToken(normalized.id, userToken);
  return {
    ...normalized,
    tokenName: String(firstValue(tokenRecord, 'userTokenName', 'UserTokenName', 'name', 'Name') ?? tokenName),
    userToken: userToken || undefined,
  };
}

export async function createAgentUserToken(
  settings: LiveSettings,
  agentPortfolioId: string,
  tokenLabel: string,
): Promise<string> {
  await assertAgentPortfolioV2Available(settings);
  const response = await fetch(apiUrl(settings, `/api/v2/agent-portfolios/${encodeURIComponent(agentPortfolioId)}/user-tokens`), {
    method: 'POST',
    headers: apiHeaders(settings),
    cache: 'no-store',
    body: JSON.stringify({
      userTokenName: tokenLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32),
      scopeNames: [...REQUIRED_AGENT_SCOPES],
    }),
  });
  const body = await parseResponse(response);
  const record = unwrap(body);
  const token = tokenSecretFrom(record);
  if (!token) throw new Error('eToro ha creato il token ma non ne ha restituito il segreto utilizzabile.');
  saveAgentSessionToken(agentPortfolioId, token);
  return token;
}

/**
 * Pre-check non operativo: legge i minimi e l'ammissibilità direttamente
 * dall'account virtuale dell'Agent. Non crea né modifica ordini.
 */
export async function validateAgentAllocationPlan(
  settings: LiveSettings,
  plan: StrategyOrderPlan,
  agentUserToken: string,
): Promise<AgentPlanValidation> {
  if (!agentUserToken) throw new Error('Token operativo Agent assente dalla sessione.');
  const ids = [...new Set(plan.orders.map((item) => item.instrumentId).filter((id) => id > 0))];
  if (ids.length === 0) throw new Error('Il piano non contiene strumenti verificabili.');
  const response = await fetch(apiUrl(settings, '/api/v2/trading/info/eligibility'), {
    method: 'POST',
    headers: apiHeaders(settings, agentUserToken),
    cache: 'no-store',
    body: JSON.stringify({ instrumentIds: ids, currency: 'USD' }),
  });
  const body = unwrap(await parseResponse(response));
  const rows = recordList(firstValue(body, 'eligibilities', 'Eligibilities'));
  const byId = new Map(rows.map((row) => [Number(firstValue(row, 'instrumentId', 'InstrumentId') ?? 0), row]));
  const blockingIssues = [...plan.unresolvedSymbols.map((symbol) => `${symbol}: strumento non risolto` )];
  const checks = plan.orders.map((item) => {
    const row = byId.get(item.instrumentId);
    const leverageConfigs = recordList(firstValue(row ?? {}, 'leverageConfigs', 'LeverageConfigs'));
    const longLeverageOneMins = leverageConfigs
      .filter((config) => {
        const direction = String(firstValue(config, 'direction', 'Direction') ?? '').toUpperCase();
        const values = firstValue(config, 'leverageValues', 'LeverageValues');
        return (!direction || direction === 'LONG') && Array.isArray(values) && values.map(Number).includes(1);
      })
      .map((config) => Number(firstValue(config, 'minPositionAmount', 'MinPositionAmount') ?? 0) || 0)
      .filter((value) => value > 0);
    const brokerMin = Math.max(
      Number(firstValue(row ?? {}, 'minPositionExposure', 'MinPositionExposure') ?? 0) || 0,
      longLeverageOneMins.length > 0 ? Math.min(...longLeverageOneMins) : 0,
    );
    const allowOpenPosition = Boolean(firstValue(row ?? {}, 'allowOpenPosition', 'AllowOpenPosition'));
    const smallestOrderUsd = item.chunks.length > 0 ? Math.min(...item.chunks) : 0;
    let detail = 'Ordine ammesso';
    if (!row) detail = 'eToro non ha restituito l’ammissibilità';
    else if (!allowOpenPosition) detail = 'Apertura non consentita ora: mercato chiuso o strumento non negoziabile';
    else if (smallestOrderUsd + 0.005 < brokerMin) detail = `Minimo eToro ${brokerMin.toFixed(2)} USD`;
    const eligible = Boolean(row) && allowOpenPosition && smallestOrderUsd + 0.005 >= brokerMin;
    if (!eligible) blockingIssues.push(`${item.symbol}: ${detail}`);
    return { symbol: item.symbol, instrumentId: item.instrumentId, allowOpenPosition, minPositionExposureUsd: brokerMin, smallestOrderUsd, eligible, detail };
  });
  return { ok: blockingIssues.length === 0, checks, blockingIssues, checkedAt: Date.now() };
}

export function summarizeAgentOrderReceipts(receipts: StrategyOrderReceipt[], scale: number): AgentOrderExecutionResult {
  const submitted = receipts.filter((item) => item.orderId != null || item.status !== 'failed').length;
  const filled = receipts.filter((item) => item.status === 'filled').length;
  const partial = receipts.filter((item) => item.status === 'partially-filled').length;
  const pending = receipts.filter((item) => item.status === 'accepted' || item.status === 'pending').length;
  const failed = receipts.filter((item) => item.status === 'failed' || item.status === 'rejected').length;
  const residualVirtualUsd = Math.round(receipts.reduce((sum, item) => sum + Math.max(0, item.requestedVirtualAmountUsd - item.filledVirtualAmountUsd), 0) * 100) / 100;
  const residualMirrorUsd = scale > 0 ? Math.round(residualVirtualUsd / scale * 100) / 100 : residualVirtualUsd;
  return {
    ok: receipts.length > 0 && filled === receipts.length,
    submitted,
    filled,
    partial,
    pending,
    failed,
    residualVirtualUsd,
    residualMirrorUsd,
    receipts,
    messages: receipts.map((item) => `${item.symbol}: ${item.statusLabel}${item.error ? ` — ${item.error}` : ''}`),
  };
}

async function checkAgentOrderReceipts(
  settings: LiveSettings,
  receipts: StrategyOrderReceipt[],
  agentUserToken: string,
): Promise<StrategyOrderReceipt[]> {
  return Promise.all(receipts.map(async (receipt) => {
    if (receipt.status === 'filled' || receipt.status === 'partially-filled' || receipt.status === 'failed' || receipt.status === 'rejected') return receipt;
    const query = receipt.orderId != null
      ? `orderId=${encodeURIComponent(String(receipt.orderId))}`
      : `referenceId=${encodeURIComponent(receipt.referenceId)}`;
    try {
      const response = await fetch(apiUrl(settings, `/api/v2/trading/info/orders:lookup?${query}`), {
        method: 'GET',
        headers: apiHeaders(settings, agentUserToken),
        cache: 'no-store',
      });
      const body = unwrap(await parseResponse(response));
      const statusRecord = asRecord(firstValue(body, 'status', 'Status'));
      const rawStatus = String(firstValue(statusRecord, 'name', 'Name') ?? firstValue(body, 'statusName', 'StatusName') ?? 'Pending');
      const normalized = rawStatus.toLowerCase();
      const statusId = Number(firstValue(statusRecord, 'id', 'Id') ?? 0) || 0;
      const executions = recordList(firstValue(body, 'positionExecutions', 'PositionExecutions'));
      const positionIds = executions.map((item) => Number(firstValue(item, 'positionId', 'PositionId', 'PositionID') ?? 0)).filter((id) => id > 0);
      const reportedFilled = executions.reduce((sum, item) => sum + (Number(firstValue(item, 'investedAmountCurrency', 'InvestedAmountCurrency', 'initialExposureAccountCurrency', 'InitialExposureAccountCurrency') ?? 0) || 0), 0);
      const isPartiallyFilled = statusId === 5 || statusId === 10 || /partial/.test(normalized);
      const isFilled = statusId === 3 || (!isPartiallyFilled && /filled|executed|completed/.test(normalized));
      const isRejected = statusId === 4 || (!isPartiallyFilled && /reject|cancel|fail|expired/.test(normalized));
      const error = String(firstValue(statusRecord, 'errorMessage', 'ErrorMessage') ?? '').trim() || undefined;
      return {
        ...receipt,
        orderId: Number(firstValue(body, 'orderId', 'OrderId', 'OrderID') ?? receipt.orderId ?? 0) || receipt.orderId,
        status: isFilled ? 'filled' : isPartiallyFilled ? 'partially-filled' : isRejected ? 'rejected' : 'pending',
        statusLabel: rawStatus,
        filledVirtualAmountUsd: reportedFilled > 0 ? reportedFilled : isFilled ? receipt.requestedVirtualAmountUsd : 0,
        positionIds,
        error,
      };
    } catch (error) {
      // Un lookup appena dopo l'invio può non essere ancora indicizzato: resta pending.
      return { ...receipt, status: 'pending', statusLabel: 'In verifica', error: error instanceof Error ? error.message : undefined };
    }
  }));
}

async function waitForAgentOrderReceipts(
  settings: LiveSettings,
  receipts: StrategyOrderReceipt[],
  agentUserToken: string,
): Promise<StrategyOrderReceipt[]> {
  let current = receipts;
  // Due letture ravvicinate sono sufficienti per intercettare gli eseguiti
  // immediati senza moltiplicare le chiamate e rischiare un 429. Gli ordini
  // ancora pendenti restano salvati e vengono ricontrollati solo su richiesta.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    current = await checkAgentOrderReceipts(settings, current, agentUserToken);
    if (current.every((item) => item.status === 'filled' || item.status === 'partially-filled' || item.status === 'failed' || item.status === 'rejected')) break;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  return current;
}

export async function verifyAgentOrderExecutions(
  settings: LiveSettings,
  receipts: StrategyOrderReceipt[],
  agentUserToken: string,
  scale: number,
): Promise<AgentOrderExecutionResult> {
  if (!agentUserToken) throw new Error('Token operativo Agent assente dalla sessione.');
  const checked = await waitForAgentOrderReceipts(settings, receipts, agentUserToken);
  return summarizeAgentOrderReceipts(checked, scale);
}

/**
 * Esegue esclusivamente un piano già confermato dalla UI usando il token
 * dell'Agent Portfolio. Non viene mai richiamata durante bootstrap o test.
 */
export async function executeAgentAllocationPlan(
  settings: LiveSettings,
  plan: StrategyOrderPlan,
  agentUserToken: string,
  maxOrders: number,
): Promise<AgentOrderExecutionResult> {
  if (settings.permissions !== 'write') throw new Error('La chiave applicazione è configurata in sola lettura.');
  if (!agentUserToken) throw new Error('Token operativo Agent assente dalla sessione.');
  if (plan.unresolvedSymbols.length > 0) throw new Error(`Strumenti non risolti: ${plan.unresolvedSymbols.join(', ')}.`);
  const pending = plan.orders.flatMap((item) => item.chunks.map((amount) => ({ item, amount })));
  if (pending.length === 0) throw new Error('Il piano non contiene ordini eseguibili.');
  if (pending.length > maxOrders) throw new Error(`Il piano contiene ${pending.length} ordini, oltre il limite di ${maxOrders}.`);
  const validation = await validateAgentAllocationPlan(settings, plan, agentUserToken);
  if (!validation.ok) throw new Error(validation.blockingIssues.join(' · '));
  const receipts: StrategyOrderReceipt[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const { item, amount } = pending[index];
    const referenceId = crypto.randomUUID();
    const response = await fetch(apiUrl(settings, '/api/v2/trading/execution/orders'), {
      method: 'POST',
      headers: apiHeaders(settings, agentUserToken, referenceId),
      cache: 'no-store',
      body: JSON.stringify({
        action: 'open',
        transaction: 'buy',
        instrumentId: item.instrumentId,
        orderType: 'mkt',
        leverage: 1,
        amount,
        orderCurrency: 'usd',
      }),
    });
    try {
      const body = unwrap(await parseResponse(response));
      receipts.push({
        symbol: item.symbol,
        instrumentId: item.instrumentId,
        requestedVirtualAmountUsd: amount,
        orderId: Number(firstValue(body, 'orderId', 'OrderId', 'OrderID') ?? 0) || undefined,
        referenceId: String(firstValue(body, 'referenceId', 'ReferenceId') ?? referenceId),
        status: 'accepted',
        statusLabel: 'Accettato · verifica esecuzione',
        filledVirtualAmountUsd: 0,
        positionIds: [],
      });
    } catch (error) {
      receipts.push({ symbol: item.symbol, instrumentId: item.instrumentId, requestedVirtualAmountUsd: amount, referenceId, status: 'failed', statusLabel: 'Invio non riuscito', filledVirtualAmountUsd: 0, positionIds: [], error: error instanceof Error ? error.message : 'ordine non riuscito' });
      for (const skipped of pending.slice(index + 1)) {
        receipts.push({
          symbol: skipped.item.symbol,
          instrumentId: skipped.item.instrumentId,
          requestedVirtualAmountUsd: skipped.amount,
          referenceId: crypto.randomUUID(),
          status: 'failed',
          statusLabel: 'Non inviato',
          filledVirtualAmountUsd: 0,
          positionIds: [],
          error: 'Invio interrotto dopo il primo errore per evitare ordini parziali non controllati.',
        });
      }
      break;
    }
  }
  const checked = await waitForAgentOrderReceipts(settings, receipts, agentUserToken);
  return summarizeAgentOrderReceipts(checked, plan.scale);
}
