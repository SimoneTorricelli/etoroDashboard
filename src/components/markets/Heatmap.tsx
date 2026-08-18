/**
 * Heatmap — treemap settoriale squarified (hand-rolled, nessuna dipendenza).
 * Dimensione tile = market cap/peso, colore = Δ 1g su scala divergente
 * rosso → neutro → verde. Hover: bordo strong + tooltip; click: apre drawer.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus } from 'lucide-react';
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
    // `strip` is the fixed width/height of this row. The other side must
    // preserve the item's area (`value = strip * side`). Using a share of
    // `strip` here leaves most of the treemap empty and distorts every tile.
    const side = strip > 0 ? it.value / strip : 0;
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
  onSelect(id: number): void;
}

interface Tile { row: MarketRow; rect: Rect }
interface SectorBlock { sector: string; rect: Rect; tiles: Tile[] }

const GAP = 2;
const HEADER_H = 20;

function HeatmapComponent({ rows, height = 420, onSelect }: HeatmapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [tooltip, setTooltip] = useState<MarketRow | null>(null);
  const [zoom, setZoom] = useState(1);
  const [focusSector, setFocusSector] = useState<string | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 900));
    ro.observe(el); // ResizeObserver scatta subito con la dimensione iniziale
    return () => ro.disconnect();
  }, []);

  const sectorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.sector, (counts.get(row.sector) ?? 0) + 1);
    return [...counts.entries()].map(([sector, count]) => ({ sector, count }));
  }, [rows]);

  const activeSector = focusSector && sectorOptions.some((option) => option.sector === focusSector) ? focusSector : null;
  const visibleRows = useMemo(() => activeSector ? rows.filter((row) => row.sector === activeSector) : rows, [activeSector, rows]);

  const sectors = useMemo(() => {
    const bySector = new Map<string, MarketRow[]>();
    for (const r of visibleRows) {
      const arr = bySector.get(r.sector) ?? [];
      arr.push(r);
      bySector.set(r.sector, arr);
    }
    return [...bySector.entries()].map(([sector, list]) => ({
      sector,
      list,
      value: list.reduce((a, r) => a + (r.marketCap ?? 1), 0),
    }));
  }, [visibleRows]);

  const moveTooltip = (clientX: number, clientY: number) => {
    const node = tooltipRef.current;
    if (!node) return;
    const x = Math.min(clientX + 14, window.innerWidth - 290);
    const y = Math.min(clientY + 14, window.innerHeight - 110);
    node.style.transform = `translate3d(${Math.max(8, x)}px, ${Math.max(8, y)}px, 0)`;
  };

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
        sec.list.map((row) => ({ value: row.marketCap ?? 1, data: row })),
        inner,
      ).map(([row, r]) => ({ row, rect: r }));
      return { sector: sec.sector, rect, tiles };
    });
  }, [sectors, height, width]);

  const vH = (height / Math.max(1, width)) * 1000;
  const px = (x: number) => `${(x / 1000) * 100}%`;
  const py = (y: number) => `${(y / vH) * 100}%`;

  const canvas = (
    <div ref={hostRef} className="relative min-w-[620px]" style={{ width: `${zoom * 100}%`, height: height * zoom }}>
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
        b.tiles.map((t) => {
          const pctW = (t.rect.w / 1000) * 100;
          const pctH = (t.rect.h / vH) * 100;
          const big = pctW > 7 && pctH > 9;
          const mid = pctW > 3.5 && pctH > 5;
          const change = t.row.quote?.changePct;
          const id = t.row.instrument.instrumentId;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              onMouseEnter={(e) => {
                setTooltip(t.row);
                requestAnimationFrame(() => moveTooltip(e.clientX, e.clientY));
              }}
              onMouseMove={(e) => moveTooltip(e.clientX, e.clientY)}
              onMouseLeave={() => setTooltip(null)}
              className="absolute flex flex-col items-center justify-center overflow-hidden rounded-[4px] border border-bg-0 text-center hover:z-10 hover:border-hairline-strong focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
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
            </button>
          );
        }),
      )}

    </div>
  );

  return (
    <div className="relative">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1" aria-label="Categorie heatmap">
          <button type="button" onClick={() => setFocusSector(null)} aria-pressed={activeSector == null} className={cn('shrink-0 rounded-md border px-2 py-1 text-micro', activeSector == null ? 'border-info/40 bg-info/10 text-info' : 'border-hairline text-text-2 hover:text-text-0')}>Tutti · {rows.length}</button>
          {sectorOptions.map((option) => <button key={option.sector} type="button" onClick={() => setFocusSector(option.sector)} aria-pressed={activeSector === option.sector} className={cn('shrink-0 rounded-md border px-2 py-1 text-micro', activeSector === option.sector ? 'border-info/40 bg-info/10 text-info' : 'border-hairline text-text-2 hover:text-text-0')}>{option.sector} · {option.count}</button>)}
        </div>
        <div className="z-30 flex shrink-0 items-center rounded-lg border border-hairline-strong bg-bg-0/90 p-1 shadow-lg">
          <button type="button" aria-label="Riduci zoom heatmap" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.25))} className="rounded-md p-1.5 text-text-1 hover:bg-bg-2 disabled:opacity-30"><Minus className="h-3.5 w-3.5" aria-hidden /></button>
          <span className="w-11 text-center font-mono text-micro text-text-2">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Aumenta zoom heatmap" disabled={zoom >= 1.75} onClick={() => setZoom((value) => Math.min(1.75, value + 0.25))} className="rounded-md p-1.5 text-text-1 hover:bg-bg-2 disabled:opacity-30"><Plus className="h-3.5 w-3.5" aria-hidden /></button>
        </div>
      </div>
      <div className="w-full overflow-auto rounded-lg" style={{ height }} aria-label="Heatmap navigabile; aumenta lo zoom per scorrere">
        {canvas}
      </div>
      {tooltip && createPortal(
        <div
          ref={tooltipRef}
          className="pointer-events-none fixed z-[200] w-max max-w-[280px] rounded-lg border border-hairline-strong bg-bg-2 px-3 py-2 shadow-2xl"
          style={{ left: 0, top: 0, willChange: 'transform' }}
        >
          <div className="text-body-strong text-text-0">{tooltip.instrument.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-caption text-text-1">
            <span className="font-mono">{tooltip.instrument.symbol}</span>
            {tooltip.quote ? <><span className="tabular-nums">{formatPrice(tooltip.quote.last)}</span><span className={cn('tabular-nums', tooltip.quote.changePct >= 0 ? 'text-gain' : 'text-loss')}>{formatPercent(tooltip.quote.changePct)}</span></> : null}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export const Heatmap = memo(HeatmapComponent);
