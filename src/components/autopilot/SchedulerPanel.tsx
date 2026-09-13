import { Clock3 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { SchedulerState } from '@/lib/agent/autopilot-api';

const date = (value: number | null) => value == null ? 'Non disponibile' : new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short',
}).format(value);
const statuses: Record<string, string> = {
  pending: 'In attesa', claimed: 'In esecuzione', completed: 'Run conclusa',
  blocked: 'Bloccata', expired: 'Tempo di recupero scaduto', cancelled: 'Calendario sostituito',
  skipped: 'Saltata', needs_review: 'Esito da verificare', failed: 'Errore',
};
const reasons: Record<string, string> = {
  pipeline_busy: 'Pipeline occupata: il prossimo controllo riprova entro il termine.',
  lock_unavailable: 'Impossibile verificare il lock: il prossimo controllo riprova.',
  recovery_expired: 'Scadenza troppo vecchia. Nessun avvio tardivo.',
  schedule_changed: 'Strategia, calendario o stato di sicurezza modificati.',
  dst_nonexistent: 'Questo orario non esiste per il passaggio all’ora legale.',
  execution_unknown: 'Run interrotta: verificare gli ordini eToro prima di intervenire.',
  autopilot_frozen: 'Autopilot congelato.',
  pipeline_started: 'Scadenza acquisita dalla pipeline.',
  pipeline_finished: 'Consulta la run per decisione ed eventuali ordini.',
  run_reconciled: 'Esito recuperato dallo storico persistito.',
  pipeline_blocked: 'La pipeline ha bloccato l’esecuzione.',
  pipeline_failed: 'La pipeline ha segnalato un errore.',
};
export function SchedulerPanel({ scheduler, frozen, onOpenRun }: {
  scheduler?: SchedulerState; frozen: boolean; onOpenRun: (id: string) => void;
}) {
  const stale = scheduler?.lastReceivedAt != null && scheduler.checkedAt - scheduler.lastReceivedAt > 3 * 60_000;
  const catchingUp = scheduler?.scannedThrough != null && scheduler.checkedAt - scheduler.scannedThrough > 60_000;
  return <Card>
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-base"><Clock3 className="size-4" />Pianificazione e recupero</CardTitle>
      <CardDescription>Orari Europe/Rome. Una run conclusa può non aver prodotto ordini.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {!scheduler ? <p className="text-sm text-text-1">Il Worker collegato non espone ancora il registro delle scadenze.</p> : <>
        <div className="grid gap-4 text-sm sm:grid-cols-3">
          <div><p className="text-text-1">Prossimo ribilanciamento previsto</p><p className="font-semibold">{date(scheduler.nextRebalance?.dueAt ?? null)}</p></div>
          <div><p className="text-text-1">Ultimo controllo ricevuto</p><p className="font-semibold">{date(scheduler.lastReceivedAt)}</p></div>
          <div><p className="text-text-1">Finestra di recupero</p><p className="font-semibold">{scheduler.recoveryMinutes} minuti</p></div>
        </div>
        {(frozen || stale || catchingUp || !scheduler.initialized || scheduler.configurationPending) && <p role="status" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          {frozen ? 'Autopilot congelato: i ribilanciamenti automatici sono bloccati. ' : ''}
          {!scheduler.initialized ? 'In attesa del primo controllo del nuovo scheduler. ' : ''}
          {catchingUp ? 'Registro in recupero dopo un’interruzione; le vecchie scadenze non avviano acquisti tardivi. ' : ''}
          {stale ? 'Nessun controllo recente: verificare cron e log del Worker. ' : ''}
          {scheduler.configurationPending ? 'Le nuove impostazioni saranno recepite al prossimo controllo.' : ''}
        </p>}
        {scheduler.unresolved.length > 0 && <div role="alert" className="rounded-lg border border-loss/30 p-3 text-sm text-loss">
          <p>Esecuzioni recenti con esito da verificare: {scheduler.unresolved.length}. Il sistema non le rilancia automaticamente.</p>
          {scheduler.unresolved.map(row => <div key={row.id} className="mt-1 flex flex-wrap items-center gap-2">
            <span>{date(row.due_at_utc)} · {row.kind}</span>
            {row.run_id && row.run_status !== 'not_recorded' && <Button variant="outline" size="sm" onClick={() => onOpenRun(row.run_id!)}>Verifica run</Button>}
          </div>)}
        </div>}
        {scheduler.recentRebalances.length === 0 ? <p className="text-sm text-text-1">Nessuna scadenza registrata dall’attivazione. Lo storico precedente non viene ricostruito come se fosse stato osservato.</p> :
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="text-xs text-text-1"><tr><th className="py-2 pr-3">Scadenza</th><th className="pr-3">Esito e motivo</th><th className="pr-3">Tentativi</th><th>Dettaglio</th></tr></thead>
            <tbody>{scheduler.recentRebalances.map(row => <tr key={row.id} className="border-t border-border/60 align-top">
              <td className="whitespace-nowrap py-3 pr-3">{row.local_due}<p className="text-xs text-text-1">Termine: {date(row.expires_at)}</p></td>
              <td className="max-w-md py-3 pr-3"><p className="font-medium">{statuses[row.status] ?? row.status}</p><p className="text-xs text-text-1">{row.reason || reasons[row.reason_code ?? ''] || row.reason_code || 'In attesa del dispatcher.'}</p></td>
              <td className="py-3 pr-3">{row.attempts}</td>
              <td className="py-3">{row.run_id && row.run_status !== 'not_recorded' ? <Button variant="outline" size="sm" onClick={() => onOpenRun(row.run_id!)}>Apri run</Button> : '—'}</td>
            </tr>)}</tbody>
          </table></div>}
        <p className="text-xs text-text-1">Controllo ogni minuto, senza chiamate AI nei tick vuoti. Le scadenze già avviate non vengono ripetute; mercato chiuso e altri blocchi restano spiegati nella run.</p>
      </>}
    </CardContent>
  </Card>;
}
