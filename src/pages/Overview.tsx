/**
 * Panoramica (/) — command dashboard (design/overview.md).
 * ROW 0: RiskBanner condizionale
 * ROW 1: Hero Valore Portafoglio (span 5) + KpiCards P&L Oggi / Totale / Cash
 * ROW 2: Grafico P&L (span 8, lightweight-charts) + Suggerimenti (span 4)
 * ROW 3: Watchlist live (span 5) + Agent status (span 4) + Valute (span 3)
 * ROW 4: Posizioni aperte (span 8) + Avvisi (span 4)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import { createChart, AreaSeries, LineSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import {
  ArrowRight, Bell, Bot, CircleAlert, Database, Lightbulb, Loader2, Pencil, Plus, TrendingUp, TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import {
  formatCurrency, formatFxRate, formatPercent, formatPrice, formatSignedCurrency, formatTime, formatUnits,
} from '@/lib/format';
import { KpiCard } from '@/components/shared/KpiCard';
import { DeltaChip } from '@/components/shared/DeltaChip';
import { Sparkline } from '@/components/shared/Sparkline';
import { DataTable } from '@/components/shared/DataTable';
import type { DataTableColumn } from '@/components/shared/DataTable';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import { RiskBanner } from '@/components/shared/RiskBanner';
import { EmptyState } from '@/components/shared/EmptyState';
import { StatusDot } from '@/components/shared/StatusDot';
import { Skeleton } from '@/components/shared/Skeleton';
import { TickValue } from '@/components/shared/TickValue';
import { FreshnessBadge } from '@/components/shared/FreshnessBadge';
import { CopyPortfolioTable } from '@/components/portfolio/CopyPortfolioTable';
import { enrichLookThroughPositions } from '@/components/portfolio/analytics';
import type { Candle, EquityPoint, PnlSummary, Portfolio, Position, PriceAlert } from '@/lib/data/types';
import { externalCryptoSymbol } from '@/lib/data/ExternalPriceProvider';
import { AgentMasterSwitch } from '@/components/agent/AgentMasterSwitch';
import { logReturnStats, projectPercentiles } from '@/lib/finance/scenario';

const WATCHLIST_SYMBOLS = ['AAPL', 'META', 'BTC', 'ETH', 'SPY', 'EURUSD'];
const TIMEFRAMES = [
  { key: '1G', days: 1 }, { key: '1S', days: 7 }, { key: '1M', days: 30 },
  { key: '3M', days: 90 }, { key: '1A', days: 365 }, { key: 'TUTTO', days: 365 },
] as const;

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

type TrendResult = {
  points: EquityPoint[];
  source: 'etoro' | 'reconstructed' | 'loading' | 'unavailable';
  coveragePct: number;
  projectionPoints: EquityPoint[];
  projectionCoveragePct: number;
  projectionSource: 'reconstructed' | 'account' | 'loading' | 'unavailable';
};

function usePortfolioTrend(
  portfolio: Portfolio | null,
  pnl: PnlSummary | null,
  getCandles: ReturnType<typeof useAppData>['getCandles'],
): TrendResult {
  const official = pnl?.historySource === 'etoro-balances' ? pnl.equityHistory : [];
  const [result, setResult] = useState<TrendResult>({
    points: official,
    source: official.length >= 20 ? 'etoro' : 'loading',
    coveragePct: official.length >= 20 ? 100 : 0,
    projectionPoints: [],
    projectionCoveragePct: 0,
    projectionSource: 'loading',
  });
  const holdingsKey = portfolio
    ? `${portfolio.asOf}:${portfolio.positions.map((position) => position.positionId).join(',')}:${(portfolio.copyPortfolios ?? []).map((copy) => copy.copyId).join(',')}`
    : '';

  useEffect(() => {
    if (!portfolio || portfolio.totalValue <= 0) {
      setResult({
        points: official,
        source: official.length >= 2 ? 'etoro' : 'unavailable',
        coveragePct: official.length >= 2 ? 100 : 0,
        projectionPoints: official,
        projectionCoveragePct: official.length >= 20 ? 100 : 0,
        projectionSource: official.length >= 20 ? 'account' : 'unavailable',
      });
      return;
    }
    const controller = new AbortController();
    const allRows = enrichLookThroughPositions(portfolio).filter((row) => row.instrumentId > 0 && row.value > 0).sort((a, b) => b.value - a.value);
    // Prova le dieci esposizioni maggiori: fermarsi appena raggiunto il 90%
    // poteva lasciare la copertura sotto soglia se uno dei primi asset non aveva storico.
    const selected = allRows.slice(0, 10);
    setResult((current) => ({
      ...current,
      points: official.length >= 20 ? official : current.points,
      source: official.length >= 20 ? 'etoro' : 'loading',
      coveragePct: official.length >= 20 ? 100 : current.coveragePct,
      projectionSource: 'loading',
    }));
    void Promise.allSettled(selected.map(async (row) => ({ row, candles: await getCandles(row.instrumentId, 'OneDay', 756, controller.signal) })))
      .then((settled) => {
        if (controller.signal.aborted) return;
        const valid = settled.flatMap((entry) => entry.status === 'fulfilled' && entry.value.candles.length >= 20 ? [entry.value] : []);
        if (valid.length === 0) {
          setResult({
            points: official,
            source: official.length >= 2 ? 'etoro' : 'unavailable',
            coveragePct: official.length >= 2 ? 100 : 0,
            projectionPoints: official,
            projectionCoveragePct: official.length >= 20 ? 100 : 0,
            projectionSource: official.length >= 20 ? 'account' : 'unavailable',
          });
          return;
        }
        const anchor = [...valid].sort((a, b) => b.candles.length - a.candles.length)[0].candles;
        const series = valid.map(({ row, candles }) => ({
          row,
          candles,
          latest: candles[candles.length - 1].close,
        })).filter((item) => item.latest > 0);
        const dynamicValue = series.reduce((sum, item) => sum + item.row.value, 0);
        const staticValue = Math.max(0, portfolio.totalValue - dynamicValue);
        const commonStart = Math.max(...series.map((item) => item.candles[0].time));
        const points = anchor.filter((anchorCandle) => anchorCandle.time >= commonStart).map((anchorCandle) => {
          let value = staticValue;
          for (const item of series) {
            let candle = item.candles[0];
            for (const candidate of item.candles) {
              if (candidate.time > anchorCandle.time) break;
              candle = candidate;
            }
            value += item.row.value * (candle.close / item.latest);
          }
          return { time: anchorCandle.time, value };
        }).filter((point) => Number.isFinite(point.value) && point.value > 0);
        points.push({ time: Math.floor(Date.now() / 1000), value: portfolio.totalValue });
        const knownStatic = Math.max(0, portfolio.cash + (portfolio.copyPortfolios ?? []).reduce((sum, copy) => sum + copy.availableCash, 0));
        const coveragePct = Math.round(Math.min(100, ((dynamicValue + knownStatic) / portfolio.totalValue) * 100));
        setResult({
          points: official.length >= 20 ? official : points,
          source: official.length >= 20 ? 'etoro' : 'reconstructed',
          coveragePct: official.length >= 20 ? 100 : coveragePct,
          projectionPoints: points,
          projectionCoveragePct: coveragePct,
          projectionSource: 'reconstructed',
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({
          points: official,
          source: official.length >= 2 ? 'etoro' : 'unavailable',
          coveragePct: official.length >= 2 ? 100 : 0,
          projectionPoints: official,
          projectionCoveragePct: official.length >= 20 ? 100 : 0,
          projectionSource: official.length >= 20 ? 'account' : 'unavailable',
        });
      });
    return () => controller.abort();
    // La firma cambia solo quando cambia lo snapshot autorevole o la composizione.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getCandles, holdingsKey, official.length]);

  return result;
}

export default function Overview() {
  const navigate = useNavigate();
  const {
    portfolio, pnl, loading, status,
    displayCurrency, fromUsd, realExecutionActive, agent, getCandles,
  } = useAppData();

  const cur = displayCurrency;
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]['key']>('1M');
  const trend = usePortfolioTrend(portfolio, pnl, getCandles);

  /* ── Empty state: Live senza connessione e nessun dato ──────────── */
  if (!loading && !portfolio) {
    return (
      <EmptyState
        headline="Il tuo terminale è pronto"
        copy="Configura chiavi e proxy per collegare il tuo account eToro reale. Nessun dato simulato verrà mostrato."
        actionLabel="Configura la connessione"
        onAction={() => navigate('/impostazioni')}
      />
    );
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* ROW 0 — RiskBanner */}
      {realExecutionActive && agent.masterEnabled && (
        <div className="col-span-12">
          <RiskBanner
            variant="danger"
            message="Agent attivo sul conto reale — le regole abilitate possono usare denaro reale entro i limiti configurati."
          />
        </div>
      )}
      {(status === 'error' || status === 'disconnected') && (
        <div className="col-span-12">
          <RiskBanner
            variant="warn"
            message="Connessione a eToro assente — verifica proxy e chiavi in Impostazioni."
            actionLabel="Vai a Impostazioni"
            onAction={() => navigate('/impostazioni')}
          />
        </div>
      )}

      {/* ROW 1 — Hero KPI strip */}
      <motion.div {...stagger(0)} className="card-surface density-pad col-span-12 p-5 lg:col-span-5">
        <div className="flex items-center justify-between">
          <span className="overline">Valore portafoglio</span>
          <FreshnessBadge asOf={portfolio?.asOf} source="Snapshot conto eToro · aggiornamento autorevole ogni 45 secondi" />
        </div>
        {portfolio ? (
          <>
            <HeroNumber value={fromUsd(portfolio.totalValue)} currency={cur} />
            <div className="mt-2">
              <DeltaChip
                value={pnl?.dailyPnlPct ?? 0}
                absoluteValue={pnl ? fromUsd(pnl.dailyPnl) : 0}
                currency={cur}
              />
            </div>
          </>
        ) : (
          <Skeleton className="mt-3 h-11 w-56" />
        )}
      </motion.div>

      <div className="col-span-12 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:col-span-7">
        <KpiCard
          label="P&L Oggi"
          value={pnl ? formatSignedCurrency(fromUsd(pnl.dailyPnl), cur) : '—'}
          numericValue={pnl ? fromUsd(pnl.dailyPnl) : undefined}
          formatValue={(value) => formatSignedCurrency(value, cur)}
          deltaPct={pnl?.dailyPnlPct}
          currency={cur}
          sparkData={pnl?.historySource === 'etoro-balances' ? pnl.equityHistory.slice(-30).map((p) => p.value) : undefined}
          sparkLive
          status={pnl && pnl.dailyPnl >= 0 ? 'ok' : 'error'}
          className="relative"
          info={pnl ? `${pnl.sourceLabel}. Aggiornato ${new Date(pnl.asOf).toLocaleString('it-IT')}.` : 'Dato non ancora disponibile.'}
        />
        <KpiCard
          label="P&L Totale"
          value={pnl ? formatSignedCurrency(fromUsd(pnl.totalPnl), cur) : '—'}
          numericValue={pnl ? fromUsd(pnl.totalPnl) : undefined}
          formatValue={(value) => formatSignedCurrency(value, cur)}
          deltaPct={pnl?.totalPnlPct}
          currency={cur}
          sparkData={pnl?.historySource === 'etoro-balances' ? pnl.equityHistory.slice(-90).map((p) => p.value) : undefined}
          info="Somma del P&L non realizzato manuale, del P&L non realizzato mirror e del profitto netto delle posizioni mirror chiuse, come da formula eToro."
        />
        <KpiCard
          label="Cash disponibile"
          value={portfolio ? formatCurrency(fromUsd(portfolio.cash), cur) : '—'}
          numericValue={portfolio ? fromUsd(portfolio.cash) : undefined}
          formatValue={(value) => formatCurrency(value, cur)}
          currency={cur}
        />
      </div>

      {/* ROW 2 — P&L chart + Suggerimenti */}
      <motion.div {...stagger(1)} className="card-surface density-pad col-span-12 p-5 lg:col-span-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-title text-text-0">Andamento portafoglio</h2>
          <div className="flex rounded-lg border border-hairline bg-bg-0 p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.key}
                onClick={() => setTimeframe(tf.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-micro font-medium transition-colors',
                  timeframe === tf.key ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
                )}
              >
                {tf.key}
              </button>
            ))}
          </div>
        </div>
        <PnlChart
          data={trend.points}
          days={TIMEFRAMES.find((t) => t.key === timeframe)!.days}
          fromUsd={fromUsd}
        />
        <TrendSource source={trend.source} coveragePct={trend.coveragePct} />
        <PnlStats history={trend.points} />
        <ProjectionScenario history={trend.projectionPoints} coveragePct={trend.projectionCoveragePct} source={trend.projectionSource} fromUsd={fromUsd} currency={cur} />
      </motion.div>

      <SuggestionsCard />

      {/* ROW 3 — Watchlist + Agent + Valute */}
      <motion.div {...stagger(2)} className="card-surface density-pad col-span-12 p-5 md:col-span-6 lg:col-span-5">
        <div className="flex items-center justify-between">
          <h2 className="text-title text-text-0">Watchlist</h2>
          <button aria-label="Modifica watchlist" className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-1">
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="mt-3 divide-y divide-hairline">
          {WATCHLIST_SYMBOLS.map((symbol) => (
            <WatchlistRow key={symbol} symbol={symbol} />
          ))}
        </div>
      </motion.div>

      <AgentStatusCard />

      <motion.div {...stagger(4)} className="card-surface density-pad col-span-12 p-5 md:col-span-6 lg:col-span-3">
        <h2 className="text-title text-text-0">Valute</h2>
        <CurrencyExposure />
      </motion.div>

      {/* ROW 4 — Posizioni + Avvisi */}
      <motion.div {...stagger(5)} className="card-surface density-pad col-span-12 p-5 lg:col-span-8">
        <div className="flex items-center justify-between">
          <h2 className="text-title text-text-0">Posizioni aperte</h2>
          <button
            onClick={() => navigate('/portfolio')}
            className="flex items-center gap-1 text-caption text-info transition-colors hover:text-info/80"
          >
            Tutte le posizioni <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <PositionsTable />
        {portfolio?.copyPortfolios && portfolio.copyPortfolios.length > 0 && (
          <div className="mt-5 border-t border-hairline pt-4">
            <div className="mb-2 flex items-center justify-between"><h3 className="text-body-strong text-text-0">Copy trading e Copy Agent</h3><span className="text-micro text-text-2">{portfolio.copyPortfolios.length} attivi</span></div>
            <CopyPortfolioTable
              portfolios={portfolio.copyPortfolios}
              fmtMoney={(usd) => formatCurrency(fromUsd(usd), displayCurrency)}
              fmtSignedMoney={(usd) => formatSignedCurrency(fromUsd(usd), displayCurrency)}
              onSelect={(copy) => navigate(`/portfolio?copyId=${encodeURIComponent(copy.copyId)}`)}
            />
          </div>
        )}
      </motion.div>

      <AlertsCard />
    </div>
  );
}

/* ── Hero number con count-up 900ms ────────────────────────────────── */
function HeroNumber({ value, currency }: { value: number; currency: 'EUR' | 'USD' }) {
  const [display, setDisplay] = useState(0);
  const firstRef = useRef(true);

  useEffect(() => {
    const duration = firstRef.current ? 900 : 400;
    firstRef.current = false;
    const from = display;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="mt-2 font-display text-display-xl text-text-0 tabular-nums">
      {formatCurrency(display, currency)}
    </div>
  );
}

function TrendSource({ source, coveragePct }: { source: TrendResult['source']; coveragePct: number }) {
  if (source === 'loading') {
    return <div className="mt-2 flex items-center gap-2 text-caption text-text-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Ricostruzione dello storico dai prezzi reali in corso…</div>;
  }
  if (source === 'etoro') {
    return <div className="mt-2 flex items-center gap-2 text-caption text-gain"><Database className="h-3.5 w-3.5" aria-hidden /> Storico equity ufficiale eToro, fine giornata.</div>;
  }
  if (source === 'reconstructed') {
    return (
      <div className="mt-2 rounded-lg border border-info/25 bg-info/5 px-3 py-2 text-caption leading-relaxed text-text-1">
        <span className="font-medium text-info">Ricostruzione sui prezzi reali · copertura {coveragePct}%.</span>{' '}
        Applica la composizione attuale ai prezzi storici eToro; non ricostruisce acquisti, vendite, versamenti o dividendi passati.
      </div>
    );
  }
  return <div className="mt-2 text-caption text-warn">Storico non ancora disponibile: mantengo visibile il valore corrente senza inventare punti.</div>;
}

function ProjectionScenario({ history, coveragePct, source, fromUsd, currency }: { history: { time: number; value: number }[]; coveragePct: number; source: TrendResult['projectionSource']; fromUsd(value: number): number; currency: 'EUR' | 'USD' }) {
  const [months, setMonths] = useState(12);
  const qualityReason = source === 'loading'
    ? 'Sto ricostruendo lo storico della composizione attuale.'
    : source === 'account'
      ? 'Lo storico del saldo può contenere versamenti e prelievi: non lo uso per proiettare rendimenti di mercato.'
      : source !== 'reconstructed'
        ? 'Non è disponibile uno storico della composizione corrente.'
        : coveragePct < 80
          ? `Copertura dati ${coveragePct}%: serve almeno l’80% del valore corrente.`
          : history.length < 126
            ? `Sono disponibili ${history.length} sedute: ne servono almeno 126 per evitare una proiezione troppo fragile.`
            : null;
  const scenario = useMemo(() => {
    if (qualityReason) return null;
    const stats = logReturnStats(history.map((point) => point.value));
    if (!stats) return null;
    const base = history[history.length - 1].value;
    return { base, stats, ...projectPercentiles(base, stats, months) };
  }, [history, months, qualityReason]);

  const horizonLabel = months < 12 ? `${months} mesi` : months === 12 ? '1 anno' : months === 18 ? '18 mesi' : `${months / 12} anni`;

  return (
    <div className="mt-4 rounded-lg border border-hairline bg-bg-0/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-body-strong text-text-0"><TriangleAlert className="h-4 w-4 text-warn" aria-hidden /> Quanto potrebbe valere il portafoglio?</div>
          <p className="mt-0.5 text-micro text-text-2">Capitale di oggi proiettato sui prezzi reali della composizione attuale · capitalizzazione composta · scenario statistico, non previsione</p>
        </div>
        <div className="flex max-w-full overflow-x-auto rounded-md border border-hairline bg-bg-1 p-0.5" aria-label="Orizzonte scenario">
          {[3, 6, 12, 18, 24, 36].map((value) => <button key={value} type="button" onClick={() => setMonths(value)} className={cn('shrink-0 rounded px-2 py-1 text-micro', months === value ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1')}>{value < 12 ? `${value}M` : value === 12 ? '1A' : value === 18 ? '18M' : `${value / 12}A`}</button>)}
        </div>
      </div>
      {scenario ? (
        <div className="mt-3">
          <p className="mb-2 text-caption text-text-1">Partendo da <span className="font-mono font-medium text-text-0">{formatCurrency(fromUsd(scenario.base), currency)}</span>, tra <span className="font-medium text-text-0">{horizonLabel}</span> il modello produce questa fascia:</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <ScenarioMetric label="P10 · scenario debole" probability="Il 10% degli esiti simulati è sotto questo valore" value={formatCurrency(fromUsd(scenario.p10), currency)} delta={`${formatSignedCurrency(fromUsd(scenario.p10 - scenario.base), currency)} · ${formatPercent(scenario.p10ChangePct, 1)}`} tone="loss" />
            <ScenarioMetric label="P50 · scenario mediano" probability="Metà degli esiti è sopra e metà sotto" value={formatCurrency(fromUsd(scenario.p50), currency)} delta={`${formatSignedCurrency(fromUsd(scenario.p50 - scenario.base), currency)} · ${formatPercent(scenario.p50ChangePct, 1)}`} />
            <ScenarioMetric label="P90 · scenario forte" probability="Solo il 10% degli esiti simulati è sopra questo valore" value={formatCurrency(fromUsd(scenario.p90), currency)} delta={`${formatSignedCurrency(fromUsd(scenario.p90 - scenario.base), currency)} · ${formatPercent(scenario.p90ChangePct, 1)}`} tone="gain" />
          </div>
          {Math.abs(scenario.p50ChangePct) < 2 ? <p className="mt-2 rounded-md border border-warn/25 bg-warn/5 px-2.5 py-2 text-micro leading-relaxed text-warn">Perché la mediana resta quasi uguale? Il campione disponibile ha un rendimento geometrico annualizzato vicino a zero ({formatPercent(scenario.stats.annualizedMedianPct, 1)}). Il modello lo ripete: non sta dicendo che il mercato “deve” restare fermo.</p> : null}
          <div className="mt-2 rounded-md bg-bg-1 px-2.5 py-2 text-micro leading-relaxed text-text-2"><span className="font-medium text-text-1">Metodo:</span> ogni rendimento giornaliero si applica al saldo del giorno precedente, quindi guadagni e perdite si compongono. P10, P50 e P90 sono percentili, non tre saldi promessi. Campione: {scenario.stats.observations} variazioni giornaliere · copertura {coveragePct}% · circa {scenario.tradingDays} sedute proiettate. Non include versamenti, prelievi, dividendi, costi futuri o cambi di composizione.</div>
        </div>
      ) : <p className="mt-3 rounded-md border border-warn/25 bg-warn/5 px-3 py-2 text-caption leading-relaxed text-warn"><span className="font-medium">Scenario non pubblicato.</span> {qualityReason ?? 'I dati disponibili non superano i controlli minimi di qualità.'} Preferisco non mostrare un saldo futuro apparentemente preciso ma fuorviante.</p>}
    </div>
  );
}

function ScenarioMetric({ label, probability, value, delta, tone }: { label: string; probability: string; value: string; delta: string; tone?: 'gain' | 'loss' }) {
  return <div className="min-w-0 rounded-md bg-bg-1 p-2.5"><div className="text-micro font-medium text-text-1">{label}</div><div className={cn('mt-1 font-mono text-body-strong tabular-nums', tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : 'text-text-0')}>{value}</div><div className={cn('mt-0.5 font-mono text-micro tabular-nums', tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : 'text-text-2')}>{delta}</div><p className="mt-1.5 text-micro leading-snug text-text-2">{probability}</p></div>;
}

/* ── Grafico P&L (lightweight-charts area) ─────────────────────────── */
function PnlChart({ data, days, fromUsd }: { data: { time: number; value: number }[]; days: number; fromUsd(n: number): number }) {
  const { instruments, getCandles } = useAppData();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const benchRef = useRef<ISeriesApi<'Line'> | null>(null);
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [benchmark, setBenchmark] = useState<Candle[]>([]);
  const [benchmarkState, setBenchmarkState] = useState<'idle' | 'loading' | 'error'>('idle');
  const spxInstrument = instruments.find((instrument) => instrument.symbol.toUpperCase() === 'SPX500');
  /* ref per evitare il rebuild della serie a ogni tick FX */
  const fromUsdRef = useRef(fromUsd);
  useEffect(() => { fromUsdRef.current = fromUsd; }, [fromUsd]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: 260,
      layout: { background: { color: 'transparent' }, textColor: '#5C6B7A', fontFamily: 'JetBrains Mono' },
      grid: { vertLines: { color: '#FFFFFF0A' }, horzLines: { color: '#FFFFFF0A' } },
      crosshair: {
        vertLine: { color: '#5C6B7A', style: 2 },
        horzLine: { color: '#5C6B7A', style: 2 },
      },
      rightPriceScale: { borderColor: '#FFFFFF14' },
      timeScale: { borderColor: '#FFFFFF14', timeVisible: true },
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; benchRef.current = null; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length < 2) return;
    const cutoff = Date.now() / 1000 - days * 86400;
    const inRange = data.filter((p) => p.time >= cutoff);
    const filtered = inRange.length >= 2 ? inRange : data.slice(-2);
    const positive = filtered[filtered.length - 1].value >= filtered[0].value;
    const color = positive ? '#00C390' : '#F4556B';

    if (seriesRef.current) chart.removeSeries(seriesRef.current);
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: `${color}1F`,
      bottomColor: `${color}00`,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    series.setData(filtered.map((p) => ({ time: p.time as UTCTimestamp, value: fromUsdRef.current(p.value) })));
    seriesRef.current = series;
    chart.timeScale().fitContent();
  }, [data, days]);

  useEffect(() => {
    if (!showBenchmark || !spxInstrument) return;
    const controller = new AbortController();
    const interval = days <= 1 ? 'OneHour' : 'OneDay';
    const count = days <= 1 ? 24 : Math.min(365, Math.max(7, days));
    void getCandles(spxInstrument.instrumentId, interval, count, controller.signal)
      .then((candles) => {
        if (candles.length < 2) {
          setBenchmark([]);
          setBenchmarkState('error');
          return;
        }
        setBenchmark(candles);
        setBenchmarkState('idle');
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setBenchmarkState('error');
      });
    return () => controller.abort();
  }, [days, getCandles, showBenchmark, spxInstrument]);

  /* Benchmark SPX reale, normalizzato al valore iniziale del portafoglio. */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || data.length < 2) return;
    if (benchRef.current) { chart.removeSeries(benchRef.current); benchRef.current = null; }
    if (!showBenchmark || benchmark.length < 2) return;
    const cutoff = Date.now() / 1000 - days * 86400;
    const inRange = data.filter((p) => p.time >= cutoff);
    const filtered = inRange.length >= 2 ? inRange : data.slice(-2);
    if (filtered.length < 2) return;
    const base = fromUsdRef.current(filtered[0].value);
    const benchmarkBase = benchmark[0].close;
    const line = chart.addSeries(LineSeries, { color: '#5C6B7A', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
    line.setData(benchmark.map((candle) => ({ time: candle.time as UTCTimestamp, value: base * (candle.close / benchmarkBase) })));
    benchRef.current = line;
    chart.timeScale().fitContent();
  }, [benchmark, showBenchmark, data, days]);

  return (
    <div className="mt-3">
      <div className="relative min-h-[260px]">
        <div ref={containerRef} className="w-full" />
        {data.length < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-dashed border-hairline text-caption text-text-2">
            In attesa di almeno due punti reali per disegnare il grafico.
          </div>
        ) : null}
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-2 text-caption text-text-2">
        <input
          type="checkbox"
          checked={showBenchmark}
          onChange={(e) => {
            setShowBenchmark(e.target.checked);
            setBenchmarkState(e.target.checked ? 'loading' : 'idle');
          }}
          className="h-3.5 w-3.5 accent-[#00C390]"
        />
        Confronta con benchmark (SPX)
      </label>
      {showBenchmark && benchmarkState === 'loading' ? <p className="mt-1 text-micro text-text-2">Caricamento benchmark reale eToro…</p> : null}
      {showBenchmark && (benchmarkState === 'error' || !spxInstrument) ? <p className="mt-1 text-micro text-warn">Storico SPX non disponibile da eToro per questo intervallo.</p> : null}
    </div>
  );
}

/* ── Footer stats del grafico: max drawdown, volatilità, Sharpe ────── */
function PnlStats({ history }: { history: { time: number; value: number }[] }) {
  const stats = useMemo(() => {
    if (history.length < 30) return null;
    const values = history.map((p) => p.value);
    let peak = values[0];
    let maxDd = 0;
    for (const v of values) {
      peak = Math.max(peak, v);
      maxDd = Math.min(maxDd, (v - peak) / peak);
    }
    const returns: number[] = [];
    for (let i = 1; i < values.length; i++) returns.push((values[i] - values[i - 1]) / values[i - 1]);
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const vol = Math.sqrt(variance) * Math.sqrt(252) * 100;
    const sharpe = vol > 0 ? (mean * 252 * 100) / vol : 0;
    return { maxDd: maxDd * 100, vol, sharpe };
  }, [history]);

  if (!stats) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-hairline pt-3 text-caption text-text-2">
      <span>Max drawdown <span className="text-loss tabular-nums">{formatPercent(stats.maxDd, 1, false)}</span></span>
      <span>Volatilità ann. <span className="text-text-1 tabular-nums">{formatPercent(stats.vol, 1, false)}</span></span>
      <span>Sharpe semplice <span className="text-text-1 tabular-nums">{stats.sharpe.toFixed(2)}</span></span>
    </div>
  );
}

/* ── Suggerimenti & Next Step ──────────────────────────────────────── */
interface Insight {
  id: string;
  severity: 'info' | 'warn' | 'opportunity';
  title: string;
  detail: string;
  to: string;
}

const SEVERITY_STYLE: Record<Insight['severity'], string> = {
  info: 'border-l-info',
  warn: 'border-l-warn',
  opportunity: 'border-l-gain',
};

function SuggestionsCard() {
  const navigate = useNavigate();
  const { portfolio, pnl, fxRate, settings, agent, fromUsd, displayCurrency } = useAppData();

  const insights = useMemo<Insight[]>(() => {
    const out: Insight[] = [];
    if (portfolio && portfolio.positions.length > 0) {
      // Concentrazione per asset class con look-through dei copy portfolio.
      const lookThrough = enrichLookThroughPositions(portfolio);
      const byClass = new Map<string, number>();
      for (const p of lookThrough) {
        byClass.set(p.assetClass, (byClass.get(p.assetClass) ?? 0) + p.value);
      }
      const total = lookThrough.reduce((sum, position) => sum + position.value, 0) || 1;
      const [topClass, topValue] = [...byClass.entries()].sort((a, b) => b[1] - a[1])[0];
      const pct = (topValue / total) * 100;
      if (pct > 50) {
        const labels: Record<string, string> = { stock: 'azioni', etf: 'ETF', crypto: 'crypto', fx: 'valute', index: 'indici', cfd: 'CFD' };
        out.push({
          id: 'concentration', severity: 'warn',
          title: 'Concentrazione elevata',
          detail: `Il ${pct.toFixed(0)}% degli asset investiti è in ${labels[topClass] ?? topClass}, includendo gli strumenti dentro i copy portfolio.`,
          to: '/portfolio',
        });
      }
      // Cash drag
      const cashPct = (portfolio.cash / portfolio.totalValue) * 100;
      if (cashPct > 10) {
        const budget = agent.getRemainingBudget();
        out.push({
          id: 'cash-drag', severity: 'info',
          title: 'Cash drag',
          detail: `${formatCurrency(fromUsd(portfolio.cash), displayCurrency)} (${cashPct.toFixed(0)}%) fermi. I gruppi Agent hanno ${formatCurrency(fromUsd(budget), displayCurrency)} di budget non allocato.`,
          to: '/agent',
        });
      }
      // Peggiore di oggi + regola
      const worst = [...lookThrough].sort((a, b) => a.pnlPctValue - b.pnlPctValue)[0];
      if (worst && worst.pnlPctValue < -3) {
        out.push({
          id: 'worst', severity: 'opportunity',
          title: `${worst.symbol} ${formatPercent(worst.pnlPctValue)} dall'apertura`,
          detail: 'La regola "Compra i cali" potrebbe attivarsi se il calo continua.',
          to: '/agent',
        });
      }
    }
    if (fxRate && fxRate.rate > settings.fxTargetRate) {
      out.push({
        id: 'fx', severity: 'opportunity',
        title: `EUR/USD a ${formatFxRate(fxRate.rate)}`,
        detail: `Sopra la tua soglia target ${formatFxRate(settings.fxTargetRate, 2)}. Monitora per la conversione USD→EUR.`,
        to: '/fx',
      });
    }
    if (pnl && pnl.dailyPnlPct > 1.5) {
      out.push({
        id: 'good-day', severity: 'info',
        title: 'Giornata positiva',
        detail: `Il portafoglio è ${formatPercent(pnl.dailyPnlPct)} oggi. Valuta prese di profitto parziali.`,
        to: '/portfolio',
      });
    }
    return out.slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio, pnl, fxRate, settings.fxTargetRate, displayCurrency]);

  const ICONS = { info: Lightbulb, warn: CircleAlert, opportunity: TrendingUp };

  return (
    <motion.div {...stagger(2)} className="card-surface density-pad col-span-12 p-5 lg:col-span-4">
      <h2 className="text-title text-text-0">Suggerimenti</h2>
      <div className="mt-3 space-y-2.5">
        {insights.length === 0 && (
          <p className="text-caption text-text-2">Nessun suggerimento al momento — il portafoglio è bilanciato.</p>
        )}
        {insights.map((ins, i) => {
          const Icon = ICONS[ins.severity];
          return (
            <motion.button
              key={ins.id}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, delay: i * 0.06 }}
              onClick={() => navigate(ins.to)}
              className={cn(
                'block w-full rounded-lg border border-hairline border-l-2 bg-bg-0 p-3 text-left transition-colors hover:bg-bg-2',
                SEVERITY_STYLE[ins.severity],
              )}
            >
              <div className="flex items-start gap-2.5">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-1" aria-hidden />
                <div className="min-w-0">
                  <div className="text-body-strong text-text-0">{ins.title}</div>
                  <div className="mt-0.5 text-caption text-text-1">{ins.detail}</div>
                  <div className="mt-1 flex items-center gap-1 text-micro font-medium text-info">
                    Vai <ArrowRight className="h-3 w-3" aria-hidden />
                  </div>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </motion.div>
  );
}

/* ── Watchlist row ─────────────────────────────────────────────────── */
function WatchlistRow({ symbol }: { symbol: string }) {
  const navigate = useNavigate();
  const { quotes, instruments, sparkFor } = useAppData();
  const inst = instruments.find((i) => i.symbol.toUpperCase() === symbol);
  if (!inst) return null;
  const quote = quotes[inst.instrumentId];

  return (
    <button
      onClick={() => navigate(`/mercati?instrument=${inst.instrumentId}`)}
      className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-bg-2/50"
    >
      <InstrumentAvatar symbol={inst.symbol} size={32} imageUrl={inst.imageUrl} backgroundColor={inst.imageBackgroundColor} textColor={inst.imageTextColor} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-ticker text-text-0">{inst.symbol}</div>
        <div className="truncate text-caption text-text-2">{inst.name}</div>
      </div>
      <Sparkline data={sparkFor(inst.instrumentId)} width={60} height={20} live />
      <div className="w-24 text-right">
        {quote ? (
          <>
            <TickValue value={quote.last} className="block text-body-strong text-text-0">
              {formatPrice(quote.last)}
            </TickValue>
            <span className={cn('text-micro tabular-nums', quote.changePct >= 0 ? 'text-gain' : 'text-loss')}>
              {formatPercent(quote.changePct)}
            </span>
          </>
        ) : (
          <Skeleton className="ml-auto h-4 w-16" />
        )}
      </div>
    </button>
  );
}

/* ── Agent status card ─────────────────────────────────────────────── */
function AgentStatusCard() {
  const navigate = useNavigate();
  const { agent, fromUsd, displayCurrency, agentVersion, realExecutionActive } = useAppData();
  // agentVersion forza il re-render a ogni update dell'engine
  void agentVersion;
  const rules = agent.getRules();
  const pending = agent.getPendingConfirmations();

  return (
    <motion.div {...stagger(3)} className="card-surface density-pad col-span-12 border-l-2 border-l-agent p-5 md:col-span-6 lg:col-span-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-title text-text-0">
          <Bot className="h-4 w-4 text-agent" aria-hidden />
          eToro Agent
        </h2>
        <AgentMasterSwitch agent={agent} realExecutionActive={realExecutionActive} label="" />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: 'Regole attive', value: String(agent.getActiveRulesCount()) },
          { label: 'Eseguiti oggi', value: `${agent.getExecutionsToday()}/${agent.maxOrdersPerDay}` },
          { label: 'Budget residuo', value: formatCurrency(fromUsd(agent.getRemainingBudget()), displayCurrency, 0) },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-hairline bg-bg-0 p-2.5">
            <div className="text-micro text-text-2">{s.label}</div>
            <div className="mt-0.5 text-body-strong text-text-0 tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {rules.slice(0, 3).map((rule) => (
          <div key={rule.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-bg-0 px-3 py-2">
            <StatusDot variant={rule.enabled ? 'ok' : 'idle'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-strong text-text-0">{rule.name}</div>
              <div className="truncate text-micro text-text-2">
                {rule.enabled ? `Cooldown ${rule.cooldownMinutes}m · ${rule.instrumentIds.length} strumenti` : 'In pausa'}
              </div>
            </div>
          </div>
        ))}
        {pending.slice(0, 2).map((exec) => (
          <div
            key={exec.id}
            className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 motion-safe:animate-[pending-ring_1.6s_ease-in-out_infinite]"
          >
            <div className="flex items-center gap-2">
              <StatusDot variant="warn" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-strong text-text-0">{exec.symbol} — conferma richiesta</div>
                <div className="truncate text-micro text-text-1">{exec.ruleName} · {formatCurrency(exec.amount, 'USD', 0)}</div>
              </div>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void agent.confirmExecution(exec.id)}
                className="rounded-md bg-warn px-2.5 py-1 text-micro font-semibold text-bg-0 transition-colors hover:bg-warn/90"
              >
                Conferma
              </button>
              <button
                onClick={() => agent.ignoreExecution(exec.id)}
                className="rounded-md border border-hairline-strong px-2.5 py-1 text-micro font-medium text-text-1 transition-colors hover:bg-bg-2"
              >
                Ignora
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => navigate('/agent')}
        className="mt-3 flex items-center gap-1 text-caption font-medium text-agent transition-colors hover:text-agent/80"
      >
        Apri Agent <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
      <style>{`@keyframes pending-ring { 0%,100% { box-shadow: 0 0 0 0 #F5A62300; } 50% { box-shadow: 0 0 0 3px #F5A62333; } }`}</style>
    </motion.div>
  );
}

/* ── Esposizione valuta ────────────────────────────────────────────── */
function CurrencyExposure() {
  const { portfolio } = useAppData();

  const exposure = useMemo(() => {
    if (!portfolio) return [];
    const byCcy = new Map<string, number>();
    byCcy.set('USD', portfolio.cash);
    for (const position of enrichLookThroughPositions(portfolio)) {
      byCcy.set(position.currency, (byCcy.get(position.currency) ?? 0) + position.value);
    }
    const total = [...byCcy.values()].reduce((s, v) => s + v, 0) || 1;
    return [...byCcy.entries()]
      .map(([ccy, v]) => ({ ccy, pct: (v / total) * 100 }))
      .sort((a, b) => b.pct - a.pct);
  }, [portfolio]);

  const COLORS: Record<string, string> = { USD: '#4C9AFF', EUR: '#00C390', GBP: '#9B8CFF', CHF: '#F5A623', JPY: '#F4556B' };
  const usdPct = exposure.find((e) => e.ccy === 'USD')?.pct ?? 0;

  return (
    <div className="mt-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {exposure.map((e) => (
          <div
            key={e.ccy}
            style={{ width: `${e.pct}%`, backgroundColor: COLORS[e.ccy] ?? '#5C6B7A' }}
            title={`${e.ccy} ${e.pct.toFixed(0)}%`}
          />
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {exposure.map((e) => (
          <div key={e.ccy} className="flex items-center gap-2 text-caption">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: COLORS[e.ccy] ?? '#5C6B7A' }} />
            <span className="font-mono text-ticker text-text-1">{e.ccy}</span>
            <span className="ml-auto text-text-0 tabular-nums">{e.pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
      {usdPct > 60 && (
        <p className="mt-3 text-caption text-warn">Esposizione USD elevata — vedi modulo FX.</p>
      )}
    </div>
  );
}

/* ── Tabella posizioni ─────────────────────────────────────────────── */
const ASSET_BADGE: Record<string, string> = {
  stock: 'Azione', etf: 'ETF', crypto: 'Crypto', fx: 'FX', index: 'Indice', cfd: 'CFD',
};

interface OverviewPosition extends Position {
  purchaseCount: number;
}

function PositionsTable() {
  const navigate = useNavigate();
  const { portfolio, fromUsd, displayCurrency, sparkFor } = useAppData();

  const groupedRows = useMemo<OverviewPosition[]>(() => {
    if (!portfolio) return [];
    const map = new Map<number, OverviewPosition>();
    for (const position of portfolio.positions) {
      const value = position.currentValue ?? position.invested + (position.pnl ?? 0);
      const current = map.get(position.instrumentId);
      if (!current) {
        map.set(position.instrumentId, {
          ...position,
          positionId: -position.instrumentId,
          currentValue: value,
          pnl: position.pnl ?? 0,
          purchaseCount: 1,
        });
        continue;
      }
      const previousUnits = current.units;
      const units = previousUnits + position.units;
      const invested = current.invested + position.invested;
      current.units = units;
      current.invested = invested;
      current.currentValue = (current.currentValue ?? 0) + value;
      current.pnl = (current.pnl ?? 0) + (position.pnl ?? 0);
      current.pnlPct = invested > 0 ? ((current.pnl ?? 0) / invested) * 100 : 0;
      current.openPrice = units > 0 ? (current.openPrice * previousUnits + position.openPrice * position.units) / units : current.openPrice;
      current.purchaseCount += 1;
    }
    return [...map.values()];
  }, [portfolio]);

  const columns: DataTableColumn<OverviewPosition>[] = useMemo(() => [
    {
      key: 'instrument', header: 'Strumento', sticky: true,
      sortValue: (p) => p.symbol,
      cell: (p) => (
        <div className="flex items-center gap-2.5">
          <InstrumentAvatar symbol={p.symbol} size={28} imageUrl={p.imageUrl} />
          <div>
            <div className="font-mono text-ticker text-text-0">{p.symbol}</div>
            <div className="max-w-32 truncate text-micro text-text-2">{p.name} · {p.purchaseCount} acquisti</div>
          </div>
        </div>
      ),
    },
    {
      key: 'type', header: 'Tipo', align: 'center',
      sortValue: (p) => p.assetClass,
      cell: (p) => (
        <span className="rounded-md bg-bg-2 px-1.5 py-0.5 text-micro font-medium text-text-1">
          {ASSET_BADGE[p.assetClass] ?? p.assetClass}
        </span>
      ),
    },
    {
      key: 'units', header: 'Quantità', align: 'right',
      sortValue: (p) => p.units,
      cell: (p) => <span className="text-text-1">{formatUnits(p.units)}</span>,
    },
    {
      key: 'open', header: 'Prezzo medio', align: 'right',
      sortValue: (p) => p.openPrice,
      cell: (p) => <span className="text-text-1">{formatPrice(p.openPrice)}</span>,
    },
    {
      key: 'last', header: 'Ultimo', align: 'right',
      sortValue: (p) => p.currentPrice ?? 0,
      cell: (p) => (
        <TickValue value={p.currentPrice ?? p.openPrice} className="text-text-0">
          {formatPrice(p.currentPrice ?? p.openPrice)}
        </TickValue>
      ),
    },
    {
      key: 'value', header: 'Valore', align: 'right',
      sortValue: (p) => p.currentValue ?? 0,
      cell: (p) => <span className="font-medium text-text-0">{formatCurrency(fromUsd(p.currentValue ?? 0), displayCurrency)}</span>,
    },
    {
      key: 'pnl', header: 'P&L', align: 'right',
      sortValue: (p) => p.pnl ?? 0,
      cell: (p) => (
        <span className={cn('font-medium', (p.pnl ?? 0) >= 0 ? 'text-gain' : 'text-loss')}>
          {formatSignedCurrency(fromUsd(p.pnl ?? 0), displayCurrency)}
        </span>
      ),
    },
    {
      key: 'pnlpct', header: 'P&L %', align: 'right',
      sortValue: (p) => p.pnlPct ?? 0,
      cell: (p) => <DeltaChip value={p.pnlPct ?? 0} size="sm" />,
    },
    {
      key: 'spark', header: '7g', align: 'right',
      cell: (p) => <Sparkline data={sparkFor(p.instrumentId)} width={60} height={20} />,
    },
  ], [fromUsd, displayCurrency, sparkFor]);

  if (!portfolio) return <Skeleton className="mt-3 h-48 w-full" />;

  return (
    <DataTable
      className="mt-3"
      columns={columns}
      rows={groupedRows}
      rowKey={(p) => p.positionId}
      defaultSortKey="pnl"
      onRowClick={(p) => navigate(`/portfolio?instrument=${p.instrumentId}`)}
      emptyMessage="Nessuna posizione aperta."
    />
  );
}

/* ── Avvisi ────────────────────────────────────────────────────────── */
interface AlertItem {
  id: string;
  timestamp: number;
  text: string;
  kind: 'price' | 'agent' | 'system';
  priceAlert?: PriceAlert;
}

function AlertsCard() {
  const { logs, instruments, priceAlerts, addPriceAlert, removePriceAlert, resetPriceAlert } = useAppData();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newInstrumentId, setNewInstrumentId] = useState(1001);
  const [newThreshold, setNewThreshold] = useState('');
  const [newDirection, setNewDirection] = useState<'above' | 'below'>('above');
  const [newSource, setNewSource] = useState<'etoro' | 'binance'>('etoro');
  const selectedInstrument = instruments.find((instrument) => instrument.instrumentId === newInstrumentId);

  const items = useMemo<AlertItem[]>(() => {
    const fromPriceAlerts: AlertItem[] = priceAlerts.map((alert) => {
      const instrument = instruments.find((item) => item.instrumentId === alert.instrumentId);
      const symbol = instrument?.symbol ?? alert.symbol;
      const direction = alert.direction === 'above' ? 'sopra' : 'sotto';
      return {
        id: alert.id,
        timestamp: alert.triggeredAt ?? alert.createdAt,
        text: `${alert.triggeredAt ? 'Avviso scattato' : 'Avviso attivo'}: ${symbol} ${direction} ${formatPrice(alert.threshold)}${alert.source === 'binance' ? ' · Binance' : ''}`,
        kind: 'price',
        priceAlert: alert,
      };
    });
    const fromLogs: AlertItem[] = logs
      .filter((l) => l.level === 'agent' || l.level === 'error' || (l.level === 'warn' && !l.message.startsWith('Avviso prezzo:')))
      .slice(0, 6)
      .map((l) => ({ id: l.id, timestamp: l.timestamp, text: l.message, kind: l.level === 'agent' ? 'agent' : 'system' }));
    return [...fromPriceAlerts, ...fromLogs].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  }, [instruments, logs, priceAlerts]);

  const KIND_COLOR: Record<AlertItem['kind'], string> = {
    price: 'text-info', agent: 'text-agent', system: 'text-warn',
  };

  return (
    <motion.div {...stagger(6)} className="card-surface density-pad col-span-12 p-5 lg:col-span-4">
      <div className="flex items-center justify-between">
        <h2 className="text-title text-text-0">Avvisi</h2>
        <button
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-1 rounded-lg border border-hairline px-2 py-1 text-micro font-medium text-text-1 transition-colors hover:bg-bg-2"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Nuovo avviso
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((a) => (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-start gap-2.5 rounded-lg border border-hairline bg-bg-0 px-3 py-2"
          >
            <Bell className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', KIND_COLOR[a.kind])} aria-hidden />
            <div className="min-w-0">
              <div className="text-caption text-text-0">{a.text}</div>
              <div className="font-mono text-micro text-text-2">{formatTime(a.timestamp)}</div>
            </div>
            {a.priceAlert && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {a.priceAlert.triggeredAt && (
                  <button
                    type="button"
                    onClick={() => resetPriceAlert(a.priceAlert!.id)}
                    className="rounded-md px-1.5 py-1 text-micro text-info hover:bg-info/10"
                  >
                    Ri-arma
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removePriceAlert(a.priceAlert!.id)}
                  className="rounded-md px-1.5 py-1 text-micro text-text-2 hover:bg-bg-2 hover:text-loss"
                >
                  Elimina
                </button>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDialogOpen(false)}>
          <div
            className="w-full max-w-sm rounded-xl border border-hairline-strong bg-bg-1 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-title text-text-0">Nuovo avviso prezzo</h3>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="overline">Strumento</span>
                <select
                  value={newInstrumentId}
                  onChange={(e) => { const id = Number(e.target.value); const nextInstrument = instruments.find((item) => item.instrumentId === id); setNewInstrumentId(id); if (nextInstrument?.assetClass !== 'crypto' || !externalCryptoSymbol(nextInstrument?.symbol ?? '')) setNewSource('etoro'); }}
                  className="mt-1 w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 text-body text-text-0 outline-none focus:border-hairline-strong"
                >
                  {instruments.map((i) => (
                    <option key={i.instrumentId} value={i.instrumentId}>{i.symbol} — {i.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="overline">Fonte prezzo</span>
                <select
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value as 'etoro' | 'binance')}
                  className="mt-1 w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 text-body text-text-0 outline-none focus:border-hairline-strong"
                >
                  <option value="etoro">eToro · WebSocket</option>
                  <option value="binance" disabled={selectedInstrument?.assetClass !== 'crypto' || !externalCryptoSymbol(selectedInstrument?.symbol ?? '')}>Binance · stream esterno crypto</option>
                </select>
                {newSource === 'binance' && <span className="mt-1 block text-micro text-warn">Prezzo di mercato esterno: non coincide necessariamente con spread e prezzo di esecuzione eToro.</span>}
              </label>
              <label className="block">
                <span className="overline">Soglia prezzo</span>
                <input
                  value={newThreshold}
                  onChange={(e) => setNewThreshold(e.target.value)}
                  placeholder="es. 250"
                  inputMode="decimal"
                  className="mt-1 w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 font-mono text-ticker text-text-0 outline-none placeholder:text-text-2 focus:border-hairline-strong"
                />
              </label>
              <div>
                <span className="overline">Direzione</span>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-hairline bg-bg-3 p-1">
                  {(['above', 'below'] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      onClick={() => setNewDirection(direction)}
                      className={cn(
                        'rounded-md py-1.5 text-caption font-medium transition-colors',
                        newDirection === direction ? 'bg-info/20 text-info' : 'text-text-2 hover:text-text-1',
                      )}
                    >
                      {direction === 'above' ? 'Sopra la soglia' : 'Sotto la soglia'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDialogOpen(false)}
                className="rounded-lg border border-hairline-strong px-3 py-1.5 text-body-strong text-text-1 hover:bg-bg-2"
              >
                Annulla
              </button>
              <button
                onClick={() => {
                  if (newThreshold) {
                    const instrument = instruments.find((item) => item.instrumentId === newInstrumentId);
                    const threshold = Number(newThreshold.replace(',', '.'));
                    if (instrument && Number.isFinite(threshold) && threshold > 0) {
                      addPriceAlert({
                        instrumentId: instrument.instrumentId,
                        symbol: instrument.symbol,
                        source: newSource,
                        direction: newDirection,
                        threshold,
                      });
                    }
                  }
                  setDialogOpen(false);
                  setNewThreshold('');
                }}
                className="rounded-lg bg-gain px-3 py-1.5 text-body-strong text-bg-0 hover:bg-gain/90"
              >
                Crea avviso
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
