import type { LiveSettings } from '../settings';
import type { StrategyPortfolioConfig } from './strategy-portfolios';

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
}

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

function apiHeaders(settings: LiveSettings): HeadersInit {
  return {
    'x-api-key': settings.apiKey,
    'x-user-key': settings.userKey,
    'x-request-id': crypto.randomUUID(),
    'Content-Type': 'application/json',
  };
}

function apiUrl(settings: LiveSettings, path: string): string {
  return `${settings.proxyUrl.replace(/\/+$/, '')}${path}`;
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
      agentPortfolioDescription: `Torino — strategia ${config.templateId}; max ${config.maxPositions} posizioni; ${config.cashReservePct}% liquidità.`,
    }),
  });
  const body = await parseResponse(response);
  const normalized = normalizeRemote(body);
  if (!normalized) throw new Error('eToro non ha restituito l’identificativo del nuovo Agent Portfolio.');
  const record = unwrap(body);
  const tokens = firstValue(record, 'userTokens', 'UserTokens');
  const tokenRecord = Array.isArray(tokens) ? asRecord(tokens[0]) : {};
  return {
    ...normalized,
    tokenName: String(firstValue(tokenRecord, 'userTokenName', 'UserTokenName', 'name', 'Name') ?? tokenName),
  };
}
