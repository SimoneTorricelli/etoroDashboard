/**
 * Pannello di diagnostica: prova ogni credenziale separatamente e mostra
 * l'errore preciso invece di un generico HTTP 401.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CircleDashed, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { autopilot, type DiagnosticsReport } from '@/lib/agent/autopilot-api';

interface Props {
  onReport?: (report: DiagnosticsReport) => void;
}

export function DiagnosticsPanel({ onReport }: Props) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const result = await autopilot.diagnose();
      setReport(result);
      onReport?.(result);
      const failed = result.checks.filter((item) => item.ok === false).length;
      if (failed === 0) toast.success('Tutti i controlli superati');
      else toast.warning(`${failed} controll${failed === 1 ? 'o' : 'i'} da sistemare`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-text-0">
              <Stethoscope className="size-4 text-agent" /> Diagnostica
            </CardTitle>
            <CardDescription className="text-text-1">
              Prova una per una le credenziali e le fonti dati, e dice esattamente cosa non funziona.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => void run()} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
            {running ? 'Controllo in corso…' : 'Esegui controlli'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {!report && !running && (
          <p className="text-sm text-text-1">
            Lancialo dopo aver salvato le credenziali: è il modo più rapido per capire se l’agente è pronto.
          </p>
        )}

        {report && (
          <>
            <div className="flex flex-wrap gap-2 pb-1">
              <Badge variant={report.readyForShadow ? 'default' : 'destructive'}>
                {report.readyForShadow ? 'Pronto per shadow e dry-run' : 'Non pronto: mancano eToro o OpenRouter'}
              </Badge>
              <Badge variant={report.readyForLive ? 'default' : 'outline'}>
                {report.readyForLive ? 'Pronto anche per live' : 'Live non disponibile: token Agent Portfolio mancante o non valido'}
              </Badge>
            </div>

            {report.checks.map((check) => (
              <div
                key={check.id}
                className={`rounded-lg border p-3 ${
                  check.ok === false ? 'border-loss/40 bg-loss-dim' : check.ok === null ? 'border-hairline bg-bg-2/40' : 'border-gain/30 bg-gain-dim'
                }`}
              >
                <div className="flex items-start gap-2">
                  {check.ok === true && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-gain" />}
                  {check.ok === false && <XCircle className="mt-0.5 size-4 shrink-0 text-loss" />}
                  {check.ok === null && <CircleDashed className="mt-0.5 size-4 shrink-0 text-text-2" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-0">{check.label}</p>
                    <p className="text-xs leading-relaxed text-text-1">{check.detail ?? check.error}</p>
                    {check.hint && (
                      <p className="mt-1 text-xs leading-relaxed text-warn">Come risolvere: {check.hint}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
