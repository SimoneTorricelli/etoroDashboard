/**
 * RiskBanner — banner dismissible ambra / persistente rosso (design.md).
 * Slide-down 280ms al mount, collapse 200ms alla chiusura.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RiskBannerProps {
  variant: 'warn' | 'danger';
  message: string;
  /** CTA opzionale (es. "Vai a Impostazioni"). */
  actionLabel?: string;
  onAction?: () => void;
  /** danger = persistente (non dismissible) di default. */
  dismissible?: boolean;
  className?: string;
}

export function RiskBanner({
  variant, message, actionLabel, onAction, dismissible = variant === 'warn', className,
}: RiskBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className={cn('overflow-hidden', className)}
        >
          <div
            role="alert"
            className={cn(
              'flex items-center gap-3 rounded-xl border px-4 py-3 text-body',
              variant === 'warn'
                ? 'border-warn/30 bg-warn/10 text-warn'
                : 'border-loss/40 bg-loss/10 text-loss',
            )}
          >
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
            <p className="flex-1 text-body text-text-0">{message}</p>
            {actionLabel && onAction && (
              <button
                onClick={onAction}
                className="shrink-0 rounded-lg border border-hairline-strong px-3 py-1 text-micro font-medium text-text-0 transition-colors hover:bg-bg-2"
              >
                {actionLabel}
              </button>
            )}
            {dismissible && (
              <button
                onClick={() => setDismissed(true)}
                aria-label="Chiudi avviso"
                className="shrink-0 rounded-md p-1 text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
