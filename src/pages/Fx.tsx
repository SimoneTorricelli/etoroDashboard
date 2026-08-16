/**
 * FX — Cambio EUR/USD (/fx) — design/fx.md.
 * ROW 1: Rate hero (span 7) + Il tuo impatto (span 5)
 * ROW 2: Grafico con bande target (span 8) + Advisor "Quando prelevare" (span 4)
 * ROW 3: Calcolatore conversione (span 6) + Avvisi di cambio (span 6)
 * ROW 4: Guida rapida (span 12)
 * Accento del modulo: blu (info). UI in italiano.
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import { Toaster } from 'sonner';
import { useAppData } from '@/lib/data/store';
import { cn } from '@/lib/utils';
import { RateHero } from '@/components/fx/RateHero';
import { ImpactCard } from '@/components/fx/ImpactCard';
import { FxChart } from '@/components/fx/FxChart';
import { AdvisorCard } from '@/components/fx/AdvisorCard';
import { ConversionCalculator } from '@/components/fx/ConversionCalculator';
import { FxAlerts } from '@/components/fx/FxAlerts';
import { FxGuide } from '@/components/fx/FxGuide';
import { FX_TIMEFRAMES, useFxBands, useFxHistory } from '@/components/fx/useFxData';
import type { FxTimeframe } from '@/components/fx/useFxData';

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

export default function Fx() {
  const { fxRate } = useAppData();
  const [timeframe, setTimeframe] = useState<FxTimeframe>('3M');
  const { candles, stats } = useFxHistory(timeframe);
  const { target, upper, setTarget, setUpperBand } = useFxBands();

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* Header pagina */}
      <motion.div {...stagger(0)} className="col-span-12 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-display-lg text-text-0">Cambio EUR/USD</h1>
          <p className="mt-1 text-caption text-text-1">
            Monitora il tasso, calcola i costi di conversione e decidi quando prelevare in euro.
          </p>
        </div>
      </motion.div>

      {/* ROW 1 — Hero + Impatto */}
      <motion.div {...stagger(1)} className="col-span-12 lg:col-span-7">
        <RateHero stats={stats} />
      </motion.div>
      <motion.div {...stagger(2)} className="col-span-12 lg:col-span-5">
        <ImpactCard />
      </motion.div>

      {/* ROW 2 — Grafico + Advisor */}
      <motion.div {...stagger(3)} className="card-surface density-pad col-span-12 p-5 lg:col-span-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-title text-text-0">Storico EUR/USD</h2>
          <div className="flex gap-1 rounded-lg border border-hairline bg-bg-3 p-0.5">
            {FX_TIMEFRAMES.map((tf) => (
              <button
                key={tf.key}
                onClick={() => setTimeframe(tf.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-micro font-medium transition-colors',
                  timeframe === tf.key ? 'bg-info/20 text-info' : 'text-text-2 hover:text-text-1',
                )}
                aria-pressed={timeframe === tf.key}
              >
                {tf.key}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <FxChart
            candles={candles}
            liveRate={fxRate?.rate ?? null}
            target={target}
            upper={upper}
            onTargetChange={setTarget}
            onUpperChange={setUpperBand}
          />
        </div>
      </motion.div>
      <motion.div {...stagger(4)} className="col-span-12 lg:col-span-4">
        <AdvisorCard stats={stats} target={target} />
      </motion.div>

      {/* ROW 3 — Calcolatore + Avvisi */}
      <motion.div {...stagger(5)} className="col-span-12 lg:col-span-6">
        <ConversionCalculator stats={stats} />
      </motion.div>
      <motion.div {...stagger(6)} className="col-span-12 lg:col-span-6">
        <FxAlerts />
      </motion.div>

      {/* ROW 4 — Guida */}
      <motion.div {...stagger(7)} className="col-span-12">
        <FxGuide />
      </motion.div>

      {/* Toaster locale per gli avvisi di cambio (nessun Toaster globale nella shell) */}
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
