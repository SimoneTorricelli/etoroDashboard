/**
 * AdvisorCard — "Quando prelevare" (design/fx.md Row 2, span 4):
 * verdetto (favorevole/neutro/sconsigliato) da withdrawalAdvisor(@/lib/fx),
 * max 3 bullet con numeri reali (tasso vs media 90g, trend 30g, vs target,
 * costo conversione) e box strategia suggerita.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, CircleAlert, CircleMinus, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { conversionCostPct, withdrawalAdvisor } from '@/lib/fx';
import type { WithdrawalVerdict } from '@/lib/fx';
import { formatFxRate, formatPercent } from '@/lib/format';
import { Skeleton } from '@/components/shared/Skeleton';
import type { FxStats } from './useFxData';

const VERDICT_UI: Record<WithdrawalVerdict, { label: string; icon: typeof CheckCircle2; ring: string; text: string; bg: string }> = {
  favorable: {
    label: 'Momento favorevole',
    icon: CheckCircle2,
    ring: 'border-gain/50',
    text: 'text-gain',
    bg: 'bg-gain-dim',
  },
  neutral: {
    label: 'Neutro — attendi',
    icon: CircleMinus,
    ring: 'border-warn/50',
    text: 'text-warn',
    bg: 'bg-[#F5A62314]',
  },
  unfavorable: {
    label: 'Sconsigliato ora',
    icon: CircleAlert,
    ring: 'border-loss/50',
    text: 'text-loss',
    bg: 'bg-loss-dim',
  },
};

export function AdvisorCard({ stats, target }: { stats: FxStats; target: number }) {
  const { fxRate } = useAppData();

  if (!fxRate) {
    return (
      <div className="card-surface density-pad h-full p-5">
        <span className="overline">Quando prelevare</span>
        <Skeleton className="mt-4 h-16 w-full" />
        <Skeleton className="mt-3 h-4 w-3/4" />
        <Skeleton className="mt-2 h-4 w-2/3" />
      </div>
    );
  }

  const advice = withdrawalAdvisor(fxRate, target);
  const ui = VERDICT_UI[advice.verdict];
  const Icon = ui.icon;

  /* Bullet motivazionali (max 3, numeri reali) */
  const bullets: string[] = [];
  if (stats.mean90 != null) {
    const diffPct = ((fxRate.rate - stats.mean90) / stats.mean90) * 100;
    bullets.push(
      `Il cambio è ${formatPercent(Math.abs(diffPct), 1).replace('+', '')} ${diffPct >= 0 ? 'sopra' : 'sotto'} la media a 90 giorni (${formatFxRate(stats.mean90)}).`,
    );
  }
  if (stats.change30dPct != null) {
    bullets.push(
      `Trend 30g: EUR in ${stats.change30dPct >= 0 ? 'rafforzamento' : 'indebolimento'} (${formatPercent(stats.change30dPct, 1)}).`,
    );
  }
  const aboveTarget = fxRate.rate > target;
  bullets.push(
    aboveTarget
      ? `Sei sopra la tua soglia target di ${formatFxRate(target, 2)}: ogni dollaro convertito vale meno euro.`
      : `Sei sotto la tua soglia target di ${formatFxRate(target, 2)}: conversione vantaggiosa.`,
  );

  const costPct = conversionCostPct(fxRate.rate);
  const strategy =
    advice.verdict === 'favorable'
      ? `Strategia suggerita: converti a tranche — es. 50% ora, il resto se il cambio scende ancora. Costo stimato ~${costPct.toFixed(2).replace('.', ',')}% per conversione.`
      : advice.verdict === 'neutral'
        ? `Strategia suggerita: converti a tranche — es. 25% ora, il resto a target ${formatFxRate(target, 2)} con avviso automatico.`
        : `Strategia suggerita: attendi e imposta un avviso a ${formatFxRate(target, 2)} — convertire ora costa ~${costPct.toFixed(2).replace('.', ',')}% più un cambio sfavorevole.`;

  return (
    <div className="card-surface density-pad flex h-full flex-col p-5">
      <span className="overline">Quando prelevare</span>

      <AnimatePresence mode="wait">
        <motion.div
          key={advice.verdict}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.3 }}
          className={cn('mt-3 flex items-center gap-3 rounded-xl border-2 px-4 py-3', ui.ring, ui.bg)}
        >
          <Icon className={cn('h-6 w-6 shrink-0', ui.text)} aria-hidden />
          <div>
            <div className={cn('font-display text-title', ui.text)}>{ui.label}</div>
            <div className="text-caption text-text-1">{advice.detail}</div>
          </div>
        </motion.div>
      </AnimatePresence>

      <ul className="mt-4 space-y-2">
        {bullets.slice(0, 3).map((b, i) => (
          <motion.li
            key={b}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.24, delay: i * 0.06 }}
            className="flex items-start gap-2 text-caption text-text-1"
          >
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-info" aria-hidden />
            <span className="tabular-nums">{b}</span>
          </motion.li>
        ))}
      </ul>

      <div className="mt-auto pt-4">
        <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info/10 px-3 py-2.5">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
          <p className="text-caption text-text-0">{strategy}</p>
        </div>
      </div>
    </div>
  );
}
