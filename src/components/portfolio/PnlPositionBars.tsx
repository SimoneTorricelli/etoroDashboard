/**
 * PnlPositionBars — bar chart divergente orizzontale del P&L per posizione:
 * verde a destra / rosso a sinistra dell'asse centrale, ordinato discendente.
 * Tooltip al hover con € e % (design/portfolio.md Row 3).
 */
import { motion } from 'framer-motion';
import { formatPercent } from '@/lib/format';
import type { PositionRow } from './analytics';

export function PnlPositionBars({ rows, fmtSigned }: { rows: PositionRow[]; fmtSigned: (usd: number) => string }) {
  const sorted = [...rows].sort((a, b) => b.pnlUsd - a.pnlUsd);
  const maxAbs = Math.max(...sorted.map((r) => Math.abs(r.pnlUsd)), 0.01);

  return (
    <div>
      <h2 className="text-title text-text-0">P&L per posizione</h2>
      <div className="mt-4 space-y-2">
        {sorted.map((r, i) => {
          const positive = r.pnlUsd >= 0;
          const half = (Math.abs(r.pnlUsd) / maxAbs) * 50; // % di metà riga
          return (
            <div key={r.positionId} className="group flex items-center gap-2" title={`${r.name}: ${fmtSigned(r.pnlUsd)} (${formatPercent(r.pnlPctValue)})`}>
              <span className="w-14 shrink-0 truncate font-mono text-ticker text-text-1">{r.symbol}</span>
              <div className="relative h-5 flex-1">
                {/* asse centrale */}
                <div className="absolute left-1/2 top-0 h-full w-px bg-hairline-strong" aria-hidden />
                <motion.div
                  className="absolute top-0.5 h-4 rounded-sm"
                  style={{
                    backgroundColor: positive ? '#00C390' : '#F4556B',
                    left: positive ? '50%' : `${50 - half}%`,
                  }}
                  initial={{ width: 0 }}
                  animate={{ width: `${half}%` }}
                  transition={{ duration: 0.6, delay: i * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
                />
              </div>
              <motion.span
                className="w-24 shrink-0 text-right text-caption tabular-nums"
                style={{ color: positive ? '#00C390' : '#F4556B' }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 + i * 0.04, duration: 0.25 }}
              >
                {fmtSigned(r.pnlUsd)}
              </motion.span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
