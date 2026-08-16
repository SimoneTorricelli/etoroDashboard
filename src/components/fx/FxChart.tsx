/**
 * FxChart — grafico storico EUR/USD (design/fx.md Row 2, span 8):
 * candele via getCandles, overlay media mobile 50g (toggle), marker del
 * tasso corrente e BANDE TARGET trascinabili:
 *  - banda verde "Zona prelievo ideale" sotto la soglia target (fxTargetRate)
 *  - banda rossa "Zona sfavorevole" sopra la soglia superiore
 * Le bande sono overlay HTML posizionati via priceToCoordinate; i bordi
 * hanno handle drag (pointer events → coordinateToPrice) con persistenza.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatFxRate } from '@/lib/format';
import type { Candle } from '@/lib/data/types';

export interface FxChartProps {
  candles: Candle[];
  /** Ultimo tasso live: aggiorna la candela corrente e il marker. */
  liveRate: number | null;
  target: number;
  upper: number;
  onTargetChange: (v: number) => void;
  onUpperChange: (v: number) => void;
}

const MIN_GAP = 0.005; // distanza minima tra le due soglie

function computeSma(candles: Candle[], period: number): Array<{ time: UTCTimestamp; value: number }> {
  const out: Array<{ time: UTCTimestamp; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time as UTCTimestamp, value: sum / period });
  }
  return out;
}

export function FxChart({ candles, liveRate, target, upper, onTargetChange, onUpperChange }: FxChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const [showSma, setShowSma] = useState(true);
  const [positions, setPositions] = useState<{ targetY: number | null; upperY: number | null; currentY: number | null }>({
    targetY: null, upperY: null, currentY: null,
  });
  const [dragging, setDragging] = useState<'target' | 'upper' | null>(null);

  /* Refs per i callback di drag (evitano closure stale) */
  const targetRef = useRef(target);
  const upperRef = useRef(upper);
  useEffect(() => {
    targetRef.current = target;
    upperRef.current = upper;
  }, [target, upper]);

  /* ── Creazione chart (una sola volta) ────────────────────────────── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: 320,
      layout: { background: { color: 'transparent' }, textColor: '#5C6B7A', fontFamily: 'JetBrains Mono', fontSize: 11 },
      grid: { vertLines: { color: '#FFFFFF0A' }, horzLines: { color: '#FFFFFF0A' } },
      crosshair: {
        vertLine: { color: '#5C6B7A', style: 2, labelBackgroundColor: '#1C2530' },
        horzLine: { color: '#5C6B7A', style: 2, labelBackgroundColor: '#1C2530' },
      },
      rightPriceScale: { borderColor: '#FFFFFF14' },
      timeScale: { borderColor: '#FFFFFF14', timeVisible: false },
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#00C390', downColor: '#F4556B',
      borderUpColor: '#00C390', borderDownColor: '#F4556B',
      wickUpColor: '#00C390', wickDownColor: '#F4556B',
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    });
    candleRef.current = series;

    const updatePositions = () => {
      const s = candleRef.current;
      if (!s) return;
      setPositions({
        targetY: s.priceToCoordinate(targetRef.current),
        upperY: s.priceToCoordinate(upperRef.current),
        currentY: null, // aggiornato dall'effetto live
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(updatePositions);
    const interval = setInterval(updatePositions, 500); // autoscale/live updates

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
      updatePositions();
    });
    ro.observe(el);

    return () => {
      clearInterval(interval);
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updatePositions);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      smaRef.current = null;
    };
  }, []);

  /* ── Dati candele ────────────────────────────────────────────────── */
  useEffect(() => {
    const series = candleRef.current;
    const chart = chartRef.current;
    if (!series || !chart || candles.length < 2) return;
    series.setData(candles.map((c) => ({
      time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    chart.timeScale().fitContent();
  }, [candles]);

  /* ── Tick live: aggiorna l'ultima candela ────────────────────────── */
  useEffect(() => {
    const series = candleRef.current;
    if (!series || liveRate == null || candles.length < 1) return;
    const last = candles[candles.length - 1];
    series.update({
      time: last.time as UTCTimestamp,
      open: last.open,
      high: Math.max(last.high, liveRate),
      low: Math.min(last.low, liveRate),
      close: liveRate,
    });
    setPositions((p) => ({ ...p, currentY: series.priceToCoordinate(liveRate) }));
  }, [liveRate, candles]);

  /* ── Media mobile 50g ────────────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (smaRef.current) { chart.removeSeries(smaRef.current); smaRef.current = null; }
    if (!showSma || candles.length < 50) return;
    const line = chart.addSeries(LineSeries, {
      color: '#4C9AFF', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    line.setData(computeSma(candles, 50));
    smaRef.current = line;
  }, [showSma, candles]);

  /* ── Ricalcolo posizioni bande al cambio delle soglie ────────────── */
  useEffect(() => {
    const s = candleRef.current;
    if (!s) return;
    setPositions((p) => ({
      ...p,
      targetY: s.priceToCoordinate(target),
      upperY: s.priceToCoordinate(upper),
    }));
  }, [target, upper, candles]);

  /* ── Drag handle ─────────────────────────────────────────────────── */
  const startDrag = useCallback((which: 'target' | 'upper') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = containerRef.current;
    const series = candleRef.current;
    if (!el || !series) return;
    setDragging(which);
    const rect = el.getBoundingClientRect();

    const onMove = (ev: PointerEvent) => {
      const y = ev.clientY - rect.top;
      const price = series.coordinateToPrice(y);
      if (price == null) return;
      const p = Number(price);
      if (which === 'target') {
        onTargetChange(Math.min(p, upperRef.current - MIN_GAP));
      } else {
        onUpperChange(Math.max(p, targetRef.current + MIN_GAP));
      }
    };
    const onUp = () => {
      setDragging(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [onTargetChange, onUpperChange]);

  const chartHeight = 320;
  const bandTop = positions.upperY;
  const bandBottom = positions.targetY;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-micro text-text-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-gain/40" aria-hidden /> Zona prelievo ideale
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-loss/40" aria-hidden /> Zona sfavorevole
          </span>
        </div>
        <button
          onClick={() => setShowSma((v) => !v)}
          className={cn(
            'rounded-full border px-2.5 py-1 text-micro transition-colors',
            showSma ? 'border-info/40 bg-info/10 text-info' : 'border-hairline text-text-2 hover:text-text-1',
          )}
          aria-pressed={showSma}
        >
          Media 50g
        </button>
      </div>

      <div ref={containerRef} className="relative mt-2 w-full" style={{ height: chartHeight }}>
        {/* Overlay bande (allineato al pane del chart) */}
        <div className="pointer-events-none absolute inset-0" style={{ bottom: 26, right: 52 }} aria-hidden>
          {bandTop != null && (
            <div
              className="absolute left-0 right-0 top-0 bg-loss/10 transition-[height] duration-200"
              style={{ height: Math.max(0, bandTop) }}
            />
          )}
          {bandBottom != null && (
            <div
              className="absolute bottom-0 left-0 right-0 bg-gain/10 transition-[top] duration-200"
              style={{ top: Math.max(0, bandBottom) }}
            />
          )}
          {positions.currentY != null && (
            <div className="absolute left-0 right-0 border-t border-dashed border-text-2" style={{ top: positions.currentY }} />
          )}
        </div>

        {/* Handle trascinabili sui bordi delle bande */}
        {positions.upperY != null && (
          <BandHandle
            y={positions.upperY}
            value={upper}
            label={`Soglia sfavorevole ${formatFxRate(upper)}`}
            tone="loss"
            active={dragging === 'upper'}
            onPointerDown={startDrag('upper')}
          />
        )}
        {positions.targetY != null && (
          <BandHandle
            y={positions.targetY}
            value={target}
            label={`Target prelievo ${formatFxRate(target)}`}
            tone="gain"
            active={dragging === 'target'}
            onPointerDown={startDrag('target')}
          />
        )}
      </div>

      <p className="mt-2 text-micro text-text-2">
        Trascina i bordi delle bande per aggiornare le soglie — alimentano l'advisor e gli avvisi.
      </p>
    </div>
  );
}

function BandHandle({
  y, value, label, tone, active, onPointerDown,
}: {
  y: number;
  value: number;
  label: string;
  tone: 'gain' | 'loss';
  active: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute left-0 right-0 z-10 flex cursor-ns-resize items-center border-t-2 border-dashed transition-colors',
        tone === 'gain' ? 'border-gain/70' : 'border-loss/70',
        active && (tone === 'gain' ? 'border-gain' : 'border-loss'),
      )}
      style={{ top: y - 1, right: 52, bottom: 'auto' }}
    >
      <span
        className={cn(
          'ml-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-micro tabular-nums',
          tone === 'gain' ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss',
        )}
      >
        <GripHorizontal className="h-3 w-3" aria-hidden />
        {label}
      </span>
    </div>
  );
}
