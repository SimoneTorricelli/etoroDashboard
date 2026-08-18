/**
 * Mercati (/mercati) — mercati globali in tempo reale (design/markets.md).
 * Header con chip stato mercati + orologio live; tab bar asset-class sticky;
 * heatmap treemap settoriale + Top Movers; tabella strumenti sortable con
 * sparkline e tick-flash; drawer dettaglio 480px con candele e CTA ordine/regola.
 * Supporta ?instrument=<id> per aprire il drawer via deep-link.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'framer-motion';
import { LayoutGrid, Search, Table2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { EmptyState } from '@/components/shared/EmptyState';
import { Skeleton } from '@/components/shared/Skeleton';
import { StatusDot } from '@/components/shared/StatusDot';
import type { AssetClass, Candle, HistoricalClosingPrice } from '@/lib/data/types';
import { Heatmap } from '@/components/markets/Heatmap';
import { MoversCard } from '@/components/markets/MoversCard';
import { InstrumentsTable } from '@/components/markets/InstrumentsTable';
import { InstrumentDrawer } from '@/components/markets/InstrumentDrawer';
import type { MarketRow } from '@/components/markets/meta';
import { sectorFor } from '@/components/markets/meta';

type TabKey = 'all' | AssetClass;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'Tutti' },
  { key: 'stock', label: 'Azioni' },
  { key: 'etf', label: 'ETF' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'index', label: 'Indici' },
  { key: 'fx', label: 'Valute' },
  { key: 'cfd', label: 'Materie prime' },
];

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, delay: i * 0.04, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

export default function Markets() {
  const { instruments, quotes, loading, getCandles, getQuotes, getHistoricalClosingPrices } = useAppData();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabKey>('all');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'table' | 'heatmap'>('table');
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [dailyCandles, setDailyCandles] = useState<Map<number, Candle[]>>(new Map());
  const [closingPrices, setClosingPrices] = useState<Map<number, HistoricalClosingPrice>>(new Map());
  const [marketError, setMarketError] = useState<string | null>(null);

  /* Prezzi correnti e chiusure 1g/7g/1M: due richieste batch, non una per riga. */
  useEffect(() => {
    if (!instruments.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const ids = instruments.map((instrument) => instrument.instrumentId);
        const [, closes] = await Promise.all([getQuotes(ids), getHistoricalClosingPrices()]);
        if (!cancelled) {
          setClosingPrices(new Map(closes.map((close) => [close.instrumentId, close])));
          setMarketError(null);
        }
      } catch (error) {
        if (!cancelled) setMarketError(error instanceof Error ? error.message : 'Dati mercato non disponibili');
      }
    })();
    return () => { cancelled = true; };
  }, [instruments, getQuotes, getHistoricalClosingPrices]);

  /* Spark reali solo per le prime righe visibili; la coda condivisa limita a 2. */
  useEffect(() => {
    const visible = instruments.slice(0, 8);
    if (visible.length === 0) return;
    let cancelled = false;
    void (async () => {
      const settled = await Promise.allSettled(visible.map(async (instrument) => [instrument.instrumentId, await getCandles(instrument.instrumentId, 'OneDay', 32)] as const));
      if (cancelled) return;
      const entries = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      setDailyCandles(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [instruments, getCandles]);

  const rows = useMemo<MarketRow[]>(() => instruments.map((instrument) => {
    const candles = dailyCandles.get(instrument.instrumentId) ?? [];
    const close = closingPrices.get(instrument.instrumentId);
    const current = quotes[instrument.instrumentId]?.last ?? close?.officialClosingPrice;
    const delta = (past?: number) => current && past && past > 0 ? ((current - past) / past) * 100 : null;
    return {
      instrument,
      quote: quotes[instrument.instrumentId],
      change7d: delta(close?.weekly),
      change1m: delta(close?.monthly),
      spark: candles.map((c) => c.close),
      volume: null,
      marketCap: null,
      sector: sectorFor(instrument),
    };
  }), [instruments, quotes, dailyCandles, closingPrices]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== 'all' && r.instrument.assetClass !== tab) return false;
      if (q && !r.instrument.symbol.toLowerCase().includes(q) && !r.instrument.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, tab, filter]);

  /* Drawer sincronizzato con ?instrument=<id> */
  const selectedId = searchParams.get('instrument');
  const selected = useMemo(
    () => instruments.find((i) => String(i.instrumentId) === selectedId) ?? null,
    [instruments, selectedId],
  );
  const openDrawer = (id: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('instrument', String(id));
      return next;
    });
  };
  const closeDrawer = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('instrument');
      return next;
    });
  };

  const isLoading = loading && rows.every((r) => !r.quote);

  return (
    <div className="flex flex-col gap-4">
      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <motion.h1 {...stagger(0)} className="font-display text-display-lg text-text-0">
          Mercati globali
        </motion.h1>
        <div className="flex flex-wrap items-center gap-2">
          <MarketChips />
          <LiveClock />
        </div>
      </div>

      {/* ── Tab bar sticky ──────────────────────────────────────── */}
      <div className="sticky top-14 z-20 -mx-1 flex flex-wrap items-center gap-2 border-b border-hairline bg-bg-0/80 px-1 pb-2 pt-1 backdrop-blur-[12px]">
        <div className="flex flex-wrap items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'relative px-2.5 py-1.5 text-body-strong transition-colors',
                tab === t.key ? 'text-text-0' : 'text-text-1 hover:text-text-0',
              )}
            >
              {t.label}
              {tab === t.key && (
                <motion.span
                  layoutId="markets-tab-underline"
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-gain"
                  transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                />
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 rounded-lg border border-hairline bg-bg-1 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-text-2" aria-hidden />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtra strumenti…"
              className="w-36 bg-transparent text-body text-text-0 outline-none placeholder:text-text-2"
            />
          </label>
          <div className="flex rounded-lg border border-hairline bg-bg-1 p-0.5">
            <button
              onClick={() => setView('table')}
              title="Vista tabella"
              aria-label="Vista tabella"
              className={cn(
                'rounded-md p-1.5 transition-colors',
                view === 'table' ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
              )}
            >
              <Table2 className="h-4 w-4" aria-hidden />
            </button>
            <button
              onClick={() => setView('heatmap')}
              title="Focus heatmap"
              aria-label="Focus heatmap"
              className={cn(
                'rounded-md p-1.5 transition-colors',
                view === 'heatmap' ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
              )}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {marketError ? <div role="status" className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-caption text-warn">{marketError.includes('Rate limit') ? 'Quota eToro temporaneamente esaurita: i dati disponibili restano visibili e il retry segue Retry-After.' : `Mercati: ${marketError}`}</div> : null}

      {filtered.length === 0 && !isLoading ? (
        <EmptyState
          headline="Nessuno strumento trovato"
          copy="Nessuno strumento corrisponde ai filtri attivi. Reimposta i filtri per vedere l'intero mercato."
          actionLabel="Reimposta filtri"
          onAction={() => { setFilter(''); setTab('all'); }}
        />
      ) : (
        <>
          {/* ── ROW 1: Heatmap + Movers ─────────────────────────── */}
          <div className="grid grid-cols-12 gap-4">
            <motion.div
              {...stagger(1)}
              className={cn(
                'card-surface density-pad col-span-12 p-5',
                view === 'heatmap' ? 'lg:col-span-12' : 'lg:col-span-8',
              )}
            >
              <div className="mb-3 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-title text-text-0">Heatmap</h2>
                <span className="text-caption text-text-2 sm:text-right">Dimensione uniforme · Colore = Δ 1g · cap. non fornita da eToro</span>
              </div>
              {isLoading ? (
                <Skeleton className="h-[420px] w-full" />
              ) : (
                <Heatmap
                  rows={filtered}
                  height={view === 'heatmap' ? 560 : 420}
                  hoveredId={hoveredId}
                  onHover={setHoveredId}
                  onSelect={openDrawer}
                />
              )}
            </motion.div>

            {view === 'table' && (
              <motion.div {...stagger(2)} className="card-surface density-pad col-span-12 p-5 lg:col-span-4">
                {isLoading ? (
                  <div className="flex flex-col gap-2">
                    {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                  </div>
                ) : (
                  <MoversCard rows={filtered} onSelect={openDrawer} />
                )}
              </motion.div>
            )}
          </div>

          {/* ── ROW 2: Tabella strumenti ────────────────────────── */}
          <motion.div {...stagger(3)} className="card-surface density-pad col-span-12 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-title text-text-0">Strumenti</h2>
              <span className="text-caption text-text-2 tabular-nums">{filtered.length} strumenti</span>
            </div>
            {isLoading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
              </div>
            ) : (
              <InstrumentsTable rows={filtered} onSelect={openDrawer} onHover={setHoveredId} />
            )}
          </motion.div>
        </>
      )}

      {/* ── Drawer dettaglio ────────────────────────────────────── */}
      <InstrumentDrawer instrument={selected} onClose={closeDrawer} />
    </div>
  );
}

/* ── Chip stato mercati (orari locali) ─────────────────────────────── */
function marketOpen(now: Date, timeZone: string, openMin: number, closeMin: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return false;
  const mins = Number(get('hour')) % 24 * 60 + Number(get('minute'));
  return mins >= openMin && mins < closeMin;
}

function localTime(now: Date, timeZone: string): string {
  return now.toLocaleTimeString('it-IT', { timeZone, hour: '2-digit', minute: '2-digit' });
}

function MarketChips() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const nyseOpen = marketOpen(now, 'America/New_York', 9 * 60 + 30, 16 * 60);
  const lseOpen = marketOpen(now, 'Europe/London', 8 * 60, 16 * 60 + 30);

  const chips = [
    { label: nyseOpen ? 'NYSE Aperto' : 'NYSE Chiuso', time: localTime(now, 'America/New_York'), dot: nyseOpen ? 'live' as const : 'idle' as const },
    { label: lseOpen ? 'LSE Aperto' : 'LSE Chiuso', time: localTime(now, 'Europe/London'), dot: lseOpen ? 'live' as const : 'idle' as const },
    { label: 'Crypto 24/7', time: 'sempre aperto', dot: 'ok' as const },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c, i) => (
        <motion.span
          key={c.label}
          {...stagger(i + 1)}
          className="flex items-center gap-1.5 rounded-full border border-hairline bg-bg-1 px-2.5 py-1 text-micro text-text-1"
        >
          <StatusDot variant={c.dot} />
          {c.label}
          <span className="text-text-2 tabular-nums">· {c.time}</span>
        </motion.span>
      ))}
    </div>
  );
}

/* ── Orologio live (mono, tabular, tick 1s) ────────────────────────── */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="rounded-full border border-hairline bg-bg-1 px-2.5 py-1 font-mono text-micro text-text-1 tabular-nums">
      {now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>
  );
}
