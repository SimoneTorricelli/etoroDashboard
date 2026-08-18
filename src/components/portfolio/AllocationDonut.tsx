/**
 * AllocationDonut — donut SVG con segmenti animati (sweep 700ms, stagger 80ms),
 * totale al centro, legenda con % e valore; hover evidenzia riga + segmento,
 * click sul segmento/riga → filtro (onSelect).
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface DonutSlice {
  key: string;
  label: string;
  /** Peso 0–1. */
  weight: number;
  /** Valore già formattato per la legenda. */
  valueLabel: string;
  color: string;
}

export interface AllocationDonutProps {
  title: string;
  slices: DonutSlice[];
  /** Testo centrale (totale formattato). */
  centerValue: string;
  centerLabel?: string;
  /** Chiave attualmente selezionata (filtro attivo). */
  selectedKey?: string | null;
  onSelect?: (key: string | null) => void;
}

const R = 70;
const STROKE = 26;
const SIZE = 180;
const C = SIZE / 2;
const CIRC = 2 * Math.PI * R;

export function AllocationDonut({ title, slices, centerValue, centerLabel, selectedKey, onSelect }: AllocationDonutProps) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const positive = slices.filter((slice) => Number.isFinite(slice.weight) && slice.weight > 0);
  const totalWeight = positive.reduce((sum, slice) => sum + slice.weight, 0);
  const segs = positive.map((slice, index) => {
    const normalizedWeight = totalWeight > 0 ? slice.weight / totalWeight : 0;
    const start = totalWeight > 0 ? positive.slice(0, index).reduce((sum, previous) => sum + previous.weight / totalWeight, 0) : 0;
    return { ...slice, displayWeight: slice.weight, weight: normalizedWeight, start };
  });

  const handleSelect = (key: string) => {
    if (!onSelect) return;
    onSelect(selectedKey === key ? null : key);
  };

  return (
    <div>
      <h2 className="text-title text-text-0">{title}</h2>
      <div className="mt-3 flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90" aria-hidden>
            <circle cx={C} cy={C} r={R} fill="none" stroke="#FFFFFF0A" strokeWidth={STROKE} />
            {segs.map((s, i) => {
              const frac = Math.max(0, s.weight - (segs.length > 1 ? 0.004 : 0));
              const active = hoverKey === s.key || selectedKey === s.key;
              return (
                <motion.circle
                  key={s.key}
                  cx={C}
                  cy={C}
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={active ? STROKE + 5 : STROKE}
                  strokeDashoffset={-s.start * CIRC}
                  initial={{ strokeDasharray: `0 ${CIRC}` }}
                  animate={{ strokeDasharray: `${frac * CIRC} ${CIRC}` }}
                  transition={{ duration: 0.7, delay: i * 0.08, ease: [0.2, 0.8, 0.2, 1] }}
                  style={{ cursor: onSelect ? 'pointer' : 'default', transition: 'stroke-width 150ms' }}
                  onMouseEnter={() => setHoverKey(s.key)}
                  onMouseLeave={() => setHoverKey(null)}
                  onClick={() => handleSelect(s.key)}
                />
              );
            })}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-display text-[20px] font-semibold tabular-nums text-text-0">{centerValue}</span>
            {centerLabel && <span className="text-micro text-text-2">{centerLabel}</span>}
          </div>
        </div>

        <ul className="w-full min-w-0 flex-1 space-y-1">
          {segs.map((s) => {
            const active = hoverKey === s.key || selectedKey === s.key;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => handleSelect(s.key)}
                  onMouseEnter={() => setHoverKey(s.key)}
                  onMouseLeave={() => setHoverKey(null)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150',
                    active ? 'bg-bg-2' : 'hover:bg-bg-2/60',
                    selectedKey === s.key && 'ring-1 ring-hairline-strong',
                  )}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body text-text-1">{s.label}</span>
                  <span className="text-body-strong tabular-nums text-text-0">{(s.displayWeight * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%</span>
                  <span className="w-20 text-right text-caption tabular-nums text-text-2">{s.valueLabel}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
