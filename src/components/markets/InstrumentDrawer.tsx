/**
 * InstrumentDrawer — dettaglio strumento (design/markets.md).
 * Drawer destro 480px: header con monogramma, prezzo live, grafico candele
 * (lightweight-charts, intervalli 1m/5m/1h/1g/1S, legenda OHLC crosshair),
 * griglia statistiche, strip posizione, azioni (Nuovo ordine → ConfirmDialog,
 * Crea regola Agent → /agent?new=rule&instrument=<id>, Imposta avviso).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { Bell, BellRing, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import {
  formatCompact, formatFxRate, formatPercent,
  formatPrice, formatSignedCurrency, formatUnits,
} from '@/lib/format';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { DeltaChip } from '@/components/shared/DeltaChip';
import { TickValue } from '@/components/shared/TickValue';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Skeleton } from '@/components/shared/Skeleton';
import type { Candle, CandleInterval, Instrument } from '@/lib/data/types';
import { marketCapFor, volumeFor } from './meta';

const INTERVALS: { key: string; label: string; interval: CandleInterval; count: number; seconds: number }[] = [
  { key: '1m', label: '1m', interval: 'OneMinute', count: 240, seconds: 60 },
  { key: '5m', label: '5m', interval: 'FiveMinutes', count: 200, seconds: 300 },
  { key: '1h', label: '1h', interval: 'OneHour', count: 200, seconds: 3600 },
  { key: '1g', label: '1g', interval: 'OneDay', count: 180, seconds: 86400 },
  { key: '1S', label: '1S', interval: 'OneWeek', count: 104, seconds: 604800 },
];

export interface InstrumentDrawerProps {
  instrument: Instrument | null;
  onClose(): void;
}

export function InstrumentDrawer({ instrument, onClose }: InstrumentDrawerProps) {
  return (
    <Drawer open={instrument != null} onOpenChange={(open) => { if (!open) onClose(); }} direction="right">
      <DrawerContent className="w-full border-l border-hairline bg-bg-1 data-[vaul-drawer-direction=right]:w-full sm:max-w-[480px]">
        {instrument && <DrawerBody key={instrument.instrumentId} instrument={instrument} onClose={onClose} />}
      </DrawerContent>
    </Drawer>
  );
}

function DrawerBody({ instrument, onClose }: { instrument: Instrument; onClose(): void }) {
  const navigate = useNavigate();
  const {
    quotes, portfolio, fxRate, displayCurrency, fromUsd,
    placeOrder, realExecutionActive,
  } = useAppData();

  const quote = quotes[instrument.instrumentId];
  const cur = displayCurrency;

  const [intervalKey, setIntervalKey] = useState('1g');
  const [alertSet, setAlertSet] = useState(false);

  /* ordine */
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState(250);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [orderMsg, setOrderMsg] = useState<string | null>(null);

  const position = useMemo(
    () => portfolio?.positions.find((p) => p.instrumentId === instrument.instrumentId),
    [portfolio, instrument.instrumentId],
  );

  const handleConfirm = useCallback(async () => {
    setPlacing(true);
    try {
      const res = await placeOrder({
        instrumentId: instrument.instrumentId,
        isBuy,
        amount,
      });
      setOrderMsg(res.ok ? `Ordine eseguito${res.orderId ? ` · #${res.orderId}` : ''}` : (res.message ?? 'Ordine rifiutato'));
      if (res.ok) setConfirmOpen(false);
    } finally {
      setPlacing(false);
    }
  }, [placeOrder, instrument.instrumentId, isBuy, amount]);

  const stagger = (i: number) => ({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.24, delay: 0.05 + i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
  });

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <DrawerTitle className="sr-only">{instrument.name}</DrawerTitle>

      {/* Header */}
      <motion.div {...stagger(0)} className="flex items-start gap-3 border-b border-hairline p-5">
        <InstrumentAvatar symbol={instrument.symbol} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-title text-text-0">{instrument.name}</h2>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="font-mono text-ticker text-text-1">{instrument.symbol}</span>
            {instrument.exchange && (
              <span className="rounded border border-hairline px-1.5 py-0.5 text-micro text-text-2">
                {instrument.exchange}
              </span>
            )}
            <span className="rounded border border-hairline px-1.5 py-0.5 text-micro text-text-2">
              {instrument.currency}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Chiudi dettaglio"
          className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </motion.div>

      {/* Prezzo */}
      <motion.div {...stagger(1)} className="flex items-end justify-between gap-3 px-5 pt-4">
        <TickValue
          value={quote?.last ?? 0}
          className="font-display text-display-md text-text-0"
        >
          {quote ? formatPrice(quote.last) : '—'}
        </TickValue>
        {quote && <DeltaChip value={quote.changePct} />}
      </motion.div>

      {/* Grafico candele */}
      <motion.div {...stagger(2)} className="px-5 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="overline">Grafico</span>
          <div className="flex rounded-lg border border-hairline bg-bg-0 p-0.5">
            {INTERVALS.map((it) => (
              <button
                key={it.key}
                onClick={() => setIntervalKey(it.key)}
                className={cn(
                  'rounded-md px-2 py-1 text-micro font-medium transition-colors',
                  intervalKey === it.key ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
                )}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>
        <CandleChart instrumentId={instrument.instrumentId} intervalKey={intervalKey} />
      </motion.div>

      {/* Statistiche */}
      <motion.div {...stagger(3)} className="px-5 pt-4">
        <StatsGrid instrument={instrument} />
      </motion.div>

      {/* Posizione */}
      {position && (
        <motion.div {...stagger(4)} className="px-5 pt-4">
          <div
            className={cn(
              'rounded-lg border p-3',
              (position.pnl ?? 0) >= 0 ? 'border-gain/30 bg-gain-dim' : 'border-loss/30 bg-loss-dim',
            )}
          >
            <div className="text-caption text-text-1">
              Possiedi <span className="text-body-strong text-text-0">{formatUnits(position.units)} unità</span>
              {' · '}P&L{' '}
              <span className={cn('text-body-strong tabular-nums', (position.pnl ?? 0) >= 0 ? 'text-gain' : 'text-loss')}>
                {formatSignedCurrency(fromUsd(position.pnl ?? 0), cur)} ({formatPercent(position.pnlPct ?? 0)})
              </span>
            </div>
          </div>
        </motion.div>
      )}

      {/* Azioni */}
      <motion.div {...stagger(5)} className="mt-auto px-5 py-5">
        <div className="rounded-lg border border-hairline bg-bg-0 p-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 rounded-lg border border-hairline bg-bg-1 p-0.5">
              {([true, false] as const).map((buy) => (
                <button
                  key={String(buy)}
                  onClick={() => setIsBuy(buy)}
                  className={cn(
                    'flex-1 rounded-md px-3 py-1.5 text-micro font-medium transition-colors',
                    isBuy === buy
                      ? buy ? 'bg-gain-dim text-gain' : 'bg-loss-dim text-loss'
                      : 'text-text-2 hover:text-text-1',
                  )}
                >
                  {buy ? 'Compra' : 'Vendi'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 rounded-lg border border-hairline bg-bg-1 px-2 py-1.5">
              <span className="text-micro text-text-2">$</span>
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 0))}
                className="w-20 bg-transparent text-body-strong tabular-nums text-text-0 outline-none"
                aria-label="Importo ordine in USD"
              />
            </label>
          </div>
          <div className="mt-2 flex gap-1.5">
            {[100, 250, 500, 1000].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(v)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-micro transition-colors',
                  amount === v ? 'border-gain/40 text-gain' : 'border-hairline text-text-2 hover:text-text-1',
                )}
              >
                ${v}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setOrderMsg(null); setConfirmOpen(true); }}
            className={cn(
              'mt-3 w-full rounded-lg px-4 py-2.5 text-body-strong transition-colors',
              isBuy ? 'bg-gain text-bg-0 hover:bg-gain/90' : 'bg-loss text-bg-0 hover:bg-loss/90',
            )}
          >
            Nuovo ordine
          </button>
          {orderMsg && <p className="mt-2 text-center text-caption text-text-1">{orderMsg}</p>}
        </div>

        <div className="mt-3 flex gap-2">
          <button
            onClick={() => navigate(`/agent?new=rule&instrument=${instrument.instrumentId}`)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-agent/40 px-3 py-2 text-body-strong text-agent transition-colors hover:bg-agent/10"
          >
            <Zap className="h-4 w-4" aria-hidden />
            Crea regola Agent
          </button>
          <button
            onClick={() => setAlertSet((v) => !v)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-body-strong transition-colors',
              alertSet ? 'text-info' : 'text-text-1 hover:bg-bg-2',
            )}
          >
            {alertSet ? <BellRing className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
            {alertSet ? 'Avviso attivo' : 'Imposta avviso'}
          </button>
        </div>
      </motion.div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Conferma ordine ${instrument.symbol}`}
        description={`${isBuy ? 'Acquisto' : 'Vendita'} a mercato · ${instrument.name}`}
        isBuy={isBuy}
        amountUsd={amount}
        fxRate={fxRate?.rate}
        requireHold={realExecutionActive}
        onConfirm={handleConfirm}
        loading={placing}
      />
    </div>
  );
}

/* ── Grafico candele + volumi (lightweight-charts) ─────────────────── */
function CandleChart({ instrumentId, intervalKey }: { instrumentId: number; intervalKey: string }) {
  const { getCandles, quotes } = useAppData();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesDataRef = useRef<Candle[]>([]);
  const [legend, setLegend] = useState<Candle | null>(null);
  const [lastCandle, setLastCandle] = useState<Candle | null>(null);
  /** Chiave strumento:intervallo per cui i dati sono stati caricati. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const spec = INTERVALS.find((i) => i.key === intervalKey) ?? INTERVALS[3];

  /* creazione chart (una sola volta) */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: 240,
      layout: { background: { color: 'transparent' }, textColor: '#5C6B7A', fontFamily: 'JetBrains Mono', fontSize: 10 },
      grid: { vertLines: { color: '#FFFFFF0A' }, horzLines: { color: '#FFFFFF0A' } },
      crosshair: {
        vertLine: { color: '#5C6B7A', style: 2 },
        horzLine: { color: '#5C6B7A', style: 2 },
      },
      rightPriceScale: { borderColor: '#FFFFFF14' },
      timeScale: { borderColor: '#FFFFFF14', timeVisible: true, secondsVisible: false },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#00C390', downColor: '#F4556B',
      wickUpColor: '#00C390', wickDownColor: '#F4556B',
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.22 } });

    chart.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(candles) as { open: number; high: number; low: number; close: number } | undefined;
      if (data) {
        setLegend({ time: (param.time as number) ?? 0, ...data });
      } else {
        setLegend(null);
      }
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  /* caricamento dati per strumento/intervallo */
  const loadKey = `${instrumentId}:${spec.interval}`;
  const ready = loadedFor === loadKey;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await getCandles(instrumentId, spec.interval, spec.count);
      if (cancelled) return;
      candlesDataRef.current = data;
      candleRef.current?.setData(data.map((c) => ({
        time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close,
      })));
      volumeRef.current?.setData(data.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume ?? 0,
        color: c.close >= c.open ? '#00C39033' : '#F4556B33',
      })));
      chartRef.current?.timeScale().fitContent();
      setLastCandle(data[data.length - 1] ?? null);
      setLoadedFor(`${instrumentId}:${spec.interval}`);
    })();
    return () => { cancelled = true; };
  }, [instrumentId, spec.interval, spec.count, getCandles]);

  /* morphing live dell'ultima candela */
  const quote = quotes[instrumentId];
  useEffect(() => {
    if (!quote || !candleRef.current) return;
    const data = candlesDataRef.current;
    if (!data.length) return;
    const step = spec.seconds;
    const slot = Math.floor(Date.now() / 1000 / step) * step;
    const last = data[data.length - 1];
    let target: Candle;
    if (slot > last.time) {
      target = { time: slot, open: last.close, high: Math.max(last.close, quote.last), low: Math.min(last.close, quote.last), close: quote.last, volume: 0 };
      data.push(target);
    } else {
      last.close = quote.last;
      last.high = Math.max(last.high, quote.last);
      last.low = Math.min(last.low, quote.last);
      target = last;
    }
    candleRef.current.update({
      time: target.time as UTCTimestamp,
      open: target.open, high: target.high, low: target.low, close: target.close,
    });
  }, [quote, spec.seconds]);

  /* legenda: candela sotto crosshair, oppure ultima fusa col tick live */
  const shown = legend ?? (lastCandle
    ? {
        ...lastCandle,
        close: quote?.last ?? lastCandle.close,
        high: Math.max(lastCandle.high, quote?.last ?? -Infinity),
        low: Math.min(lastCandle.low, quote?.last ?? Infinity),
      }
    : null);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: ready ? 1 : 0.4 }}
      transition={{ duration: 0.5 }}
      className="relative rounded-lg border border-hairline bg-bg-0 p-2"
    >
      {/* legenda OHLC */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex gap-2 font-mono text-[10px] text-text-2">
        {shown && (
          <>
            <span>A <span className="text-text-1">{formatPrice(shown.open)}</span></span>
            <span>M <span className="text-gain">{formatPrice(shown.high)}</span></span>
            <span>m <span className="text-loss">{formatPrice(shown.low)}</span></span>
            <span>C <span className="text-text-1">{formatPrice(shown.close)}</span></span>
          </>
        )}
      </div>
      {!ready && <Skeleton className="absolute inset-2 h-[232px]" />}
      <div ref={containerRef} className="w-full" />
    </motion.div>
  );
}

/* ── Griglia statistiche 2×3 ───────────────────────────────────────── */
function StatsGrid({ instrument }: { instrument: Instrument }) {
  const { getCandles, quotes, fxRate, displayCurrency } = useAppData();
  const [daily, setDaily] = useState<Candle[]>([]);
  const [weekly, setWeekly] = useState<Candle[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [d, w] = await Promise.all([
        getCandles(instrument.instrumentId, 'OneDay', 30),
        getCandles(instrument.instrumentId, 'OneWeek', 52),
      ]);
      if (!cancelled) { setDaily(d); setWeekly(w); }
    })();
    return () => { cancelled = true; };
  }, [instrument.instrumentId, getCandles]);

  const quote = quotes[instrument.instrumentId];
  const lastDay = daily[daily.length - 1];
  const high24 = lastDay ? Math.max(lastDay.high, quote?.last ?? -Infinity) : null;
  const low24 = lastDay ? Math.min(lastDay.low, quote?.last ?? Infinity) : null;
  const wHigh = weekly.length ? Math.max(...weekly.map((c) => c.high)) : null;
  const wLow = weekly.length ? Math.min(...weekly.map((c) => c.low)) : null;

  const cells: { label: string; value: string }[] = [
    { label: 'Apertura', value: lastDay ? formatPrice(lastDay.open) : '—' },
    { label: 'Max/Min 24h', value: high24 != null && low24 != null ? `${formatPrice(high24)} / ${formatPrice(low24)}` : '—' },
    { label: 'Volume', value: formatCompact(volumeFor(instrument), instrument.currency) },
    { label: 'Cap. mercato', value: formatCompact(marketCapFor(instrument), instrument.currency) },
    { label: 'Var. 52 sett.', value: wHigh != null && wLow != null ? `${formatPrice(wLow)} – ${formatPrice(wHigh)}` : '—' },
    {
      label: 'Cambio applicato',
      value: instrument.currency !== 'EUR' && displayCurrency === 'EUR' && fxRate
        ? `EUR/USD ${formatFxRate(fxRate.rate)}`
        : instrument.currency !== displayCurrency && fxRate
          ? `EUR/USD ${formatFxRate(fxRate.rate)}`
          : '—',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border border-hairline bg-bg-0 px-3 py-2">
          <div className="text-micro uppercase tracking-[0.04em] text-text-2">{c.label}</div>
          <div className="mt-0.5 truncate text-body-strong tabular-nums text-text-0">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
