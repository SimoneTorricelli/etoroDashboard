/**
 * ConversionCalculator — "Calcolatore USD → EUR" (design/fx.md Row 3, span 6):
 * importo USD (quick chips + "Usa il mio saldo USD"), tasso editabile
 * (default live), costo eToro in pips (slider 50–150, DEFAULT_CONVERSION_PIPS
 * come base; conversionCostPct per la %). Output: EUR netti, costo €/%,
 * confronto vs media 30g.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { conversionCostPct, convertUsdToEur, DEFAULT_CONVERSION_PIPS } from '@/lib/fx';
import { formatCurrency, formatFxRate, formatNumber } from '@/lib/format';
import { Slider } from '@/components/ui/slider';
import type { FxStats } from './useFxData';

const QUICK_AMOUNTS = [500, 1000, 5000];

/** Tween 300ms sugli output a ogni cambio input (design/fx.md). */
function useTween(target: number, duration = 300): number {
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

function parseItalianNumber(raw: string): number | null {
  const s = raw.trim().replace(/\./g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function ConversionCalculator({ stats }: { stats: FxStats }) {
  const { fxRate, portfolio } = useAppData();
  const liveRate = fxRate?.rate ?? null;

  const [amountRaw, setAmountRaw] = useState('1.000');
  const [rateRaw, setRateRaw] = useState<string | null>(null); // null = segui il live
  const [pips, setPips] = useState(100);

  const amount = parseItalianNumber(amountRaw) ?? 0;
  const rate = rateRaw != null ? (parseItalianNumber(rateRaw) ?? liveRate ?? 1.09) : (liveRate ?? 1.09);

  const quote = useMemo(() => convertUsdToEur(amount, rate, pips), [amount, rate, pips]);
  const netEur = useTween(quote.netAmount);
  const feeEur = useTween(quote.fee);
  const costPct = conversionCostPct(rate, pips);

  /* Confronto vs media 30g: tasso più basso = più euro per gli stessi USD */
  const vsMean30 = useMemo(() => {
    if (stats.mean30 == null || amount <= 0) return null;
    const eurAtMean = amount / stats.mean30;
    return quote.grossAmount - eurAtMean; // >0 → convertendo oggi ricevi di più
  }, [stats.mean30, amount, quote.grossAmount]);

  const useCash = () => {
    if (portfolio) setAmountRaw(formatNumber(portfolio.cash, 2));
  };

  return (
    <div className="card-surface density-pad flex h-full flex-col p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-title text-text-0">Calcolatore USD → EUR</h2>
        {portfolio && portfolio.cash > 0 && (
          <button
            onClick={useCash}
            className="flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-micro text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
          >
            <Wallet className="h-3 w-3" aria-hidden />
            Usa il mio saldo USD
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {/* Importo USD */}
        <div>
          <label htmlFor="fx-amount" className="text-label text-text-1">Importo in USD</label>
          <div className="relative mt-1.5">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-ticker text-text-2">$</span>
            <input
              id="fx-amount"
              inputMode="decimal"
              value={amountRaw}
              onChange={(e) => setAmountRaw(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-bg-3 py-2 pl-7 pr-3 font-mono text-ticker text-text-0 outline-none transition-colors focus:border-hairline-strong focus:ring-1 focus:ring-info/40"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK_AMOUNTS.map((a) => (
              <button
                key={a}
                onClick={() => setAmountRaw(formatNumber(a, 0))}
                className="rounded-full border border-hairline px-2.5 py-1 font-mono text-micro text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                ${formatNumber(a, 0)}
              </button>
            ))}
            <button
              onClick={useCash}
              className="rounded-full border border-hairline px-2.5 py-1 text-micro text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
            >
              Tutto
            </button>
          </div>
        </div>

        {/* Tasso */}
        <div>
          <label htmlFor="fx-rate" className="text-label text-text-1">Tasso EUR/USD</label>
          <div className="relative mt-1.5">
            <input
              id="fx-rate"
              inputMode="decimal"
              value={rateRaw ?? (liveRate != null ? formatFxRate(liveRate) : '')}
              onChange={(e) => setRateRaw(e.target.value)}
              placeholder="—"
              className="w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 font-mono text-ticker text-text-0 outline-none transition-colors focus:border-hairline-strong focus:ring-1 focus:ring-info/40"
            />
            {rateRaw != null && (
              <button
                onClick={() => setRateRaw(null)}
                title="Torna al tasso live"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-2 transition-colors hover:bg-bg-2 hover:text-info"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
          <p className="mt-2 text-micro text-text-2">
            {rateRaw == null ? 'Tasso live in tempo reale.' : 'Tasso personalizzato — clicca ↺ per tornare al live.'}
          </p>
        </div>
      </div>

      {/* Pips */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <label className="text-label text-text-1">Commissione eToro</label>
          <span className="font-mono text-ticker text-info tabular-nums">{pips} pips</span>
        </div>
        <Slider
          value={[pips]}
          onValueChange={([v]) => setPips(v)}
          min={50}
          max={150}
          step={5}
          className="mt-3"
          aria-label="Commissione in pips"
        />
        <p className="mt-1.5 text-micro text-text-2">
          eToro applica tipicamente 50–150 pips sulla conversione (base: {DEFAULT_CONVERSION_PIPS} pips).
        </p>
      </div>

      {/* Output */}
      <div className="mt-4 rounded-lg bg-bg-2 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-micro text-text-2">Ricevi in EUR</div>
            <div className="mt-1 font-display text-display-md tabular-nums text-text-0">
              {formatCurrency(netEur, 'EUR')}
            </div>
          </div>
          <div className="text-right">
            <div className="text-micro text-text-2">Costo di conversione</div>
            <div className="mt-1 text-body-strong tabular-nums text-loss">
              −{formatCurrency(feeEur, 'EUR')} ({formatNumber(costPct, 2)}%)
            </div>
            <div className="text-micro text-text-2">tasso effettivo {formatFxRate(quote.effectiveRate)}</div>
          </div>
        </div>
        {vsMean30 != null && (
          <p className={cn('mt-3 border-t border-hairline pt-3 text-caption tabular-nums', vsMean30 >= 0 ? 'text-gain' : 'text-loss')}>
            {vsMean30 >= 0
              ? `Convertendo oggi risparmi ~${formatCurrency(Math.abs(vsMean30), 'EUR')} rispetto alla media del mese scorso.`
              : `Convertendo oggi perdi ~${formatCurrency(Math.abs(vsMean30), 'EUR')} rispetto alla media del mese scorso.`}
          </p>
        )}
      </div>
    </div>
  );
}
