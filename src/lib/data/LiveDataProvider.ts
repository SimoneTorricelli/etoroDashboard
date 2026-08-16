/**
 * LiveDataProvider — eToro Public API.
 *
 * - REST via proxy CORS configurato dall'utente: le chiamate vanno a
 *   `{proxyUrl}/{path}` inoltrando gli header eToro (x-api-key, x-user-key,
 *   x-request-id UUID). eToro non supporta CORS, quindi il proxy è obbligatorio.
 * - WebSocket quotes `wss://ws.etoro.com/ws` best-effort, con fallback a
 *   polling REST ogni 5s se il socket fallisce.
 * - Backoff esponenziale su errori/429.
 * - Mapping risposte eToro (PascalCase) → types del data layer.
 */
import { ProviderEmitter } from './DataProvider';
import type { DataProvider } from './DataProvider';
import type { LiveSettings } from '../settings';
import type {
  Candle,
  CandleInterval,
  ConnectionStatus,
  CopyPortfolio,
  EquityPoint,
  FxRate,
  Instrument,
  LogEntry,
  OrderRequest,
  OrderResult,
  PnlSummary,
  Portfolio,
  Position,
  Quote,
} from './types';

const ETORO_WS_URL = 'wss://ws.etoro.com/ws';
const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;

/* Strumenti noti minimo per search/mapping locale (il catalogo completo
 * arriverebbe da /market-data/instruments; qui teniamo un fallback compatto). */
const KNOWN: Array<[number, string, string, Instrument['assetClass'], string]> = [
  [1001, 'AAPL', 'Apple Inc.', 'stock', 'USD'],
  [1002, 'MSFT', 'Microsoft Corp.', 'stock', 'USD'],
  [1003, 'NVDA', 'NVIDIA Corp.', 'stock', 'USD'],
  [1401, 'EURUSD', 'Euro / Dollaro USA', 'fx', 'USD'],
  [1301, 'BTC', 'Bitcoin', 'crypto', 'USD'],
  [1302, 'ETH', 'Ethereum', 'crypto', 'USD'],
  [1201, 'SPY', 'SPDR S&P 500 ETF', 'etf', 'USD'],
  [1501, 'SPX500', 'S&P 500', 'index', 'USD'],
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
  private settings: LiveSettings;
  private status: ConnectionStatus = 'disconnected';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private wsFailed = false;
  private backoffMs = POLL_MS;
  private logSeq = 0;
  private watchedIds = new Set<number>();
  private fxInstrumentId = 1401;
  private instrumentMetadataPromise: Promise<void> | null = null;
  private instrumentMetadataLoaded = new Set<number>();
  private instruments = new Map<number, Instrument>(
    KNOWN.map(([instrumentId, symbol, name, assetClass, currency]) => [
      instrumentId, { instrumentId, symbol, name, assetClass, currency },
    ]),
  );
  private lastFx: FxRate = { pair: 'EURUSD', rate: 1.09, prevClose: 1.09, changePct: 0, timestamp: Date.now() };

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

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const base = this.settings.proxyUrl.replace(/\/+$/, '');
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    const res = await fetch(url, { ...init, headers: { ...this.headers(), ...(init?.headers ?? {}) } });
    if (res.status === 429) {
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.log('warn', `Rate limit eToro (429) — backoff ${Math.round(this.backoffMs / 1000)}s`);
      throw new Error('Rate limit eToro (429)');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`eToro API ${res.status}: ${text.slice(0, 200)}`);
    }
    this.backoffMs = POLL_MS;
    return (await res.json()) as T;
  }

  private envPrefix(): string {
    // eToro account endpoints are explicitly scoped by environment.
    // Demo → /demo/..., Real → /real/...
    return this.settings.environment === 'demo' ? 'demo/' : 'real/';
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
    const pnl = Number.isFinite(reportedPnl) && reportedPnl !== 0 ? reportedPnl : positionPnl;
    const reportedValue = Number(raw['value'] ?? raw['Value'] ?? raw['currentValue'] ?? raw['CurrentValue'] ?? raw['equity'] ?? raw['Equity'] ?? 0);
    const value = Number.isFinite(reportedValue) && reportedValue > 0 ? reportedValue : invested + pnl;
    const parentCID = Number(raw['parentCID'] ?? raw['ParentCID'] ?? raw['parentCid'] ?? raw['CID'] ?? raw['cid'] ?? 0);
    const rawId = raw['copyId'] ?? raw['CopyID'] ?? raw['copyID'] ?? raw['id'] ?? raw['ID'];
    const copyId = String(rawId ?? (parentCID > 0 ? parentCID : `copy-${index + 1}`));
    const parentUsername = String(raw['parentUsername'] ?? raw['ParentUsername'] ?? raw['username'] ?? raw['Username'] ?? raw['parentName'] ?? raw['ParentName'] ?? '');
    const name = String(raw['name'] ?? raw['Name'] ?? raw['displayName'] ?? raw['DisplayName'] ?? raw['parentName'] ?? raw['ParentName'] ?? (parentUsername ? `Copy · ${parentUsername}` : `Copy portfolio ${index + 1}`));
    const type = String(raw['type'] ?? raw['Type'] ?? raw['portfolioType'] ?? raw['PortfolioType'] ?? '').toLowerCase();
    const isAgent = Boolean(raw['isAgent'] ?? raw['IsAgent'] ?? raw['isAgentPortfolio'] ?? raw['IsAgentPortfolio'] ?? raw['agentPortfolioId'] ?? raw['AgentPortfolioId'] ?? raw['agentPortfolioGcid'] ?? raw['AgentPortfolioGcid'] ?? raw['agent'] ?? raw['Agent']) || type.includes('agent');
    return {
      copyId,
      name,
      parentCID: parentCID > 0 ? parentCID : undefined,
      parentUsername: parentUsername || undefined,
      isAgent,
      status: String(raw['status'] ?? raw['Status'] ?? raw['state'] ?? raw['State'] ?? 'active'),
      invested,
      value,
      pnl,
      pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
      positions,
    };
  }

  private equityHistory(account: Record<string, unknown>, equity: number, dailyPnl: number): EquityPoint[] {
    const raw = this.recordList(
      account['equityHistory'] ?? account['EquityHistory']
      ?? account['equityCurve'] ?? account['EquityCurve']
      ?? account['history'] ?? account['History'],
    );
    const points = raw.map((item) => {
      const timeRaw = item['time'] ?? item['Time'] ?? item['timestamp'] ?? item['Timestamp'] ?? item['date'] ?? item['Date'];
      const numericTime = Number(timeRaw);
      const time = Number.isFinite(numericTime)
        ? (numericTime > 10_000_000_000 ? Math.floor(numericTime / 1000) : Math.floor(numericTime))
        : Math.floor(new Date(String(timeRaw)).getTime() / 1000);
      const value = Number(item['value'] ?? item['Value'] ?? item['equity'] ?? item['Equity'] ?? item['amount'] ?? item['Amount']);
      return { time, value };
    }).filter((point) => Number.isFinite(point.time) && point.time > 0 && Number.isFinite(point.value) && point.value > 0);
    if (points.length >= 2) return points.slice(-365);
    const now = Math.floor(Date.now() / 1000);
    const previous = Math.max(0, equity - dailyPnl);
    return previous > 0 && equity > 0
      ? [{ time: now - 86400, value: previous }, { time: now, value: equity }]
      : [];
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
      try {
        const fx = (await this.getQuotes([this.fxInstrumentId])).find((quote) => quote.instrumentId === this.fxInstrumentId);
        if (fx && fx.last > 0) this.lastFx = { pair: 'EURUSD', rate: fx.last, prevClose: fx.prevClose, changePct: fx.changePct, timestamp: fx.timestamp };
      } catch {
        // The account data remains usable if the FX quote is temporarily unavailable.
      }
      this.emitter.emit('quotes', [{
        instrumentId: this.fxInstrumentId,
        bid: this.lastFx.rate,
        ask: this.lastFx.rate,
        last: this.lastFx.rate,
        prevClose: this.lastFx.prevClose,
        changePct: this.lastFx.changePct,
        timestamp: this.lastFx.timestamp,
      }]);
      const portfolio = await this.getPortfolio();
      for (const p of portfolio.positions) this.watchedIds.add(p.instrumentId);
      this.watchedIds.add(this.fxInstrumentId);
      const pnl = await this.getPnl();
      this.setStatus('connected');
      this.log('success', `Connesso a eToro — ${portfolio.positions.length} posizioni caricate.`);
      this.emitter.emit('portfolio', portfolio);
      // Il caricamento iniziale viene consumato dallo store senza ripetere
      // subito le stesse chiamate REST (riduce il rischio di rate limit).
      this.emitter.emit('pnl', pnl);
      this.connectWebSocket();
      if (this.wsFailed) this.startPolling();
    } catch (err) {
      this.setStatus('error');
      this.log('error', `Connessione fallita: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    if (this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.bootstrap();
    }, this.backoffMs) as unknown as ReturnType<typeof setInterval>;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  stop(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); clearInterval(this.pollTimer); }
    this.pollTimer = null;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.setStatus('disconnected');
  }

  on: DataProvider['on'] = (event, handler) => this.emitter.on(event, handler);

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.emitter.emit('status', s);
  }

  private async resolveFxInstrument() {
    try {
      const data = await this.api<Record<string, unknown>>('api/v1/market-data/search?internalSymbolFull=EURUSD');
      const candidates = this.recordList(data['instruments'] ?? data['Instruments'] ?? data['results'] ?? data['items'] ?? data);
      const match = candidates.find((item) => String(item['internalSymbolFull'] ?? item['InternalSymbolFull'] ?? item['symbol'] ?? '').toUpperCase() === 'EURUSD');
      const id = Number(match?.['instrumentId'] ?? match?.['InstrumentID'] ?? match?.['id'] ?? match?.['Id'] ?? 0);
      if (id > 0) {
        this.fxInstrumentId = id;
        if (!this.instruments.has(id)) {
          this.instruments.set(id, { instrumentId: id, symbol: 'EURUSD', name: 'Euro / Dollaro USA', assetClass: 'fx', currency: 'USD' });
        }
        const searchRate = Number(match?.['currentRate'] ?? match?.['CurrentRate'] ?? 0);
        if (Number.isFinite(searchRate) && searchRate > 0) {
          this.lastFx = { pair: 'EURUSD', rate: searchRate, prevClose: searchRate, changePct: 0, timestamp: Date.now() };
        }
      }
    } catch {
      // Keep the known fallback ID and the last known fallback rate.
    }
  }

  /**
   * Le risposte P&L possono contenere solo instrumentID. Recuperiamo il
   * catalogo display ufficiale in batch, così la UI non mostra #12345.
   */
  private async enrichInstrumentMetadata(instrumentIds: number[]) {
    // I valori KNOWN sono solo un fallback Demo: per il Live il catalogo remoto
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
          this.instruments.set(instrumentId, {
            instrumentId,
            symbol,
            name,
            assetClass: this.inferAssetClass(item, instrumentId, symbol, name),
            currency: String(item['currency'] ?? item['Currency'] ?? existing?.currency ?? 'USD'),
            exchange: existing?.exchange,
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
          if (q) this.emitter.emit('quotes', [q]);
        } catch { /* frame non JSON: ignora */ }
      };
      ws.onerror = () => { /* gestito da onclose */ };
      ws.onclose = () => {
        if (this.status === 'connected' && !this.wsFailed) {
          this.wsFailed = true;
          this.log('warn', 'WebSocket non disponibile — fallback a polling REST ogni 5s.');
          this.startPolling();
        }
      };
    } catch {
      this.wsFailed = true;
      this.startPolling();
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
    return { instrumentId: id, bid, ask, last, prevClose: last, changePct: 0, timestamp: Date.now() };
  }

  private startPolling() {
    if (this.pollTimer) return;
    const poll = async () => {
      try {
        const ids = [...this.watchedIds];
        if (ids.length) {
          const quotes = await this.getQuotes(ids);
          this.emitter.emit('quotes', quotes);
          const fx = quotes.find((q) => q.instrumentId === this.fxInstrumentId);
          if (fx) this.lastFx = { pair: 'EURUSD', rate: fx.last, prevClose: fx.prevClose, changePct: fx.changePct, timestamp: fx.timestamp };
        }
        this.pollTimer = setTimeout(poll, POLL_MS) as unknown as ReturnType<typeof setInterval>;
      } catch {
        this.pollTimer = setTimeout(poll, this.backoffMs) as unknown as ReturnType<typeof setInterval>;
      }
    };
    void poll();
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
  async getPortfolio(): Promise<Portfolio> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/trading/info/${this.envPrefix()}pnl`.replace('//', '/'),
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
    // Le quote live arricchiranno i prezzi; qui usiamo openPrice come stima iniziale
    const positionsValue = positions.reduce((s, p) => s + (p.currentValue ?? (p.currentPrice ?? p.openPrice) * p.units * p.leverage), 0);
    return {
      positions,
      copyPortfolios,
      cash: credit,
      totalInvested: totalInvested + mirrors.invested,
      positionsValue,
      mirrorValue: mirrors.value,
      mirrorInvested: mirrors.invested,
      totalValue: credit + positionsValue + mirrors.value,
      currency: 'USD',
    };
  }

  async getPnl(): Promise<PnlSummary> {
    const data = await this.api<Record<string, unknown>>(`api/v1/trading/info/${this.envPrefix()}pnl`.replace('//', '/'));
    const account = this.accountPayload(data);
    const rawPositions = (account['Positions'] ?? account['positions'] ?? []) as Array<Record<string, unknown>>;
    const mirrorSummary = this.mirrorSummary(account);
    const positionPnl = rawPositions.reduce((sum, position) => sum + this.positionPnl(position), 0);
    const daily = Number(account['DailyPnL'] ?? account['dailyPnL'] ?? account['dailyPnl'] ?? 0);
    const calculatedTotal = positionPnl + mirrorSummary.pnl;
    const reportedTotal = Number(account['UnrealizedPnL'] ?? account['unrealizedPnL'] ?? account['TotalPnL'] ?? account['totalPnl']);
    const total = rawPositions.length || mirrorSummary.invested > 0 ? calculatedTotal : (Number.isFinite(reportedTotal) ? reportedTotal : 0);
    const directInvested = rawPositions.reduce((sum, position) => sum + Number(position['Amount'] ?? position['amount'] ?? 0), 0) + mirrorSummary.invested;
    const equityFallback = Number(account['credit'] ?? account['Credit'] ?? 0) + directInvested + total;
    const reportedEquity = Number(account['Equity'] ?? account['equity']);
    const equity = Number.isFinite(reportedEquity) && reportedEquity > 0 ? reportedEquity : equityFallback;
    return {
      dailyPnl: daily,
      dailyPnlPct: equity ? (daily / (equity - daily)) * 100 : 0,
      totalPnl: total,
      totalPnlPct: equity ? (total / (equity - total)) * 100 : 0,
      equityHistory: this.equityHistory(account, equity, daily),
    };
  }

  async getQuotes(instrumentIds: number[]): Promise<Quote[]> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/market-data/instruments/rates?instrumentIds=${instrumentIds.join(',')}`,
    );
    const rates = (data['Rates'] ?? data['rates'] ?? []) as Array<Record<string, unknown>>;
    return rates.map((r) => {
      const bid = Number(r['Bid'] ?? r['bid'] ?? 0);
      const ask = Number(r['Ask'] ?? r['ask'] ?? 0);
      const last = Number(r['Last'] ?? r['last'] ?? r['LastExecution'] ?? r['lastExecution'] ?? r['CurrentRate'] ?? r['currentRate'] ?? r['UnitMargin'] ?? r['unitMargin'] ?? (bid + ask) / 2);
      const prevClose = Number(r['PrevClose'] ?? r['prevClose'] ?? r['CloseYesterday'] ?? r['closeYesterday'] ?? last);
      return {
        instrumentId: Number(r['InstrumentID'] ?? r['instrumentId'] ?? r['instrumentID'] ?? 0),
        bid, ask, last, prevClose,
        changePct: prevClose ? ((last - prevClose) / prevClose) * 100 : 0,
        timestamp: Date.now(),
      };
    });
  }

  async getCandles(instrumentId: number, interval: CandleInterval, count: number): Promise<Candle[]> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/market-data/instruments/${instrumentId}/history/candles/asc/${interval}/${count}`,
    );
    const candles = (data['Candles'] ?? data['candles'] ?? []) as Array<Record<string, unknown>>;
    return candles.map((c) => ({
      time: Math.floor(new Date(String(c['FromDate'] ?? c['Time'] ?? 0)).getTime() / 1000),
      open: Number(c['Open'] ?? 0),
      high: Number(c['High'] ?? 0),
      low: Number(c['Low'] ?? 0),
      close: Number(c['Close'] ?? 0),
      volume: c['Volume'] != null ? Number(c['Volume']) : undefined,
    }));
  }

  async searchInstruments(query: string): Promise<Instrument[]> {
    const q = query.trim().toLowerCase();
    // Catalogo locale (la Public API non espone una search testuale stabile)
    return this.listInstruments().filter(
      (i) => !q || i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q),
    ).slice(0, 20);
  }

  listInstruments(): Instrument[] {
    return [...this.instruments.values()];
  }

  getFxRate(): FxRate {
    return this.lastFx;
  }

  /* ── Ordini ──────────────────────────────────────────────────────── */
  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    if (this.settings.permissions !== 'write') {
      return { ok: false, message: 'Chiavi in sola lettura — abilita i permessi di scrittura in Impostazioni.' };
    }
    const body = {
      InstrumentID: req.instrumentId,
      IsBuy: req.isBuy,
      Leverage: req.leverage ?? 1,
      Amount: req.amount,
      ...(req.stopLossRate != null ? { StopLossRate: req.stopLossRate } : {}),
      ...(req.takeProfitRate != null ? { TakeProfitRate: req.takeProfitRate } : {}),
    };
    try {
      const data = await this.api<Record<string, unknown>>(
        `api/v1/trading/execution/${this.envPrefix()}market-open-orders/by-amount`.replace('//', '/'),
        { method: 'POST', body: JSON.stringify(body) },
      );
      this.log('success', `Ordine inviato a eToro: ${req.isBuy ? 'BUY' : 'SELL'} #${req.instrumentId} · $${req.amount}`);
      return {
        ok: true,
        orderId: String(data['OrderID'] ?? data['TokenForReference'] ?? ''),
        positionId: data['PositionID'] != null ? Number(data['PositionID']) : undefined,
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
