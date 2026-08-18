/**
 * Portfolio (/portfolio) — Valutazione del Portafoglio (design/portfolio.md).
 * Header: titolo + period selector + toggle EUR/USD + export + badge sorgente.
 * ROW 1: 4 KpiCard (Valore, P&L totale, P&L non realizzato, Cash & Dividendi)
 * ROW 2: Score diversificazione | Donut asset class | Donut valuta + callout USD
 * ROW 3: Allocazione per settore | P&L per posizione (barre divergenti)
 * ROW 4: Tabella posizioni raggruppabile (span 12)
 * ROW 5: Analisi & Suggerimenti + checklist | Heatmap P&L mensile
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { motion } from 'framer-motion';
import { Download, X } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import {
  formatCurrency, formatFxRate, formatSignedCurrency,
} from '@/lib/format';
import { KpiCard } from '@/components/shared/KpiCard';
import { EmptyState } from '@/components/shared/EmptyState';
import { Skeleton } from '@/components/shared/Skeleton';
import { FreshnessBadge } from '@/components/shared/FreshnessBadge';
import {
  allocate, buildSuggestions, computeDiversification, enrichLookThroughPositions, enrichPositions, monthlyPnl,
  CLASS_LABELS,
} from '@/components/portfolio/analytics';
import type { PositionRow } from '@/components/portfolio/analytics';
import { DiversificationGauge } from '@/components/portfolio/DiversificationGauge';
import { AllocationDonut } from '@/components/portfolio/AllocationDonut';
import type { DonutSlice } from '@/components/portfolio/AllocationDonut';
import { SectorBars } from '@/components/portfolio/SectorBars';
import { PnlPositionBars } from '@/components/portfolio/PnlPositionBars';
import { PositionsTable } from '@/components/portfolio/PositionsTable';
import { PositionDrawer } from '@/components/portfolio/PositionDrawer';
import { SuggestionsCard } from '@/components/portfolio/SuggestionsCard';
import { PnlHeatmap } from '@/components/portfolio/PnlHeatmap';
import { CopyPortfolioDrawer, CopyPortfolioTable } from '@/components/portfolio/CopyPortfolioTable';
import type { CopyPortfolio } from '@/lib/data/types';

const PERIODS = [
  { key: '1M', days: 30 },
  { key: '3M', days: 90 },
  { key: '6M', days: 180 },
  { key: '1A', days: 365 },
  { key: 'MAX', days: Number.POSITIVE_INFINITY },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];

const CLASS_COLORS: Record<string, string> = {
  stock: '#4C9AFF', etf: '#9B8CFF', crypto: '#F5A623', cash: '#5C6B7A',
  fx: '#4CC9F0', index: '#A3E635', cfd: '#E879F9', mirror: '#00C390',
};
const CURRENCY_COLORS = ['#4C9AFF', '#9B8CFF', '#4CC9F0', '#F5A623', '#A3E635', '#5C6B7A'];

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

export default function Portfolio() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    portfolio, pnl, fxRate, loading, status,
    displayCurrency, setDisplayCurrency, fromUsd,
    sparkFor, agent, agentVersion, closePosition,
  } = useAppData();

  const cur = displayCurrency;
  const [period, setPeriod] = useState<PeriodKey>('1M');
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<PositionRow | null>(null);
  const [copyDrawer, setCopyDrawer] = useState<CopyPortfolio | null>(null);
  const instrumentFilterId = Number(searchParams.get('instrument') ?? 0);
  const copyFilterId = searchParams.get('copyId');

  useEffect(() => {
    if (!copyFilterId || !portfolio?.copyPortfolios) return;
    setCopyDrawer(portfolio.copyPortfolios.find((copy) => copy.copyId === copyFilterId) ?? null);
  }, [copyFilterId, portfolio]);

  const fmt = (usd: number) => formatCurrency(fromUsd(usd), cur);
  const fmtSigned = (usd: number) => formatSignedCurrency(fromUsd(usd), cur);
  const fmtWeight = (w: number) =>
    `${(w * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`;

  /* ── Dati derivati ─────────────────────────────────────────────── */
  const rows = useMemo(() => (portfolio ? enrichPositions(portfolio) : []), [portfolio]);
  const lookThroughRows = useMemo(() => (portfolio ? enrichLookThroughPositions(portfolio) : []), [portfolio]);
  const lookThroughCash = useMemo(
    () => (portfolio?.cash ?? 0) + (portfolio?.copyPortfolios ?? []).reduce((sum, copy) => sum + copy.availableCash, 0),
    [portfolio],
  );

  const score = useMemo(
    () => computeDiversification(lookThroughRows, lookThroughCash, portfolio?.totalValue ?? 0),
    [lookThroughCash, lookThroughRows, portfolio],
  );

  const classSlices = useMemo(() => {
    if (!portfolio) return [];
    return allocate(
      lookThroughRows,
      (r) => r.assetClass,
      (k) => CLASS_LABELS[k as keyof typeof CLASS_LABELS] ?? k,
      portfolio.totalValue,
      [
        ...(lookThroughCash > 0
          ? [{ key: 'cash', label: 'Cash', value: lookThroughCash, weight: lookThroughCash / portfolio.totalValue }]
          : []),
      ],
    );
  }, [lookThroughCash, lookThroughRows, portfolio]);

  const currencySlices = useMemo(() => {
    if (!portfolio) return [];
    return allocate(
      lookThroughRows,
      (r) => r.currency,
      (k) => k,
      portfolio.totalValue,
      [
        ...(lookThroughCash > 0
          ? [{ key: 'USD', label: 'USD (cash)', value: lookThroughCash, weight: lookThroughCash / portfolio.totalValue }]
          : []),
      ],
    );
  }, [lookThroughCash, lookThroughRows, portfolio]);

  const sectorSlices = useMemo(() => {
    if (!portfolio) return [];
    return allocate(
      lookThroughRows,
      (r) => r.sector,
      (k) => k,
      portfolio.totalValue,
      [],
    );
  }, [lookThroughRows, portfolio]);

  const usdExposure = useMemo(
    () => lookThroughCash + lookThroughRows.filter((r) => r.currency === 'USD').reduce((s, r) => s + r.value, 0),
    [lookThroughCash, lookThroughRows],
  );
  const usdExposurePct = portfolio && portfolio.totalValue > 0 ? usdExposure / portfolio.totalValue : 0;

  const months = useMemo(() => monthlyPnl(pnl?.equityHistory ?? []), [pnl]);

  const suggestions = useMemo(
    () => buildSuggestions({
      rows: lookThroughRows,
      totalValue: portfolio?.totalValue ?? 0,
      cash: portfolio?.cash ?? 0,
      usdExposure,
      usdExposurePct,
      score,
      fmt,
      fmtPct: fmtWeight,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lookThroughRows, portfolio, usdExposure, usdExposurePct, score, cur],
  );

  const unprotectedCount = rows.filter((r) => r.stopLossRate == null).length;
  const checklist = useMemo(() => [
    {
      id: 'stop-loss',
      label: unprotectedCount > 0
        ? `Imposta stop-loss sulle ${unprotectedCount} posizioni senza protezione`
        : 'Verifica gli stop-loss delle posizioni aperte',
    },
    { id: 'fx-threshold', label: 'Definisci soglia EUR/USD per il prelievo' },
    { id: 'accumulo', label: 'Attiva regola di accumulo mensile ETF' },
    { id: 'csv-import', label: "Importa l'estratto conto eToro (CSV) per lo storico completo" },
  ], [unprotectedCount]);

  /* Mappa strumento → gruppo Agent (per il group-by "Gruppo Agent"). */
  const agentGroupFor = useMemo(() => {
    const groups = agent.getGroups();
    const nameOf = new Map(groups.map((g) => [g.id, g.name]));
    const map = new Map<number, string>();
    for (const rule of agent.getRules()) {
      const gName = nameOf.get(rule.groupId);
      if (!gName) continue;
      for (const id of rule.instrumentIds) if (!map.has(id)) map.set(id, gName);
    }
    return (instrumentId: number) => map.get(instrumentId) ?? 'Nessun gruppo';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, agentVersion]);

  const filteredRows = useMemo(
    () => rows.filter((r) => (!classFilter || r.assetClass === classFilter) && (!instrumentFilterId || r.instrumentId === instrumentFilterId)),
    [rows, classFilter, instrumentFilterId],
  );

  const sparkWindow = (arr: Array<{ value: number }> | undefined) => {
    if (!arr) return undefined;
    const days = PERIODS.find((p) => p.key === period)!.days;
    const sliced = Number.isFinite(days) ? arr.slice(-days) : arr;
    return sliced.map((p) => p.value);
  };

  const unrealizedPnl = pnl?.totalPnl ?? rows.reduce((s, r) => s + r.pnlUsd, 0);
  const unrealizedPct = portfolio && portfolio.totalInvested > 0
    ? (unrealizedPnl / portfolio.totalInvested) * 100
    : 0;

  /* ── Azioni ────────────────────────────────────────────────────── */
  const handleClosePosition = async (row: PositionRow) => {
    const res = await closePosition(row.positionId);
    if (res.ok) toast.success(`Posizione ${row.symbol} chiusa al prezzo di mercato.`);
    else toast.error(res.message ?? `Chiusura di ${row.symbol} non riuscita.`);
  };

  const exportReport = () => {
    if (!portfolio) return;
    const header = 'Simbolo;Nome;Classe;Settore;Valuta;Unità;Prezzo medio;Ultimo;Valore;P&L;P&L %;Peso %';
    const lines = rows.map((r) => [
      r.symbol, `"${r.name}"`, CLASS_LABELS[r.assetClass] ?? r.assetClass, r.sector, r.currency,
      String(r.units).replace('.', ','),
      r.openPrice.toFixed(2).replace('.', ','),
      r.price.toFixed(2).replace('.', ','),
      fromUsd(r.value).toFixed(2).replace('.', ','),
      fromUsd(r.pnlUsd).toFixed(2).replace('.', ','),
      r.pnlPctValue.toFixed(2).replace('.', ','),
      (r.weight * 100).toFixed(1).replace('.', ','),
    ].join(';'));
    const summary = [
      `Report Portfolio Torino;${new Date().toLocaleString('it-IT')}`,
      `Valuta report;${cur}`,
      `Valore totale;${fromUsd(portfolio.totalValue).toFixed(2).replace('.', ',')}`,
      `P&L totale;${pnl ? fromUsd(pnl.totalPnl).toFixed(2).replace('.', ',') : ''}`,
      `Score diversificazione;${score.total}`,
      `Esposizione USD;${(usdExposurePct * 100).toFixed(1).replace('.', ',')}%`,
      '',
      header,
      ...lines,
    ].join('\n');
    // BOM (\uFEFF) in testa per compatibilità Excel con UTF-8
    const blob = new Blob(['\uFEFF' + summary], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `torino-portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Report esportato — CSV scaricato.');
  };

  /* ── Stati vuoti / caricamento ─────────────────────────────────── */
  if (!loading && !portfolio) {
    return (
      <EmptyState
        headline="Nessun dato disponibile"
        copy="Configura chiavi e proxy per collegare il tuo account eToro reale. Nessun dato simulato verrà mostrato."
        actionLabel="Configura la connessione"
        onAction={() => navigate('/impostazioni')}
      />
    );
  }

  if (!loading && portfolio && portfolio.positions.length === 0) {
    return (
      <EmptyState
        headline="Nessuna posizione"
        copy="Il portafoglio reale è vuoto. Puoi importare l'estratto conto eToro per estendere lo storico."
        actionLabel="Importa CSV eToro"
        onAction={() => navigate('/impostazioni')}
      />
    );
  }

  const classDonutSlices: DonutSlice[] = classSlices.map((s) => ({
    key: s.key,
    label: s.label,
    weight: s.weight,
    valueLabel: fmt(s.value),
    color: CLASS_COLORS[s.key] ?? '#5C6B7A',
  }));

  const currencyDonutSlices: DonutSlice[] = currencySlices.map((s, i) => ({
    key: s.key,
    label: s.label,
    weight: s.weight,
    valueLabel: fmt(s.value),
    color: CURRENCY_COLORS[i % CURRENCY_COLORS.length],
  }));

  return (
    <div className="space-y-4">
      <Toaster theme="dark" position="bottom-right" />

      {/* ── Header ──────────────────────────────────────────────── */}
      <motion.div {...stagger(0)} className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-display-lg text-text-0">Portfolio</h1>
          <span className="rounded-full border border-hairline bg-bg-1 px-1.5 py-0.5">
            <FreshnessBadge asOf={portfolio?.asOf} source="Snapshot conto reale eToro" />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Period selector */}
          <div className="flex rounded-lg border border-hairline bg-bg-1 p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-micro font-medium transition-colors',
                  period === p.key ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
                )}
              >
                {p.key}
              </button>
            ))}
          </div>
          {/* Currency toggle */}
          <div className="flex rounded-lg border border-hairline bg-bg-1 p-0.5">
            {(['EUR', 'USD'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setDisplayCurrency(c)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-micro font-medium transition-colors',
                  cur === c ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={exportReport}
            className="flex items-center gap-1.5 rounded-lg border border-hairline bg-transparent px-3 py-1.5 text-caption font-medium text-text-1 transition-colors hover:border-hairline-strong hover:text-text-0"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Esporta report
          </button>
        </div>
      </motion.div>

      {/* ── ROW 1: KPI ──────────────────────────────────────────── */}
      {loading && !portfolio ? (
        <div className="grid grid-cols-12 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="col-span-12 h-32 sm:col-span-6 lg:col-span-3" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <KpiCard
              label="Valore totale"
              value={portfolio ? fmt(portfolio.totalValue) : '—'}
              numericValue={portfolio ? fromUsd(portfolio.totalValue) : undefined}
              formatValue={(value) => formatCurrency(value, cur)}
              deltaPct={pnl?.dailyPnlPct}
              deltaAbsolute={pnl ? fromUsd(pnl.dailyPnl) : undefined}
              currency={cur}
              sparkData={sparkWindow(pnl?.equityHistory)}
              sparkLive
              status={status === 'connected' ? 'live' : 'idle'}
              info="Equity corrente: cash più valore delle posizioni manuali e dei copy portfolio nello snapshot reale eToro."
            />
          </div>
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <KpiCard
              label="P&L totale"
              value={pnl ? fmtSigned(pnl.totalPnl) : '—'}
              numericValue={pnl ? fromUsd(pnl.totalPnl) : undefined}
              formatValue={(value) => formatSignedCurrency(value, cur)}
              deltaPct={pnl?.totalPnlPct}
              currency={cur}
              sparkData={sparkWindow(pnl?.equityHistory)}
              info="Formula eToro: P&L manuale non realizzato + P&L mirror non realizzato + profitto netto mirror chiuso."
            />
          </div>
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <KpiCard
              label="P&L non realizzato"
              value={fmtSigned(unrealizedPnl)}
              numericValue={fromUsd(unrealizedPnl)}
              formatValue={(value) => formatSignedCurrency(value, cur)}
              deltaPct={unrealizedPct}
              currency={cur}
              sparkData={sparkWindow(pnl?.equityHistory)}
            />
          </div>
          <motion.div {...stagger(3)} className="card-surface density-pad col-span-12 p-5 sm:col-span-6 lg:col-span-3">
            <span className="overline">Cash &amp; Dividendi</span>
            <div className="mt-2 font-display text-display-md tabular-nums text-text-0">
              {portfolio ? fmt(portfolio.cash) : '—'}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-caption text-text-2">
                Dividendi YTD: <span className="tabular-nums text-text-1">{formatCurrency(0, cur)}</span>
              </span>
              <span className="text-micro text-text-2">
                {portfolio ? fmtWeight(portfolio.cash / Math.max(portfolio.totalValue, 0.01)) : ''} del totale
              </span>
            </div>
          </motion.div>
        </div>
      )}

      {/* ── ROW 2: Score + Donuts ───────────────────────────────── */}
      <div className="grid grid-cols-12 gap-4">
        <motion.div {...stagger(1)} className="card-surface density-pad col-span-12 p-5 md:col-span-6 lg:col-span-4">
          <DiversificationGauge data={score} />
        </motion.div>

        <motion.div {...stagger(2)} className="card-surface density-pad col-span-12 p-5 md:col-span-6 lg:col-span-4">
          <AllocationDonut
            title="Allocazione per asset class"
            slices={classDonutSlices}
            centerValue={portfolio ? fmt(portfolio.totalValue) : '—'}
            centerLabel="Totale"
            selectedKey={classFilter}
            onSelect={(key) => setClassFilter(key === 'cash' ? null : key)}
          />
          {classFilter && (
            <button
              type="button"
              onClick={() => setClassFilter(null)}
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-info/40 bg-info/10 px-2 py-0.5 text-micro font-medium text-info transition-colors hover:bg-info/20"
            >
              Filtro tabella: {CLASS_LABELS[classFilter as keyof typeof CLASS_LABELS] ?? classFilter}
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </motion.div>

        <motion.div {...stagger(3)} className="card-surface density-pad col-span-12 p-5 lg:col-span-4">
          <AllocationDonut
            title="Esposizione valuta"
            slices={currencyDonutSlices}
            centerValue={fxRate ? formatFxRate(fxRate.rate) : '—'}
            centerLabel="EUR/USD"
          />
          <div className="mt-4 rounded-lg border border-info/30 bg-info/5 p-3">
            <p className="text-caption leading-relaxed text-text-1">
              <span className="font-semibold text-info">{fmtWeight(usdExposurePct)} in USD</span>
              {' — '}una variazione del 5% nel cambio EUR/USD muove il tuo portafoglio di{' '}
              <span className="font-semibold tabular-nums text-text-0">~{fmt(usdExposure * 0.05)}</span>.
            </p>
            <Link
              to="/fx"
              className="mt-2 inline-flex items-center gap-1 text-caption font-medium text-info transition-colors hover:text-text-0"
            >
              Apri modulo FX →
            </Link>
          </div>
        </motion.div>
      </div>

      {/* ── ROW 3: Settori + P&L per posizione ──────────────────── */}
      <div className="grid grid-cols-12 gap-4">
        <motion.div {...stagger(4)} className="card-surface density-pad col-span-12 p-5 lg:col-span-6">
          <SectorBars slices={sectorSlices} fmtValue={fmt} />
        </motion.div>
        <motion.div {...stagger(5)} className="card-surface density-pad col-span-12 p-5 lg:col-span-6">
          <PnlPositionBars rows={rows} fmtSigned={fmtSigned} />
        </motion.div>
      </div>

      {/* ── ROW 4: Tabella posizioni ────────────────────────────── */}
      <motion.div {...stagger(6)} className="card-surface density-pad col-span-12 p-5">
        {instrumentFilterId > 0 && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-info/30 bg-info/5 px-3 py-2">
            <span className="text-caption text-info">Dettaglio acquisti di {rows.find((row) => row.instrumentId === instrumentFilterId)?.symbol ?? `strumento #${instrumentFilterId}`} · {filteredRows.length} posizioni aperte</span>
            <button type="button" onClick={() => navigate('/portfolio')} className="rounded-md px-2 py-1 text-micro text-text-1 hover:bg-bg-2">Mostra tutto</button>
          </div>
        )}
        <PositionsTable
          rows={filteredRows}
          fmtMoney={fmt}
          fmtSignedMoney={fmtSigned}
          sparkFor={sparkFor}
          agentGroupFor={agentGroupFor}
          onDetails={setDrawerRow}
          onClose={handleClosePosition}
        />
      </motion.div>

      {portfolio?.copyPortfolios && portfolio.copyPortfolios.length > 0 && (
        <motion.div {...stagger(7)} className="card-surface density-pad col-span-12 p-5">
          <div className="mb-3 flex items-center justify-between"><div><h2 className="text-title text-text-0">Copy trading e Copy Agent</h2><p className="text-caption text-text-2">Ogni riga apre il dettaglio delle posizioni acquistate dal copy.</p></div><span className="text-micro text-text-2">{portfolio.copyPortfolios.length} attivi</span></div>
          <CopyPortfolioTable portfolios={portfolio.copyPortfolios} fmtMoney={fmt} fmtSignedMoney={fmtSigned} onSelect={setCopyDrawer} />
        </motion.div>
      )}

      {/* ── ROW 5: Suggerimenti + Storico ───────────────────────── */}
      <div className="grid grid-cols-12 gap-4">
        <motion.div {...stagger(7)} className="card-surface density-pad col-span-12 p-5 lg:col-span-7">
          <SuggestionsCard suggestions={suggestions} checklist={checklist} />
        </motion.div>
        <motion.div {...stagger(8)} className="card-surface density-pad col-span-12 p-5 lg:col-span-5">
          <PnlHeatmap months={months} fmtSigned={fmtSigned} />
        </motion.div>
      </div>

      {/* ── Drawer dettaglio posizione ──────────────────────────── */}
      <PositionDrawer
        row={drawerRow}
        onClose={() => setDrawerRow(null)}
        fmtMoney={fmt}
        fmtSignedMoney={fmtSigned}
        sparkFor={sparkFor}
        onClosePosition={handleClosePosition}
      />
      <CopyPortfolioDrawer portfolio={copyDrawer} onClose={() => setCopyDrawer(null)} fmtMoney={fmt} fmtSignedMoney={fmtSigned} />
    </div>
  );
}
