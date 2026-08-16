/**
 * ImpactCard — "Il tuo impatto" (design/fx.md Row 1, span 5):
 * esposizione USD del portfolio convertita in EUR al tasso live,
 * due scenari rapidi (tasso ±2% su livelli tondi) e tabella sensitività ±5%.
 * Stato vuoto: "Nessuna esposizione USD rilevata" (la pagina resta usabile).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { formatCurrency, formatFxRate, formatSignedCurrency } from '@/lib/format';

/** Tween 400ms sui numeri al cambio del tasso (design/fx.md). */
function useTween(target: number, duration = 400): number {
  const [value, setValue] = useState(target);
  const prevRef = useRef(target);
  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = target;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

const SCENARIOS = [-0.05, -0.025, 0, 0.025, 0.05];

export function ImpactCard() {
  const navigate = useNavigate();
  const { portfolio, fxRate } = useAppData();
  const rate = fxRate?.rate ?? null;
  const usdExposure = portfolio?.totalValue ?? 0;

  const eurNow = rate ? usdExposure / rate : 0;
  const tweenedEur = useTween(eurNow);

  if (!portfolio || usdExposure <= 0 || rate == null) {
    return (
      <div className="card-surface density-pad flex h-full flex-col p-5">
        <span className="overline">Il tuo impatto</span>
        <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
          <p className="font-display text-display-md text-text-0">Nessuna esposizione USD rilevata</p>
          <p className="mt-2 max-w-xs text-caption text-text-1">
            Quando colleghi un portfolio con saldo in USD, qui vedi quanto vale in euro ai vari tassi di cambio.
          </p>
        </div>
      </div>
    );
  }

  /* Livelli tondi ±2% per le due righe rapide (es. 1,10 / 1,06) */
  const upLevel = Math.round(rate * 1.02 * 100) / 100;
  const downLevel = Math.round(rate * 0.98 * 100) / 100;
  const eurAt = (r: number) => usdExposure / r;

  return (
    <div className="card-surface density-pad flex h-full flex-col p-5">
      <div className="flex items-center justify-between">
        <span className="overline">Il tuo impatto</span>
        <button
          onClick={() => navigate('/portfolio')}
          className="flex items-center gap-1 text-caption text-info transition-colors hover:text-info/80"
        >
          Vedi esposizione completa <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <p className="mt-3 text-body text-text-1">
        Hai <span className="font-semibold text-text-0 tabular-nums">{formatCurrency(tweenedEur, 'EUR')}</span> equivalenti
        esposti in USD ({formatCurrency(usdExposure, 'USD', 0)} al cambio attuale).
      </p>

      <div className="mt-3 space-y-2">
        <ScenarioRow
          icon={<TrendingUp className="h-4 w-4 text-loss" aria-hidden />}
          text={`Se EUR/USD sale a ${formatFxRate(upLevel, 2)} → il tuo controvalore EUR scende di ~${formatCurrency(Math.abs(eurAt(upLevel) - eurNow), 'EUR', 0)}`}
          tone="down"
        />
        <ScenarioRow
          icon={<TrendingDown className="h-4 w-4 text-gain" aria-hidden />}
          text={`Se scende a ${formatFxRate(downLevel, 2)} → sale di ~${formatCurrency(Math.abs(eurAt(downLevel) - eurNow), 'EUR', 0)}`}
          tone="up"
        />
      </div>

      {/* Tabella sensitività ±5% */}
      <div className="mt-4 overflow-hidden rounded-lg border border-hairline">
        <table className="w-full text-caption">
          <thead>
            <tr className="bg-bg-2 text-left text-micro text-text-2">
              <th className="px-3 py-1.5 font-medium">Scenario</th>
              <th className="px-3 py-1.5 text-right font-medium">Tasso</th>
              <th className="px-3 py-1.5 text-right font-medium">Valore in EUR</th>
              <th className="hidden px-3 py-1.5 text-right font-medium sm:table-cell">Δ vs oggi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {SCENARIOS.map((d) => {
              const r = rate * (1 + d);
              const eur = eurAt(r);
              const diff = eur - eurNow;
              const isNow = d === 0;
              return (
                <tr key={d} className={cn('tabular-nums', isNow && 'bg-bg-2/60')}>
                  <td className="px-3 py-1.5 text-text-1">
                    {isNow ? 'Attuale' : `EUR/USD ${d > 0 ? '+' : ''}${(d * 100).toFixed(1).replace('.', ',')}%`}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-text-0">{formatFxRate(r)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-text-0">{formatCurrency(eur, 'EUR', 0)}</td>
                  <td
                    className={cn(
                      'hidden px-3 py-1.5 text-right sm:table-cell',
                      isNow ? 'text-text-2' : diff > 0 ? 'text-gain' : 'text-loss',
                    )}
                  >
                    {isNow ? '—' : formatSignedCurrency(diff, 'EUR', 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScenarioRow({ icon, text, tone }: { icon: React.ReactNode; text: string; tone: 'up' | 'down' }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-caption',
        tone === 'up' ? 'border-gain/20 bg-gain-dim text-text-0' : 'border-loss/20 bg-loss-dim text-text-0',
      )}
    >
      {icon}
      <span className="tabular-nums">{text}</span>
    </div>
  );
}
