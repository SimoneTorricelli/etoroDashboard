/**
 * DemoDataProvider — simulazione realistica e deterministica all'avvio.
 *
 * - ~40 strumenti (azioni US/EU, ETF, crypto, FX, indici).
 * - Random-walk con seed fisso per lo stato iniziale, poi tick live ogni ~1.5s.
 * - Portfolio demo (~10 posizioni), P&L e storico candele generati.
 * - Gli ordini simulati aggiornano il portfolio (usato dall'Agent in Demo).
 */
import { ProviderEmitter } from './DataProvider';
import type { DataProvider } from './DataProvider';
import type {
  Candle,
  CandleInterval,
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

/* ── PRNG deterministico (mulberry32) ──────────────────────────────── */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimInstrument extends Instrument {
  price: number;
  prevClose: number;
  /** Volatilità per tick (deviazione standard relativa). */
  vol: number;
  drift: number;
  /** Ultimi ~120 prezzi (per sparkline). */
  history: number[];
}

type CatalogRow = [number, string, string, Instrument['assetClass'], string, number, number];

/** [id, symbol, name, assetClass, currency, basePrice, volPerTick] */
const CATALOG: CatalogRow[] = [
  // Azioni US
  [1001, 'AAPL', 'Apple Inc.', 'stock', 'USD', 232.5, 0.0018],
  [1002, 'MSFT', 'Microsoft Corp.', 'stock', 'USD', 428.1, 0.0016],
  [1003, 'NVDA', 'NVIDIA Corp.', 'stock', 'USD', 138.2, 0.0032],
  [1004, 'AMZN', 'Amazon.com Inc.', 'stock', 'USD', 205.7, 0.0021],
  [1005, 'GOOGL', 'Alphabet Inc.', 'stock', 'USD', 178.4, 0.0019],
  [1006, 'META', 'Meta Platforms', 'stock', 'USD', 585.2, 0.0024],
  [1007, 'TSLA', 'Tesla Inc.', 'stock', 'USD', 342.8, 0.0041],
  [1008, 'JPM', 'JPMorgan Chase', 'stock', 'USD', 244.6, 0.0014],
  [1009, 'V', 'Visa Inc.', 'stock', 'USD', 309.9, 0.0012],
  [1010, 'NFLX', 'Netflix Inc.', 'stock', 'USD', 902.3, 0.0026],
  [1011, 'AMD', 'Advanced Micro Devices', 'stock', 'USD', 122.4, 0.0029],
  [1012, 'INTC', 'Intel Corp.', 'stock', 'USD', 21.3, 0.0025],
  [1013, 'DIS', 'Walt Disney Co.', 'stock', 'USD', 112.7, 0.0017],
  [1014, 'BA', 'Boeing Co.', 'stock', 'USD', 156.2, 0.0023],
  [1015, 'XOM', 'Exxon Mobil', 'stock', 'USD', 118.9, 0.0013],
  // Azioni EU
  [1101, 'ASML', 'ASML Holding', 'stock', 'EUR', 672.4, 0.0022],
  [1102, 'SAP', 'SAP SE', 'stock', 'EUR', 238.9, 0.0015],
  [1103, 'MC.PA', 'LVMH', 'stock', 'EUR', 618.5, 0.0019],
  [1104, 'ENEL', 'Enel SpA', 'stock', 'EUR', 7.14, 0.0011],
  [1105, 'RACE', 'Ferrari NV', 'stock', 'EUR', 428.7, 0.0018],
  [1106, 'SIE', 'Siemens AG', 'stock', 'EUR', 188.3, 0.0014],
  [1107, 'NESN', 'Nestlé SA', 'stock', 'CHF', 76.2, 0.0009],
  [1108, 'SHEL', 'Shell plc', 'stock', 'GBP', 26.4, 0.0012],
  // ETF
  [1201, 'SPY', 'SPDR S&P 500 ETF', 'etf', 'USD', 598.4, 0.0009],
  [1202, 'QQQ', 'Invesco QQQ Trust', 'etf', 'USD', 524.7, 0.0012],
  [1203, 'VWCE', 'Vanguard FTSE All-World', 'etf', 'EUR', 128.6, 0.0007],
  [1204, 'IWM', 'iShares Russell 2000', 'etf', 'USD', 232.1, 0.0011],
  [1205, 'GLD', 'SPDR Gold Shares', 'etf', 'USD', 252.8, 0.0008],
  [1206, 'TLT', 'iShares 20+ Year Treasury', 'etf', 'USD', 89.4, 0.0010],
  // Crypto
  [1301, 'BTC', 'Bitcoin', 'crypto', 'USD', 97400, 0.0035],
  [1302, 'ETH', 'Ethereum', 'crypto', 'USD', 3680, 0.0042],
  [1303, 'SOL', 'Solana', 'crypto', 'USD', 214.5, 0.0052],
  [1304, 'XRP', 'Ripple', 'crypto', 'USD', 2.31, 0.0058],
  [1305, 'ADA', 'Cardano', 'crypto', 'USD', 1.02, 0.0048],
  // FX
  [1401, 'EURUSD', 'Euro / Dollaro USA', 'fx', 'USD', 1.0923, 0.0004],
  [1402, 'GBPUSD', 'Sterlina / Dollaro USA', 'fx', 'USD', 1.2712, 0.0005],
  [1403, 'USDJPY', 'Dollaro USA / Yen', 'fx', 'JPY', 154.8, 0.0006],
  // Indici
  [1501, 'SPX500', 'S&P 500', 'index', 'USD', 6012.4, 0.0008],
  [1502, 'NSDQ100', 'Nasdaq 100', 'index', 'USD', 21450.2, 0.0011],
  [1503, 'DJ30', 'Dow Jones 30', 'index', 'USD', 44310.7, 0.0007],
  [1504, 'GER40', 'DAX 40', 'index', 'EUR', 20310.5, 0.0009],
  [1505, 'FRA40', 'CAC 40', 'index', 'EUR', 7480.2, 0.0009],
  [1506, 'UK100', 'FTSE 100', 'index', 'GBP', 8312.8, 0.0006],
];

const TICK_MS = 1500;
const SEED = 20250816;
const EURUSD_ID = 1401;

export class DemoDataProvider implements DataProvider {
  readonly mode = 'demo' as const;
  private emitter = new ProviderEmitter();
  private instruments = new Map<number, SimInstrument>();
  private positions: Position[] = [];
  private cash = 3200;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rng = mulberry32(SEED);
  private liveRng = mulberry32((SEED ^ Date.now()) >>> 0);
  private nextPositionId = 9000;
  private nextOrderId = 1;
  private logSeq = 0;

  constructor() {
    // Stato iniziale deterministico
    for (const [id, symbol, name, assetClass, currency, base, vol] of CATALOG) {
      const drift = (this.rng() - 0.48) * 0.0006;
      const price = base * (1 + (this.rng() - 0.5) * 0.04);
      const prevClose = price * (1 + (this.rng() - 0.5) * 0.01);
      const history: number[] = [];
      let p = prevClose;
      for (let i = 0; i < 120; i++) {
        p *= 1 + (this.rng() - 0.5) * 2 * vol + drift;
        history.push(p);
      }
      this.instruments.set(id, {
        instrumentId: id, symbol, name, assetClass, currency, exchange: assetClass === 'stock' ? (currency === 'USD' ? 'NASDAQ' : 'XETRA') : undefined,
        price, prevClose, vol, drift, history,
      });
    }
    this.seedPositions();
  }

  /* ── Posizioni demo (~10) ────────────────────────────────────────── */
  private seedPositions() {
    const defs: Array<[number, number, number, number, number]> = [
      // [instrumentId, units, openPriceOffset%, invested, daysAgo]
      [1001, 12, -0.06, 2600, 42],
      [1003, 20, -0.11, 2400, 65],
      [1002, 6, 0.03, 2500, 30],
      [1007, 8, -0.09, 2600, 55],
      [1201, 5, -0.04, 2900, 90],
      [1203, 18, -0.02, 2250, 120],
      [1301, 0.03, -0.15, 2700, 75],
      [1302, 0.6, 0.05, 2100, 25],
      [1101, 3, -0.07, 1900, 48],
      [1010, 2, 0.08, 1700, 18],
    ];
    let pid = 5000;
    for (const [iid, units, off, invested, daysAgo] of defs) {
      const inst = this.instruments.get(iid)!;
      const openPrice = inst.price * (1 + off);
      const open = new Date(Date.now() - daysAgo * 86400_000);
      this.positions.push({
        positionId: pid++,
        instrumentId: iid,
        symbol: inst.symbol,
        name: inst.name,
        assetClass: inst.assetClass,
        currency: inst.currency,
        isBuy: true,
        units,
        openPrice,
        openDate: open.toISOString(),
        invested,
        fees: Math.round(invested * 0.001 * 100) / 100,
        leverage: 1,
      });
    }
  }

  /* ── Lifecycle ───────────────────────────────────────────────────── */
  start(): void {
    if (this.timer) return;
    this.emitter.emit('status', 'demo');
    this.log('info', 'Modalità Demo attiva — dati simulati, nessun ordine reale.');
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  on: DataProvider['on'] = (event, handler) => this.emitter.on(event, handler);

  private log(level: LogEntry['level'], message: string) {
    this.emitter.emit('log', {
      id: `demo-${++this.logSeq}`,
      timestamp: Date.now(),
      level,
      message,
    });
  }

  /* ── Tick engine ─────────────────────────────────────────────────── */
  private tick() {
    const quotes: Quote[] = [];
    for (const inst of this.instruments.values()) {
      const shock = (this.liveRng() + this.liveRng() + this.liveRng() - 1.5) / 1.5; // ~triangolare
      inst.price = Math.max(inst.price * (1 + shock * inst.vol * 2 + inst.drift), inst.price * 0.5);
      inst.history.push(inst.price);
      if (inst.history.length > 120) inst.history.shift();
      quotes.push(this.toQuote(inst));
    }
    this.emitter.emit('quotes', quotes);
    this.emitter.emit('portfolio', this.buildPortfolio());
  }

  private toQuote(inst: SimInstrument): Quote {
    const spread = inst.price * 0.0004;
    return {
      instrumentId: inst.instrumentId,
      bid: inst.price - spread / 2,
      ask: inst.price + spread / 2,
      last: inst.price,
      prevClose: inst.prevClose,
      changePct: ((inst.price - inst.prevClose) / inst.prevClose) * 100,
      timestamp: Date.now(),
    };
  }

  /* ── Dati ────────────────────────────────────────────────────────── */
  private positionValue(p: Position): number {
    const inst = this.instruments.get(p.instrumentId);
    const price = inst ? inst.price : p.openPrice;
    return p.units * price * p.leverage;
  }

  private buildPortfolio(): Portfolio {
    let positionsValue = 0;
    let totalInvested = 0;
    const positions = this.positions.map((p) => {
      const inst = this.instruments.get(p.instrumentId);
      const currentPrice = inst ? inst.price : p.openPrice;
      const value = p.units * currentPrice * p.leverage;
      const pnl = value - p.invested - p.fees;
      positionsValue += value;
      totalInvested += p.invested;
      return { ...p, currentPrice, pnl, pnlPct: (pnl / p.invested) * 100 };
    });
    return {
      positions,
      cash: this.cash,
      totalInvested,
      positionsValue,
      totalValue: this.cash + positionsValue,
      currency: 'USD',
    };
  }

  async getPortfolio(): Promise<Portfolio> {
    return this.buildPortfolio();
  }

  async getPnl(): Promise<PnlSummary> {
    const portfolio = this.buildPortfolio();
    const totalPnl = portfolio.positionsValue - portfolio.totalInvested
      - portfolio.positions.reduce((s, p) => s + p.fees, 0);
    const totalPnlPct = (totalPnl / portfolio.totalInvested) * 100;

    // Storico equity giornaliero deterministico (365 giorni) che termina al valore attuale
    const rng = mulberry32(SEED ^ 0x9e3779b9);
    const days = 365;
    const start = portfolio.totalValue / (1 + totalPnlPct / 100);
    const history: { time: number; value: number }[] = [];
    let v = start;
    const dailyVol = 0.011;
    const drift = Math.pow(portfolio.totalValue / start, 1 / days) - 1;
    const now = Math.floor(Date.now() / 1000);
    for (let i = days; i >= 0; i--) {
      history.push({ time: now - i * 86400, value: v });
      v *= 1 + drift + (rng() - 0.5) * 2 * dailyVol;
    }
    // Ancora l'ultimo punto al valore reale
    history[history.length - 1].value = portfolio.totalValue;
    const dayAgo = history[history.length - 2]?.value ?? portfolio.totalValue;
    const dailyPnl = portfolio.totalValue - dayAgo;
    return {
      dailyPnl,
      dailyPnlPct: (dailyPnl / dayAgo) * 100,
      totalPnl,
      totalPnlPct,
      equityHistory: history,
    };
  }

  async getQuotes(instrumentIds: number[]): Promise<Quote[]> {
    return instrumentIds
      .map((id) => this.instruments.get(id))
      .filter((i): i is SimInstrument => !!i)
      .map((i) => this.toQuote(i));
  }

  /** Ultimi prezzi simulati (per sparkline / RSI dell'Agent). */
  getRecentPrices(instrumentId: number): number[] {
    return this.instruments.get(instrumentId)?.history ?? [];
  }

  async getCandles(instrumentId: number, interval: CandleInterval, count: number): Promise<Candle[]> {
    const inst = this.instruments.get(instrumentId);
    if (!inst) return [];
    const seconds: Record<CandleInterval, number> = {
      OneMinute: 60, FiveMinutes: 300, OneHour: 3600, OneDay: 86400, OneWeek: 604800,
    };
    const step = seconds[interval];
    const rng = mulberry32(SEED ^ instrumentId ^ step);
    const volPerCandle = inst.vol * Math.sqrt(step / TICK_MS * 1000 / 40);
    const candles: Candle[] = [];
    const now = Math.floor(Date.now() / 1000);
    // Genera all'indietro dal prezzo corrente
    let close = inst.price;
    const reversed: Candle[] = [];
    for (let i = 0; i < count; i++) {
      const open = close * (1 + (rng() - 0.5) * 2 * volPerCandle);
      const high = Math.max(open, close) * (1 + rng() * volPerCandle);
      const low = Math.min(open, close) * (1 - rng() * volPerCandle);
      reversed.push({
        time: now - i * step,
        open, high, low, close,
        volume: Math.round(1e6 * rng()),
      });
      close = open;
    }
    for (let i = reversed.length - 1; i >= 0; i--) candles.push(reversed[i]);
    return candles;
  }

  async searchInstruments(query: string): Promise<Instrument[]> {
    const q = query.trim().toLowerCase();
    if (!q) return this.listInstruments().slice(0, 20);
    return this.listInstruments().filter(
      (i) => i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q),
    ).slice(0, 20);
  }

  listInstruments(): Instrument[] {
    return [...this.instruments.values()].map(({ instrumentId, symbol, name, assetClass, currency, exchange }) => ({
      instrumentId, symbol, name, assetClass, currency, exchange,
    }));
  }

  getFxRate(): FxRate {
    const inst = this.instruments.get(EURUSD_ID)!;
    return {
      pair: 'EURUSD',
      rate: inst.price,
      prevClose: inst.prevClose,
      changePct: ((inst.price - inst.prevClose) / inst.prevClose) * 100,
      timestamp: Date.now(),
    };
  }

  /* ── Ordini simulati ─────────────────────────────────────────────── */
  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    const inst = this.instruments.get(req.instrumentId);
    if (!inst) return { ok: false, message: 'Strumento non trovato' };
    if (req.amount <= 0) return { ok: false, message: 'Importo non valido' };
    if (req.amount > this.cash) return { ok: false, message: 'Cash insufficiente in Demo' };

    const leverage = req.leverage ?? 1;
    const units = req.amount / (inst.price * leverage);
    this.cash -= req.amount;
    const position: Position = {
      positionId: this.nextPositionId++,
      instrumentId: inst.instrumentId,
      symbol: inst.symbol,
      name: inst.name,
      assetClass: inst.assetClass,
      currency: inst.currency,
      isBuy: req.isBuy,
      units,
      openPrice: inst.price,
      openDate: new Date().toISOString(),
      invested: req.amount,
      fees: 0,
      leverage,
      stopLossRate: req.stopLossRate,
      takeProfitRate: req.takeProfitRate,
    };
    this.positions.push(position);
    this.log('success', `Ordine Demo eseguito: ${req.isBuy ? 'BUY' : 'SELL'} ${inst.symbol} · $${req.amount.toFixed(2)} @ ${inst.price.toFixed(2)}`);
    this.emitter.emit('portfolio', this.buildPortfolio());
    return { ok: true, orderId: `demo-order-${this.nextOrderId++}`, positionId: position.positionId };
  }

  async closePosition(positionId: number): Promise<OrderResult> {
    const idx = this.positions.findIndex((p) => p.positionId === positionId);
    if (idx < 0) return { ok: false, message: 'Posizione non trovata' };
    const [p] = this.positions.splice(idx, 1);
    this.cash += this.positionValue(p) - p.fees;
    this.log('info', `Posizione Demo chiusa: ${p.symbol} (#${positionId})`);
    this.emitter.emit('portfolio', this.buildPortfolio());
    return { ok: true, orderId: `demo-close-${this.nextOrderId++}` };
  }
}
