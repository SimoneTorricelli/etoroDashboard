import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { StatusDot } from './StatusDot';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function ageLabel(ageMs: number): string {
  if (ageMs < 15_000) return 'Live';
  if (ageMs < 60_000) return `Aggiornato ${Math.max(1, Math.floor(ageMs / 1000))} s fa`;
  return `Aggiornato ${Math.floor(ageMs / 60_000)} min fa`;
}

export function FreshnessBadge({ asOf, source, staleAfterMs = 120_000 }: { asOf?: number; source: string; staleAfterMs?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const age = asOf ? Math.max(0, now - asOf) : Number.POSITIVE_INFINITY;
  const stale = age > staleAfterMs;
  return (
    <TooltipProvider delayDuration={180}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-caption text-text-2 hover:text-text-1" aria-label={`Fonte dati: ${source}`}>
            <StatusDot variant={!asOf ? 'idle' : stale ? 'error' : 'live'} />
            <span>{!asOf ? 'Non disponibile' : stale ? `Stale · ${ageLabel(age)}` : ageLabel(age)}</span>
            <Info className="h-3.5 w-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          <p className="text-caption">{source}</p>
          {asOf ? <p className="mt-1 text-micro text-text-2">Timestamp: {new Date(asOf).toLocaleString('it-IT')}</p> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
