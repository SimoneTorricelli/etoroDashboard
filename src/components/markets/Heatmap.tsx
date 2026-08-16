/**
 * Heatmap — treemap settoriale squarified (hand-rolled, nessuna dipendenza).
 * Dimensione tile = market cap/peso, colore = Δ 1g su scala divergente
 * rosso → neutro → verde. Hover: bordo strong + tooltip; click: apre drawer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { formatPercent, formatPrice } from '@/lib/format';
import type { MarketRow } from './meta';

interface Rect { x: number; y: number; w: number; h: number }
interface Item<T> { value: number; data: T }

/* ── Squarified treemap (Bruls et al.) ─────────────────────────────── */
function worst(row: number[], w: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  if (s === 0) return Infinity;
  const rMax = Math.max(...row);
  const rMin = Math.min(...row);
  return Math.max((w * w * rMax) / (s * s), (s * s) / (w * w * rMin));
}

/** Posiziona una "striscia" di item lungo il lato corto di rect; ritorna il resto. */
function layoutRow<T>(row: Item<T>[], rect: Rect, out: [T, Rect][]): Rect {
  const total = row.reduce((a, b) => a + b.value, 0);
  const horizontal = rect.w >= rect.h;
  const len = horizontal ? rect.h : rect.w;
  const strip = len > 0 ? total / len : 0;
  let offset = 0;
  for (const it of row) {
    const side = total > 0 ? (it.value / total) * strip : 0;
    out.push([
      it.data,
      horizontal
        ? { x: rect.x, y: rect.y + offset, w: strip, h: side }
        : { x: rect.x + offset, y: rect.y, w: side, h: strip },
    ]);
    offset += side;
  }
  return horizontal
    ? { x: rect.x + strip, y: rect.y, w: Math.max(0, rect.w - strip), h: rect.h }
    : { x: rect.x, y: rect.y + strip, w: rect.w, h: Math.max(0, rect.h - strip) };
}

function squarify<T>(items: Item<T>[], rect: Rect): [T, Rect][] {
  const out: [T, Rect][] = [];
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const totalValue = sorted.reduce((a, b) => a + Math.max(0, b.value), 0);
  const scale = (rect.w * rect.h) / Math.max(1e-9, totalValue);
  const scaled = sorted.map((it) => ({ value: Math.max(0, it.value) * scale, data: it.data }));

  let rest = { ...rect };
  let row: Item<T>[] = [];
  const flush = () => {
    if (row.length) rest = layoutRow(row, rest, out);
    row = [];
  };
  for (const it of scaled) {
    const w = Math.min(rest.w, rest.h);
    if (
      row.length === 0 ||
      worst([...row.map((r) => r.value), it.value], w) <= worst(row.map((r) => r.value), w)
    ) {
      row.push(it);
    } else {
      flush();
      row.push(it);
    }
  }
  flush();
  return out;
}

/* ── Colore divergente Δ% (rosso → bg-2 → verde, satura a ±3%) ─────── */
const RED = [244, 85, 107];
const NEUTRAL = [21, 28, 38];
const GREEN = [0, 195, 144];

function changeColor(changePct: number | undefined): string {
  const c = changePct ?? 0;
  const t = Math.min(1, Math.abs(c) / 3);
  const target = c > 0 ? GREEN : c < 0 ? RED : NEUTRAL;
  const mix = NEUTRAL.map((n, i) => Math.round(n + (target[i] - n) * (0.25 + 0.75 * t)));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

/* ── Componente ────────────────────────────────────────────────────── */
export interface HeatmapProps {
  rows: MarketRow[];
  height?: number;
  hoveredId: number | null;
  onHover(id: number | null): void;
  onSelect(id: number): void;
}

interface Tile { row: MarketRow; rect: Rect }
interface SectorBlock { sector: string; rect: Rect; tiles: Tile[] }

const GAP = 2;
const HEADER_H = 20;

export function Heatmap({ rows, height = 420, hoveredId, onHover, onSelect }: HeatmapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; row: MarketRow } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 900));
    ro.observe(el); // ResizeObserver scatta subito con la dimensione iniziale
    return () => ro.disconnect();
  }, []);

  const sectors = useMemo(() => {
    const bySector = new Map<string, MarketRow[]>();
    for (const r of rows) {
      const arr = bySector.get(r.sector) ?? [];
      arr.push(r);
      bySector.set(r.sector, arr);
    }
    return [...bySector.entries()].map(([sector, list]) => ({
      sector,
      list,
      value: list.reduce((a, r) => a + r.marketCap, 0),
    }));
  }, [rows]);

  const blocks = useMemo<SectorBlock[]>(() => {
    const W = 1000;
    const H = (height / Math.max(1, width)) * 1000;
    const sectorRects = squarify(
      sectors.map((s) => ({ value: s.value, data: s })),
      { x: 0, y: 0, w: W, h: H },
    );
    return sectorRects.map(([sec, rect]) => {
      const inner: Rect = {
        x: rect.x + GAP,
        y: rect.y + HEADER_H,
        w: Math.max(0, rect.w - GAP * 2),
        h: Math.max(0, rect.h - HEADER_H - GAP),
      };
      const tiles = squarify(
        sec.list.map((row) => ({ value: row.marketCap, data: row })),
        inner,
      ).map(([row, r]) => ({ row, rect: r }));
      return { sector: sec.sector, rect, tiles };
    });
  }, [sectors, height, width]);

  const vH = (height / Math.max(1, width)) * 1000;
  const px = (x: number) => `${(x / 1000) * 100}%`;
  const py = (y: number) => `${(y / vH) * 100}%`;

  return (
    <div ref={hostRef} className="relative w-full overflow-hidden" style={{ height }}>
      {/* header settori */}
      {blocks.map((b) => (
        <span
          key={b.sector}
          className="pointer-events-none absolute z-10 truncate text-micro font-medium uppercase tracking-[0.04em] text-text-2"
          style={{ left: `calc(${px(b.rect.x)} + 4px)`, top: `calc(${py(b.rect.y)} + 3px)` }}
        >
          {b.sector}
        </span>
      ))}

      {/* tile */}
      {blocks.flatMap((b) =>
        b.tiles.map((t, i) => {
          const pctW = (t.rect.w / 1000) * 100;
          const pctH = (t.rect.h / vH) * 100;
          const big = pctW > 7 && pctH > 9;
          const mid = pctW > 3.5 && pctH > 5;
          const change = t.row.quote?.changePct;
          const id = t.row.instrument.instrumentId;
          return (
            <motion.button
              key={id}
              type="button"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.025, 0.6), ease: [0.2, 0.8, 0.2, 1] }}
              onClick={() => onSelect(id)}
              onMouseEnter={(e) => {
                onHover(id);
                const host = hostRef.current?.getBoundingClientRect();
                const r = e.currentTarget.getBoundingClientRect();
                if (host) setTooltip({ x: r.left - host.left + r.width / 2, y: r.top - host.top, row: t.row });
              }}
              onMouseLeave={() => { onHover(null); setTooltip(null); }}
              className={cn(
                'absolute flex flex-col items-center justify-center overflow-hidden rounded-[4px] border text-center',
                hoveredId === id ? 'z-10 border-hairline-strong' : 'border-bg-0',
              )}
              style={{
                left: px(t.rect.x),
                top: py(t.rect.y),
                width: px(t.rect.w),
                height: py(t.rect.h),
                backgroundColor: changeColor(change),
                transition: 'background-color 400ms',
              }}
            >
              {mid && (
                <span className={cn('font-mono font-medium text-text-0', big ? 'text-ticker' : 'text-[10px] leading-3')}>
                  {t.row.instrument.symbol}
                </span>
              )}
              {big && change != null && (
                <span className="text-micro tabular-nums text-text-0/80">{formatPercent(change, 1)}</span>
              )}
            </motion.button>
          );
        }),
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-lg border border-hairline-strong bg-bg-2 px-3 py-2"
          style={{ left: tooltip.x, top: tooltip.y - 6 }}
        >
          <div className="text-body-strong text-text-0">{tooltip.row.instrument.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-caption text-text-1">
            <span className="font-mono">{tooltip.row.instrument.symbol}</span>
            {tooltip.row.quote && (
              <>
                <span className="tabular-nums">{formatPrice(tooltip.row.quote.last)}</span>
                <span className={cn('tabular-nums', tooltip.row.quote.changePct >= 0 ? 'text-gain' : 'text-loss')}>
                  {formatPercent(tooltip.row.quote.changePct)}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
