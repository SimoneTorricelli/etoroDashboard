/**
 * EmptyState — headline Space Grotesk, copy, CTA primaria (+ secondaria opzionale),
 * backdrop dotted-grid CSS (design.md).
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  headline: string;
  copy: string;
  /** CTA primaria. */
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({
  headline, copy, actionLabel, onAction, secondaryLabel, onSecondary, icon, className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'card-surface relative flex flex-col items-center justify-center overflow-hidden px-6 py-16 text-center',
        className,
      )}
    >
      {/* dotted grid backdrop */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ backgroundImage: 'radial-gradient(#FFFFFF14 1px, transparent 1px)', backgroundSize: '20px 20px' }}
        aria-hidden
      />
      <div className="relative flex flex-col items-center">
        {icon ?? (
          <img src="./logo.svg" alt="" className="mb-4 h-12 w-12 opacity-30" aria-hidden />
        )}
        <h2 className="font-display text-display-md text-text-0">{headline}</h2>
        <p className="mt-2 max-w-md text-body text-text-1">{copy}</p>
        {(actionLabel || secondaryLabel) && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {actionLabel && (
              <button
                onClick={onAction}
                className="rounded-lg bg-gain px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-gain/90"
              >
                {actionLabel}
              </button>
            )}
            {secondaryLabel && (
              <button
                onClick={onSecondary}
                className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-0 transition-colors hover:bg-bg-2"
              >
                {secondaryLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
