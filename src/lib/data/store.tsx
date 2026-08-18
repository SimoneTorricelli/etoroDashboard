/**
 * AppDataStore — React context che istanzia il provider Live
 * quando la configurazione è completa e distribuisce dati reali
 * a tutta l'app.
 *
 * Uso:
 *   const { portfolio, quotes, fxRate, agent, ... } = useAppData();
 *
 * Persistenza: solo localStorage (impostazioni + stato Agent).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { LiveDataProvider } from './LiveDataProvider';
import type { DataProvider } from './DataProvider';
import type {
  Candle,
  CandleInterval,
  ClosedTrade,
  ConnectionStatus,
  DataMode,
  FxRate,
  HistoricalClosingPrice,
  Instrument,
  LogEntry,
  OrderRequest,
  OrderResult,
  PnlSummary,
  Portfolio,
  PriceAlert,
  Quote,
} from './types';
import {
  hasLiveCredentials,
  isRealExecutionActive,
  loadSettings,
  saveSettings,
} from '../settings';
import type { AppSettings, Density, DisplayCurrency, LiveSettings } from '../settings';
import { AgentEngine } from '../agent/engine';
import { externalCryptoSymbol, fetchBinancePrices, openBinanceTickerStream } from './ExternalPriceProvider';

const MAX_LOGS = 300;
const SPARK_POINTS = 60;
const PRICE_ALERTS_KEY = 'torino.price-alerts.v1';

function loadPriceAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(PRICE_ALERTS_KEY);
    return raw ? (JSON.parse(raw) as PriceAlert[]) : [];
  } catch {
    return [];
  }
}

function savePriceAlerts(alerts: PriceAlert[]) {
  try { localStorage.setItem(PRICE_ALERTS_KEY, JSON.stringify(alerts)); } catch { /* storage bloccato: ignora */ }
}

export interface AppDataStore {
  /* impostazioni */
  settings: AppSettings;
  updateSettings(patch: Partial<AppSettings>): void;
  updateLiveSettings(patch: Partial<LiveSettings>): void;
  mode: DataMode;
  setMode(mode: DataMode): void;
  displayCurrency: DisplayCurrency;
  setDisplayCurrency(c: DisplayCurrency): void;
  density: Density;
  setDensity(d: Density): void;
  /** Converte un importo USD (valuta conto) nella valuta di display. */
  fromUsd(usd: number): number;
  /** true se Live+REAL+write: gli ordini usano denaro reale. */
  realExecutionActive: boolean;

  /* stato provider */
  status: ConnectionStatus;
  loading: boolean;
  provider: DataProvider | null;

  /* dati */
  quotes: Record<number, Quote>;
  portfolio: Portfolio | null;
  pnl: PnlSummary | null;
  fxRate: FxRate | null;
  instruments: Instrument[];
  logs: LogEntry[];
  priceAlerts: PriceAlert[];

  /* agent */
  agent: AgentEngine;
  /** Contatore che incrementa a ogni update dell'Agent (per re-render). */
  agentVersion: number;

  /* azioni */
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(positionId: number): Promise<OrderResult>;
  refresh(): Promise<void>;
  getCandles(instrumentId: number, interval: CandleInterval, count: number, signal?: AbortSignal): Promise<Candle[]>;
  getQuotes(instrumentIds: number[]): Promise<Quote[]>;
  getHistoricalClosingPrices(): Promise<HistoricalClosingPrice[]>;
  getTradeHistory(): Promise<ClosedTrade[]>;
  getFxInstrumentId(): number | null;
  searchInstruments(query: string): Promise<Instrument[]>;
  addPriceAlert(alert: Omit<PriceAlert, 'id' | 'createdAt' | 'triggeredAt'>): void;
  removePriceAlert(id: string): void;
  resetPriceAlert(id: string): void;
  /** Ultimi prezzi osservati per sparkline (max 60 punti). */
  sparkFor(instrumentId: number): number[];
}

const AppDataContext = createContext<AppDataStore | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<Record<number, Quote>>({});
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [fxRate, setFxRate] = useState<FxRate | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>(loadPriceAlerts);
  const [agentVersion, setAgentVersion] = useState(0);

  const providerRef = useRef<DataProvider | null>(null);
  const sparksRef = useRef<Map<number, number[]>>(new Map());
  const priceAlertsRef = useRef(priceAlerts);
  priceAlertsRef.current = priceAlerts;
  const previousQuotesRef = useRef<Record<number, number>>({});

  const pushLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [entry, ...prev].slice(0, MAX_LOGS));
  }, []);

  /* ref delle settings per i callback dell'engine (evita closure stale) */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* Agent engine: stabile per tutta la vita dell'app */
  const agentRef = useRef<AgentEngine | null>(null);
  if (!agentRef.current) {
    agentRef.current = new AgentEngine({
      getProvider: () => providerRef.current,
      getMode: () => settingsRef.current.mode,
      canWrite: () => {
        const s = settingsRef.current;
        return s.mode === 'live' && s.live.permissions === 'write';
      },
      log: (level, message) =>
        pushLog({ id: `app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now(), level, message }),
    });
  }
  const agent = agentRef.current;

  useEffect(() => agent.onUpdate(() => setAgentVersion((v) => v + 1)), [agent]);

  /* Istanziazione/switch provider */
  useEffect(() => {
    let cancelled = false;
    const prev = providerRef.current;
    if (prev) prev.stop();

    const useLive = hasLiveCredentials(settings);
    if (!useLive) {
      providerRef.current = null;
      setStatus('disconnected');
      setLoading(false);
      setQuotes({});
      setPortfolio(null);
      setPnl(null);
      setFxRate(null);
      setInstruments([]);
      previousQuotesRef.current = {};
      return () => { cancelled = true; };
    }
    const provider: DataProvider = new LiveDataProvider(settings.live);
    providerRef.current = provider;

    const offQuotes = provider.on('quotes', (qs) => {
      if (cancelled) return;
      const fired: Array<{ alert: PriceAlert; quote: Quote }> = [];
      const currentAlerts = priceAlertsRef.current;
      for (const q of qs) {
        const previous = previousQuotesRef.current[q.instrumentId];
        if (previous == null) continue;
        for (const alert of currentAlerts) {
          if (alert.instrumentId !== q.instrumentId || alert.triggeredAt) continue;
          const crossed = alert.direction === 'above'
            ? previous < alert.threshold && q.last >= alert.threshold
            : previous > alert.threshold && q.last <= alert.threshold;
          if (crossed) fired.push({ alert, quote: q });
        }
      }
      if (fired.length > 0) {
        const firedIds = new Set(fired.map(({ alert }) => alert.id));
        const now = Date.now();
        const nextAlerts = currentAlerts.map((alert) =>
          firedIds.has(alert.id) ? { ...alert, triggeredAt: now } : alert,
        );
        priceAlertsRef.current = nextAlerts;
        setPriceAlerts(nextAlerts);
        savePriceAlerts(nextAlerts);
        for (const { alert, quote } of fired) {
          const instrument = provider.listInstruments().find((i) => i.instrumentId === alert.instrumentId);
          const symbol = instrument?.symbol ?? alert.symbol;
          const direction = alert.direction === 'above' ? 'ha superato' : 'è sceso sotto';
          pushLog({
            id: `alert-${alert.id}-${now}`,
            timestamp: now,
            level: 'warn',
            message: `Avviso prezzo: ${symbol} ${direction} ${alert.threshold} (ora ${quote.last}).`,
          });
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try { new Notification(`Torino — ${symbol}`, { body: `Prezzo ${direction} ${alert.threshold}: ${quote.last}` }); } catch { /* ignora */ }
          }
        }
      }
      setQuotes((prevQuotes) => {
        const next = { ...prevQuotes };
        for (const q of qs) next[q.instrumentId] = q;
        return next;
      });
      for (const q of qs) {
        previousQuotesRef.current[q.instrumentId] = q.last;
        let arr = sparksRef.current.get(q.instrumentId);
        if (!arr) { arr = []; sparksRef.current.set(q.instrumentId, arr); }
        arr.push(q.last);
        if (arr.length > SPARK_POINTS) arr.shift();
      }
      agent.handleQuotes(qs);
      setFxRate(provider.getFxRate());
    });
    const offPortfolio = provider.on('portfolio', (p) => {
      if (cancelled) return;
      setPortfolio(p);
      // Il provider può aver appena risolto i metadati degli instrumentID live.
      setInstruments(provider.listInstruments());
    });
    const offPnl = provider.on('pnl', (p) => {
      if (!cancelled) setPnl(p);
    });
    const offStatus = provider.on('status', (s) => {
      if (cancelled) return;
      setStatus(s);
      if (s === 'connected' || s === 'error') setLoading(false);
    });
    const offLog = provider.on('log', (l) => { if (!cancelled) pushLog(l); });

    setLoading(true);
    setInstruments(provider.listInstruments());
    provider.start();

    return () => {
      cancelled = true;
      offQuotes(); offPortfolio(); offPnl(); offStatus(); offLog();
      provider.stop();
      providerRef.current = null;
      previousQuotesRef.current = {};
    };
    // Re-istanzia solo quando cambia la configurazione rilevante
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.mode, settings.live.apiKey, settings.live.userKey, settings.live.proxyUrl, settings.live.environment]);

  /* Avvisi esterni opzionali: stream Binance per le crypto, separato dai dati
   * eToro. Il prezzo esterno non aggiorna portafoglio, P&L o ordini. */
  useEffect(() => {
    const externalAlerts = priceAlerts.filter((alert) => alert.source === 'binance' && !alert.triggeredAt && externalCryptoSymbol(alert.symbol));
    if (externalAlerts.length === 0) return undefined;
    let cancelled = false;
    const symbols = [...new Set(externalAlerts.map((alert) => alert.symbol.toUpperCase()))];
    const evaluate = (symbol: string, price: number) => {
      if (cancelled || !Number.isFinite(price) || price <= 0) return;
      const current = priceAlertsRef.current;
      const fired = current.filter((alert) => alert.source === 'binance' && !alert.triggeredAt && alert.symbol.toUpperCase() === symbol && (
        alert.direction === 'above' ? price >= alert.threshold : price <= alert.threshold
      ));
      if (fired.length === 0) return;
      const now = Date.now();
      const ids = new Set(fired.map((alert) => alert.id));
      const next = current.map((alert) => ids.has(alert.id) ? { ...alert, triggeredAt: now } : alert);
      priceAlertsRef.current = next;
      setPriceAlerts(next);
      savePriceAlerts(next);
      for (const alert of fired) {
        const direction = alert.direction === 'above' ? 'ha superato' : 'è sceso sotto';
        pushLog({ id: `external-alert-${alert.id}-${now}`, timestamp: now, level: 'warn', message: `Avviso esterno Binance: ${symbol} ${direction} ${alert.threshold} (ora ${price}).` });
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try { new Notification(`Torino — ${symbol} (Binance)`, { body: `Prezzo ${direction} ${alert.threshold}: ${price}` }); } catch { /* ignora */ }
        }
      }
    };
    const stopStream = openBinanceTickerStream(symbols, evaluate);
    const poll = async () => {
      try {
        const prices = await fetchBinancePrices(symbols);
        for (const [symbol, price] of Object.entries(prices)) evaluate(symbol, price);
      } catch { /* lo stream resta best effort */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => { cancelled = true; stopStream(); window.clearInterval(timer); };
  }, [priceAlerts, pushLog]);

  /* ── Azioni ──────────────────────────────────────────────────────── */
  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const updateLiveSettings = useCallback((patch: Partial<LiveSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, live: { ...prev.live, ...patch } };
      saveSettings(next);
      return next;
    });
  }, []);

  const setMode = useCallback((mode: DataMode) => {
    setSettings((prev) => {
      const next = { ...prev, mode };
      saveSettings(next);
      return next;
    });
  }, []);

  const setDisplayCurrency = useCallback((displayCurrency: DisplayCurrency) => {
    updateSettings({ displayCurrency });
  }, [updateSettings]);

  const setDensity = useCallback((density: Density) => {
    updateSettings({ density });
  }, [updateSettings]);

  const fromUsd = useCallback((usd: number): number => {
    if (settings.displayCurrency === 'USD') return usd;
    const rate = fxRate?.rate ?? 0;
    return rate > 0 ? usd / rate : Number.NaN;
  }, [settings.displayCurrency, fxRate]);

  const placeOrder = useCallback(async (req: OrderRequest): Promise<OrderResult> => {
    const provider = providerRef.current;
    if (!provider) return { ok: false, message: 'Provider non inizializzato' };
    const result = await provider.placeMarketOrder(req);
    if (result.ok) {
      const pf = await provider.getPortfolio();
      setPortfolio(pf);
    }
    return result;
  }, []);

  const closePosition = useCallback(async (positionId: number): Promise<OrderResult> => {
    const provider = providerRef.current;
    if (!provider) return { ok: false, message: 'Provider non inizializzato' };
    const result = await provider.closePosition(positionId);
    if (result.ok) {
      const pf = await provider.getPortfolio();
      setPortfolio(pf);
    }
    return result;
  }, []);

  const refresh = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    setLoading(true);
    try {
      const [pf, pnlData] = await Promise.all([provider.getPortfolio(), provider.getPnl()]);
      setPortfolio(pf);
      setPnl(pnlData);
    } finally {
      setLoading(false);
    }
  }, []);

  const getCandles = useCallback(
    (instrumentId: number, interval: CandleInterval, count: number, signal?: AbortSignal) =>
      providerRef.current?.getCandles(instrumentId, interval, count, signal) ?? Promise.resolve([]),
    [],
  );

  const getQuotes = useCallback(
    async (instrumentIds: number[]) => {
      const nextQuotes = await (providerRef.current?.getQuotes(instrumentIds) ?? Promise.resolve([]));
      setQuotes((previous) => {
        const next = { ...previous };
        for (const quote of nextQuotes) next[quote.instrumentId] = quote;
        return next;
      });
      if (providerRef.current) setInstruments(providerRef.current.listInstruments());
      return nextQuotes;
    },
    [],
  );

  const getHistoricalClosingPrices = useCallback(
    () => providerRef.current?.getHistoricalClosingPrices() ?? Promise.resolve([]),
    [],
  );

  const getTradeHistory = useCallback(
    () => providerRef.current?.getTradeHistory() ?? Promise.resolve([]),
    [],
  );

  const getFxInstrumentId = useCallback(() => providerRef.current?.getFxInstrumentId() ?? null, []);

  const searchInstruments = useCallback(
    async (query: string) => {
      const provider = providerRef.current;
      if (!provider) return [];
      const result = await provider.searchInstruments(query);
      setInstruments(provider.listInstruments());
      return result;
    },
    [],
  );

  const addPriceAlert = useCallback((alert: Omit<PriceAlert, 'id' | 'createdAt' | 'triggeredAt'>) => {
    const next: PriceAlert[] = [
      { ...alert, id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() },
      ...priceAlertsRef.current,
    ];
    priceAlertsRef.current = next;
    setPriceAlerts(next);
    savePriceAlerts(next);
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  const removePriceAlert = useCallback((id: string) => {
    const next = priceAlertsRef.current.filter((alert) => alert.id !== id);
    priceAlertsRef.current = next;
    setPriceAlerts(next);
    savePriceAlerts(next);
  }, []);

  const resetPriceAlert = useCallback((id: string) => {
    const next = priceAlertsRef.current.map((alert) => alert.id === id ? { ...alert, triggeredAt: undefined } : alert);
    priceAlertsRef.current = next;
    setPriceAlerts(next);
    savePriceAlerts(next);
  }, []);

  const sparkFor = useCallback((instrumentId: number): number[] => {
    return sparksRef.current.get(instrumentId) ?? [];
  }, []);

  const realExecutionActive = isRealExecutionActive(settings);

  const value = useMemo<AppDataStore>(() => ({
    settings,
    updateSettings,
    updateLiveSettings,
    mode: settings.mode,
    setMode,
    displayCurrency: settings.displayCurrency,
    setDisplayCurrency,
    density: settings.density,
    setDensity,
    fromUsd,
    realExecutionActive,
    status,
    loading,
    provider: providerRef.current,
    quotes,
    portfolio,
    pnl,
    fxRate,
    instruments,
    logs,
    priceAlerts,
    agent,
    agentVersion,
    placeOrder,
    closePosition,
    refresh,
    getCandles,
    getQuotes,
    getHistoricalClosingPrices,
    getTradeHistory,
    getFxInstrumentId,
    searchInstruments,
    addPriceAlert,
    removePriceAlert,
    resetPriceAlert,
    sparkFor,
  }), [
    settings, updateSettings, updateLiveSettings, setMode, setDisplayCurrency, setDensity,
    fromUsd, realExecutionActive, status, loading, quotes, portfolio, pnl, fxRate,
    instruments, logs, priceAlerts, agent, agentVersion, placeOrder, closePosition, refresh,
    getCandles, getQuotes, getHistoricalClosingPrices, getTradeHistory, getFxInstrumentId,
    searchInstruments, addPriceAlert, removePriceAlert, resetPriceAlert, sparkFor,
  ]);

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** Hook di accesso allo store. Deve essere usato dentro <AppDataProvider>. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAppData(): AppDataStore {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData deve essere usato dentro <AppDataProvider>');
  return ctx;
}
