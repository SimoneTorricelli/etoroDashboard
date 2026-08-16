/**
 * StatusDot — dot 6px con glow ring (design.md).
 * variant: 'live' (verde pulsante), 'ok' (verde), 'warn' (ambra), 'error' (rosso), 'idle' (grigio), 'agent' (viola).
 */
import { cn } from '@/lib/utils';

export type StatusDotVariant = 'live' | 'ok' | 'warn' | 'error' | 'idle' | 'agent';

const COLORS: Record<StatusDotVariant, string> = {
  live: 'bg-gain',
  ok: 'bg-gain',
  warn: 'bg-warn',
  error: 'bg-loss',
  idle: 'bg-text-2',
  agent: 'bg-agent',
};

const GLOWS: Record<StatusDotVariant, string> = {
  live: 'shadow-[0_0_6px_1px_#00C39066]',
  ok: 'shadow-[0_0_6px_1px_#00C39044]',
  warn: 'shadow-[0_0_6px_1px_#F5A62355]',
  error: 'shadow-[0_0_6px_1px_#F4556B66]',
  idle: '',
  agent: 'shadow-[0_0_6px_1px_#9B8CFF55]',
};

export function StatusDot({ variant, className }: { variant: StatusDotVariant; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        COLORS[variant],
        GLOWS[variant],
        variant === 'live' && 'animate-pulse-dot motion-reduce:animate-none',
        className,
      )}
      aria-hidden
    />
  );
}
