/**
 * PnlHeatmap — calendar-heatmap del P&L mensile (12 celle, scala di intensità
 * verde/rossa, € al hover) + callout mese migliore/peggiore
 * (design/portfolio.md Row 5).
 */
import { motion } from 'framer-motion';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { formatPercent } from '@/lib/format';
import type { MonthPnl } from './analytics';

export function PnlHeatmap({ months, fmtSigned }: { months: MonthPnl[]; fmtSigned: (usd: number) => string }) {
  const maxAbs = Math.max(...months.map((m) => Math.abs(m.pnl)), 0.01);
  const best = months.length ? months.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worst = months.length ? months.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;

  return (
    <div>
      <h2 className="text-title text-text-0">Storico P&L mensile</h2>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {months.map((m, i) => {
          const intensity = 0.12 + (Math.abs(m.pnl) / maxAbs) * 0.55;
          const positive = m.pnl >= 0;
          return (
            <motion.div
              key={m.key}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25, delay: i * 0.03 }}
              title={`${m.label}: ${fmtSigned(m.pnl)} (${formatPercent(m.pct)})`}
              className="flex cursor-default flex-col items-center justify-center rounded-lg border border-hairline px-2 py-3"
              style={{
                backgroundColor: positive
                  ? `rgba(0, 195, 144, ${intensity.toFixed(3)})`
                  : `rgba(244, 85, 107, ${intensity.toFixed(3)})`,
              }}
            >
              <span className="text-micro font-medium uppercase tracking-wide text-text-1">{m.label}</span>
              <span className="mt-0.5 text-caption font-semibold tabular-nums text-text-0">
                {formatPercent(m.pct, 1)}
              </span>
            </motion.div>
          );
        })}
        {months.length === 0 && (
          <p className="col-span-full py-6 text-center text-caption text-text-2">
            Storico non disponibile.
          </p>
        )}
      </div>

      {best && worst && months.length > 1 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-hairline bg-bg-0 px-3 py-2">
            <TrendingUp className="h-4 w-4 shrink-0 text-gain" aria-hidden />
            <span className="text-caption text-text-1">
              Mese migliore: <span className="font-medium capitalize text-text-0">{best.label}</span>
              {' · '}<span className="tabular-nums text-gain">{fmtSigned(best.pnl)}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-hairline bg-bg-0 px-3 py-2">
            <TrendingDown className="h-4 w-4 shrink-0 text-loss" aria-hidden />
            <span className="text-caption text-text-1">
              Mese peggiore: <span className="font-medium capitalize text-text-0">{worst.label}</span>
              {' · '}<span className="tabular-nums text-loss">{fmtSigned(worst.pnl)}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
