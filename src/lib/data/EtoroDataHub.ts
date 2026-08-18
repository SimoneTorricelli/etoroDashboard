import type { LiveSettings } from '../settings';

export interface BalanceSnapshotDetail {
  date: string;
  totalBalance: number;
  totalCash: number;
  totalInvested: number;
  totalPnl: number;
}

export interface CashTransactionDetail {
  id: string;
  accountId: string;
  type: string;
  subtype: string;
  direction: string;
  status: string;
  amount: number;
  currency: string;
  postedAt: string;
  isPotentialDividend: boolean;
}

export interface WatchlistSummary {
  id: string;
  name: string;
  totalItems: number;
  isDefault: boolean;
}

export interface RemoteAlertSummary {
  id: string;
  instrumentId: number;
  symbol: string;
  targetPrice: number;
  currentPrice?: number;
  createdAt?: string;
}

export interface NotificationSummary {
  id: string;
  message: string;
  category?: string;
  publishedAt?: string;
  actionLink?: string;
}

export interface PopularInvestorSummary {
  cid: number;
  username: string;
  fullName?: string;
  avatarUrl?: string;
  gain: number;
  annualizedReturn: number;
  riskScore: number;
  copiers: number;
  drawdown: number;
  winRatio: number;
  profitableMonthsPct: number;
}

export type HubCapabilityKey = 'balances' | 'trades' | 'cash' | 'watchlists' | 'alerts' | 'notifications' | 'rankings';

export interface HubCapability {
  key: HubCapabilityKey;
  status: 'ok' | 'empty' | 'unavailable';
  count: number;
  detail: string;
}

export interface EtoroDataHubSnapshot {
  balances: BalanceSnapshotDetail[];
  closedTradesCount: number;
  closedPnl: number;
  profitableTradesPct?: number;
  cashTransactions: CashTransactionDetail[];
  watchlists: WatchlistSummary[];
  watchlistInstrumentIds: number[];
  priceAlerts: RemoteAlertSummary[];
  notifications: NotificationSummary[];
  popularInvestors: PopularInvestorSummary[];
  capabilities: HubCapability[];
  asOf: number;
}

const SESSION_KEY = 'torino.etoro-data-hub.v1';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

async function getJson(settings: LiveSettings, path: string): Promise<unknown> {
  const url = `${settings.proxyUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'x-api-key': settings.apiKey,
      'x-user-key': settings.userKey,
      'x-request-id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  });
  const raw = await response.text();
  let body: unknown = {};
  try { body = raw ? JSON.parse(raw) as unknown : {}; } catch { body = { message: raw }; }
  if (!response.ok) {
    const bodyRecord = record(body);
    throw new Error(text(pick(bodyRecord, 'errorMessage', 'message', 'error')) || `HTTP ${response.status}`);
  }
  return body;
}

async function mutateJson(settings: LiveSettings, path: string, method: 'POST' | 'DELETE', body: unknown): Promise<void> {
  const url = `${settings.proxyUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    headers: {
      'x-api-key': settings.apiKey,
      'x-user-key': settings.userKey,
      'x-request-id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    throw new Error(raw.slice(0, 240) || `HTTP ${response.status}`);
  }
}

export async function updateEtoroWatchlistItem(
  settings: LiveSettings,
  watchlistId: string,
  instrumentId: number,
  add: boolean,
): Promise<void> {
  const item = { itemId: instrumentId, itemType: 'Instrument', itemRank: 0, itemAddedReason: 'Manual', itemAddedDate: new Date().toISOString() };
  await mutateJson(settings, `api/v1/watchlists/${encodeURIComponent(watchlistId)}/items`, add ? 'POST' : 'DELETE', [item]);
}

function rowsFrom(body: unknown, ...keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return list(body);
  const bodyRecord = record(body);
  for (const key of keys) {
    const rows = list(bodyRecord[key]);
    if (rows.length > 0) return rows;
  }
  const nested = record(pick(bodyRecord, 'data', 'Data', 'result', 'Result'));
  for (const key of keys) {
    const rows = list(nested[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function capability(key: HubCapabilityKey, result: PromiseSettledResult<unknown>, count: number, okDetail: string): HubCapability {
  if (result.status === 'rejected') return { key, status: 'unavailable', count: 0, detail: result.reason instanceof Error ? result.reason.message : 'Permesso o endpoint non disponibile' };
  return { key, status: count > 0 ? 'ok' : 'empty', count, detail: count > 0 ? okDetail : 'Endpoint disponibile, nessun elemento restituito' };
}

export function loadEtoroDataHubSnapshot(): EtoroDataHubSnapshot | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) as EtoroDataHubSnapshot : null;
  } catch { return null; }
}

export async function syncEtoroDataHub(settings: LiveSettings): Promise<EtoroDataHubSnapshot> {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 364);
  const date = (value: Date) => value.toISOString().slice(0, 10);
  const requests = await Promise.allSettled([
    getJson(settings, `api/v1/balances/history?displayCurrency=USD&fromDate=${date(from)}&toDate=${date(now)}`),
    getJson(settings, `api/v1/trading/info/trade/history?minDate=${date(from)}&page=1&pageSize=500`),
    getJson(settings, 'api/v1/watchlists?pageNumber=0&itemsPerPage=100'),
    getJson(settings, 'api/v1/watchlists/default-watchlists/items?itemsPerPage=100'),
    getJson(settings, 'api/v1/price-alerts'),
    getJson(settings, 'api/v1/notifications/messages'),
    getJson(settings, 'api/v2/portfolios/rankings?period=OneYearAgo&sort=-copiers&page=1&pageSize=12&popularInvestor=true'),
  ]);

  const [balanceResult, tradeResult, watchlistResult, watchlistItemsResult, alertResult, notificationResult, rankingResult] = requests;
  const balanceBody = balanceResult.status === 'fulfilled' ? balanceResult.value : {};
  const balanceRows = rowsFrom(balanceBody, 'snapshots', 'Snapshots');
  const balances = balanceRows.map((item) => ({
    date: text(pick(item, 'date', 'Date')),
    totalBalance: number(pick(item, 'totalBalance', 'TotalBalance', 'displayTotalBalance')),
    totalCash: number(pick(item, 'totalCash', 'TotalCash', 'cash', 'Cash')),
    totalInvested: number(pick(item, 'totalInvestedAmount', 'TotalInvestedAmount', 'totalInvested', 'TotalInvested')),
    totalPnl: number(pick(item, 'totalPnl', 'TotalPnl', 'totalPnL', 'TotalPnL')),
  })).filter((item) => item.date && item.totalBalance > 0).sort((a, b) => a.date.localeCompare(b.date));

  const tradeRows = tradeResult.status === 'fulfilled' ? rowsFrom(tradeResult.value, 'items', 'Items', 'trades', 'Trades') : [];
  const closedPnl = tradeRows.reduce((sum, item) => sum + number(pick(item, 'netProfit', 'NetProfit')), 0);
  const profitableTrades = tradeRows.filter((item) => number(pick(item, 'netProfit', 'NetProfit')) > 0).length;

  const watchlistRows = watchlistResult.status === 'fulfilled' ? rowsFrom(watchlistResult.value, 'watchlists', 'Watchlists', 'items', 'Items') : [];
  const watchlists = watchlistRows.map((item) => ({
    id: text(pick(item, 'watchlistId', 'WatchlistId', 'id', 'Id')),
    name: text(pick(item, 'name', 'Name')) || 'Watchlist',
    totalItems: number(pick(item, 'totalItems', 'TotalItems')),
    isDefault: Boolean(pick(item, 'isDefault', 'IsDefault', 'isUserSelectedDefault', 'IsUserSelectedDefault')),
  })).filter((item) => item.id);
  const watchlistItemRows = watchlistItemsResult.status === 'fulfilled' ? rowsFrom(watchlistItemsResult.value, 'items', 'Items', 'results', 'Results') : [];
  const watchlistInstrumentIds = [...new Set(watchlistItemRows
    .filter((item) => text(pick(item, 'itemType', 'ItemType')).toLowerCase() !== 'person')
    .map((item) => number(pick(item, 'itemId', 'ItemId', 'instrumentId', 'InstrumentId')))
    .filter((item) => item > 0))];

  const alertRows = alertResult.status === 'fulfilled' ? rowsFrom(alertResult.value, 'results', 'Results', 'alerts', 'Alerts') : [];
  const priceAlerts = alertRows.map((item) => ({
    id: text(pick(item, 'alertId', 'AlertId', 'id', 'Id')),
    instrumentId: number(pick(item, 'instrumentId', 'InstrumentId', 'InstrumentID')),
    symbol: text(pick(item, 'symbol', 'Symbol')),
    targetPrice: number(pick(item, 'targetPrice', 'TargetPrice')),
    currentPrice: number(pick(item, 'currentPrice', 'CurrentPrice')) || undefined,
    createdAt: text(pick(item, 'createdAt', 'CreatedAt')) || undefined,
  })).filter((item) => item.id);

  const notificationRecord = notificationResult.status === 'fulfilled' ? record(notificationResult.value) : {};
  const notificationRows = notificationResult.status === 'fulfilled' ? rowsFrom(notificationResult.value, 'messages', 'Messages') : [];
  const notifications = notificationRows.map((item) => ({
    id: text(pick(item, 'messageId', 'MessageId', 'id', 'Id')),
    message: text(pick(item, 'message', 'Message', 'imageTitle', 'ImageTitle')),
    category: text(pick(item, 'category', 'Category', 'notificationType', 'NotificationType')) || undefined,
    publishedAt: text(pick(item, 'publishDate', 'PublishDate')) || undefined,
    actionLink: text(pick(item, 'actionLink', 'ActionLink')) || undefined,
  })).filter((item) => item.id);

  const rankingRows = rankingResult.status === 'fulfilled' ? rowsFrom(rankingResult.value, 'results', 'Results') : [];
  const popularInvestors = rankingRows.map((item) => ({
    cid: number(pick(item, 'cid', 'CID')),
    username: text(pick(item, 'username', 'Username')),
    fullName: text(pick(item, 'fullName', 'FullName')) || undefined,
    avatarUrl: text(pick(item, 'avatarUrl', 'AvatarUrl')) || undefined,
    gain: number(pick(item, 'gain', 'Gain')),
    annualizedReturn: number(pick(item, 'annualizedReturn', 'AnnualizedReturn')),
    riskScore: number(pick(item, 'riskScore', 'RiskScore')),
    copiers: number(pick(item, 'copiers', 'Copiers')),
    drawdown: number(pick(item, 'peakToValley', 'PeakToValley', 'dailyDD', 'DailyDD')),
    winRatio: number(pick(item, 'winRatio', 'WinRatio')),
    profitableMonthsPct: number(pick(item, 'profitableMonthsPct', 'ProfitableMonthsPct')),
  })).filter((item) => item.cid > 0 || item.username);

  const accountIds = new Set<string>();
  for (const snapshot of balanceRows) {
    for (const account of list(pick(snapshot, 'accountSnapshots', 'AccountSnapshots', 'accounts', 'Accounts'))) {
      const accountType = text(pick(account, 'accountType', 'AccountType', 'type', 'Type')).toLowerCase();
      const accountId = text(pick(account, 'accountId', 'AccountId', 'id', 'Id'));
      if (accountId && (!accountType || accountType.includes('cash') || accountType.includes('money'))) accountIds.add(accountId);
    }
  }
  const cashResults = await Promise.allSettled([...accountIds].slice(0, 3).map((accountId) =>
    getJson(settings, `api/v1/money/accounts/cash/${encodeURIComponent(accountId)}/transactions?limit=100`),
  ));
  const cashRows = cashResults.flatMap((result) => result.status === 'fulfilled' ? rowsFrom(result.value, 'transactions', 'Transactions', 'items', 'Items', 'results', 'Results') : []);
  const cashTransactions = cashRows.map((item) => {
    const type = text(pick(item, 'transactionType', 'TransactionType', 'type', 'Type'));
    const subtype = text(pick(item, 'transactionSubtype', 'TransactionSubtype', 'subtype', 'Subtype'));
    return {
      id: text(pick(item, 'id', 'Id', 'transactionId', 'TransactionId')),
      accountId: text(pick(item, 'accountId', 'AccountId')),
      type,
      subtype,
      direction: text(pick(item, 'direction', 'Direction')),
      status: text(pick(item, 'status', 'Status')),
      amount: number(pick(item, 'amount', 'Amount')),
      currency: text(pick(item, 'currency', 'Currency')) || 'USD',
      postedAt: text(pick(item, 'postedAt', 'PostedAt', 'createdAt', 'CreatedAt')),
      isPotentialDividend: /dividend|distribution|income/i.test(`${type} ${subtype}`),
    };
  }).filter((item) => item.id);

  const notSeen = number(pick(record(pick(notificationRecord, 'meta', 'Meta')), 'notSeen', 'NotSeen'));
  const cashCapability: HubCapability = accountIds.size === 0
    ? { key: 'cash', status: 'empty', count: 0, detail: 'Nessun account Cash identificato negli snapshot saldo' }
    : cashResults.some((result) => result.status === 'fulfilled')
      ? { key: 'cash', status: cashTransactions.length ? 'ok' : 'empty', count: cashTransactions.length, detail: cashTransactions.length ? `${cashTransactions.length} movimenti cash letti` : 'Account Cash disponibile, nessun movimento restituito' }
      : { key: 'cash', status: 'unavailable', count: 0, detail: 'Permesso Cash Transactions non disponibile' };

  const snapshot: EtoroDataHubSnapshot = {
    balances,
    closedTradesCount: tradeRows.length,
    closedPnl,
    profitableTradesPct: tradeRows.length ? profitableTrades / tradeRows.length * 100 : undefined,
    cashTransactions,
    watchlists,
    watchlistInstrumentIds,
    priceAlerts,
    notifications,
    popularInvestors,
    capabilities: [
      capability('balances', balanceResult, balances.length, `${balances.length} snapshot giornalieri reali`),
      capability('trades', tradeResult, tradeRows.length, `${tradeRows.length} operazioni chiuse`),
      cashCapability,
      capability('watchlists', watchlistResult, watchlists.length, `${watchlists.length} watchlist sincronizzate`),
      capability('alerts', alertResult, priceAlerts.length, `${priceAlerts.length} price alert eToro`),
      capability('notifications', notificationResult, notifications.length, `${notSeen} notifiche non viste`),
      capability('rankings', rankingResult, popularInvestors.length, `${popularInvestors.length} Popular Investor analizzati`),
    ],
    asOf: Date.now(),
  };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot)); } catch { /* cache di sessione opzionale */ }
  return snapshot;
}
