/**
 * BacktestCard — "Simula una regola sui dati storici" (design/agent.md, Row 4).
 * Card collassabile: scelta regola + periodo (6M/1A), esecuzione sulle candele
 * giornaliere, equity line vs buy&hold (dashed) e stat chips con disclaimer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { ChevronDown, FlaskConical, Play } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatCurrency, formatPercent, formatSignedCurrency } from '@/lib/format';
import { useAppData } from '@/lib/data/store';
import type { AgentRule } from '@/lib/data/types';
import type { BacktestResult, SlTp } from './agent-utils';
import { runBacktest } from './agent-utils';

export interface BacktestCardProps {
  rules: AgentRule[];
  sltpMap: Record<string, SlTp>;
  capitalLimitFor: (rule: AgentRule) => number;
}

const PERIODS = [
  { key: '6M', days: 180 },
  { key: '1A', days: 365 },
] as const;

export function BacktestCard({ rules, sltpMap, capitalLimitFor }: BacktestCardProps) {
  const { getCandles, fromUsd, displayCurrency } = useAppData();
  const [open, setOpen] = useState(false);
  const [ruleId, setRuleId] = useState<string>('');
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('6M');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);

  const selectedRule = useMemo(
    () => rules.find((r) => r.id === ruleId) ?? rules[0] ?? null,
    [rules, ruleId],
  );

  const run = async () => {
    if (!selectedRule || running) return;
    setRunning(true);
    setResult(null);
    try {
      const days = PERIODS.find((p) => p.key === period)!.days;
      const entries = await Promise.all(
        selectedRule.instrumentIds.map(
          async (iid) => [iid, await getCandles(iid, 'OneDay', Math.min(days, 1000))] as const,
        ),
      );
      const map = new Map(entries);
      const sltp = sltpMap[selectedRule.id] ?? { stopLossPct: 8, takeProfitPct: 15 };
      setResult(runBacktest(selectedRule, sltp, map, capitalLimitFor(selectedRule)));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="card-surface density-pad col-span-12 p-5">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left">
          <span className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-agent" aria-hidden />
            <h2 className="text-title text-text-0">Simula una regola sui dati storici</h2>
          </span>
          <ChevronDown
            className={cn('h-4 w-4 text-text-2 transition-transform duration-200', open && 'rotate-180')}
            aria-hidden
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Select value={selectedRule?.id ?? ''} onValueChange={setRuleId}>
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder="Scegli una regola" />
              </SelectTrigger>
              <SelectContent>
                {rules.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex rounded-lg border border-hairline bg-bg-0 p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
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
            <button
              type="button"
              onClick={run}
              disabled={!selectedRule || running}
              className="relative flex items-center gap-1.5 overflow-hidden rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {running ? 'Simulazione…' : 'Esegui simulazione'}
              {running && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-bg-0/60" aria-hidden />
              )}
            </button>
          </div>

          {result && selectedRule && (
            <div className="mt-4">
              <BacktestChart result={result} fromUsd={fromUsd} />
              <div className="mt-3 flex flex-wrap gap-2">
                <StatChip label="Ordini simulati" value={String(result.orders)} />
                <StatChip
                  label="P&L simulato"
                  value={formatSignedCurrency(fromUsd(result.pnl), displayCurrency)}
                  tone={result.pnl >= 0 ? 'pos' : 'neg'}
                />
                <StatChip
                  label="Max drawdown"
                  value={formatPercent(-result.maxDrawdownPct, 1, false)}
                  tone={result.maxDrawdownPct > 15 ? 'neg' : 'neutral'}
                />
                <StatChip label="Vincenti / Perdenti" value={`${result.wins} / ${result.losses}`} />
                <StatChip
                  label="Capitale impiegato max"
                  value={formatCurrency(fromUsd(result.investedTotal), displayCurrency, 0)}
                />
              </div>
              <p className="mt-3 text-caption text-text-2">
                Simulazione indicativa su dati storici — non garantisce risultati futuri.
              </p>
            </div>
          )}
          {!result && !running && (
            <p className="mt-4 text-caption text-text-2">
              Scegli una regola e un periodo: la simulazione valuta la condizione giorno per giorno
              sulle candele storiche e applica SL/TP della regola.
            </p>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function StatChip({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'pos' | 'neg' | 'neutral' }) {
  return (
    <span className="flex items-center gap-2 rounded-lg border border-hairline bg-bg-2 px-3 py-1.5">
      <span className="text-micro text-text-2">{label}</span>
      <span
        className={cn(
          'font-mono text-ticker tabular-nums',
          tone === 'pos' ? 'text-gain' : tone === 'neg' ? 'text-loss' : 'text-text-0',
        )}
      >
        {value}
      </span>
    </span>
  );
}

function BacktestChart({ result, fromUsd }: { result: BacktestResult; fromUsd(n: number): number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const eqRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bhRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: 220,
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
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      eqRef.current = null;
      bhRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || result.equity.length < 2) return;
    if (eqRef.current) chart.removeSeries(eqRef.current);
    if (bhRef.current) chart.removeSeries(bhRef.current);

    const eq = chart.addSeries(LineSeries, { color: '#9B8CFF', lineWidth: 2 });
    eq.setData(result.equity.map((p) => ({ time: p.time as UTCTimestamp, value: fromUsd(p.value) })));
    const bh = chart.addSeries(LineSeries, { color: '#5C6B7A', lineWidth: 1, lineStyle: 2 });
    bh.setData(result.buyHold.map((p) => ({ time: p.time as UTCTimestamp, value: fromUsd(p.value) })));
    eqRef.current = eq;
    bhRef.current = bh;
    chart.timeScale().fitContent();
  }, [result, fromUsd]);

  return (
    <div>
      <div className="mb-1 flex items-center gap-4 text-micro text-text-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-agent" aria-hidden /> Equity regola
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-4 border-t border-dashed border-text-2" aria-hidden /> Buy &amp; hold
        </span>
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
