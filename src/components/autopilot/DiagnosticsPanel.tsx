/**
 * Pannello di diagnostica: prova ogni credenziale separatamente e mostra
 * l'errore preciso invece di un generico HTTP 401.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CircleDashed, Copy, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { autopilot, type DiagnosticsReport } from '@/lib/agent/autopilot-api';
import {
  buildLlmTechnicalReport, copyJsonToClipboard, isLlmAttemptArray, llmAttemptDebugFacts,
} from '@/lib/agent/llm-diagnostics';

interface Props {
  onReport?: (report: DiagnosticsReport) => void;
}

export function DiagnosticsPanel({ onReport }: Props) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);

  const modelAttempts = report?.checks.find((check) => check.id === 'models')?.data;
  const canCopyModelReport = isLlmAttemptArray(modelAttempts) && modelAttempts.length > 0;

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

  const copyReport = async () => {
    if (!report || !isLlmAttemptArray(modelAttempts)) return;
    try {
      await copyJsonToClipboard(buildLlmTechnicalReport({
        source: 'diagnostics',
        checkedAt: report.checkedAt,
        attempts: modelAttempts,
      }));
      toast.success('Report tecnico copiato negli appunti');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossibile copiare il report tecnico.');
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
          <div className="flex flex-wrap gap-2">
            {report ? (
              <Button variant="outline" size="sm" onClick={() => void copyReport()} disabled={!canCopyModelReport}>
                <Copy className="size-4" /> Copia report JSON
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void run()} disabled={running}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
              {running ? 'Controllo in corso…' : 'Esegui controlli'}
            </Button>
          </div>
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
                    {check.id === 'models' && isLlmAttemptArray(check.data) && check.data.length > 0 ? (
                      <div className="mt-2 space-y-1.5 border-t border-current/10 pt-2">
                        {check.data.map((attempt, index) => {
                          const facts = llmAttemptDebugFacts(attempt);
                          return (
                            <div key={`${attempt.provider ?? 'provider'}-${attempt.model}-${attempt.format ?? 'probe'}-${index}`} className="rounded-md bg-bg-0/70 px-2 py-1.5">
                              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                                <p className={`min-w-0 break-all font-mono text-[11px] ${attempt.ok ? 'text-gain' : 'text-text-1'}`}>
                                  {attempt.ok ? '✓' : '✗'} {attempt.provider ? `${attempt.provider}/` : ''}{attempt.model}{attempt.format ? ` [${attempt.format}]` : ''}
                                </p>
                                {facts.length > 0 ? <p className="text-[10px] text-text-2">{facts.join(' · ')}</p> : null}
                              </div>
                              {attempt.error ? <p className="mt-0.5 break-words text-[11px] leading-relaxed text-text-2">{attempt.error}</p> : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
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
