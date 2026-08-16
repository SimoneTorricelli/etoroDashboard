/**
 * TickValue — valore live con flash 300ms verde/rosso al cambio (design.md,
 * "live pulse": la micro-interazione distintiva dell'app).
 * Rispetta prefers-reduced-motion (via CSS in index.css).
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface TickValueProps {
  /** Valore numerico osservato: il flash scatta quando cambia. */
  value: number;
  /** Testo già formattato da mostrare. */
  children: React.ReactNode;
  className?: string;
}

export function TickValue({ value, children, className }: TickValueProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevRef = useRef(value);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (value === prev) return;
    const dir = value > prev ? 'up' : 'down';
    const raf = requestAnimationFrame(() => setFlash(dir));
    const t = setTimeout(() => setFlash(null), 320);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [value]);

  return (
    <span
      className={cn(
        'rounded px-0.5 tabular-nums transition-colors',
        flash === 'up' && 'tick-flash-up',
        flash === 'down' && 'tick-flash-down',
        className,
      )}
    >
      {children}
    </span>
  );
}
