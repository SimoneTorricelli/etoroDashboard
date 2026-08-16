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
    // environment 'demo' → endpoint /demo/..., 'real' → endpoint reale
    return this.settings.environment === 'demo' ? 'demo/' : '';
  }

  /* ── Lifecycle ───────────────────────────────────────────────────── */
  start(): void {
    this.setStatus('connecting');
    this.log('info', `Connessione a eToro (${this.settings.environment.toUpperCase()}) via proxy…`);
    void this.bootstrap();
  }

  private async bootstrap() {
    try {
      const portfolio = await this.getPortfolio();
      for (const p of portfolio.positions) this.watchedIds.add(p.instrumentId);
      this.watchedIds.add(1401); // EURUSD
      this.setStatus('connected');
      this.log('success', `Connesso a eToro — ${portfolio.positions.length} posizioni caricate.`);
      this.emitter.emit('portfolio', portfolio);
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

  private log(level: LogEntry['level'], message: string) {
    this.emitter.emit('log', { id: `live-${++this.logSeq}`, timestamp: Date.now(), level, message });
  }

  /* ── WebSocket (best effort) + fallback polling ──────────────────── */
  private connectWebSocket() {
    try {
      const ws = new WebSocket(ETORO_WS_URL);
      this.ws = ws;
      ws.onopen = () => {
        this.log('info', 'WebSocket eToro connesso — streaming quote attivo.');
        // Best effort: il protocollo di sottoscrizione eToro può variare;
        // inviamo una subscribe semplice e restiamo in ascolto.
        ws.send(JSON.stringify({ type: 'subscribe', instrumentIds: [...this.watchedIds] }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
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
    const id = (msg['InstrumentID'] ?? msg['instrumentId']) as number | undefined;
    const bid = (msg['Bid'] ?? msg['bid']) as number | undefined;
    const ask = (msg['Ask'] ?? msg['ask']) as number | undefined;
    if (!id || bid == null || ask == null) return null;
    const last = (bid + ask) / 2;
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
          const fx = quotes.find((q) => q.instrumentId === 1401);
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
  private mapPosition(raw: Record<string, unknown>): Position {
    const iid = Number(raw['InstrumentID'] ?? raw['instrumentId'] ?? 0);
    const known = this.instruments.get(iid);
    const openRate = Number(raw['OpenRate'] ?? 0);
    const units = Number(raw['Units'] ?? 0);
    const invested = Number(raw['Amount'] ?? raw['Invested'] ?? units * openRate);
    return {
      positionId: Number(raw['PositionID'] ?? raw['positionId'] ?? 0),
      instrumentId: iid,
      symbol: known?.symbol ?? `#${iid}`,
      name: known?.name ?? `Strumento ${iid}`,
      assetClass: known?.assetClass ?? 'stock',
      currency: known?.currency ?? 'USD',
      isBuy: Boolean(raw['IsBuy'] ?? true),
      units,
      openPrice: openRate,
      openDate: String(raw['OpenDateTime'] ?? new Date().toISOString()),
      invested,
      fees: Number(raw['TotalFees'] ?? 0),
      leverage: Number(raw['Leverage'] ?? 1),
      stopLossRate: raw['StopLossRate'] != null ? Number(raw['StopLossRate']) : undefined,
      takeProfitRate: raw['TakeProfitRate'] != null ? Number(raw['TakeProfitRate']) : undefined,
    };
  }

  /* ── API pubblica ────────────────────────────────────────────────── */
  async getPortfolio(): Promise<Portfolio> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/trading/info/${this.envPrefix()}portfolio`.replace('//', '/'),
    );
    const credit = Number(data['Credit'] ?? data['credit'] ?? 0);
    const rawPositions = (data['Positions'] ?? data['positions'] ?? []) as Array<Record<string, unknown>>;
    const positions = rawPositions.map((r) => this.mapPosition(r));
    const totalInvested = positions.reduce((s, p) => s + p.invested, 0);
    // Le quote live arricchiranno i prezzi; qui usiamo openPrice come stima iniziale
    const positionsValue = positions.reduce((s, p) => s + p.units * p.openPrice * p.leverage, 0);
    return {
      positions,
      cash: credit,
      totalInvested,
      positionsValue,
      totalValue: credit + positionsValue,
      currency: 'USD',
    };
  }

  async getPnl(): Promise<PnlSummary> {
    const data = await this.api<Record<string, unknown>>(`api/v1/trading/info/${this.envPrefix()}pnl`.replace('//', '/'));
    const daily = Number(data['DailyPnL'] ?? data['dailyPnl'] ?? 0);
    const total = Number(data['TotalPnL'] ?? data['totalPnl'] ?? 0);
    const equity = Number(data['Equity'] ?? data['equity'] ?? 0);
    return {
      dailyPnl: daily,
      dailyPnlPct: equity ? (daily / (equity - daily)) * 100 : 0,
      totalPnl: total,
      totalPnlPct: equity ? (total / (equity - total)) * 100 : 0,
      equityHistory: [],
    };
  }

  async getQuotes(instrumentIds: number[]): Promise<Quote[]> {
    const data = await this.api<Record<string, unknown>>(
      `api/v1/market-data/instruments/rates?instrumentIds=${instrumentIds.join(',')}`,
    );
    const rates = (data['Rates'] ?? data['rates'] ?? []) as Array<Record<string, unknown>>;
    return rates.map((r) => {
      const bid = Number(r['Bid'] ?? 0);
      const ask = Number(r['Ask'] ?? 0);
      const last = Number(r['Last'] ?? (bid + ask) / 2);
      const prevClose = Number(r['PrevClose'] ?? r['CloseYesterday'] ?? last);
      return {
        instrumentId: Number(r['InstrumentID'] ?? 0),
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
