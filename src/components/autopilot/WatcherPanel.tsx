/**
 * Eventi del watcher: cosa ha visto ogni ora, come l'ha classificato l'AI e
 * perché ha agito o si è fermato.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CircleAlert, Eye, RefreshCw, ShoppingCart, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { autopilot, type WatcherEvent } from '@/lib/agent/autopilot-api';

const KIND_LABEL: Record<string, string> = {
  crash: 'crollo giornaliero',
  slide: 'discesa prolungata',
  spike: 'rialzo esplosivo',
  vol_regime: 'volatilità anomala',
  position_stop: 'posizione sotto stop',
};

const CLASSIFICATION_LABEL: Record<string, { text: string; className: string }> = {
  structural_break: { text: 'rottura strutturale', className: 'text-loss' },
  technical_overreaction: { text: 'eccesso tecnico', className: 'text-gain' },
  unclear: { text: 'non determinabile', className: 'text-warn' },
};

const ACTION_LABEL: Record<string, { text: string; icon: typeof Eye }> = {
  executed: { text: 'acquisto eseguito', icon: ShoppingCart },
  buy: { text: 'acquisto proposto', icon: ShoppingCart },
  propose_exit: { text: 'uscita proposta', icon: TrendingDown },
  noop: { text: 'nessuna azione', icon: Ban },
};

export function WatcherPanel() {
  const [events, setEvents] = useState<WatcherEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents((await autopilot.watcherEvents(60)).events);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-text-0">
              <CircleAlert className="size-4 text-agent" /> Watcher orario
            </CardTitle>
            <CardDescription className="text-text-1">
              Ogni ora fa uno scan gratuito. Solo davanti a un'anomalia reale chiede all'AI se sia un deterioramento strutturale o un
              eccesso tecnico. Non compra mai dentro il movimento: attende la stabilizzazione.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} /> Aggiorna
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {events.length === 0 && (
          <p className="text-sm text-text-1">
            Nessun evento registrato. È normale: nella grande maggioranza delle ore non succede nulla che meriti un'analisi.
          </p>
        )}
        {events.map((event) => {
          const classification = CLASSIFICATION_LABEL[event.classification ?? ''] ?? { text: 'non classificato', className: 'text-text-1' };
          const action = ACTION_LABEL[event.action] ?? { text: event.action, icon: Eye };
          const ActionIcon = action.icon;
          return (
            <div key={event.id} className="rounded-lg border border-hairline bg-bg-2/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-0">{event.symbol}</span>
                <Badge variant="outline">{KIND_LABEL[event.kind] ?? event.kind}</Badge>
                {typeof event.metrics?.dayChangePct === 'number' && (
                  <span className={cn('tabular-nums text-sm', event.metrics.dayChangePct < 0 ? 'text-loss' : 'text-gain')}>
                    {event.metrics.dayChangePct > 0 ? '+' : ''}{event.metrics.dayChangePct}%
                  </span>
                )}
                <span className={cn('text-sm', classification.className)}>{classification.text}</span>
                {event.confidence != null && (
                  <Badge variant="secondary" className="text-[10px]">confidence {event.confidence.toFixed(2)}</Badge>
                )}
                <span className="ml-auto flex items-center gap-1 text-xs text-text-1">
                  <ActionIcon className="size-3.5" /> {action.text}
                </span>
              </div>
              {event.rationale && <p className="mt-1.5 text-xs leading-relaxed text-text-1">{event.rationale}</p>}
              <p className="mt-1 text-[11px] text-text-2">
                {new Date(event.at).toLocaleString('it-IT')}
                {event.metrics?.stabilized != null && ` · ${event.metrics.stabilized ? 'movimento stabilizzato' : 'movimento in corso'}`}
                {event.model ? ` · ${event.model}` : ''}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
