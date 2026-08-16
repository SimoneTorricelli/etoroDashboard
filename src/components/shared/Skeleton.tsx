/**
 * Skeleton — blocco shimmer 1.2s su bg-2 per gli stati di caricamento.
 */
import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-shimmer rounded-md bg-bg-2 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.05),transparent)] bg-[length:400px_100%]',
        className,
      )}
      aria-hidden
    />
  );
}
