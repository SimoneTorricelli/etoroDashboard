/**
 * KpiCard — label overline, valore display-md con tween, DeltaChip,
 * sparkline 80×28, status dot opzionale (design.md / Shared Components).
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { DeltaChip } from './DeltaChip';
import { Sparkline } from './Sparkline';
import { StatusDot } from './StatusDot';
import type { StatusDotVariant } from './StatusDot';

export interface KpiCardProps {
  label: string;
  /** Valore già formattato (es. "€ 12.480,32"). */
  value: string;
  /** Delta % in punti percentuali; se omesso niente chip. */
  deltaPct?: number;
  deltaAbsolute?: number;
  currency?: 'EUR' | 'USD';
  sparkData?: number[];
  sparkLive?: boolean;
  status?: StatusDotVariant;
  className?: string;
}

export function KpiCard({
  label, value, deltaPct, deltaAbsolute, currency = 'EUR', sparkData, sparkLive, status, className,
}: KpiCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
      className={cn('card-surface density-pad p-5', className)}
    >
      <div className="flex items-center justify-between">
        <span className="overline">{label}</span>
        {status && <StatusDot variant={status} />}
      </div>
      <div className="mt-2 font-display text-display-md text-text-0 tabular-nums">
        <TweenedValue value={value} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        {deltaPct != null ? (
          <DeltaChip value={deltaPct} absoluteValue={deltaAbsolute} currency={currency} size="sm" />
        ) : <span />}
        {sparkData && sparkData.length > 1 && <Sparkline data={sparkData} width={80} height={28} live={sparkLive} />}
      </div>
    </motion.div>
  );
}

/** Tween 400ms sul cambio di valore numerico; se il valore non è parsabile mostra il testo così com'è. */
function TweenedValue({ value }: { value: string }) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    const from = parseLocaleNumber(prev);
    const to = parseLocaleNumber(value);
    if (from == null || to == null || from === to) {
      const raf = requestAnimationFrame(() => setDisplay(value));
      return () => cancelAnimationFrame(raf);
    }
    const start = performance.now();
    const duration = 400;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (to - from) * eased;
      setDisplay(rebuildString(value, current));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{display}</>;
}

/** Estrae il numero da una stringa formattata it-IT ("€ 12.480,32" → 12480.32). */
function parseLocaleNumber(s: string): number | null {
  const cleaned = s.replace(/[^\d,.\-+]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== '' ? n : null;
}

/** Ricostruisce la stringa mantenendo prefisso/suffisso non numerici. */
function rebuildString(template: string, n: number): string {
  const match = template.match(/^([^\d\-+]*)([\d.,\-+]+)(.*)$/);
  if (!match) return template;
  const [, prefix, , suffix] = match;
  const decimals = template.includes(',') ? (template.split(',').pop()?.replace(/\D.*$/, '').length ?? 2) : 0;
  const formatted = new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: Math.min(decimals, 4),
    maximumFractionDigits: Math.min(decimals, 4),
  }).format(n);
  return `${prefix}${formatted}${suffix}`;
}
