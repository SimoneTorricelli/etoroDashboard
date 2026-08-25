/**
 * FxAlerts — "Avvisi EUR/USD" (design/fx.md Row 3, span 6):
 * lista avvisi su soglia (sopra/sotto) con persistenza localStorage,
 * dialog di creazione, valutazione a ogni tick → toast + notifica browser
 * (permesso richiesto contestualmente) + riga in cima con check.
 */
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, BellRing, Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { formatDate, formatFxRate } from '@/lib/format';
import { StatusDot } from '@/components/shared/StatusDot';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { evaluateFxAlerts, useFxAlerts } from './useFxData';

function parseRate(raw: string): number | null {
  const n = Number(raw.trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function FxAlerts() {
  const { fxRate } = useAppData();
  const { alerts, addAlert, removeAlert, markTriggered, resetAlert } = useFxAlerts();

  const [open, setOpen] = useState(false);
  const [thresholdRaw, setThresholdRaw] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [note, setNote] = useState('');

  /* Valutazione a ogni tick */
  useEffect(() => {
    const rate = fxRate?.rate;
    if (rate == null) return;
    const fired = evaluateFxAlerts(alerts, rate);
    for (const a of fired) {
      markTriggered(a.id);
      const msg = `EUR/USD ${a.direction === 'above' ? 'ha superato' : 'è sceso sotto'} ${formatFxRate(a.threshold)} (ora ${formatFxRate(rate)})`;
      toast('Avviso di cambio scattato', { description: a.note ? `${msg} — ${a.note}` : msg });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('Torri — Avviso EUR/USD', { body: msg }); } catch { /* ignora */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fxRate?.rate]);

  /* Ordina: scattati di recente + attivi in cima */
  const sorted = useMemo(
    () => [...alerts].sort((a, b) => Number(Boolean(b.triggeredAt)) - Number(Boolean(a.triggeredAt)) || b.createdAt - a.createdAt),
    [alerts],
  );

  const submit = () => {
    const threshold = parseRate(thresholdRaw);
    if (threshold == null) return;
    addAlert({ threshold, direction, note: note.trim() || undefined });
    /* Permesso notifiche richiesto contestualmente alla creazione del primo avviso */
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    setOpen(false);
    setThresholdRaw('');
    setNote('');
  };

  return (
    <div className="card-surface density-pad flex h-full flex-col p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-title text-text-0">Avvisi EUR/USD</h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-1.5 rounded-lg bg-info/15 px-3 py-1.5 text-caption font-medium text-info transition-colors hover:bg-info/25">
              <Plus className="h-3.5 w-3.5" aria-hidden /> Nuovo avviso
            </button>
          </DialogTrigger>
          <DialogContent className="border-hairline bg-bg-1 text-text-0 sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">Nuovo avviso di cambio</DialogTitle>
              <DialogDescription className="text-text-1">
                Ricevi un avviso quando EUR/USD incrocia la soglia. Valutato a ogni tick.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label htmlFor="fx-alert-rate" className="text-label text-text-1">Soglia EUR/USD</label>
                <input
                  id="fx-alert-rate"
                  inputMode="decimal"
                  value={thresholdRaw}
                  onChange={(e) => setThresholdRaw(e.target.value)}
                  placeholder={fxRate ? formatFxRate(fxRate.rate) : '1,1000'}
                  className="mt-1.5 w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 font-mono text-ticker text-text-0 outline-none transition-colors focus:border-hairline-strong focus:ring-1 focus:ring-info/40"
                />
              </div>
              <div>
                <span className="text-label text-text-1">Direzione</span>
                <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg border border-hairline bg-bg-3 p-1">
                  {(['above', 'below'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDirection(d)}
                      className={cn(
                        'rounded-md py-1.5 text-caption font-medium transition-colors',
                        direction === d ? 'bg-info/20 text-info' : 'text-text-2 hover:text-text-1',
                      )}
                      aria-pressed={direction === d}
                    >
                      {d === 'above' ? 'Sopra la soglia' : 'Sotto la soglia'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="fx-alert-note" className="text-label text-text-1">Nota (opzionale)</label>
                <input
                  id="fx-alert-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="es. preleva il 25%"
                  className="mt-1.5 w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 text-body text-text-0 outline-none transition-colors focus:border-hairline-strong focus:ring-1 focus:ring-info/40"
                />
              </div>
            </div>
            <DialogFooter>
              <button
                onClick={submit}
                disabled={parseRate(thresholdRaw) == null}
                className="rounded-lg bg-info px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-info/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Crea avviso
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-3 flex-1">
        {sorted.length === 0 ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-hairline-strong py-8 text-center">
            <Bell className="h-6 w-6 text-text-2" aria-hidden />
            <p className="mt-2 text-caption text-text-1">Nessun avviso attivo.</p>
            <p className="text-micro text-text-2">Crea un avviso per essere avvisato quando il cambio raggiunge il tuo target.</p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {sorted.map((a, i) => (
              <motion.li
                key={a.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: i * 0.04 }}
                className={cn(
                  'flex items-center gap-3 py-2.5',
                  a.triggeredAt && 'rounded-lg ring-1 ring-info/40',
                )}
              >
                <StatusDot variant={a.triggeredAt ? 'ok' : 'warn'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-ticker tabular-nums text-text-0">{formatFxRate(a.threshold)}</span>
                    <span className="text-micro text-text-2">{a.direction === 'above' ? 'sopra' : 'sotto'}</span>
                    {a.triggeredAt && (
                      <span className="flex items-center gap-1 rounded-full bg-gain-dim px-1.5 py-0.5 text-micro text-gain">
                        <Check className="h-3 w-3" aria-hidden /> Scattato
                      </span>
                    )}
                  </div>
                  <div className="truncate text-micro text-text-2">
                    {a.note ? `${a.note} · ` : ''}creato il {formatDate(a.createdAt)}
                  </div>
                </div>
                {a.triggeredAt && (
                  <button
                    onClick={() => resetAlert(a.id)}
                    className="rounded-md px-2 py-1 text-micro text-info transition-colors hover:bg-bg-2"
                  >
                    Ri-arma
                  </button>
                )}
                <button
                  onClick={() => removeAlert(a.id)}
                  aria-label="Elimina avviso"
                  className="rounded-md p-1.5 text-text-2 transition-colors hover:bg-bg-2 hover:text-loss"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </motion.li>
            ))}
          </ul>
        )}
      </div>

      {alerts.some((a) => !a.triggeredAt) && (
        <p className="mt-2 flex items-center gap-1.5 text-micro text-text-2">
          <BellRing className="h-3 w-3" aria-hidden />
          Gli avvisi vengono valutati a ogni tick del cambio.
        </p>
      )}
    </div>
  );
}
