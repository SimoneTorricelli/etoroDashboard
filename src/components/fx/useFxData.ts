/**
 * Hook condivisi del modulo FX (/fx):
 * - useFxHistory: candele EUR/USD per timeframe + statistiche derivate
 *   (max/min 24h, Δ7g, Δ30g, medie 30/50/90g) usate da hero, advisor e calcolatore.
 * - useFxBands: soglie target trascinabili del grafico (persistenza localStorage).
 *   La soglia "target" è settings.fxTargetRate (alimenta withdrawalAdvisor).
 * - useFxAlerts: avvisi di cambio con persistenza localStorage e valutazione a ogni tick.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppData } from '@/lib/data/store';
import type { Candle, CandleInterval } from '@/lib/data/types';

/* ── Storico ───────────────────────────────────────────────────────── */

export type FxTimeframe = '1S' | '1M' | '3M' | '1A' | '5A';

export const FX_TIMEFRAMES: Array<{ key: FxTimeframe; interval: CandleInterval; count: number }> = [
  { key: '1S', interval: 'OneDay', count: 7 },
  { key: '1M', interval: 'OneDay', count: 30 },
  { key: '3M', interval: 'OneDay', count: 90 },
  { key: '1A', interval: 'OneDay', count: 365 },
  { key: '5A', interval: 'OneWeek', count: 260 },
];

export interface FxStats {
  high24h: number | null;
  low24h: number | null;
  /** Variazioni % (punti percentuali). */
  change7dPct: number | null;
  change30dPct: number | null;
  mean30: number | null;
  mean50: number | null;
  mean90: number | null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function useFxHistory(timeframe: FxTimeframe) {
  const { getCandles, getFxInstrumentId, instruments } = useAppData();
  const [candles, setCandles] = useState<Candle[]>([]);
  const [daily, setDaily] = useState<Candle[]>([]);
  const [loadingCandles, setLoadingCandles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fxInstrumentId = instruments.find((instrument) => instrument.symbol.toUpperCase() === 'EURUSD')?.instrumentId ?? getFxInstrumentId();

  /* Serie del timeframe selezionato (grafico) */
  useEffect(() => {
    if (!fxInstrumentId) {
      const timer = window.setTimeout(() => { setLoadingCandles(false); setError('ID EUR/USD non disponibile nel catalogo eToro.'); }, 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    const tf = FX_TIMEFRAMES.find((t) => t.key === timeframe)!;
    const timer = window.setTimeout(() => { if (!controller.signal.aborted) { setLoadingCandles(true); setError(null); } }, 0);
    void getCandles(fxInstrumentId, tf.interval, tf.count, controller.signal).then((cs) => {
      if (controller.signal.aborted) return;
      setCandles(cs);
      setLoadingCandles(false);
      if (cs.length < 2) setError('Storico insufficiente da eToro per questo timeframe.');
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setCandles([]);
      setLoadingCandles(false);
      setError(reason instanceof Error && /429|rate/i.test(reason.message) ? 'Quota eToro temporaneamente esaurita. Riprova tra poco.' : 'Storico EUR/USD non disponibile da eToro.');
    });
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [getCandles, timeframe, fxInstrumentId]);

  /* Serie giornaliera fissa (statistiche hero/advisor/calcolatore) */
  useEffect(() => {
    if (!fxInstrumentId) return undefined;
    const controller = new AbortController();
    void getCandles(fxInstrumentId, 'OneDay', 120, controller.signal).then((cs) => {
      if (!controller.signal.aborted) setDaily(cs);
    }).catch(() => { if (!controller.signal.aborted) setDaily([]); });
    return () => controller.abort();
  }, [getCandles, fxInstrumentId]);

  const stats = useMemo<FxStats>(() => {
    if (daily.length < 2) {
      return { high24h: null, low24h: null, change7dPct: null, change30dPct: null, mean30: null, mean50: null, mean90: null };
    }
    const closes = daily.map((c) => c.close);
    const last = closes[closes.length - 1];
    const pct = (days: number) => {
      const ref = closes[closes.length - 1 - days];
      return ref ? ((last - ref) / ref) * 100 : null;
    };
    const today = daily[daily.length - 1];
    return {
      high24h: today.high,
      low24h: today.low,
      change7dPct: pct(7),
      change30dPct: pct(30),
      mean30: mean(closes.slice(-30)),
      mean50: mean(closes.slice(-50)),
      mean90: mean(closes.slice(-90)),
    };
  }, [daily]);

  return { candles, daily, stats, loadingCandles, error, fxInstrumentId };
}

/* ── Bande target ──────────────────────────────────────────────────── */

const UPPER_BAND_KEY = 'torino.fx.upperBand.v1';

function loadUpperBand(fallback: number): number {
  try {
    const raw = localStorage.getItem(UPPER_BAND_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Bande del grafico: il bordo verde è la soglia target (settings.fxTargetRate,
 * usata anche da withdrawalAdvisor); il bordo rosso è una soglia superiore
 * persistita in localStorage. Trascinando le bande si aggiornano entrambe.
 */
export function useFxBands() {
  const { settings, updateSettings } = useAppData();
  const target = settings.fxTargetRate;
  const [upper, setUpper] = useState<number>(() => loadUpperBand(target + 0.04));

  const setTarget = useCallback((v: number) => {
    const clamped = Math.round(v * 10000) / 10000;
    updateSettings({ fxTargetRate: clamped });
  }, [updateSettings]);

  const setUpperBand = useCallback((v: number) => {
    const clamped = Math.round(v * 10000) / 10000;
    setUpper(clamped);
    try { localStorage.setItem(UPPER_BAND_KEY, String(clamped)); } catch { /* ignora */ }
  }, []);

  return { target, upper, setTarget, setUpperBand };
}

/* ── Avvisi di cambio ──────────────────────────────────────────────── */

export interface FxAlert {
  id: string;
  /** Soglia EUR/USD (es. 1.10). */
  threshold: number;
  direction: 'above' | 'below';
  note?: string;
  createdAt: number;
  triggeredAt?: number;
}

const ALERTS_KEY = 'torino.fx.alerts.v1';

function loadAlerts(): FxAlert[] {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FxAlert[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAlerts(alerts: FxAlert[]): void {
  try { localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts)); } catch { /* ignora */ }
}

export function useFxAlerts() {
  const [alerts, setAlerts] = useState<FxAlert[]>(loadAlerts);

  const addAlert = useCallback((a: Omit<FxAlert, 'id' | 'createdAt'>) => {
    setAlerts((prev) => {
      const next: FxAlert[] = [
        { ...a, id: `fxa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() },
        ...prev,
      ];
      saveAlerts(next);
      return next;
    });
  }, []);

  const removeAlert = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.filter((a) => a.id !== id);
      saveAlerts(next);
      return next;
    });
  }, []);

  /** Marca un avviso come scattato (mantiene la riga in cima con check). */
  const markTriggered = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.map((a) => (a.id === id ? { ...a, triggeredAt: Date.now() } : a));
      saveAlerts(next);
      return next;
    });
  }, []);

  /** Ri-arma un avviso già scattato. */
  const resetAlert = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.map((a) => (a.id === id ? { ...a, triggeredAt: undefined } : a));
      saveAlerts(next);
      return next;
    });
  }, []);

  return { alerts, addAlert, removeAlert, markTriggered, resetAlert };
}

/**
 * Valuta gli avvisi a ogni tick del tasso; ritorna quelli appena scattati.
 * Semantica: "avvisami quando EUR/USD è sopra/sotto la soglia" — scatta una
 * sola volta (triggeredAt persiste), poi va ri-armato manualmente.
 */
export function evaluateFxAlerts(alerts: FxAlert[], rate: number): FxAlert[] {
  return alerts.filter((a) => {
    if (a.triggeredAt) return false;
    return a.direction === 'above' ? rate >= a.threshold : rate <= a.threshold;
  });
}
