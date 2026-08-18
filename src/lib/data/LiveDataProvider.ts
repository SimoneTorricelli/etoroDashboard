/**
 * LiveDataProvider — eToro Public API.
 *
 * - REST via proxy CORS configurato dall'utente: le chiamate vanno a
 *   `{proxyUrl}/{path}` inoltrando gli header eToro (x-api-key, x-user-key,
 *   x-request-id UUID). eToro non supporta CORS, quindi il proxy è obbligatorio.
 * - WebSocket quotes `wss://ws.etoro.com/ws` best-effort, con fallback a
 *   polling REST ogni 20s se il socket fallisce.
 * - Backoff esponenziale su errori/429.
 * - Mapping risposte eToro (PascalCase) → types del data layer.
 */
import { ProviderEmitter } from './DataProvider';
import type { DataProvider } from './DataProvider';
import { RateLimitError, RequestManager } from './RequestManager';
import type { LiveSettings } from '../settings';
import type {
  Candle,
  CandleInterval,
  ConnectionStatus,
  CopyPortfolio,
  EquityPoint,
  FxRate,
  HistoricalClosingPrice,
  Instrument,
  LogEntry,
  OrderRequest,
  OrderResult,
  PnlSummary,
  Portfolio,
  Position,
  Quote,
  ClosedTrade,
} from './types';

const ETORO_WS_URL = 'wss://ws.etoro.com/ws';
const QUOTE_POLL_MS = 20_000;
const ACCOUNT_POLL_MS = 45_000;
const MAX_BACKOFF_MS = 60_000;
const ACCOUNT_TTL_MS = 30_000;
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const MARKET_HISTORY_TTL_MS = 10 * 60 * 1000;
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const INTRADAY_STORAGE_KEY = 'torino.intraday-equity.v1';
const SYMBOL_CACHE_KEY = 'torino.instrument-symbols.v1';

type ApiOptions = {
  ttlMs?: number;
  priority?: 'account' | 'visible' | 'history';
  lane?: 'default' | 'candles';
  signal?: AbortSignal;
  force?: boolean;
};

interface AccountSnapshot {
  portfolio: Portfolio;
  pnl: PnlSummary;
}

/* Strumenti noti minimo per search/mapping locale (il catalogo completo
 * arriverebbe da /market-data/instruments; qui teniamo un fallback compatto). */
const KNOWN: Array<[number, string, string, Instrument['assetClass'], string]> = [
  [1001, 'AAPL', 'Apple Inc.', 'stock', 'USD'],
  [1002, 'GOOG', 'Alphabet', 'stock', 'USD'],
  [1003, 'META', 'Meta Platforms Inc', 'stock', 'USD'],
];

const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX', 'MATIC', 'LTC', 'BNB', 'BCH', 'XLM', 'ATOM',
  'NEAR', 'ALGO', 'VET', 'FIL', 'ICP', 'MIOTA', 'SAND', 'MANA', 'AXS', 'CRV', 'COMP', 'CHZ', 'CELO', 'GRT', 'SUSHI',
  'ENJ', 'EGLD', 'FTM', 'ONE', 'FLOW', 'KSM', 'LRC', 'QNT', 'MKR', 'SNX', 'ZRX', 'OMG', 'BAT', 'DAI', 'USDT',
  'USDC', 'SHIB', 'LINK', 'UNI', 'AAVE', 'OP', 'ARB', 'APT', 'INJ', 'RUNE', 'PEPE', 'SKY',
]);

export class LiveDataProvider implements DataProvider {
  readonly mode = 'live' as const;
  private emitter = new ProviderEmitter();
  private requests = new RequestManager();
  private settings: LiveSettings;
  private status: ConnectionStatus = 'disconnected';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private quotePollTimer: ReturnType<typeof setTimeout> | null = null;
  private accountPollTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private wsFailed = false;
  private backoffMs = QUOTE_POLL_MS;
  private logSeq = 0;
  private watchedIds = new Set<number>();
  private fxInstrumentId = 0;
  private instrumentMetadataPromise: Promise<void> | null = null;
  private instrumentMetadataLoaded = new Set<number>();
  private instruments = new Map<number, Instrument>(
    KNOWN.map(([instrumentId, symbol, name, assetClass, currency]) => [
      instrumentId, { instrumentId, symbol, name, assetClass, currency },
    ]),
  );
  private lastFx: FxRate = { pair: 'EURUSD', rate: 0, prevClose: 0, changePct: 0, timestamp: 0 };
  private lastSnapshot: AccountSnapshot | null = null;
  private accountSnapshotPromise: Promise<AccountSnapshot> | null = null;
  private lastQuotes = new Map<number, Quote>();
  private closedTrades: ClosedTrade[] = [];

  constructor(settings: LiveSettings) {
    this.settings = settings;
  }

  updateSettings(settings: LiveSettings) {
    this.settings = settings;
  }

  /* ── HTTP via proxy ──────────────────────────────────────────────── */
  private headers(): Record<string, string> {
    return {
      'x-api-key': this.settings.apiKey,
      'x-user-key': this.settings.userKey,
      'x-request-id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    };
  }

  private async api<T>(path: string, init?: RequestInit, options: ApiOptions = {}): Promise<T> {
    const base = this.settings.proxyUrl.replace(/\/+$/, '');
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    const method = String(init?.method ?? 'GET').toUpperCase();
    const key = `${method}:${path}`;
    return this.requests.request<T>(key, async () => {
      const res = await fetch(url, {
        ...init,
        signal: options.signal ?? init?.signal,
        headers: { ...this.headers(), ...(init?.headers ?? {}) },
      });
      if (res.status === 429) {
        const error = this.requests.noteRateLimit(res.headers.get('Retry-After'));
        this.backoffMs = Math.min(Math.max(error.retryAt - Date.now(), 2_000), MAX_BACKOFF_MS);
        this.log('warn', `Quota eToro in pausa · nuovo tentativo tra ${Math.ceil(this.backoffMs / 1000)} s`);
        throw error;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`eToro API ${res.status}: ${body.slice(0, 200)}`);
      }
      this.backoffMs = QUOTE_POLL_MS;
      this.requests.noteSuccess();
      return (await res.json()) as T;
    }, {
      ttlMs: method === 'GET' ? options.ttlMs : 0,
      priority: options.priority,
      lane: options.lane,
      signal: options.signal,
      force: options.force,
    });
  }

  private envPrefix(): string {
    return 'real/';
  }

  private accountPayload(data: Record<string, unknown>): Record<string, unknown> {
    const nested = data['clientPortfolio'] ?? data['ClientPortfolio'] ?? data['portfolio'] ?? data['Portfolio'];
    return nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : data;
  }

  private recordList(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
  }

  private copyRecords(account: Record<string, unknown>): Array<Record<string, unknown>> {
    return this.recordList(
      account['copyPortfolios'] ?? account['CopyPortfolios']
      ?? account['copiedPortfolios'] ?? account['CopiedPortfolios']
      ?? account['mirrors'] ?? account['Mirrors'],
    );
  }

  private inferAssetClass(raw: Record<string, unknown>, instrumentId: number, symbol = '', name = ''): Instrument['assetClass'] {
    const rawClass = String(raw['assetClass'] ?? raw['AssetClass'] ?? raw['instrumentType'] ?? raw['InstrumentType'] ?? '').toLowerCase();
    if (rawClass.includes('crypto') || rawClass.includes('coin') || rawClass.includes('token')) return 'crypto';
    if (rawClass.includes('etf') || rawClass.includes('fund')) return 'etf';
    if (rawClass.includes('forex') || rawClass === 'fx' || rawClass.includes('currency')) return 'fx';
    if (rawClass.includes('index')) return 'index';
    if (rawClass.includes('cfd') || rawClass.includes('commodity')) return 'cfd';
    const normalized = `${symbol} ${name}`.toUpperCase();
    if ((instrumentId >= 1300 && instrumentId < 1400) || CRYPTO_SYMBOLS.has(symbol.toUpperCase()) || /BITCOIN|ETHEREUM|SOLANA|CARDANO|POLKADOT|AXIE|COMPOUND|CHILIZ|FILECOIN|DECENTRALAND|CURVE|CELO|CRYPTO|COIN|TOKEN/.test(normalized)) return 'crypto';
    if (/ETF|FUND/.test(normalized)) return 'etf';
    if (/EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF/.test(normalized)) return 'fx';
    return 'stock';
  }

  private positionPnl(raw: Record<string, unknown>): number {
    const unrealized = raw['unrealizedPnL'] ?? raw['UnrealizedPnL'] ?? raw['unrealizedPnl'];
    const nested = unrealized && typeof unrealized === 'object' && !Array.isArray(unrealized)
      ? unrealized as Record<string, unknown>
      : undefined;
    const value = nested?.['pnL'] ?? nested?.['PnL'] ?? nested?.['pnl'] ?? raw['pnL'] ?? raw['PnL'] ?? raw['pnl'] ?? raw['netProfit'];
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private positionCloseRate(raw: Record<string, unknown>): number | undefined {
    const unrealized = raw['unrealizedPnL'] ?? raw['UnrealizedPnL'] ?? raw['unrealizedPnl'];
    const nested = unrealized && typeof unrealized === 'object' && !Array.isArray(unrealized)
      ? unrealized as Record<string, unknown>
      : undefined;
    const value = raw['CloseRate'] ?? raw['closeRate'] ?? raw['CurrentRate'] ?? nested?.['closeRate'] ?? nested?.['CloseRate'];
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private mirrorSummary(account: Record<string, unknown>): { value: number; invested: number; pnl: number } {
    const mirrors = this.copyRecords(account);
    return mirrors.reduce<{ value: number; invested: number; pnl: number }>((summary, mirror) => {
      const positions = this.recordList(mirror['positions'] ?? mirror['Positions']);
      const positionAmount = positions.reduce((sum, position) => sum + Number(position['amount'] ?? position['Amount'] ?? 0), 0);
      const positionPnl = positions.reduce((sum, position) => sum + this.positionPnl(position), 0);
      const available = Number(mirror['availableAmount'] ?? mirror['AvailableAmount'] ?? 0);
      const closedPnl = Number(mirror['closedPositionsNetProfit'] ?? mirror['ClosedPositionsNetProfit'] ?? 0);
      const invested = positionAmount + available - closedPnl;
      const pnl = positionPnl + closedPnl;
      return {
        value: summary.value + invested + pnl,
        invested: summary.invested + invested,
        pnl: summary.pnl + pnl,
      };
    }, { value: 0, invested: 0, pnl: 0 });
  }

  private mapCopyPortfolio(raw: Record<string, unknown>, index: number): CopyPortfolio {
    const rawPositions = this.recordList(raw['positions'] ?? raw['Positions']);
    const positions = rawPositions.map((position, positionIndex) => {
      const mapped = this.mapPosition(position, positionIndex);
      // L'endpoint P&L può omettere PositionID: evita collisioni tra copie diverse.
      return mapped.positionId && !position['PositionID'] && !position['positionId']
        ? { ...mapped, positionId: mapped.positionId + (index + 1) * 1_000_000_000 }
        : mapped;
    });
    const positionInvested = positions.reduce((sum, position) => sum + position.invested, 0);
    const positionPnl = positions.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
    const available = Number(raw['availableAmount'] ?? raw['AvailableAmount'] ?? raw['cash'] ?? raw['Cash'] ?? 0);
    const reportedInvested = Number(raw['invested'] ?? raw['Invested'] ?? raw['amount'] ?? raw['Amount'] ?? raw['copyAmount'] ?? raw['CopyAmount'] ?? 0);
    const invested = Number.isFinite(reportedInvested) && reportedInvested > 0 ? reportedInvested : positionInvested + available;
    const reportedPnl = Number(raw['pnl'] ?? raw['PnL'] ?? raw['unrealizedPnL'] ?? raw['UnrealizedPnL'] ?? raw['netProfit'] ?? 0);
    const activeUnrealizedPnl = Number.isFinite(reportedPnl) && reportedPnl !== 0 ? reportedPnl : positionPnl;
    const closedRealizedPnl = Number(raw['closedPositionsNetProfit'] ?? raw['ClosedPositionsNetProfit'] ?? 0);
    const totalPnl = activeUnrealizedPnl + (Number.isFinite(closedRealizedPnl) ? closedRealizedPnl : 0);
    const pnl = totalPnl;
    const reportedValue = Number(raw['value'] ?? raw['Value'] ?? raw['currentValue'] ?? raw['CurrentValue'] ?? raw['equity'] ?? raw['Equity'] ?? 0);
    // Il valore corrente include solo equity aperta + liquidità disponibile.
    // Il P&L chiuso serve alla performance totale, ma non è un'esposizione attuale.
    const calculatedValue = positionInvested + positionPnl + available;
    const value = Number.isFinite(reportedValue) && reportedValue > 0 ? reportedValue : calculatedValue;
    const parentCID = Number(raw['parentCID'] ?? raw['ParentCID'] ?? raw['parentCid'] ?? raw['CID'] ?? raw['cid'] ?? 0);
    const rawId = raw['copyId'] ?? raw['CopyID'] ?? raw['copyID'] ?? raw['id'] ?? raw['ID'];
    const copyId = String(rawId ?? (parentCID > 0 ? parentCID : `copy-${index + 1}`));
    const mirrorId = Number(raw['mirrorId'] ?? raw['MirrorId'] ?? raw['mirrorID'] ?? raw['MirrorID'] ?? rawId ?? 0);
    const parentUsername = String(raw['parentUsername'] ?? raw['ParentUsername'] ?? raw['username'] ?? raw['Username'] ?? raw['parentName'] ?? raw['ParentName'] ?? '');
    const name = String(raw['name'] ?? raw['Name'] ?? raw['displayName'] ?? raw['DisplayName'] ?? raw['parentName'] ?? raw['ParentName'] ?? (parentUsername ? `Copy · ${parentUsername}` : `Copy portfolio ${index + 1}`));
    const type = String(raw['type'] ?? raw['Type'] ?? raw['portfolioType'] ?? raw['PortfolioType'] ?? '').toLowerCase();
    const isAgent = Boolean(raw['isAgent'] ?? raw['IsAgent'] ?? raw['isAgentPortfolio'] ?? raw['IsAgentPortfolio'] ?? raw['agentPortfolioId'] ?? raw['AgentPortfolioId'] ?? raw['agentPortfolioGcid'] ?? raw['AgentPortfolioGcid'] ?? raw['agent'] ?? raw['Agent']) || type.includes('agent');
    return {
      copyId,
      mirrorId: Number.isFinite(mirrorId) && mirrorId > 0 ? mirrorId : undefined,
      name,
      parentCID: parentCID > 0 ? parentCID : undefined,
      parentUsername: parentUsername || undefined,
      isAgent,
      status: String(raw['status'] ?? raw['Status'] ?? raw['state'] ?? raw['State'] ?? 'active'),
      invested,
      value,
      availableCash: Number.isFinite(available) && available > 0 ? available : 0,
      pnl,
      pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
      activeUnrealizedPnl,
      closedRealizedPnl: Number.isFinite(closedRealizedPnl) ? closedRealizedPnl : 0,
      totalPnl,
      startDate: String(raw['startDate'] ?? raw['StartDate'] ?? raw['openDate'] ?? raw['OpenDate'] ?? '') || undefined,
      avatarUrl: String(raw['avatarUrl'] ?? raw['AvatarUrl'] ?? raw['imageUrl'] ?? raw['ImageUrl'] ?? '') || undefined,
      positions,
    };
  }

  private loadIntradayHistory(): EquityPoint[] {
    try {
      const raw = localStorage.getItem(INTRADAY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as EquityPoint[] : [];
      const cutoff = Date.now() / 1000 - 36 * 60 * 60;
      return parsed.filter((point) => Number.isFinite(point.time) && point.time >= cutoff && Number.isFinite(point.value) && point.value > 0);
    } catch {
      return [];
    }
  }

  private persistIntradayPoint(value: number): EquityPoint[] {
    if (!Number.isFinite(value) || value <= 0) return this.loadIntradayHistory();
    const now = Math.floor(Date.now() / 1000);
    const points = this.loadIntradayHistory();
    const last = points[points.length - 1];
    if (!last || now - last.time >= 55) points.push({ time: now, value });
    else points[points.length - 1] = { time: now, value };
    try { localStorage.setItem(INTRADAY_STORAGE_KEY, JSON.stringify(points.slice(-1_440))); } catch { /* storage non disponibile */ }
    return points;
  }

  private async getBalanceHistory(): Promise<EquityPoint[]> {
    const now = new Date();
    const from = new Date(now);
    // Il limite eToro è 365 giorni inclusivi: oggi + 364 giorni precedenti.
    from.setUTCDate(from.getUTCDate() - 364);
    const date = (d: Date) => d.toISOString().slice(0, 10);
    const data = await this.api<Record<string, unknown>>(
      `api/v1/balances/history?displayCurrency=USD&fromDate=${date(from)}&toDate=${date(now)}`,
      undefined,
      { ttlMs: HISTORY_TTL_MS, priority: 'history' },
    );
    return this.recordList(data['snapshots'] ?? data['Snapshots']).map((item) => ({
      time: Math.floor(new Date(String(item['date'] ?? item['Date'])).getTime() / 1000),
      value: Number(item['totalBalance'] ?? item['TotalBalance'] ?? item['displayTotalBalance'] ?? item['DisplayTotalBalance']),
    })).filter((point) => Number.isFinite(point.time) && point.time > 0 && Number.isFinite(point.value) && point.value > 0)
      .sort((a, b) => a.time - b.time)
      .slice(-365);
  }

  private async getUsername(): Promise<string | null> {
    try {
      const data = await this.api<Record<string, unknown>>('api/v1/user-info/people', undefined, { ttlMs: METADATA_TTL_MS, priority: 'history' });
      const user = this.recordList(data['users'] ?? data['Users'])[0];
      const username = String(user?.['username'] ?? user?.['Username'] ?? '');
      return username || null;
    } catch {
      return null;
    }
  }

  private async getDailyGain(): Promise<number | null> {
    const username = await this.getUsername();
    if (!username) return null;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const data = await this.api<unknown>(
        `api/v1/user-info/people/${encodeURIComponent(username)}/daily-gain?minDate=${today}&maxDate=${today}&type=Daily`,
        undefined,
        { ttlMs: 2 * 60 * 1000, priority: 'account' },
      );
      const rows = Array.isArray(data) ? this.recordList(data) : this.recordList((data as Record<string, unknown>)['items']);
      const gain = Number(rows[rows.length - 1]?.['gain'] ?? rows[rows.length - 1]?.['Gain']);
      return Number.isFinite(gain) ? gain : null;
    } catch {
      return null;
    }
  }

  /* ── Lifecycle ───────────────────────────────────────────────────── */
  start(): void {
    this.setStatus('connecting');
    this.log('info', `Connessione a eToro (${this.settings.environment.toUpperCase()}) via proxy…`);
    void this.bootstrap();
  }

  private async bootstrap() {
    try {
      await this.resolveFxInstrument();
      const featuredIds = await this.resolveFeaturedInstruments();
      try {
        const initialQuotes = await this.getQuotes([...featuredIds, this.fxInstrumentId]);
        for (const quote of initialQuotes) this.lastQuotes.set(quote.instrumentId, quote);
        const fx = initialQuotes.find((quote) => quote.instrumentId === this.fxInstrumentId);
        if (fx && fx.last > 0) this.lastFx = { pair: 'EURUSD', rate: fx.last, prevClose: fx.prevClose, changePct: fx.changePct, timestamp: fx.timestamp };
        if (initialQuotes.length > 0) this.emitter.emit('quotes', initialQuotes);
      } catch {
        // The account data remains usable if the FX quote is temporarily unavailable.
      }
      const snapshot = await this.getAccountSnapshot(true);
      const { portfolio, pnl } = snapshot;
      for (const p of portfolio.positions) this.watchedIds.add(p.instrumentId);
      for (const copy of portfolio.copyPortfolios ?? []) for (const position of copy.positions) this.watchedIds.add(position.instrumentId);
      for (const instrumentId of featuredIds) this.watchedIds.add(instrumentId);
      if (this.fxInstrumentId > 0) this.watchedIds.add(this.fxInstrumentId);
      this.setStatus('connected');
      this.log('success', `Connesso a eToro — ${portfolio.positions.length} posizioni caricate.`);
      this.emitter.emit('portfolio', portfolio);
      // Il caricamento iniziale viene consumato dallo store senza ripetere
      // subito le stesse chiamate REST (riduce il rischio di rate limit).
      this.emitter.emit('pnl', pnl);
      this.connectWebSocket();
      this.startAccountPolling();
      if (this.wsFailed) this.startQuotePolling();
    } catch (err) {
      this.setStatus('error');
      this.log('error', `Connessione fallita: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.bootstrap();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.quotePollTimer) clearTimeout(this.quotePollTimer);
    if (this.accountPollTimer) clearTimeout(this.accountPollTimer);
    this.retryTimer = null;
    this.quotePollTimer = null;
    this.accountPollTimer = null;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.setStatus('disconnected');
  }

  on: DataProvider['on'] = (event, handler) => this.emitter.on(event, handler);

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.emitter.emit('status', s);
  }

  private async resolveFxInstrument() {
    const cached = this.loadSymbolCache()['EURUSD'];
    if (cached?.instrumentId > 0) {
      this.fxInstrumentId = cached.instrumentId;
      this.instruments.set(cached.instrumentId, { ...cached, symbol: 'EURUSD', assetClass: 'fx', currency: cached.currency || 'USD' });
      return;
    }
    try {
      const data = await this.api<Record<string, unknown>>('api/v1/market-data/search?internalSymbolFull=EURUSD');
      const candidates = this.recordList(data['instruments'] ?? data['Instruments'] ?? data['results'] ?? data['items'] ?? data);
      const match = candidates.find((item) => String(item['internalSymbolFull'] ?? item['InternalSymbolFull'] ?? item['symbol'] ?? '').toUpperCase() === 'EURUSD');
      const id = Number(match?.['instrumentId'] ?? match?.['InstrumentID'] ?? match?.['id'] ?? match?.['Id'] ?? 0);
      if (id > 0) {
        for (const [existingId, instrument] of this.instruments) {
          if (existingId !== id && instrument.symbol.toUpperCase() === 'EURUSD') this.instruments.delete(existingId);
        }
        this.fxInstrumentId = id;
        if (!this.instruments.has(id)) {
          this.instruments.set(id, { instrumentId: id, symbol: 'EURUSD', name: 'Euro / Dollaro USA', assetClass: 'fx', currency: 'USD' });
        }
        this.saveSymbolCache({ EURUSD: this.instruments.get(id)! });
        const searchRate = Number(match?.['currentRate'] ?? match?.['CurrentRate'] ?? 0);
        if (Number.isFinite(searchRate) && searchRate > 0) {
          this.lastFx = { pair: 'EURUSD', rate: searchRate, prevClose: searchRate, changePct: 0, timestamp: Date.now() };
        }
      }
    } catch {
      // La UI mostrerà lo stato non disponibile finché l'ID reale non è risolto.
    }
  }

  private async resolveFeaturedInstruments(): Promise<number[]> {
    const featured = ['AAPL', 'META', 'BTC', 'ETH', 'SPY', 'SPX500'];
    const cache = this.loadSymbolCache();
    const cachedIds: number[] = [];
    const missing = featured.filter((symbol) => {
      const instrument = cache[symbol];
      if (!instrument?.instrumentId) return true;
      this.instruments.set(instrument.instrumentId, instrument);
      cachedIds.push(instrument.instrumentId);
      return false;
    });
    const discovered: Record<string, Instrument> = {};
    const results = await Promise.allSettled(missing.map(async (symbol) => {
      const data = await this.api<Record<string, unknown>>(
        `api/v1/market-data/search?internalSymbolFull=${encodeURIComponent(symbol)}`,
        undefined,
        { ttlMs: METADATA_TTL_MS, priority: 'history' },
      );
      const candidates = this.recordList(data['instruments'] ?? data['Instruments'] ?? data['results'] ?? data['items'] ?? data);
      const match = candidates.find((item) => String(item['internalSymbolFull'] ?? item['InternalSymbolFull'] ?? item['symbol'] ?? item['Symbol'] ?? '').toUpperCase() === symbol);
      const id = Number(match?.['instrumentId'] ?? match?.['InstrumentID'] ?? match?.['id'] ?? match?.['Id'] ?? 0);
      if (!match || id <= 0) return;
      const name = String(match['instrumentDisplayName'] ?? match['InstrumentDisplayName'] ?? match['name'] ?? match['Name'] ?? symbol);
      const instrument: Instrument = {
        instrumentId: id,
        symbol,
        name,
        assetClass: this.inferAssetClass(match, id, symbol, name),
        currency: String(match['currency'] ?? match['Currency'] ?? 'USD'),
      };
      this.instruments.set(id, instrument);
      discovered[symbol] = instrument;
      return id;
    }));
    if (results.some((result) => result.status === 'rejected')) {
      this.log('info', 'Alcuni strumenti in evidenza non sono disponibili nel catalogo eToro corrente.');
    }
    if (Object.keys(discovered).length > 0) this.saveSymbolCache(discovered);
    return [...cachedIds, ...results.flatMap((result) => result.status === 'fulfilled' && typeof result.value === 'number' ? [result.value] : [])];
  }

  private loadSymbolCache(): Record<string, Instrument> {
    try {
      const parsed = JSON.parse(localStorage.getItem(SYMBOL_CACHE_KEY) ?? '{}') as { savedAt?: number; instruments?: Record<string, Instrument> };
      if (!parsed.savedAt || Date.now() - parsed.savedAt > METADATA_TTL_MS) return {};
      return parsed.instruments ?? {};
    } catch {
      return {};
    }
  }

  private saveSymbolCache(next: Record<string, Instrument>): void {
    try {
      const current = this.loadSymbolCache();
      localStorage.setItem(SYMBOL_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), instruments: { ...current, ...next } }));
    } catch { /* storage non disponibile */ }
  }

  /**
   * Le risposte P&L possono contenere solo instrumentID. Recuperiamo il
   * catalogo display ufficiale in batch, così la UI non mostra #12345.
   */
  private async enrichInstrumentMetadata(instrumentIds: number[]) {
    // I valori KNOWN sono solo un fallback di metadati: il catalogo remoto
    // deve sempre avere l'ultima parola, anche se l'ID coincide per caso.
    const missing = [...new Set(instrumentIds)].filter((id) => id > 0 && !this.instrumentMetadataLoaded.has(id));
    if (missing.length === 0) return;
    if (this.instrumentMetadataPromise) {
      await this.instrumentMetadataPromise;
      return;
    }
    this.instrumentMetadataPromise = (async () => {
      try {
        const data = await this.api<Record<string, unknown>>(
          `api/v1/market-data/instruments?instrumentIds=${missing.join(',')}`,
          undefined,
          { ttlMs: METADATA_TTL_MS, priority: 'history' },
        );
        const items = this.recordList(
          data['instrumentDisplayDatas'] ?? data['InstrumentDisplayDatas'] ?? data['items'] ?? data['Items'] ?? data,
        );
        for (const item of items) {
          const instrumentId = Number(item['instrumentID'] ?? item['instrumentId'] ?? item['InstrumentID'] ?? 0);
          if (!instrumentId) continue;
          const symbol = String(item['symbolFull'] ?? item['internalSymbolFull'] ?? item['symbol'] ?? `#${instrumentId}`);
          const name = String(item['instrumentDisplayName'] ?? item['InstrumentDisplayName'] ?? symbol);
          const existing = this.instruments.get(instrumentId);
          const images = this.recordList(item['images'] ?? item['Images']);
          const image = [...images].sort((a, b) => Number(b['width'] ?? b['Width'] ?? 0) - Number(a['width'] ?? a['Width'] ?? 0))[0];
          this.instruments.set(instrumentId, {
            instrumentId,
            symbol,
            name,
            assetClass: this.inferAssetClass(item, instrumentId, symbol, name),
            currency: String(item['currency'] ?? item['Currency'] ?? existing?.currency ?? 'USD'),
            exchange: String(item['exchangeName'] ?? item['ExchangeName'] ?? item['exchange'] ?? item['Exchange'] ?? existing?.exchange ?? '') || undefined,
            sector: String(item['sectorName'] ?? item['SectorName'] ?? item['sector'] ?? item['Sector'] ?? '') || undefined,
            industry: String(item['industryName'] ?? item['IndustryName'] ?? item['industry'] ?? item['Industry'] ?? '') || undefined,
            country: String(item['countryName'] ?? item['CountryName'] ?? item['country'] ?? item['Country'] ?? '') || undefined,
            imageUrl: String(image?.['uri'] ?? image?.['Uri'] ?? image?.['url'] ?? image?.['Url'] ?? '') || undefined,
            imageBackgroundColor: String(image?.['backgroundColor'] ?? image?.['BackgroundColor'] ?? '') || undefined,
            imageTextColor: String(image?.['textColor'] ?? image?.['TextColor'] ?? '') || undefined,
          });
        }
        for (const instrumentId of missing) this.instrumentMetadataLoaded.add(instrumentId);
      } catch {
        // I prezzi e il portafoglio restano disponibili anche se il catalogo è temporaneamente assente.
      } finally {
        this.instrumentMetadataPromise = null;
      }
    })();
    await this.instrumentMetadataPromise;
  }

  private log(level: LogEntry['level'], message: string) {
    this.emitter.emit('log', { id: `live-${++this.logSeq}`, timestamp: Date.now(), level, message });
  }

  /* ── WebSocket (best effort) + fallback polling ──────────────────── */
  private connectWebSocket() {
    try {
      const ws = new WebSocket(ETORO_WS_URL);
      this.ws = ws;
      let subscribed = false;
      const subscribe = () => {
        if (subscribed || ws.readyState !== WebSocket.OPEN) return;
        subscribed = true;
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          operation: 'Subscribe',
          data: { topics: [...this.watchedIds].map((id) => `instrument:${id}`), snapshot: false },
        }));
      };
      ws.onopen = () => {
        this.log('info', 'WebSocket eToro connesso — streaming quote attivo.');
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          operation: 'Authenticate',
          data: { userKey: this.settings.userKey, apiKey: this.settings.apiKey },
        }));
        // Alcune risposte di autenticazione non hanno uno schema uniforme:
        // ritardiamo appena la sottoscrizione e la anticipiamo se arriva l'ack.
        window.setTimeout(subscribe, 250);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
          const operation = String(msg['operation'] ?? msg['type'] ?? '').toLowerCase();
          if (!subscribed && (operation.includes('auth') || operation.includes('success'))) subscribe();
          const q = this.mapWsQuote(msg);
          if (q) this.handleQuoteUpdate([q]);
        } catch { /* frame non JSON: ignora */ }
      };
      ws.onerror = () => { /* gestito da onclose */ };
      ws.onclose = () => {
        if (this.status === 'connected' && !this.wsFailed) {
          this.wsFailed = true;
          this.log('warn', 'WebSocket non disponibile — prezzi in polling REST ogni 20 s.');
          this.startQuotePolling();
        }
      };
    } catch {
      this.wsFailed = true;
      this.startQuotePolling();
    }
  }

  private mapWsQuote(msg: Record<string, unknown>): Quote | null {
    const nested = msg['data'] && typeof msg['data'] === 'object' && !Array.isArray(msg['data'])
      ? msg['data'] as Record<string, unknown>
      : msg;
    const id = (nested['InstrumentID'] ?? nested['instrumentID'] ?? nested['instrumentId']) as number | undefined;
    const bid = Number(nested['Bid'] ?? nested['bid'] ?? 0);
    const ask = Number(nested['Ask'] ?? nested['ask'] ?? 0);
    if (!id || bid == null || ask == null) return null;
    const last = Number(nested['Last'] ?? nested['last'] ?? nested['lastExecution'] ?? (bid + ask) / 2);
    const previous = this.lastQuotes.get(id);
    const prevClose = previous?.prevClose ?? last;
    return { instrumentId: id, bid, ask, last, prevClose, changePct: prevClose ? ((last - prevClose) / prevClose) * 100 : 0, timestamp: Date.now() };
  }

  private handleQuoteUpdate(quotes: Quote[]) {
    for (const quote of quotes) this.lastQuotes.set(quote.instrumentId, quote);
    const fx = quotes.find((quote) => quote.instrumentId === this.fxInstrumentId);
    if (fx) this.lastFx = { pair: 'EURUSD', rate: fx.last, prevClose: fx.prevClose, changePct: fx.changePct, timestamp: fx.timestamp };
    this.emitter.emit('quotes', quotes);
    if (this.lastSnapshot) {
      this.lastSnapshot = this.markToMarket(this.lastSnapshot, quotes);
      this.emitter.emit('portfolio', this.lastSnapshot.portfolio);
      this.emitter.emit('pnl', this.lastSnapshot.pnl);
    }
  }

  private markPosition(position: Position, quotes: Map<number, Quote>): Position {
    const quote = quotes.get(position.instrumentId);
    if (!quote || !Number.isFinite(position.units) || position.units === 0 || position.openPrice <= 0) return position;
    const currentPrice = position.isBuy ? quote.bid || quote.last : quote.ask || quote.last;
    const direction = position.isBuy ? 1 : -1;
    const grossPnl = (currentPrice - position.openPrice) * position.units * direction;
    const pnl = grossPnl - position.fees;
    const currentValue = Math.max(0, position.invested + pnl);
    return {
      ...position,
      currentPrice,
      currentValue,
      pnl,
      pnlPct: position.invested > 0 ? (pnl / position.invested) * 100 : 0,
    };
  }

  /**
   * P&L della seduta sulle sole posizioni aperte, usando le chiusure ufficiali
   * precedenti restituite dalle quote eToro. È volutamente separato dal
   * `daily-gain`, che rappresenta una metrica percentuale di performance utente.
   */
  private openPositionsDailyPnl(positions: Position[], copyPortfolios: CopyPortfolio[]) {
    const all = [...positions, ...copyPortfolios.flatMap((copy) => copy.positions)];
    let totalWeight = 0;
    let coveredWeight = 0;
    let value = 0;
    for (const position of all) {
      const weight = Math.max(0, position.currentValue ?? position.invested);
      totalWeight += weight;
      const quote = this.lastQuotes.get(position.instrumentId);
      if (!quote || !(quote.prevClose > 0) || !(position.units > 0)) continue;
      const currentPrice = position.isBuy ? quote.bid || quote.last : quote.ask || quote.last;
      const direction = position.isBuy ? 1 : -1;
      value += (currentPrice - quote.prevClose) * position.units * direction;
      coveredWeight += weight;
    }
    return {
      value,
      coveragePct: totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0,
    };
  }

  private markToMarket(snapshot: AccountSnapshot, incoming: Quote[]): AccountSnapshot {
    const quoteMap = new Map(this.lastQuotes);
    for (const quote of incoming) quoteMap.set(quote.instrumentId, quote);
    const positions = snapshot.portfolio.positions.map((position) => this.markPosition(position, quoteMap));
    const copyPortfolios = (snapshot.portfolio.copyPortfolios ?? []).map((copy) => {
      const copyPositions = copy.positions.map((position) => this.markPosition(position, quoteMap));
      const activeUnrealizedPnl = copyPositions.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
      const totalPnl = activeUnrealizedPnl + copy.closedRealizedPnl;
      const livePositionValue = copyPositions.reduce((sum, position) => sum + (position.currentValue ?? 0), 0);
      return {
        ...copy,
        positions: copyPositions,
        activeUnrealizedPnl,
        totalPnl,
        pnl: totalPnl,
        pnlPct: copy.invested > 0 ? (totalPnl / copy.invested) * 100 : 0,
        value: livePositionValue + copy.availableCash,
      };
    });
    const positionsValue = positions.reduce((sum, position) => sum + (position.currentValue ?? 0), 0);
    const mirrorValue = copyPortfolios.reduce((sum, copy) => sum + copy.value, 0);
    const totalValue = snapshot.portfolio.cash + positionsValue + mirrorValue;
    const totalPnl = positions.reduce((sum, position) => sum + (position.pnl ?? 0), 0)
      + copyPortfolios.reduce((sum, copy) => sum + copy.totalPnl, 0);
    const portfolio = { ...snapshot.portfolio, positions, copyPortfolios, positionsValue, mirrorValue, totalValue };
    const daily = this.openPositionsDailyPnl(positions, copyPortfolios);
    const useMarketDaily = daily.coveragePct >= 80;
    const pnl: PnlSummary = {
      ...snapshot.pnl,
      dailyPnl: useMarketDaily ? daily.value : snapshot.pnl.dailyPnl,
      dailyPnlPct: useMarketDaily && totalValue - daily.value > 0
        ? (daily.value / (totalValue - daily.value)) * 100
        : snapshot.pnl.dailyPnlPct,
      dailySource: useMarketDaily ? 'etoro-market-delta' : snapshot.pnl.dailySource,
      dailyCoveragePct: daily.coveragePct,
      sourceLabel: useMarketDaily
        ? `Variazione delle posizioni aperte rispetto alla chiusura precedente eToro · copertura ${daily.coveragePct}%`
        : snapshot.pnl.sourceLabel,
      totalPnl,
      totalPnlPct: portfolio.totalInvested > 0 ? (totalPnl / portfolio.totalInvested) * 100 : 0,
      asOf: Date.now(),
    };
    return { portfolio, pnl };
  }

  private startQuotePolling() {
    if (this.quotePollTimer) return;
    const poll = async () => {
      this.quotePollTimer = null;
      if (document.visibilityState === 'hidden') {
        this.quotePollTimer = setTimeout(poll, QUOTE_POLL_MS);
        return;
      }
      try {
        const ids = [...this.watchedIds];
        if (ids.length) {
          const quotes = await this.getQuotes(ids);
          this.handleQuoteUpdate(quotes);
        }
        this.quotePollTimer = setTimeout(poll, QUOTE_POLL_MS);
      } catch {
        this.quotePollTimer = setTimeout(poll, this.backoffMs);
      }
    };
    void poll();
  }

  private startAccountPolling() {
    if (this.accountPollTimer) return;
    const poll = async () => {
      this.accountPollTimer = null;
      if (document.visibilityState !== 'hidden') {
        try {
          const snapshot = await this.getAccountSnapshot(true);
          this.emitter.emit('portfolio', snapshot.portfolio);
          this.emitter.emit('pnl', snapshot.pnl);
        } catch (error) {
          if (!(error instanceof RateLimitError)) this.log('warn', 'Snapshot conto non aggiornato; mantengo l’ultimo dato reale disponibile.');
        }
      }
      this.accountPollTimer = setTimeout(poll, ACCOUNT_POLL_MS);
    };
    this.accountPollTimer = setTimeout(poll, ACCOUNT_POLL_MS);
  }

  /* ── Mapping risposte eToro (PascalCase) ─────────────────────────── */
  private mapPosition(raw: Record<string, unknown>, index = 0): Position {
    const iid = Number(raw['InstrumentID'] ?? raw['instrumentId'] ?? raw['instrumentID'] ?? 0);
    const known = this.instruments.get(iid);
    const openRate = Number(raw['OpenRate'] ?? raw['openRate'] ?? 0);
    const units = Number(raw['Units'] ?? raw['units'] ?? raw['quantity'] ?? 0);
    const amount = Number(raw['Amount'] ?? raw['amount'] ?? 0);
    const pnl = this.positionPnl(raw);
    // eToro's `amount` is the invested capital; current value is amount + unrealized P&L.
    const currentValue = amount > 0 && pnl != null ? amount + pnl : undefined;
    const invested = amount || units * openRate;
    const apiPositionId = Number(raw['PositionID'] ?? raw['positionId'] ?? raw['PositionId'] ?? 0);
    const symbol = String(raw['symbol'] ?? raw['Symbol'] ?? raw['internalSymbolFull'] ?? raw['InternalSymbolFull'] ?? raw['InstrumentDisplayName'] ?? known?.symbol ?? `#${iid}`);
    const name = String(raw['name'] ?? raw['Name'] ?? raw['instrumentDisplayName'] ?? raw['InstrumentDisplayName'] ?? known?.name ?? `Strumento ${iid}`);
    const assetClass = this.inferAssetClass(raw, iid, symbol, name);
    return {
      // The P&L endpoint may omit PositionID; keep table keys unique in that case.
      positionId: apiPositionId || (iid * 100000 + index + 1),
      instrumentId: iid,
      symbol,
      name,
      assetClass: assetClass === 'stock' && known ? known.assetClass : assetClass,
      currency: known?.currency ?? 'USD',
      sector: known?.sector,
      industry: known?.industry,
      country: known?.country,
      imageUrl: known?.imageUrl,
      isBuy: Boolean(raw['IsBuy'] ?? raw['isBuy'] ?? true),
      units,
      openPrice: openRate,
      openDate: String(raw['OpenDateTime'] ?? raw['openTimestamp'] ?? raw['openDate'] ?? new Date().toISOString()),
      invested,
      fees: Number(raw['TotalFees'] ?? raw['totalFees'] ?? raw['fees'] ?? 0),
      leverage: Number(raw['Leverage'] ?? raw['leverage'] ?? 1),
      stopLossRate: raw['StopLossRate'] != null ? Number(raw['StopLossRate']) : raw['stopLossRate'] != null ? Number(raw['stopLossRate']) : undefined,
      takeProfitRate: raw['TakeProfitRate'] != null ? Number(raw['TakeProfitRate']) : raw['takeProfitRate'] != null ? Number(raw['takeProfitRate']) : undefined,
      currentValue,
      currentPrice: this.positionCloseRate(raw),
      pnl,
      pnlPct: raw['PnLPercent'] != null ? Number(raw['PnLPercent']) : raw['pnlPercent'] != null ? Number(raw['pnlPercent']) : raw['netProfitPercentage'] != null ? Number(raw['netProfitPercentage']) : undefined,
    };
  }

  /* ── API pubblica ────────────────────────────────────────────────── */
  private getAccountSnapshot(force = false): Promise<AccountSnapshot> {
    if (!force && this.lastSnapshot && Date.now() - this.lastSnapshot.portfolio.asOf < ACCOUNT_TTL_MS) {
      return Promise.resolve(this.lastSnapshot);
    }
    if (this.accountSnapshotPromise) return this.accountSnapshotPromise;
    this.accountSnapshotPromise = this.buildAccountSnapshot(force).finally(() => {
      this.accountSnapshotPromise = null;
    });
    return this.accountSnapshotPromise;
  }

  private async buildAccountSnapshot(force = false): Promise<AccountSnapshot> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/trading/info/${this.envPrefix()}pnl`.replace('//', '/'),
      undefined,
      { ttlMs: ACCOUNT_TTL_MS, priority: 'account', force },
    );
    const account = this.accountPayload(data);
    const credit = Number(account['Credit'] ?? account['credit'] ?? 0);
    const rawPositions = (account['Positions'] ?? account['positions'] ?? []) as Array<Record<string, unknown>>;
    const copyRecords = this.copyRecords(account);
    const copyPositionIds = copyRecords.flatMap((copy) => this.recordList(copy['positions'] ?? copy['Positions']))
      .map((raw) => Number(raw['InstrumentID'] ?? raw['instrumentId'] ?? raw['instrumentID'] ?? 0));
    await this.enrichInstrumentMetadata([
      ...rawPositions.map((raw) => Number(raw['InstrumentID'] ?? raw['instrumentId'] ?? raw['instrumentID'] ?? 0)),
      ...copyPositionIds,
    ]);
    const positions = rawPositions.map((r, index) => this.mapPosition(r, index));
    const copyPortfolios = copyRecords.map((raw, index) => this.mapCopyPortfolio(raw, index));
    const mirrors = this.mirrorSummary(account);
    const totalInvested = positions.reduce((s, p) => s + p.invested, 0);
    const positionsValue = positions.reduce((s, p) => s + (p.currentValue ?? (p.currentPrice ?? p.openPrice) * p.units * p.leverage), 0);
    const asOf = Date.now();
    const portfolio: Portfolio = {
      positions,
      copyPortfolios,
      cash: credit,
      totalInvested: totalInvested + mirrors.invested,
      positionsValue,
      mirrorValue: mirrors.value,
      mirrorInvested: mirrors.invested,
      totalValue: credit + positionsValue + mirrors.value,
      currency: 'USD',
      asOf,
      source: 'etoro-pnl',
    };
    const positionPnl = rawPositions.reduce((sum, position) => sum + this.positionPnl(position), 0);
    const calculatedTotal = positionPnl + mirrors.pnl;
    const reportedTotal = Number(account['UnrealizedPnL'] ?? account['unrealizedPnL'] ?? account['TotalPnL'] ?? account['totalPnl']);
    const total = rawPositions.length || mirrors.invested > 0 ? calculatedTotal : (Number.isFinite(reportedTotal) ? reportedTotal : 0);
    const directInvested = rawPositions.reduce((sum, position) => sum + Number(position['Amount'] ?? position['amount'] ?? 0), 0) + mirrors.invested;
    const equityFallback = Number(account['credit'] ?? account['Credit'] ?? 0) + directInvested + total;
    const reportedEquity = Number(account['Equity'] ?? account['equity']);
    const equity = Number.isFinite(reportedEquity) && reportedEquity > 0 ? reportedEquity : equityFallback;

    const [dailyGain, balanceHistory] = await Promise.all([
      this.getDailyGain(),
      this.getBalanceHistory().catch(() => [] as EquityPoint[]),
    ]);
    let dailyPnl = 0;
    let dailyPnlPct = 0;
    let dailySource: PnlSummary['dailySource'] = 'unavailable';
    const marketDaily = this.openPositionsDailyPnl(positions, copyPortfolios);
    if (marketDaily.coveragePct >= 80) {
      dailyPnl = marketDaily.value;
      dailyPnlPct = equity - dailyPnl > 0 ? (dailyPnl / (equity - dailyPnl)) * 100 : 0;
      dailySource = 'etoro-market-delta';
    } else if (dailyGain != null && Number.isFinite(dailyGain) && dailyGain > -100) {
      const openingEquity = equity / (1 + dailyGain / 100);
      dailyPnl = equity - openingEquity;
      dailyPnlPct = dailyGain;
      dailySource = 'etoro-daily-gain';
    } else {
      const key = `torino.day-open.${new Date().toISOString().slice(0, 10)}`;
      let openingEquity = equity;
      try {
        const saved = Number(localStorage.getItem(key));
        if (Number.isFinite(saved) && saved > 0) openingEquity = saved;
        else localStorage.setItem(key, String(equity));
      } catch { /* storage non disponibile */ }
      if (openingEquity > 0) {
        dailyPnl = equity - openingEquity;
        dailyPnlPct = (dailyPnl / openingEquity) * 100;
        dailySource = 'since-connection';
      }
    }
    const intraday = this.persistIntradayPoint(equity);
    const history = [...balanceHistory];
    const currentPoint = { time: Math.floor(asOf / 1000), value: equity };
    if (history.length > 0 && currentPoint.time - history[history.length - 1].time > 60 * 60) history.push(currentPoint);
    const equityHistory = history.length >= 2 ? history : intraday;
    const pnl: PnlSummary = {
      dailyPnl,
      dailyPnlPct,
      totalPnl: total,
      totalPnlPct: directInvested > 0 ? (total / directInvested) * 100 : 0,
      equityHistory,
      asOf,
      dailySource,
      dailyCoveragePct: marketDaily.coveragePct,
      etoroDailyPerformancePct: dailyGain ?? undefined,
      historySource: history.length >= 2 ? 'etoro-balances' : intraday.length >= 2 ? 'intraday-snapshots' : 'unavailable',
      sourceLabel: dailySource === 'etoro-market-delta'
        ? `Variazione delle posizioni aperte rispetto alla chiusura precedente eToro · copertura ${marketDaily.coveragePct}%`
        : dailySource === 'etoro-daily-gain'
        ? 'Performance giornaliera eToro · equity da snapshot conto'
        : dailySource === 'since-connection'
          ? 'Variazione misurata dal primo snapshot reale della connessione'
          : 'Performance giornaliera non disponibile da eToro',
    };
    const snapshot = { portfolio, pnl };
    this.lastSnapshot = snapshot;
    for (const position of positions) this.watchedIds.add(position.instrumentId);
    for (const copy of copyPortfolios) for (const position of copy.positions) this.watchedIds.add(position.instrumentId);
    return snapshot;
  }

  async getPortfolio(): Promise<Portfolio> {
    return (await this.getAccountSnapshot()).portfolio;
  }

  async getPnl(): Promise<PnlSummary> {
    return (await this.getAccountSnapshot()).pnl;
  }

  async getQuotes(instrumentIds: number[]): Promise<Quote[]> {
    const ids = [...new Set(instrumentIds)].filter((id) => id > 0);
    if (ids.length === 0) return [];
    await this.enrichInstrumentMetadata(ids);
    const chunks: number[][] = [];
    for (let index = 0; index < ids.length; index += 50) chunks.push(ids.slice(index, index + 50));
    const [responses, closes] = await Promise.all([
      Promise.all(chunks.map((chunk) => this.api<Record<string, unknown>>(
        `api/v1/market-data/instruments/rates?instrumentIds=${chunk.join(',')}`,
        undefined,
        { ttlMs: 4_000, priority: 'visible' },
      ))),
      this.getHistoricalClosingPrices().catch(() => []),
    ]);
    const closeById = new Map(closes.map((close) => [close.instrumentId, close]));
    const rates = responses.flatMap((data) => this.recordList(data['Rates'] ?? data['rates']));
    const quotes = rates.flatMap((r) => {
      const instrumentId = Number(r['InstrumentID'] ?? r['instrumentId'] ?? r['instrumentID'] ?? 0);
      const official = closeById.get(instrumentId);
      const rawBid = Number(r['Bid'] ?? r['bid']);
      const rawAsk = Number(r['Ask'] ?? r['ask']);
      const rawLast = Number(r['Last'] ?? r['last'] ?? r['LastExecution'] ?? r['lastExecution'] ?? r['CurrentRate'] ?? r['currentRate']);
      const midpoint = rawBid > 0 && rawAsk > 0 ? (rawBid + rawAsk) / 2 : 0;
      const fallback = official?.officialClosingPrice ?? official?.daily ?? 0;
      const last = rawLast > 0 ? rawLast : midpoint > 0 ? midpoint : fallback;
      if (!(instrumentId > 0) || !(last > 0)) return [];
      const bid = rawBid > 0 ? rawBid : last;
      const ask = rawAsk > 0 ? rawAsk : last;
      const rawPrevClose = Number(r['PrevClose'] ?? r['prevClose'] ?? r['CloseYesterday'] ?? r['closeYesterday']);
      const prevClose = rawPrevClose > 0 ? rawPrevClose : official?.daily ?? official?.officialClosingPrice ?? last;
      return [{
        instrumentId, bid, ask, last, prevClose,
        changePct: prevClose ? ((last - prevClose) / prevClose) * 100 : 0,
        timestamp: Date.now(),
      }];
    });
    for (const quote of quotes) this.lastQuotes.set(quote.instrumentId, quote);
    return quotes;
  }

  async getCandles(instrumentId: number, interval: CandleInterval, count: number, signal?: AbortSignal): Promise<Candle[]> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/market-data/instruments/${instrumentId}/history/candles/asc/${interval}/${count}`,
      undefined,
      { ttlMs: 5 * 60 * 1000, priority: 'history', lane: 'candles', signal },
    );
    const containers = this.recordList(data['Candles'] ?? data['candles']);
    // La risposta ufficiale raggruppa le candele per strumento:
    // { candles: [{ instrumentId, candles: [{ fromDate, open, ... }] }] }.
    // Alcuni proxy restituiscono invece direttamente la lista interna.
    const candles = containers.flatMap((container) => {
      const nested = this.recordList(container['Candles'] ?? container['candles']);
      return nested.length > 0 ? nested : [container];
    });
    return candles.map((c) => ({
      time: Math.floor(new Date(String(c['FromDate'] ?? c['fromDate'] ?? c['Time'] ?? c['time'] ?? 0)).getTime() / 1000),
      open: Number(c['Open'] ?? c['open'] ?? 0),
      high: Number(c['High'] ?? c['high'] ?? 0),
      low: Number(c['Low'] ?? c['low'] ?? 0),
      close: Number(c['Close'] ?? c['close'] ?? 0),
      volume: c['Volume'] != null ? Number(c['Volume']) : c['volume'] != null ? Number(c['volume']) : undefined,
    })).filter((candle) => candle.time > 0 && candle.close > 0);
  }

  async getHistoricalClosingPrices(): Promise<HistoricalClosingPrice[]> {
    const data = await this.api<unknown>(
      'api/v1/market-data/instruments/history/closing-price',
      undefined,
      { ttlMs: MARKET_HISTORY_TTL_MS, priority: 'history' },
    );
    const rows = Array.isArray(data) ? this.recordList(data) : this.recordList((data as Record<string, unknown>)['items']);
    return rows.map((row) => {
      const closing = row['closingPrices'] && typeof row['closingPrices'] === 'object' ? row['closingPrices'] as Record<string, unknown> : {};
      const priceOf = (key: string) => {
        const item = closing[key] && typeof closing[key] === 'object' ? closing[key] as Record<string, unknown> : {};
        const value = Number(item['price'] ?? item['Price']);
        return Number.isFinite(value) && value > 0 ? value : undefined;
      };
      const dailyItem = closing['daily'] && typeof closing['daily'] === 'object' ? closing['daily'] as Record<string, unknown> : {};
      const official = Number(row['officialClosingPrice'] ?? row['OfficialClosingPrice']);
      return {
        instrumentId: Number(row['instrumentId'] ?? row['InstrumentId'] ?? row['InstrumentID'] ?? 0),
        officialClosingPrice: Number.isFinite(official) && official > 0 ? official : undefined,
        daily: priceOf('daily'),
        weekly: priceOf('weekly'),
        monthly: priceOf('monthly'),
        asOf: String(dailyItem['date'] ?? dailyItem['Date'] ?? '') || undefined,
      };
    }).filter((row) => row.instrumentId > 0);
  }

  async getTradeHistory(): Promise<ClosedTrade[]> {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 364);
    const minDate = from.toISOString().slice(0, 10);
    const data = await this.api<unknown>(`api/v1/trading/info/trade/history?minDate=${minDate}&page=1&pageSize=500`, undefined, { ttlMs: 15 * 60 * 1000, priority: 'history' });
    const rows = Array.isArray(data) ? this.recordList(data) : this.recordList((data as Record<string, unknown>)['items']);
    this.closedTrades = rows.map((row) => ({
      positionId: Number(row['positionId'] ?? row['PositionId'] ?? row['PositionID'] ?? 0),
      instrumentId: Number(row['instrumentId'] ?? row['InstrumentId'] ?? row['InstrumentID'] ?? 0),
      netProfit: Number(row['netProfit'] ?? row['NetProfit'] ?? 0),
      investment: Number(row['investment'] ?? row['Investment'] ?? 0),
      openRate: Number(row['openRate'] ?? row['OpenRate'] ?? 0),
      closeRate: Number(row['closeRate'] ?? row['CloseRate'] ?? 0),
      openTimestamp: String(row['openTimestamp'] ?? row['OpenTimestamp'] ?? '') || undefined,
      closeTimestamp: String(row['closeTimestamp'] ?? row['CloseTimestamp'] ?? '') || undefined,
      socialTradeId: Number(row['socialTradeId'] ?? row['SocialTradeId'] ?? 0) || undefined,
      mirrorId: Number(row['mirrorId'] ?? row['MirrorId'] ?? row['mirrorID'] ?? row['MirrorID'] ?? 0) || undefined,
    }));
    return this.closedTrades;
  }

  async searchInstruments(query: string): Promise<Instrument[]> {
    const q = query.trim().toLowerCase();
    const local = this.listInstruments().filter(
      (i) => !q || i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q),
    ).slice(0, 20);
    if (!q || local.length > 0 || !/^[a-z0-9.-]{1,16}$/.test(q)) return local;

    const symbol = q.toUpperCase();
    const cached = this.loadSymbolCache()[symbol];
    if (cached?.instrumentId > 0) {
      this.instruments.set(cached.instrumentId, cached);
      return [cached];
    }

    const data = await this.api<Record<string, unknown>>(
      `api/v1/market-data/search?internalSymbolFull=${encodeURIComponent(symbol)}`,
      undefined,
      { ttlMs: METADATA_TTL_MS, priority: 'history' },
    );
    const candidates = this.recordList(data['instruments'] ?? data['Instruments'] ?? data['results'] ?? data['items'] ?? data);
    const match = candidates.find((item) => String(item['internalSymbolFull'] ?? item['InternalSymbolFull'] ?? item['symbol'] ?? item['Symbol'] ?? '').toUpperCase() === symbol);
    const instrumentId = Number(match?.['instrumentId'] ?? match?.['InstrumentID'] ?? match?.['id'] ?? match?.['Id'] ?? 0);
    if (!match || instrumentId <= 0) return [];
    const name = String(match['instrumentDisplayName'] ?? match['InstrumentDisplayName'] ?? match['name'] ?? match['Name'] ?? symbol);
    const instrument: Instrument = {
      instrumentId,
      symbol,
      name,
      assetClass: this.inferAssetClass(match, instrumentId, symbol, name),
      currency: String(match['currency'] ?? match['Currency'] ?? 'USD'),
      exchange: String(match['exchangeName'] ?? match['ExchangeName'] ?? match['exchange'] ?? '') || undefined,
      sector: String(match['sectorName'] ?? match['SectorName'] ?? match['sector'] ?? '') || undefined,
      country: String(match['countryName'] ?? match['CountryName'] ?? match['country'] ?? '') || undefined,
    };
    this.instruments.set(instrumentId, instrument);
    this.saveSymbolCache({ [symbol]: instrument });
    return [instrument];
  }

  listInstruments(): Instrument[] {
    return [...this.instruments.values()];
  }

  getFxRate(): FxRate {
    return this.lastFx;
  }

  getFxInstrumentId(): number | null {
    return this.fxInstrumentId > 0 ? this.fxInstrumentId : null;
  }

  /* ── Ordini ──────────────────────────────────────────────────────── */
  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    if (this.settings.permissions !== 'write') {
      return { ok: false, message: 'Chiavi in sola lettura — abilita i permessi di scrittura in Impostazioni.' };
    }
    const body = {
      action: 'open',
      transaction: req.isBuy ? 'buy' : 'sellShort',
      instrumentId: req.instrumentId,
      orderType: 'mkt',
      leverage: req.leverage ?? 1,
      amount: req.amount,
      orderCurrency: 'usd',
      ...(req.stopLossRate != null ? { stopLossRate: req.stopLossRate, stopLossType: 'fixed' } : {}),
      ...(req.takeProfitRate != null ? { takeProfitRate: req.takeProfitRate } : {}),
    };
    try {
      const data = await this.api<Record<string, unknown>>(
        'api/v2/trading/execution/orders',
        { method: 'POST', body: JSON.stringify(body) },
      );
      this.log('success', `Ordine inviato a eToro: ${req.isBuy ? 'BUY' : 'SELL'} #${req.instrumentId} · $${req.amount}`);
      return {
        ok: true,
        orderId: String(data['orderId'] ?? data['OrderId'] ?? data['token'] ?? ''),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `Ordine fallito: ${message}`);
      return { ok: false, message };
    }
  }

  async closePosition(positionId: number): Promise<OrderResult> {
    if (this.settings.permissions !== 'write') {
      return { ok: false, message: 'Chiavi in sola lettura — abilita i permessi di scrittura in Impostazioni.' };
    }
    try {
      await this.api<unknown>(
        `api/v1/trading/execution/${this.envPrefix()}market-close-orders/positions/${positionId}`.replace('//', '/'),
        { method: 'POST', body: JSON.stringify({ PositionID: positionId }) },
      );
      this.log('info', `Chiusura posizione #${positionId} inviata a eToro.`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `Chiusura fallita: ${message}`);
      return { ok: false, message };
    }
  }
}
