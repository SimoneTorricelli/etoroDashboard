/**
 * Autopilot (/autopilot) — pannello di controllo dell'agente server-side.
 *
 * Questa pagina non esegue logica di trading: legge e comanda il Worker, che è
 * l'unico titolare di credenziali ed esecuzione. Chiudere il browser non ferma
 * l'agente.
 */
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { toast, Toaster } from 'sonner';
import {
  Activity, Bot, Clock, Lock, PlayCircle,
  RefreshCw, ShieldAlert, Snowflake, Unlock, XCircle,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CredentialsSection } from '@/components/agent/CredentialsSection';
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

const MODE_LABEL: Record<ExecutionMode, string> = {
  shadow: 'Shadow — solo proposte',
  'dry-run': 'Dry-run — ordini simulati',
  live: 'Live — ordini reali',
};

const STATUS_STYLE: Record<string, string> = {
  ok: 'text-emerald-500',
  running: 'text-sky-500',
  blocked: 'text-amber-500',
  frozen: 'text-red-500',
  error: 'text-red-500',
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

  const connect = async () => {
    setBaseUrl(baseUrl);
    setControlToken(token);
    await refresh();
  };

  const guarded = async (label: string, task: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await task();
      toast.success(label);
      await refresh();
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

  return (
    <div className="grid grid-cols-12 gap-4">
      <Toaster position="top-right" richColors />

      <motion.div {...stagger(0)} className="col-span-12 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Bot className="size-6 text-primary" /> Autopilot
          </h1>
          <p className="text-sm text-muted-foreground">
            Agente server-side su Cloudflare. Gira anche a browser chiuso: questa pagina è solo il pannello di controllo.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} /> Aggiorna
        </Button>
      </motion.div>

      {/* Connessione al Worker */}
      <motion.div {...stagger(1)} className="col-span-12">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Lock className="size-4" /> Connessione</CardTitle>
            <CardDescription>
              Il token resta in sessionStorage e si cancella alla chiusura della scheda. Le chiavi eToro e OpenRouter non passano mai dal browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="ap-base">URL del Worker (vuoto = stessa origine)</Label>
              <Input id="ap-base" value={baseUrl} onChange={(event) => setBase(event.target.value)} placeholder="https://etorodashboard.tuo-account.workers.dev" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ap-token">CONTROL_TOKEN</Label>
              <Input id="ap-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="token di controllo" />
            </div>
            <Button onClick={() => void connect()} disabled={!token || loading}>Connetti</Button>
          </CardContent>
        </Card>
      </motion.div>

      {error && (
        <motion.div {...stagger(2)} className="col-span-12">
          <Alert variant="destructive">
            <XCircle className="size-4" />
            <AlertTitle>Connessione non riuscita</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </motion.div>
      )}

      {frozen && (
        <motion.div {...stagger(2)} className="col-span-12">
          <Alert variant="destructive">
            <Snowflake className="size-4" />
            <AlertTitle>Agente congelato</AlertTitle>
            <AlertDescription>
              {config?.frozenReason || 'Freeze manuale'} — nessun ordine verrà inviato finché non riattivi l'agente.
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

      {state && config && (
        <>
          {/* KPI */}
          <motion.div {...stagger(3)} className="col-span-12 grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2"><CardDescription>Equity portafoglio agent</CardDescription></CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">{fmtUsd(state.equityUsd)}</div>
                <p className="text-xs text-muted-foreground">Massimo storico {fmtUsd(state.highWaterMarkUsd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Drawdown corrente</CardDescription></CardHeader>
              <CardContent>
                <div className={cn('text-2xl font-semibold tabular-nums', state.drawdownPct > config.drawdownStopPct * 0.6 ? 'text-amber-500' : 'text-foreground')}>
                  {fmtPct(state.drawdownPct)}
                </div>
                <p className="text-xs text-muted-foreground">Stop automatico a {fmtPct(config.drawdownStopPct, 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Modalità</CardDescription></CardHeader>
              <CardContent>
                <Badge variant={mode === 'live' ? 'destructive' : mode === 'dry-run' ? 'default' : 'secondary'}>{MODE_LABEL[mode]}</Badge>
                <p className="mt-1 text-xs text-muted-foreground">Budget {config.budgetEur} EUR · cadenza {config.cadence}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Ultima run</CardDescription></CardHeader>
              <CardContent>
                <div className={cn('text-lg font-semibold', STATUS_STYLE[state.lastRun?.status ?? ''] ?? '')}>
                  {state.lastRun?.status ?? '—'}
                </div>
                <p className="text-xs text-muted-foreground">{fmtDate(state.lastRun?.started_at)} · {state.lastRun?.kind ?? '—'}</p>
              </CardContent>
            </Card>
          </motion.div>

          {/* Comandi */}
          <motion.div {...stagger(4)} className="col-span-12">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Comandi</CardTitle>
                <CardDescription>Le run manuali usano la modalità corrente se non ne forzi una.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={loading} onClick={() => void guarded('Snapshot eseguito', () => autopilot.trigger('snapshot'))}>
                  <Activity className="size-4" /> Snapshot
                </Button>
                <Button size="sm" variant="outline" disabled={loading} onClick={() => void guarded('Run shadow completata', () => autopilot.trigger('rebalance', 'shadow'))}>
                  <PlayCircle className="size-4" /> Run shadow
                </Button>
                <Button size="sm" variant="outline" disabled={loading} onClick={() => void guarded('Run dry-run completata', () => autopilot.trigger('rebalance', 'dry-run'))}>
                  <PlayCircle className="size-4" /> Run dry-run
                </Button>

                <Separator orientation="vertical" className="mx-1 h-6" />

                <Button size="sm" variant={mode === 'shadow' ? 'default' : 'ghost'} disabled={loading} onClick={() => void guarded('Modalità shadow', () => autopilot.setMode('shadow'))}>Shadow</Button>
                <Button size="sm" variant={mode === 'dry-run' ? 'default' : 'ghost'} disabled={loading} onClick={() => void guarded('Modalità dry-run', () => autopilot.setMode('dry-run'))}>Dry-run</Button>
                <Button size="sm" variant={mode === 'live' ? 'destructive' : 'ghost'} disabled={loading} onClick={() => setConfirmLive(true)}>Live</Button>

                <Separator orientation="vertical" className="mx-1 h-6" />

                {frozen ? (
                  <Button size="sm" variant="outline" disabled={loading} onClick={() => void guarded('Agente riattivato', () => autopilot.unfreeze())}>
                    <Unlock className="size-4" /> Riattiva
                  </Button>
                ) : (
                  <Button size="sm" variant="destructive" disabled={loading} onClick={() => void guarded('Agente congelato', () => autopilot.freeze('freeze manuale dalla dashboard'))}>
                    <ShieldAlert className="size-4" /> Congela
                  </Button>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Guardrail e sorgenti */}
          <motion.div {...stagger(5)} className="col-span-12 lg:col-span-4">
            <Card className="h-full">
              <CardHeader className="pb-3"><CardTitle className="text-base">Guardrail attivi</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {[
                  ['Ordini per run / giorno', `${config.maxOrdersPerRun} / ${config.maxOrdersPerDay}`],
                  ['Importo ordine', `${config.minOrderUsd} – ${config.maxOrderUsd} USD`],
                  ['Turnover massimo', fmtPct(config.maxTurnoverPct, 0)],
                  ['Banda di ribilanciamento', `${fmtPct(config.minRebalanceBandAbs, 0)} assoluta · ${fmtPct(config.minRebalanceBandRel, 0)} relativa`],
                  ['Cassa', `${fmtPct(config.minCashPct, 0)} – ${fmtPct(config.maxCashPct, 0)}`],
                  ['Confidence minima', config.minConfidence.toFixed(2)],
                  ['Stop drawdown', fmtPct(config.drawdownStopPct, 0)],
                  ['Universo', config.whitelist.map((item) => item.symbol).join(', ')],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="text-right font-medium tabular-nums">{value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div {...stagger(6)} className="col-span-12 lg:col-span-8">
            <CredentialsSection
              credentials={state.credentials}
              notificationsActive={state.notificationsActive}
              onChanged={refresh}
            />
          </motion.div>

          {/* Storico run */}
          <motion.div {...stagger(7)} className="col-span-12">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Storico run</CardTitle>
                <CardDescription>Ogni run conserva input, proposta del modello, violazioni e ordini.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
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
                      <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Nessuna run registrata.</TableCell></TableRow>
                    )}
                    {runs.map((run) => (
                      <TableRow key={run.id} className="cursor-pointer" onClick={() => void openRun(run.id)}>
                        <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(run.started_at)}</TableCell>
                        <TableCell>{run.kind}</TableCell>
                        <TableCell><Badge variant="outline">{run.execution_mode}</Badge></TableCell>
                        <TableCell className={STATUS_STYLE[run.status] ?? ''}>{run.status}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtUsd(run.equity_usd)}</TableCell>
                        <TableCell className="text-right"><Button variant="ghost" size="sm">Dettaglio</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </motion.div>

          {/* Dettaglio run */}
          {detail?.run && (
            <motion.div {...stagger(8)} className="col-span-12">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Clock className="size-4" /> Run {detail.run.id}
                  </CardTitle>
                  <CardDescription>{fmtDate(detail.run.started_at)} · {detail.run.kind} · {detail.run.execution_mode}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="proposta">
                    <TabsList>
                      <TabsTrigger value="proposta">Proposta</TabsTrigger>
                      <TabsTrigger value="guardrail">Guardrail</TabsTrigger>
                      <TabsTrigger value="ordini">Ordini</TabsTrigger>
                      <TabsTrigger value="mercato">Mercato</TabsTrigger>
                      <TabsTrigger value="log">Log</TabsTrigger>
                    </TabsList>

                    <TabsContent value="proposta" className="space-y-3 pt-4">
                      {detail.proposal?.parsed ? (
                        <>
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <Badge variant="secondary">{detail.proposal.model}</Badge>
                            <Badge variant={detail.proposal.parsed.confidence >= (config.minConfidence ?? 0.55) ? 'default' : 'outline'}>
                              confidence {detail.proposal.parsed.confidence.toFixed(2)}
                            </Badge>
                          </div>
                          <p className="text-sm leading-relaxed">{detail.proposal.parsed.rationale}</p>
                          <div className="flex flex-wrap gap-2">
                            {Object.entries(detail.proposal.parsed.targetWeights).map(([symbol, weight]) => (
                              <Badge key={symbol} variant="outline" className="tabular-nums">{symbol} {(weight * 100).toFixed(1)}%</Badge>
                            ))}
                          </div>
                          {detail.proposal.parsed.risks.length > 0 && (
                            <div className="text-sm">
                              <span className="text-muted-foreground">Rischi segnalati: </span>
                              {detail.proposal.parsed.risks.join(' · ')}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">{detail.proposal?.error ?? 'Nessuna proposta per questa run.'}</p>
                      )}
                    </TabsContent>

                    <TabsContent value="guardrail" className="pt-4">
                      {detail.validation ? (
                        <div className="space-y-2">
                          <Badge variant={detail.validation.ok ? 'default' : 'destructive'}>
                            {detail.validation.ok ? 'Piano ammesso' : 'Piano bloccato'}
                          </Badge>
                          {detail.validation.violations.length === 0 && <p className="text-sm text-muted-foreground">Nessuna violazione.</p>}
                          {detail.validation.violations.map((item, index) => (
                            <div key={`${item.code}-${index}`} className="flex items-start gap-2 text-sm">
                              <Badge variant={item.severity === 'blocking' ? 'destructive' : item.severity === 'clamped' ? 'secondary' : 'outline'}>{item.severity}</Badge>
                              <span>{item.message}</span>
                            </div>
                          ))}
                        </div>
                      ) : <p className="text-sm text-muted-foreground">Validazione non eseguita.</p>}
                    </TabsContent>

                    <TabsContent value="ordini" className="pt-4">
                      {detail.orders.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nessun ordine generato.</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow><TableHead>Strumento</TableHead><TableHead>Lato</TableHead><TableHead className="text-right">Importo</TableHead><TableHead>Stato</TableHead><TableHead>Nota</TableHead></TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.orders.map((order, index) => (
                              <TableRow key={`${order.symbol}-${index}`}>
                                <TableCell className="font-medium">{order.symbol}</TableCell>
                                <TableCell className={order.side === 'buy' ? 'text-emerald-500' : 'text-red-500'}>{order.side === 'buy' ? 'ACQUISTA' : 'VENDI'}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtUsd(order.amount_usd)}</TableCell>
                                <TableCell><Badge variant="outline">{order.state}</Badge></TableCell>
                                <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">{order.message}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </TabsContent>

                    <TabsContent value="mercato" className="space-y-3 pt-4">
                      {detail.features ? (
                        <>
                          <div className="flex flex-wrap gap-2 text-sm">
                            <Badge variant="secondary">regime {detail.features.regime.label}</Badge>
                            <Badge variant="outline">VIX {detail.features.regime.vix ?? '—'}</Badge>
                            <Badge variant="outline">SPX vs SMA200 {detail.features.regime.spxVsSma200 ?? '—'}%</Badge>
                            <Badge variant="outline">curva {detail.features.regime.yieldCurveBp ?? '—'}bp</Badge>
                            <Badge variant="outline">news {detail.features.news.net}</Badge>
                          </div>
                          <ul className="space-y-1 text-sm">
                            {detail.features.news.top.slice(0, 6).map((item, index) => (
                              <li key={index} className="text-muted-foreground">• [{item.topic}] {item.t}</li>
                            ))}
                          </ul>
                          <div className="flex flex-wrap gap-1.5">
                            {detail.features.sourceDiagnostics.map((source) => (
                              <Badge key={source.name} variant={source.ok ? 'outline' : 'destructive'} className="text-[10px]">{source.name}</Badge>
                            ))}
                          </div>
                        </>
                      ) : <p className="text-sm text-muted-foreground">Feature non disponibili.</p>}
                    </TabsContent>

                    <TabsContent value="log" className="pt-4">
                      <div className="max-h-72 space-y-1 overflow-auto font-mono text-xs">
                        {detail.logs.map((log, index) => (
                          <div key={index} className={cn(log.level === 'error' ? 'text-red-500' : log.level === 'warn' ? 'text-amber-500' : 'text-muted-foreground')}>
                            {fmtDate(log.at)} [{log.stage}] {log.message}
                          </div>
                        ))}
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </>
      )}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Attivare gli ordini reali?</AlertDialogTitle>
            <AlertDialogDescription>
              In modalità live il Worker invierà ordini veri sul tuo Agent Portfolio eToro, senza altra conferma, alla cadenza configurata.
              I guardrail restano attivi, ma il capitale allocato è a rischio. Attiva solo dopo aver osservato per settimane le run in shadow e dry-run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
