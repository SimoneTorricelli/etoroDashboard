/**
 * DiversificationGauge — gauge radiale SVG (arco 270°, 0–100) con numero
 * display-xl centrale e sub-score come mini-barre orizzontali.
 * Colore: rosso <40, ambra 40–70, verde >70 (design/portfolio.md).
 */
import { motion } from 'framer-motion';
import { Info } from 'lucide-react';
import type { DiversificationScore } from './analytics';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

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
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Come viene calcolato lo score di diversificazione" className="rounded-md p-1 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-1"><Info className="h-4 w-4" aria-hidden /></button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 border-hairline bg-bg-1 text-text-1">
            <h3 className="text-body-strong text-text-0">Come leggiamo lo score</h3>
            <p className="mt-1 text-caption leading-relaxed text-text-2">Media semplice di cinque sub-score. Ogni distribuzione usa il numero effettivo di categorie derivato dall’indice HHI; le posizioni dei copy portfolio sono scomposte e unite per strumento.</p>
            <p className="mt-2 rounded-md bg-bg-0 px-2.5 py-2 text-micro leading-relaxed text-text-2"><span className="font-medium text-text-1">Le barre non sono percentuali di dati disponibili.</span> Indicano quanto il capitale è distribuito: Geografia a 100 richiede una ripartizione equilibrata tra circa quattro aree; se il portafoglio è soprattutto USA/USD la barra resta bassa anche quando tutti i dati sono presenti. Quando il Paese non è esposto da eToro, l’area viene stimata dalla valuta di quotazione.</p>
            <div className="mt-3 flex items-center justify-between text-caption"><span>Formula</span><span className="font-mono text-text-0">{data.formulaVersion}</span></div>
            <div className="mt-1 flex items-center justify-between text-caption"><span>Capitale con settore classificato</span><span className="font-mono text-text-0">{data.classifiedCoveragePct}%</span></div>
            <div className="mt-3 border-t border-hairline pt-2"><p className="text-micro uppercase tracking-[0.05em] text-text-2">Fattori che riducono lo score</p><ul className="mt-1.5 space-y-1 text-caption">{data.factors.map((factor) => <li key={factor}>• {factor}</li>)}</ul></div>
          </PopoverContent>
        </Popover>
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
