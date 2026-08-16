/**
 * DiversificationGauge — gauge radiale SVG (arco 270°, 0–100) con numero
 * display-xl centrale e sub-score come mini-barre orizzontali.
 * Colore: rosso <40, ambra 40–70, verde >70 (design/portfolio.md).
 */
import { motion } from 'framer-motion';
import { Info } from 'lucide-react';
import type { DiversificationScore } from './analytics';

const R = 84;
const STROKE = 12;
const SIZE = 200;
const C = SIZE / 2;
/** Arco da -225° a +45° (270° totali). */
const START_ANGLE = -225;
const SWEEP = 270;

function polar(angleDeg: number, r: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
}

function arcPath(fromDeg: number, toDeg: number, r: number): string {
  const [x1, y1] = polar(fromDeg, r);
  const [x2, y2] = polar(toDeg, r);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function scoreColor(score: number): string {
  if (score < 40) return '#F4556B';
  if (score <= 70) return '#F5A623';
  return '#00C390';
}

function scoreLabel(score: number): string {
  if (score < 40) return 'Bassa';
  if (score <= 70) return 'Media';
  return 'Buona';
}

export function DiversificationGauge({ data }: { data: DiversificationScore }) {
  const color = scoreColor(data.total);
  const trackPath = arcPath(START_ANGLE, START_ANGLE + SWEEP, R);
  const valuePath = arcPath(START_ANGLE, START_ANGLE + (SWEEP * data.total) / 100, R);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-title text-text-0">Score di diversificazione</h2>
        <span
          className="group relative"
          title="Basato su numero di posizioni, settori, classi di attività e concentrazione (HHI)."
        >
            <Info className="h-4 w-4 cursor-help text-text-2 transition-colors hover:text-text-1" aria-hidden />
        </span>
      </div>

      <div className="mt-3 flex justify-center">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
            <path d={trackPath} fill="none" stroke="#FFFFFF14" strokeWidth={STROKE} strokeLinecap="round" />
            <motion.path
              key={valuePath}
              d={valuePath}
              fill="none"
              stroke={color}
              strokeWidth={STROKE}
              strokeLinecap="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
              style={{ filter: `drop-shadow(0 0 6px ${color}55)` }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <motion.span
              className="font-display text-display-xl tabular-nums"
              style={{ color }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.3 }}
            >
              {data.total}
            </motion.span>
            <span className="text-caption text-text-2">Diversificazione · {scoreLabel(data.total)}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        {data.subs.map((s, i) => (
          <div key={s.key} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-caption text-text-1">{s.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-2">
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: scoreColor(s.score) }}
                initial={{ width: 0 }}
                animate={{ width: `${s.score}%` }}
                transition={{ duration: 0.6, delay: 0.3 + i * 0.06, ease: [0.2, 0.8, 0.2, 1] }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-caption tabular-nums text-text-1">{s.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
