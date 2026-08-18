/**
 * RateHero — card hero EUR/USD (design/fx.md Row 1, span 7):
 * tasso gigante mono con tick-flash BLU (colore neutro del modulo),
 * DeltaChip variazione giornaliera, mini stats (Max/Min 24h, Δ7g, Δ30g),
 * sparkline live e caption in italiano ("1 euro = 1,0842 dollari — …").
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { formatFxRate, formatPercent } from '@/lib/format';
import { DeltaChip } from '@/components/shared/DeltaChip';
import { Sparkline } from '@/components/shared/Sparkline';
import { Skeleton } from '@/components/shared/Skeleton';
import type { FxStats } from './useFxData';

/** Flash blu 300ms al cambio del tasso (neutro: non verde/rosso). */
function useBlueFlash(value: number | undefined) {
  const [flash, setFlash] = useState(false);
  const prevRef = useRef(value);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (value == null || prev == null || value === prev) return;
    const raf = requestAnimationFrame(() => setFlash(true));
    const t = setTimeout(() => setFlash(false), 320);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [value]);
  return flash;
}

export function RateHero({ stats }: { stats: FxStats }) {
  const { fxRate, sparkFor, status, getFxInstrumentId, instruments } = useAppData();
  const rate = fxRate?.rate;
  const flash = useBlueFlash(rate);
  const fxInstrumentId = instruments.find((instrument) => instrument.symbol.toUpperCase() === 'EURUSD')?.instrumentId ?? getFxInstrumentId();
  const spark = fxInstrumentId ? sparkFor(fxInstrumentId) : [];

  const strengthening = (fxRate?.changePct ?? 0) >= 0;

  return (
    <div className="card-surface density-pad relative h-full overflow-hidden p-5">
      {/* glow radiale ultra-subtle dietro il numero hero */}
      <div
        className="pointer-events-none absolute -top-24 left-1/4 h-64 w-64 rounded-full opacity-60"
        style={{ background: 'radial-gradient(closest-side, #4C9AFF14, transparent)' }}
        aria-hidden
      />
      <div className="relative">
        <div className="flex items-center justify-between">
          <span className="overline">EUR/USD</span>
          <span className="text-micro text-text-2">
            {status === 'connected' ? 'Live · eToro' : 'Non connesso'}
          </span>
        </div>

        {rate == null ? (
          <Skeleton className="mt-3 h-11 w-48" />
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
            <motion.span
              className={cn(
                'rounded-md px-1 font-display text-display-xl tabular-nums text-text-0 transition-colors duration-300',
                flash && 'bg-[#4C9AFF26]',
              )}
            >
              {formatFxRate(rate)}
            </motion.span>
            <DeltaChip value={fxRate!.changePct} className="mb-1.5" />
          </div>
        )}

        <p className="mt-2 text-caption text-text-1">
          {rate != null
            ? `1 euro = ${formatFxRate(rate)} dollari — EUR in ${strengthening ? 'rafforzamento' : 'indebolimento'} (${formatPercent(fxRate!.changePct, 1)} oggi).`
            : 'In attesa del primo tick…'}
        </p>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <MiniStat label="Max 24h" value={stats.high24h != null ? formatFxRate(stats.high24h) : '—'} />
            <MiniStat label="Min 24h" value={stats.low24h != null ? formatFxRate(stats.low24h) : '—'} />
            <MiniStat
              label="Δ 7g"
              value={stats.change7dPct != null ? formatPercent(stats.change7dPct, 2) : '—'}
              tone={stats.change7dPct == null ? undefined : stats.change7dPct >= 0 ? 'up' : 'down'}
            />
            <MiniStat
              label="Δ 30g"
              value={stats.change30dPct != null ? formatPercent(stats.change30dPct, 2) : '—'}
              tone={stats.change30dPct == null ? undefined : stats.change30dPct >= 0 ? 'up' : 'down'}
            />
          </div>
          {spark.length > 1 && (
            <Sparkline data={spark} width={96} height={32} color="#4C9AFF" live className="shrink-0" />
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-micro text-text-2">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-ticker tabular-nums',
          tone === 'up' ? 'text-gain' : tone === 'down' ? 'text-loss' : 'text-text-0',
        )}
      >
        {value}
      </div>
    </div>
  );
}
