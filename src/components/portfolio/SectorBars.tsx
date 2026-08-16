/**
 * SectorBars — allocazione per settore come lista di barre orizzontali
 * animate; sopra il 25% marker ambra sul bordo destro + tooltip
 * "Settore sopra soglia di concentrazione." (design/portfolio.md Row 3).
 */
import { motion } from 'framer-motion';
import { TriangleAlert } from 'lucide-react';
import type { AllocationSlice } from './analytics';

const THRESHOLD = 0.25;

const BAR_COLORS = ['#4C9AFF', '#9B8CFF', '#4CC9F0', '#F5A623', '#A3E635', '#E879F9', '#5C6B7A'];

export function SectorBars({ slices, fmtValue }: { slices: AllocationSlice[]; fmtValue: (usd: number) => string }) {
  const max = Math.max(...slices.map((s) => s.weight), 0.01);
  return (
    <div>
      <h2 className="text-title text-text-0">Allocazione per settore</h2>
      <div className="mt-4 space-y-3">
        {slices.map((s, i) => {
          const over = s.weight > THRESHOLD;
          return (
            <div key={s.key} className="group">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-body text-text-1">
                  <span className="truncate">{s.label}</span>
                  {over && (
                    <span title="Settore sopra soglia di concentrazione.">
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0 cursor-help text-warn" aria-hidden />
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-caption tabular-nums text-text-2">
                  <span className="text-body-strong text-text-0">
                    {(s.weight * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%
                  </span>
                  {' · '}{fmtValue(s.value)}
                </span>
              </div>
              <div className="relative h-2 overflow-hidden rounded-full bg-bg-2">
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                    boxShadow: over ? 'inset -3px 0 0 0 #F5A623' : undefined,
                  }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(s.weight / max) * 100}%` }}
                  transition={{ duration: 0.6, delay: i * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
