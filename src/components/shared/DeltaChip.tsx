/**
 * DeltaChip — pill con freccia ▲▼ e valore % (o assoluto) colorato per segno.
 * Gains sempre verdi, losses sempre rosse (design.md).
 */
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPercent, formatSignedCurrency } from '@/lib/format';

export interface DeltaChipProps {
  /** Valore in punti percentuali (es. 1.27 = +1,27%). */
  value: number;
  /** Valore assoluto opzionale mostrato prima della %, es. +€ 312,10. */
  absoluteValue?: number;
  currency?: 'EUR' | 'USD';
  size?: 'sm' | 'md';
  className?: string;
}

export function DeltaChip({ value, absoluteValue, currency = 'EUR', size = 'md', className }: DeltaChipProps) {
  const positive = value > 0;
  const neutral = value === 0;
  const Icon = neutral ? Minus : positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium tabular-nums',
        size === 'sm' ? 'px-1.5 py-0.5 text-micro' : 'px-2 py-0.5 text-caption',
        neutral
          ? 'bg-bg-2 text-text-1'
          : positive
            ? 'bg-gain-dim text-gain'
            : 'bg-loss-dim text-loss',
        className,
      )}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden />
      {absoluteValue != null && <span>{formatSignedCurrency(absoluteValue, currency)}</span>}
      <span>({formatPercent(value)})</span>
    </span>
  );
}
