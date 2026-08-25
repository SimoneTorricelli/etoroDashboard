/**
 * Autopilot (/autopilot) — pannello di controllo dell'agente server-side.
 *
 * La pagina non esegue logica di trading: legge e comanda il Worker, unico
 * titolare di credenziali ed esecuzione. Chiudere il browser non ferma l'agente.
 */
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { toast, Toaster } from 'sonner';
import {
  Activity, ArrowRight, Bot, Circle, CircleCheck, Clock, Eye, FlaskConical,
  Lock, RefreshCw, ShieldAlert, Snowflake, Radio, Unlock, XCircle,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { HowItWorks } from '@/components/autopilot/HowItWorks';
import { DiagnosticsPanel } from '@/components/autopilot/DiagnosticsPanel';
import { GuardrailsEditor } from '@/components/autopilot/GuardrailsEditor';
import { ProfileSelector } from '@/components/autopilot/ProfileSelector';
import { WatcherPanel } from '@/components/autopilot/WatcherPanel';
import { CredentialsSection } from '@/components/autopilot/CredentialsSection';
import { cn } from '@/lib/utils';
import {
  autopilot, getBaseUrl, getControlToken, setBaseUrl, setControlToken,
  type AutopilotState, type ExecutionMode, type RunBundle, type RunSummary,
} from '@/lib/agent/autopilot-api';

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

const MODES: Array<{ id: ExecutionMode; icon: typeof Eye; title: string; short: string; tone: string }> = [
  { id: 'shadow', icon: Eye, title: 'Shadow', short: 'Propone e basta. Nessun ordine viene costruito.', tone: 'text-text-0' },
  { id: 'dry-run', icon: FlaskConical, title: 'Dry-run', short: 'Costruisce gli ordini e li valida su eToro, ma non li invia.', tone: 'text-warn' },
  { id: 'live', icon: Radio, title: 'Live', short: 'Invia ordini reali sull’Agent Portfolio, senza altra conferma.', tone: 'text-loss' },
];

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  ok: { text: 'completata', className: 'text-gain' },
  running: { text: 'in corso', className: 'text-agent' },
  blocked: { text: 'bloccata dai guardrail', className: 'text-warn' },
  frozen: { text: 'agente congelato', className: 'text-loss' },
  error: { text: 'errore', className: 'text-loss' },
};

const KIND_LABEL: Record<string, string> = {
  heartbeat: 'controllo orario',
  snapshot: 'snapshot',
  rebalance: 'ribilanciamento',
  manual: 'manuale',
};

const fmtUsd = (value: number | null | undefined) =>
  value == null ? '—' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const fmtPct = (value: number | null | undefined, digits = 1) =>
  value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
const fmtDate = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function Autopilot() {
  const [token, setToken] = useState(getControlToken());
  const [baseUrl, setBase] = useState(getBaseUrl());
  const [state, setState] = useState<AutopilotState | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const refresh = useCallback(async () => {
    if (!getControlToken()) return;
    setLoading(true);
    setError(null);
    try {
      const [nextState, nextRuns] = await Promise.all([autopilot.state(), autopilot.runs(40)]);
      setState(nextState);
      setRuns(nextRuns.runs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const guarded = async (label: string, task: () => Promise<unknown>) => {
    setLoading(true);
    try {
      const result = await task() as { status?: string; error?: string; runId?: string };
      if (result?.status === 'error') toast.error(`Run fallita: ${result.error ?? 'errore sconosciuto'}`);
      else if (result?.status === 'blocked') toast.warning('Piano bloccato dai guardrail: apri il dettaglio della run.');
      else toast.success(label);
      await refresh();
      if (result?.runId) void openRun(result.runId);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const openRun = async (id: string) => {
    try { setDetail(await autopilot.run(id)); } catch (caught) { toast.error(caught instanceof Error ? caught.message : String(caught)); }
  };

  const config = state?.config;
  const mode = config?.executionMode ?? 'shadow';
  const frozen = Boolean(config?.frozen);

  const credentialsOk = state?.credentials.filter((item) => item.required).every((item) => item.configured) ?? false;
  const hasRun = runs.length > 0;

  const steps = [
    { done: Boolean(state), label: 'Connetti la dashboard al Worker' },
    { done: credentialsOk, label: 'Inserisci le credenziali obbligatorie' },
    { done: state?.notificationsActive ?? false, label: 'Collega Telegram (facoltativo ma consigliato)' },
    { done: hasRun, label: 'Lancia la prima run in shadow' },
  ];

  return (
    <div className="grid grid-cols-12 gap-4">
      <Toaster position="top-right" richColors />

      <motion.div {...stagger(0)} className="col-span-12 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text-0">
            <Bot className="size-6 text-agent" /> Autopilot
          </h1>
          <p className="max-w-3xl text-sm leading-relaxed text-text-1">
            Un agente che vive sul server: ogni settimana legge il tuo portafoglio, calcola gli indicatori, chiede a un modello AI quale
            allocazione terrebbe, verifica la risposta contro i tuoi limiti e — solo se glielo permetti — invia gli ordini a eToro.
            Funziona a computer spento.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} /> Aggiorna
        </Button>
      </motion.div>

      {/* Connessione */}
      <motion.div {...stagger(1)} className="col-span-12">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-text-0"><Lock className="size-4 text-agent" /> Connessione al Worker</CardTitle>
            <CardDescription className="text-text-1">
              Il <strong className="text-text-0">CONTROL_TOKEN</strong> è la password dell’agente, quella che hai generato con <code className="rounded bg-bg-2 px-1">openssl rand -base64 32</code> e
              caricato con <code className="rounded bg-bg-2 px-1">wrangler secret put</code>. Resta in sessionStorage e si cancella chiudendo la scheda.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="ap-base" className="text-text-0">URL del Worker</Label>
              <Input id="ap-base" value={baseUrl} onChange={(event) => setBase(event.target.value)} placeholder="vuoto = stessa origine del sito" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ap-token" className="text-text-0">CONTROL_TOKEN</Label>
              <Input id="ap-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="incolla il token" />
            </div>
            <Button onClick={() => { setBaseUrl(baseUrl); setControlToken(token); void refresh(); }} disabled={!token || loading}>
              Connetti
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {error && (
        <motion.div {...stagger(2)} className="col-span-12">
          <Alert variant="destructive">
            <XCircle className="size-4" />
            <AlertTitle>Connessione non riuscita</AlertTitle>
            <AlertDescription>
              {error}
              {error.includes('401') || error.toLowerCase().includes('autorizzato')
                ? ' — il token non corrisponde a quello caricato sul Worker. Rigeneralo con wrangler secret put CONTROL_TOKEN e riprova.'
                : ''}
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

      {frozen && (
        <motion.div {...stagger(2)} className="col-span-12">
          <Alert variant="destructive">
            <Snowflake className="size-4" />
            <AlertTitle>Agente congelato</AlertTitle>
            <AlertDescription>
              {config?.frozenReason || 'Freeze manuale'} — nessun ordine verrà inviato finché non lo riattivi dal tab Panoramica.
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

      {state && config && (
        <>
          {/* KPI */}
          <motion.div {...stagger(3)} className="col-span-12 grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-1"><CardDescription className="text-text-1">Equity Agent Portfolio</CardDescription></CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums text-text-0">{fmtUsd(state.equityUsd)}</div>
                <p className="text-xs text-text-1">Massimo storico {fmtUsd(state.highWaterMarkUsd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardDescription className="text-text-1">Drawdown dal massimo</CardDescription></CardHeader>
              <CardContent>
                <div className={cn('text-2xl font-semibold tabular-nums',
                  state.drawdownPct > config.drawdownStopPct * 0.6 ? 'text-warn' : 'text-text-0')}>
                  {fmtPct(state.drawdownPct)}
                </div>
                <p className="text-xs text-text-1">Congelamento automatico a {fmtPct(config.drawdownStopPct, 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardDescription className="text-text-1">Modalità attuale</CardDescription></CardHeader>
              <CardContent>
                <div className={cn('text-2xl font-semibold', MODES.find((item) => item.id === mode)?.tone)}>
                  {MODES.find((item) => item.id === mode)?.title}
                </div>
                <p className="text-xs text-text-1">{MODES.find((item) => item.id === mode)?.short}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardDescription className="text-text-1">Ultima esecuzione</CardDescription></CardHeader>
              <CardContent>
                <div className={cn('text-lg font-semibold', STATUS_LABEL[state.lastRun?.status ?? '']?.className ?? 'text-text-0')}>
                  {STATUS_LABEL[state.lastRun?.status ?? '']?.text ?? 'mai eseguita'}
                </div>
                <p className="text-xs text-text-1">
                  {state.lastRun ? `${fmtDate(state.lastRun.started_at)} · ${KIND_LABEL[state.lastRun.kind] ?? state.lastRun.kind}` : 'lancia una run dal tab Panoramica'}
                </p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div {...stagger(4)} className="col-span-12">
            <Tabs defaultValue="panoramica">
              <TabsList className="w-full justify-start overflow-x-auto">
                <TabsTrigger value="panoramica">Panoramica</TabsTrigger>
                <TabsTrigger value="guida">Come funziona</TabsTrigger>
                <TabsTrigger value="strategia">Strategia e limiti</TabsTrigger>
                <TabsTrigger value="credenziali">Credenziali</TabsTrigger>
                <TabsTrigger value="watcher">Watcher</TabsTrigger>
                <TabsTrigger value="diagnostica">Diagnostica</TabsTrigger>
                <TabsTrigger value="storico">Storico</TabsTrigger>
              </TabsList>

              {/* ---------------------------------------------- Panoramica */}
              <TabsContent value="panoramica" className="space-y-4 pt-4">
                {!hasRun && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base text-text-0">Configurazione iniziale</CardTitle>
                      <CardDescription className="text-text-1">Quattro passi per arrivare alla prima run.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {steps.map((step) => (
                        <div key={step.label} className="flex items-center gap-2 text-sm">
                          {step.done ? <CircleCheck className="size-4 text-gain" /> : <Circle className="size-4 text-text-2" />}
                          <span className={step.done ? 'text-text-1 line-through' : 'text-text-0'}>{step.label}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-text-0">Modalità di esecuzione</CardTitle>
                    <CardDescription className="text-text-1">
                      Determina fin dove si spinge il ciclo. Si cambia solo da qui e vale anche per le run automatiche.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-3">
                    {MODES.map((item) => {
                      const active = mode === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={loading}
                          onClick={() => (item.id === 'live' ? setConfirmLive(true) : void guarded(`Modalità ${item.title}`, () => autopilot.setMode(item.id)))}
                          className={cn(
                            'rounded-lg border p-3 text-left transition',
                            active ? 'border-agent bg-agent/10' : 'border-hairline bg-bg-2/40 hover:border-hairline-strong',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <item.icon className={cn('size-4', item.tone)} />
                            <span className={cn('text-sm font-semibold', item.tone)}>{item.title}</span>
                            {active && <Badge variant="default" className="ml-auto text-[10px]">attiva</Badge>}
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed text-text-1">{item.short}</p>
                        </button>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-text-0">Esegui adesso</CardTitle>
                    <CardDescription className="text-text-1">
                      Le run manuali non aspettano la cadenza. Quelle forzate in shadow o dry-run non toccano la modalità impostata.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <button type="button" disabled={loading}
                        onClick={() => void guarded('Snapshot eseguito', () => autopilot.trigger('snapshot'))}
                        className="rounded-lg border border-hairline bg-bg-2/40 p-3 text-left hover:border-hairline-strong">
                        <span className="flex items-center gap-2 text-sm font-medium text-text-0"><Activity className="size-4" /> Snapshot</span>
                        <p className="mt-1 text-xs leading-relaxed text-text-1">Legge il portafoglio e aggiorna gli indicatori. Niente AI, niente ordini.</p>
                      </button>
                      <button type="button" disabled={loading}
                        onClick={() => void guarded('Run shadow completata', () => autopilot.trigger('rebalance', 'shadow'))}
                        className="rounded-lg border border-hairline bg-bg-2/40 p-3 text-left hover:border-hairline-strong">
                        <span className="flex items-center gap-2 text-sm font-medium text-text-0"><Eye className="size-4" /> Ciclo completo in shadow</span>
                        <p className="mt-1 text-xs leading-relaxed text-text-1">Chiede la proposta all’AI e la valida, senza costruire ordini. Zero rischio.</p>
                      </button>
                      <button type="button" disabled={loading}
                        onClick={() => void guarded('Run dry-run completata', () => autopilot.trigger('rebalance', 'dry-run'))}
                        className="rounded-lg border border-hairline bg-bg-2/40 p-3 text-left hover:border-hairline-strong">
                        <span className="flex items-center gap-2 text-sm font-medium text-warn"><FlaskConical className="size-4" /> Ciclo completo in dry-run</span>
                        <p className="mt-1 text-xs leading-relaxed text-text-1">Costruisce gli ordini e chiede a eToro se sarebbero ammessi. Non li invia.</p>
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-bg-2/40 p-3">
                      <div>
                        <p className="text-sm font-medium text-text-0">{frozen ? 'Agente congelato' : 'Interruttore di emergenza'}</p>
                        <p className="text-xs text-text-1">
                          {frozen ? 'Nessuna run può generare ordini. Riattiva solo dopo aver verificato le posizioni su eToro.' : 'Blocca all’istante qualsiasi esecuzione, automatica o manuale.'}
                        </p>
                      </div>
                      {frozen ? (
                        <Button variant="outline" size="sm" disabled={loading} onClick={() => void guarded('Agente riattivato', () => autopilot.unfreeze())}>
                          <Unlock className="size-4" /> Riattiva
                        </Button>
                      ) : (
                        <Button variant="destructive" size="sm" disabled={loading} onClick={() => void guarded('Agente congelato', () => autopilot.freeze('freeze manuale dalla dashboard'))}>
                          <ShieldAlert className="size-4" /> Congela
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="guida" className="pt-4"><HowItWorks /></TabsContent>

              <TabsContent value="strategia" className="space-y-4 pt-4">
                <ProfileSelector current={config.strategyProfile} onApplied={refresh} />
                <GuardrailsEditor config={config} onSaved={refresh} />
              </TabsContent>

              <TabsContent value="watcher" className="pt-4"><WatcherPanel /></TabsContent>

              <TabsContent value="credenziali" className="pt-4">
                <CredentialsSection
                  credentials={state.credentials}
                  notificationsActive={state.notificationsActive}
                  onChanged={refresh}
                />
              </TabsContent>

              <TabsContent value="diagnostica" className="pt-4"><DiagnosticsPanel /></TabsContent>

              {/* ---------------------------------------------- Storico */}
              <TabsContent value="storico" className="space-y-4 pt-4">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-text-0">Storico esecuzioni</CardTitle>
                    <CardDescription className="text-text-1">
                      Ogni riga conserva input, proposta del modello, guardrail scattati e ordini. Clicca per il dettaglio completo.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="overflow-x-auto p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Quando</TableHead>
                          <TableHead>Tipo</TableHead>
                          <TableHead>Modalità</TableHead>
                          <TableHead>Esito</TableHead>
                          <TableHead className="text-right">Equity</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {runs.length === 0 && (
                          <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-text-1">Nessuna run registrata.</TableCell></TableRow>
                        )}
                        {runs.map((run) => (
                          <TableRow key={run.id} className="cursor-pointer" onClick={() => void openRun(run.id)}>
                            <TableCell className="whitespace-nowrap tabular-nums text-text-0">{fmtDate(run.started_at)}</TableCell>
                            <TableCell className="text-text-1">{KIND_LABEL[run.kind] ?? run.kind}</TableCell>
                            <TableCell><Badge variant="outline">{run.execution_mode}</Badge></TableCell>
                            <TableCell className={STATUS_LABEL[run.status]?.className}>{STATUS_LABEL[run.status]?.text ?? run.status}</TableCell>
                            <TableCell className="text-right tabular-nums text-text-0">{fmtUsd(run.equity_usd)}</TableCell>
                            <TableCell className="text-right"><ArrowRight className="ml-auto size-4 text-text-2" /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                {detail?.run && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base text-text-0">
                        <Clock className="size-4 text-agent" /> Dettaglio run
                      </CardTitle>
                      <CardDescription className="text-text-1">
                        {fmtDate(detail.run.started_at)} · {KIND_LABEL[detail.run.kind] ?? detail.run.kind} · modalità {detail.run.execution_mode}
                        {detail.run.error ? ` · errore: ${detail.run.error}` : ''}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Tabs defaultValue="proposta">
                        <TabsList className="w-full justify-start overflow-x-auto">
                          <TabsTrigger value="proposta">Proposta AI</TabsTrigger>
                          <TabsTrigger value="guardrail">Guardrail</TabsTrigger>
                          <TabsTrigger value="ordini">Ordini</TabsTrigger>
                          <TabsTrigger value="mercato">Mercato</TabsTrigger>
                          <TabsTrigger value="log">Log</TabsTrigger>
                        </TabsList>

                        <TabsContent value="proposta" className="space-y-3 pt-4">
                          {detail.proposal?.parsed ? (
                            <>
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="secondary">{detail.proposal.model}</Badge>
                                <Badge variant={detail.proposal.parsed.confidence >= config.minConfidence ? 'default' : 'outline'}>
                                  confidence {detail.proposal.parsed.confidence.toFixed(2)} (soglia {config.minConfidence})
                                </Badge>
                              </div>
                              <p className="text-sm leading-relaxed text-text-0">{detail.proposal.parsed.rationale}</p>
                              <div>
                                <p className="mb-1 text-xs text-text-1">Allocazione proposta</p>
                                <div className="flex flex-wrap gap-2">
                                  {Object.entries(detail.proposal.parsed.targetWeights).map(([symbol, weight]) => (
                                    <Badge key={symbol} variant="outline" className="tabular-nums">{symbol} {(weight * 100).toFixed(1)}%</Badge>
                                  ))}
                                </div>
                              </div>
                              {detail.proposal.parsed.risks.length > 0 && (
                                <p className="text-sm text-text-1">
                                  <span className="text-text-0">Rischi segnalati: </span>{detail.proposal.parsed.risks.join(' · ')}
                                </p>
                              )}
                            </>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-sm text-loss">{detail.proposal?.error ?? 'Nessuna proposta: questa run non ha coinvolto il modello.'}</p>
                              {Array.isArray(detail.proposal?.attempts) && detail.proposal.attempts.length > 0 && (
                                <div className="space-y-1 rounded-lg bg-bg-0 p-3">
                                  <p className="text-xs text-text-1">Tentativi per modello, in ordine:</p>
                                  {(detail.proposal.attempts as Array<{ model: string; format: string; ok: boolean; error?: string }>).map((attempt, index) => (
                                    <p key={index} className={cn('font-mono text-[11px]', attempt.ok ? 'text-gain' : 'text-text-1')}>
                                      {attempt.ok ? '✓' : '✗'} {attempt.model} [{attempt.format}]{attempt.error ? ` — ${attempt.error}` : ''}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </TabsContent>

                        <TabsContent value="guardrail" className="space-y-2 pt-4">
                          {detail.validation ? (
                            <>
                              <Badge variant={detail.validation.ok ? 'default' : 'destructive'}>
                                {detail.validation.ok ? 'Piano ammesso' : 'Piano bloccato'}
                              </Badge>
                              {detail.validation.violations.length === 0 && <p className="text-sm text-text-1">Nessun limite toccato.</p>}
                              {detail.validation.violations.map((item, index) => (
                                <div key={`${item.code}-${index}`} className="flex items-start gap-2 text-sm">
                                  <Badge variant={item.severity === 'blocking' ? 'destructive' : item.severity === 'clamped' ? 'secondary' : 'outline'}>
                                    {item.severity === 'blocking' ? 'blocco' : item.severity === 'clamped' ? 'ridotto' : 'nota'}
                                  </Badge>
                                  <span className="text-text-1">{item.message}</span>
                                </div>
                              ))}
                            </>
                          ) : <p className="text-sm text-text-1">Validazione non eseguita.</p>}
                        </TabsContent>

                        <TabsContent value="ordini" className="pt-4">
                          {detail.orders.length === 0 ? (
                            <p className="text-sm text-text-1">Nessun ordine generato: l’allocazione era già entro le bande di tolleranza.</p>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow><TableHead>Strumento</TableHead><TableHead>Lato</TableHead><TableHead className="text-right">Importo</TableHead><TableHead>Stato</TableHead><TableHead>Nota</TableHead></TableRow>
                              </TableHeader>
                              <TableBody>
                                {detail.orders.map((order, index) => (
                                  <TableRow key={`${order.symbol}-${index}`}>
                                    <TableCell className="font-medium text-text-0">{order.symbol}</TableCell>
                                    <TableCell className={order.side === 'buy' ? 'text-gain' : 'text-loss'}>{order.side === 'buy' ? 'ACQUISTA' : 'VENDI'}</TableCell>
                                    <TableCell className="text-right tabular-nums text-text-0">{fmtUsd(order.amount_usd)}</TableCell>
                                    <TableCell><Badge variant="outline">{order.state}</Badge></TableCell>
                                    <TableCell className="max-w-[280px] truncate text-xs text-text-1">{order.message}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </TabsContent>

                        <TabsContent value="mercato" className="space-y-3 pt-4">
                          {detail.features ? (
                            <>
                              <div className="flex flex-wrap gap-2">
                                <Badge variant="secondary">regime {detail.features.regime.label}</Badge>
                                <Badge variant="outline">VIX {detail.features.regime.vix ?? '—'}</Badge>
                                <Badge variant="outline">S&P vs media 200gg {detail.features.regime.spxVsSma200 ?? '—'}%</Badge>
                                <Badge variant="outline">curva 10y–2y {detail.features.regime.yieldCurveBp ?? '—'}bp</Badge>
                                <Badge variant="outline">sentiment notizie {detail.features.news.net}</Badge>
                              </div>
                              <ul className="space-y-1 text-sm">
                                {detail.features.news.top.slice(0, 6).map((item, index) => (
                                  <li key={index} className="text-text-1">• [{item.topic}] {item.t}</li>
                                ))}
                              </ul>
                              <div>
                                <p className="mb-1 text-xs text-text-1">Fonti dati interrogate</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {detail.features.sourceDiagnostics.map((source) => (
                                    <Badge key={source.name} variant={source.ok ? 'outline' : 'destructive'} className="text-[10px]">{source.name}</Badge>
                                  ))}
                                </div>
                              </div>
                            </>
                          ) : <p className="text-sm text-text-1">Indicatori non disponibili per questa run.</p>}
                        </TabsContent>

                        <TabsContent value="log" className="pt-4">
                          <div className="max-h-72 space-y-1 overflow-auto rounded-lg bg-bg-0 p-3 font-mono text-xs">
                            {detail.logs.map((log, index) => (
                              <div key={index} className={cn(log.level === 'error' ? 'text-loss' : log.level === 'warn' ? 'text-warn' : 'text-text-1')}>
                                {fmtDate(log.at)} [{log.stage}] {log.message}
                              </div>
                            ))}
                          </div>
                        </TabsContent>
                      </Tabs>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            </Tabs>
          </motion.div>
        </>
      )}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Attivare gli ordini reali?</AlertDialogTitle>
            <AlertDialogDescription>
              In modalità live il Worker invierà ordini veri sul tuo Agent Portfolio eToro, alla cadenza configurata e senza altra conferma.
              I guardrail restano attivi, ma il capitale allocato è a rischio. Attiva solo dopo settimane di osservazione in shadow e dry-run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              className="bg-loss text-white hover:bg-loss/90"
              onClick={() => void guarded('Modalità live attivata', () => autopilot.setMode('live'))}
            >
              Attiva ordini reali
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
