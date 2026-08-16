/**
 * ConfirmDialog — conferma ordine (design.md / Interaction Patterns).
 * - Header strip verde (BUY) / rossa (SELL).
 * - Importo con riga di conversione EUR⇄USD.
 * - In modalità REAL il pulsante richiede press-and-hold 800ms con progress ring.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatCurrency, formatFxRate } from '@/lib/format';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Titolo, es. "Conferma ordine AAPL". */
  title: string;
  description?: string;
  isBuy?: boolean;
  /** Importo in USD. */
  amountUsd?: number;
  /** Tasso EURUSD corrente per la riga di conversione. */
  fxRate?: number;
  /** true in Live+REAL+write: attiva press-and-hold 800ms. */
  requireHold?: boolean;
  holdMs?: number;
  confirmLabel?: string;
  onConfirm(): void;
  loading?: boolean;
}

export function ConfirmDialog({
  open, onOpenChange, title, description, isBuy = true, amountUsd, fxRate,
  requireHold = false, holdMs = 800, confirmLabel, onConfirm, loading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-hairline bg-bg-1 p-0 text-text-0 sm:max-w-md">
        {/* direction strip */}
        <div className={cn('h-1.5 rounded-t-xl', isBuy ? 'bg-gain' : 'bg-loss')} aria-hidden />
        <div className="p-6 pt-4">
          <DialogHeader>
            <DialogTitle className="font-display text-title text-text-0">{title}</DialogTitle>
            {description && <DialogDescription className="text-caption text-text-1">{description}</DialogDescription>}
          </DialogHeader>

          {amountUsd != null && (
            <div className="mt-4 rounded-lg border border-hairline bg-bg-0 p-3">
              <div className="flex items-center justify-between text-body">
                <span className="text-text-1">Importo</span>
                <span className="font-medium tabular-nums">{formatCurrency(amountUsd, 'USD')}</span>
              </div>
              {fxRate != null && (
                <div className="mt-1 flex items-center justify-between text-caption text-text-2">
                  <span>Equivalente (EUR/USD {formatFxRate(fxRate)})</span>
                  <span className="tabular-nums">≈ {formatCurrency(amountUsd / fxRate, 'EUR')}</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="mt-6 flex-row justify-end gap-2">
            <button
              onClick={() => onOpenChange(false)}
              className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2"
            >
              Annulla
            </button>
            {requireHold ? (
              <HoldButton
                holdMs={holdMs}
                isBuy={isBuy}
                disabled={loading}
                label={confirmLabel ?? (isBuy ? 'Tieni premuto per comprare' : 'Tieni premuto per vendere')}
                onComplete={onConfirm}
              />
            ) : (
              <button
                onClick={onConfirm}
                disabled={loading}
                className={cn(
                  'rounded-lg px-4 py-2 text-body-strong text-bg-0 transition-colors disabled:opacity-50',
                  isBuy ? 'bg-gain hover:bg-gain/90' : 'bg-loss hover:bg-loss/90',
                )}
              >
                {loading ? 'Invio…' : confirmLabel ?? 'Conferma'}
              </button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Press-and-hold con progress ring (REAL mode) ──────────────────── */
function HoldButton({
  holdMs, isBuy, label, disabled, onComplete,
}: { holdMs: number; isBuy: boolean; label: string; disabled?: boolean; onComplete(): void }) {
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);
  const doneRef = useRef(false);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (!doneRef.current) setProgress(0);
  }, []);

  const start = useCallback(() => {
    if (disabled) return;
    doneRef.current = false;
    startRef.current = performance.now();
    intervalRef.current = setInterval(() => {
      const t = Math.min(1, (performance.now() - startRef.current) / holdMs);
      setProgress(t);
      if (t >= 1) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
        doneRef.current = true;
        setProgress(0);
        onComplete();
      }
    }, 30);
  }, [disabled, holdMs, onComplete]);

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const R = 9;
  const C = 2 * Math.PI * R;

  return (
    <button
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      disabled={disabled}
      className={cn(
        'inline-flex select-none items-center gap-2 rounded-lg px-4 py-2 text-body-strong text-bg-0 transition-colors disabled:opacity-50',
        isBuy ? 'bg-gain' : 'bg-loss',
      )}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" className="-rotate-90" aria-hidden>
        <circle cx="11" cy="11" r={R} fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="2.5" />
        <circle
          cx="11" cy="11" r={R} fill="none" stroke="#0A0E13" strokeWidth="2.5"
          strokeDasharray={C} strokeDashoffset={C * (1 - progress)} strokeLinecap="round"
        />
      </svg>
      {label}
    </button>
  );
}
