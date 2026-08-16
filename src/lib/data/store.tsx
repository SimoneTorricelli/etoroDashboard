/**
 * AppDataStore — React context che istanzia il provider giusto
 * (Demo / Live) in base alle impostazioni e distribuisce dati live
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
import { DemoDataProvider } from './DemoDataProvider';
import { LiveDataProvider } from './LiveDataProvider';
import type { DataProvider } from './DataProvider';
import type {
  Candle,
  CandleInterval,
  ConnectionStatus,
  DataMode,
  FxRate,
  Instrument,
  LogEntry,
  OrderRequest,
  OrderResult,
  PnlSummary,
  Portfolio,
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

const MAX_LOGS = 300;
const SPARK_POINTS = 60;

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

  /* agent */
  agent: AgentEngine;
  /** Contatore che incrementa a ogni update dell'Agent (per re-render). */
  agentVersion: number;

  /* azioni */
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(positionId: number): Promise<OrderResult>;
  refresh(): Promise<void>;
  getCandles(instrumentId: number, interval: CandleInterval, count: number): Promise<Candle[]>;
  searchInstruments(query: string): Promise<Instrument[]>;
  /** Ultimi prezzi osservati per sparkline (max 60 punti). */
  sparkFor(instrumentId: number): number[];
}

const AppDataContext = createContext<AppDataStore | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [status, setStatus] = useState<ConnectionStatus>('demo');
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<Record<number, Quote>>({});
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [fxRate, setFxRate] = useState<FxRate | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentVersion, setAgentVersion] = useState(0);

  const providerRef = useRef<DataProvider | null>(null);
  const sparksRef = useRef<Map<number, number[]>>(new Map());

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
      getProvider: () => providerRef.current ?? new DemoDataProvider(),
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

    const useLive = settings.mode === 'live' && hasLiveCredentials(settings);
    const provider: DataProvider = useLive
      ? new LiveDataProvider(settings.live)
      : new DemoDataProvider();
    providerRef.current = provider;

    const offQuotes = provider.on('quotes', (qs) => {
      if (cancelled) return;
      setQuotes((prevQuotes) => {
        const next = { ...prevQuotes };
        for (const q of qs) next[q.instrumentId] = q;
        return next;
      });
      for (const q of qs) {
        let arr = sparksRef.current.get(q.instrumentId);
        if (!arr) { arr = []; sparksRef.current.set(q.instrumentId, arr); }
        arr.push(q.last);
        if (arr.length > SPARK_POINTS) arr.shift();
      }
      agent.handleQuotes(qs);
      if (provider.mode === 'demo') setFxRate(provider.getFxRate());
    });
    const offPortfolio = provider.on('portfolio', (p) => { if (!cancelled) setPortfolio(p); });
    const offStatus = provider.on('status', (s) => { if (!cancelled) setStatus(s); });
    const offLog = provider.on('log', (l) => { if (!cancelled) pushLog(l); });

    setLoading(true);
    setInstruments(provider.listInstruments());
    provider.start();
    void (async () => {
      try {
        const [pf, pnlData] = await Promise.all([provider.getPortfolio(), provider.getPnl()]);
        if (cancelled) return;
        setPortfolio(pf);
        setPnl(pnlData);
        setFxRate(provider.getFxRate());
        const initialQuotes = await provider.getQuotes(provider.listInstruments().map((i) => i.instrumentId));
        if (cancelled) return;
        setQuotes(Object.fromEntries(initialQuotes.map((q) => [q.instrumentId, q])));
        for (const q of initialQuotes) {
          let arr = sparksRef.current.get(q.instrumentId);
          if (!arr) { arr = []; sparksRef.current.set(q.instrumentId, arr); }
          arr.push(q.last);
        }
      } catch {
        /* lo stato di errore arriva via evento 'status' */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      offQuotes(); offPortfolio(); offStatus(); offLog();
      provider.stop();
      providerRef.current = null;
    };
    // Re-istanzia solo quando cambia la configurazione rilevante
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.mode, settings.live.apiKey, settings.live.userKey, settings.live.proxyUrl, settings.live.environment]);

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
    const rate = fxRate?.rate ?? 1.09;
    return usd / rate;
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
    (instrumentId: number, interval: CandleInterval, count: number) =>
      providerRef.current?.getCandles(instrumentId, interval, count) ?? Promise.resolve([]),
    [],
  );

  const searchInstruments = useCallback(
    (query: string) => providerRef.current?.searchInstruments(query) ?? Promise.resolve([]),
    [],
  );

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
    agent,
    agentVersion,
    placeOrder,
    closePosition,
    refresh,
    getCandles,
    searchInstruments,
    sparkFor,
  }), [
    settings, updateSettings, updateLiveSettings, setMode, setDisplayCurrency, setDensity,
    fromUsd, realExecutionActive, status, loading, quotes, portfolio, pnl, fxRate,
    instruments, logs, agent, agentVersion, placeOrder, closePosition, refresh,
    getCandles, searchInstruments, sparkFor,
  ]);

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** Hook di accesso allo store. Deve essere usato dentro <AppDataProvider>. */
export function useAppData(): AppDataStore {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData deve essere usato dentro <AppDataProvider>');
  return ctx;
}
