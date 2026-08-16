/**
 * LogStream — stream di log mono, auto-scroll, livelli color-coded:
 * info text-1, success verde, warn ambra, error rosso, agent viola (design.md).
 */
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/format';
import type { LogEntry, LogLevel } from '@/lib/data/types';

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: 'text-text-1',
  success: 'text-gain',
  warn: 'text-warn',
  error: 'text-loss',
  agent: 'text-agent',
};

const LEVEL_TAGS: Record<LogLevel, string> = {
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERR',
  agent: 'AGENT',
};

export interface LogStreamProps {
  entries: LogEntry[];
  /** Altezza massima con scroll (default 240px). */
  maxHeight?: number;
  autoScroll?: boolean;
  className?: string;
}

export function LogStream({ entries, maxHeight = 240, autoScroll = true, className }: LogStreamProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = 0; // entries sono in ordine anti-cronologico (più recente in alto)
    }
  }, [entries, autoScroll]);

  return (
    <div
      ref={boxRef}
      style={{ maxHeight }}
      className={cn('overflow-y-auto rounded-lg border border-hairline bg-bg-0 p-3 font-mono text-ticker', className)}
    >
      {entries.length === 0 && <div className="text-text-2">Nessun evento.</div>}
      {entries.map((e) => (
        <div key={e.id} className="flex gap-2 py-0.5 leading-5">
          <span className="shrink-0 text-text-2">{formatTime(e.timestamp)}</span>
          <span className={cn('shrink-0 w-12 font-medium', LEVEL_COLORS[e.level])}>{LEVEL_TAGS[e.level]}</span>
          <span className={cn('min-w-0 break-words', LEVEL_COLORS[e.level])}>{e.message}</span>
        </div>
      ))}
    </div>
  );
}
