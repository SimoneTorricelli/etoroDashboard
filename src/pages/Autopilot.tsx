/**
 * Autopilot (/autopilot) — pannello di controllo dell'agente server-side.
 *
 * La pagina non esegue logica di trading: legge e comanda il Worker, unico
 * titolare di credenziali ed esecuzione. Chiudere il browser non ferma l'agente.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { toast, Toaster } from 'sonner';
import {
  Activity, ArrowRight, Bot, Circle, CircleCheck, Clock, Copy, Eye, FlaskConical,
  Lock, RefreshCw, ShieldAlert, Snowflake, Radio, Sparkles, Unlock, X, XCircle,
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
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { HowItWorks } from '@/components/autopilot/HowItWorks';
import { DiagnosticsPanel } from '@/components/autopilot/DiagnosticsPanel';
import { GuardrailsEditor } from '@/components/autopilot/GuardrailsEditor';
import { ProfileSelector } from '@/components/autopilot/ProfileSelector';
import { WatcherPanel } from '@/components/autopilot/WatcherPanel';
import { CredentialsSection } from '@/components/autopilot/CredentialsSection';
import { ActiveStrategyDashboard } from '@/components/autopilot/ActiveStrategyDashboard';
import {
  StrategyOnboarding, createStrategyOnboardingPreview,
  DEFAULT_STRATEGY_ONBOARDING_ANSWERS,
  type StrategyOnboardingAnswers, type StrategyOnboardingDraft,
  type StrategyOnboardingPortfolio,
} from '@/components/autopilot/StrategyOnboarding';
import { cn } from '@/lib/utils';
import {
  autopilot, getBaseUrl, getControlToken, isTokenRemembered, setBaseUrl, setControlToken,
  AutopilotError, LIVE_CONFIRMATION, LIVE_RECOVERY_EXECUTE_CONFIRMATION, LIVE_RECOVERY_PREPARE_CONFIRMATION,
  type AutopilotState, type ExecutionMode, type RunBundle, type RunSummary,
  type GuidedStrategyBundle, type LiveRecoveryPlanCandidate, type LiveRecoveryPreparationResult,
  type LlmAttempt, type StrategyCollaboration, type StrategyTraceEvent,
} from '@/lib/agent/autopilot-api';
import {
  buildLlmTechnicalReport, copyJsonToClipboard, llmAttemptDebugFacts,
} from '@/lib/agent/llm-diagnostics';

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
});

/** Arrotondamento a decimi con somma visiva sempre pari a 100,0%. */
function allocationRows(weights: Record<string, number>) {
  const entries = Object.entries(weights).filter(([, weight]) => Number(weight) >= 0);
  const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
  if (total <= 0) return [];
  const rows = entries.map(([symbol, weight], index) => {
    const exact = (Number(weight) / total) * 1000;
    return { symbol, index, units: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = 1000 - rows.reduce((sum, row) => sum + row.units, 0);
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    row.units += 1;
    remaining -= 1;
  }
  return rows.sort((a, b) => a.index - b.index).map(({ symbol, units }) => ({ symbol, percentage: units / 10 }));
}

function reconciliationRows(logs: RunBundle['logs'] | undefined) {
  const entry = [...(logs ?? [])].reverse().find((log) => log.stage === 'reconcile' && Array.isArray(log.data));
  if (!entry || !Array.isArray(entry.data)) return [];
  return entry.data.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const value = row as Record<string, unknown>;
    const symbol = typeof value.symbol === 'string' ? value.symbol : '';
    const expectedWeight = Number(value.expectedWeight);
    const actualWeight = Number(value.actualWeight);
    const divergence = Number(value.divergence);
    if (!symbol || ![expectedWeight, actualWeight, divergence].every(Number.isFinite)) return [];
    return [{ symbol, expectedWeight, actualWeight, divergence }];
  }).sort((left, right) => right.divergence - left.divergence);
}

function explainProposalError(error = '') {
  const totalMatch = error.match(/somma pesi\s+([0-9.]+)/i);
  if (totalMatch) {
    const total = Number(totalMatch[1]);
    if (Number.isFinite(total)) {
      const delta = Math.abs(1 - total) * 100;
      return total < 1
        ? `Il modello ha distribuito solo il ${(total * 100).toFixed(1)}%: manca il ${delta.toFixed(1)}%.`
        : `Il modello ha distribuito il ${(total * 100).toFixed(1)}%: supera il budget del ${delta.toFixed(1)}%.`;
    }
  }
  if (/risposta senza contenuto/i.test(error)) return 'Il provider ha risposto, ma non ha restituito un testo finale leggibile.';
  if (/non è un oggetto|targetWeights assente/i.test(error)) return 'La risposta non conteneva l’oggetto JSON di allocazione richiesto.';
  return error;
}

function summarizeProposalFailure(attempts: LlmAttempt[]): string {
  const categories = new Set(attempts.map((attempt) => attempt.debug?.category).filter((value): value is string => typeof value === 'string'));
  const reasons: string[] = [];
  if ([...categories].some((item) => ['timeout', 'aborted'].includes(item))) {
    reasons.push('Uno o più provider hanno superato il tempo limite o interrotto l’inferenza.');
  }
  if ([...categories].some((item) => ['rate_limit', 'capacity', 'provider_error', 'http_error'].includes(item))) {
    reasons.push('Altri tentativi sono stati rifiutati per quota, capacità o errore del servizio a monte.');
  }
  if ([...categories].some((item) => ['empty_content', 'truncated'].includes(item))) {
    reasons.push('Alcune risposte erano vuote o si sono fermate prima del risultato finale.');
  }
  if ([...categories].some((item) => ['invalid_json', 'schema_error'].includes(item))) {
    reasons.push('Alcune risposte non rispettavano il JSON o i vincoli dell’allocazione.');
  }
  if (!reasons.length) reasons.push('Nessun modello ha prodotto una proposta utilizzabile; i dettagli tecnici sono elencati sotto.');
  return `${reasons.join(' ')} Autopilot non ha creato ordini.`;
}

function ProposalAttemptRow({ attempt, explainError = false }: { attempt: LlmAttempt; explainError?: boolean }) {
  const facts = llmAttemptDebugFacts(attempt);
  const explanation = attempt.error ? explainProposalError(attempt.error) : '';
  return (
    <div>
      <p className={cn('break-all font-mono text-[11px]', attempt.ok ? 'text-gain' : 'text-text-1')}>
        {attempt.ok ? '✓' : '✗'} {attempt.provider ? `${attempt.provider}/` : ''}{attempt.model}
        {attempt.format ? ` [${attempt.format}]` : ''}
        {attempt.reasoningTier ? ` · ${attempt.reasoningTier}` : ''}
        {attempt.error ? ` — ${attempt.error}` : ''}
      </p>
      {facts.length > 0 ? <p className="mt-0.5 text-[10px] text-text-2">{facts.join(' · ')}</p> : null}
      {explainError && explanation && explanation !== attempt.error ? (
        <p className="mt-0.5 text-xs text-text-2">{explanation}</p>
      ) : null}
    </div>
  );
}

function CopyTechnicalReportButton({ attempts, runId }: { attempts: LlmAttempt[]; runId: string }) {
  const copyReport = async () => {
    try {
      await copyJsonToClipboard(buildLlmTechnicalReport({ source: 'proposal', attempts, runId }));
      toast.success('Report tecnico copiato negli appunti');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossibile copiare il report tecnico.');
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void copyReport()}>
      <Copy className="size-3.5" /> Copia report tecnico
    </Button>
  );
}

const MODES: Array<{ id: ExecutionMode; icon: typeof Eye; title: string; short: string; tone: string }> = [
  { id: 'shadow', icon: Eye, title: 'Shadow', short: 'Propone e basta. Nessun ordine viene costruito.', tone: 'text-text-0' },
  { id: 'dry-run', icon: FlaskConical, title: 'Dry-run', short: 'Costruisce gli ordini e li valida su eToro, ma non li invia.', tone: 'text-warn' },
  { id: 'live', icon: Radio, title: 'Live', short: 'All’attivazione esegue subito un ciclo reale e resta attiva per quelli futuri.', tone: 'text-loss' },
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
const fmtEur = (value: number | null | undefined) =>
  value == null ? '—' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(value);
const fmtPct = (value: number | null | undefined, digits = 1) =>
  value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
const fmtDate = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const LIVE_REUSE_REASON: Record<string, string> = {
  missing: 'non esiste ancora un dry-run completo',
  incomplete: 'il dry-run più recente non è completo',
  incompatible: 'il dry-run è precedente al nuovo flusso di attivazione',
  consumed: 'quella decisione è già stata usata per un’attivazione Live',
  expired: 'la decisione ha superato le due ore di validità',
  'config-changed': 'strategia o limiti sono cambiati dopo il dry-run',
  'portfolio-changed': 'il collegamento all’Agent Portfolio è cambiato',
  blocked: 'il dry-run più recente è stato bloccato',
  error: 'il dry-run più recente è terminato con errore',
  frozen: 'il dry-run più recente è stato congelato',
  running: 'il dry-run più recente è ancora in corso',
};

function explainLiveReuseReason(reason: string) {
  return LIVE_REUSE_REASON[reason] ?? (reason || 'la decisione non è riutilizzabile');
}

const PREVIEW_COLLABORATION: StrategyCollaboration = {
  version: 1,
  mode: 'multi-model-review',
  status: 'validated',
  leadModel: 'workers-ai/@cf/openai/gpt-oss-120b',
  reviewerModels: ['gemini/gemini-3.7-flash', 'openrouter/openrouter/free'],
  finalModel: 'workers-ai/@cf/openai/gpt-oss-120b',
  reviews: [
    { reviewer: 'gemini/gemini-3.7-flash', verdict: 'approve', summary: 'Budget, rischio e diversificazione sono coerenti con il profilo scelto.', strengths: ['Universo dinamico ben delimitato'], concerns: [], requiredChanges: [], confidence: 0.88 },
    { reviewer: 'openrouter/openrouter/free', verdict: 'approve', summary: 'I limiti per asset, settore e liquidità rendono la policy applicabile in shadow.', strengths: ['Guardrail chiari'], concerns: [], requiredChanges: [], confidence: 0.83 },
  ],
  trace: [
    { id: 'preview-1', at: 1, stage: 'intake', status: 'passed', title: 'Preferenze tradotte in vincoli', summary: 'Obiettivo, budget e rischio sono diventati un contratto strutturato.', handoff: ['Onboarding normalizzato', 'Vincoli di consenso'] },
    { id: 'preview-2', at: 2, stage: 'lead', status: 'passed', title: 'Prima proposta pronta', model: 'workers-ai/@cf/openai/gpt-oss-120b', summary: 'La policy completa passa ai revisori indipendenti.', handoff: ['StrategySpec', 'Regole di universo dinamico'] },
    { id: 'preview-3', at: 3, stage: 'review', status: 'passed', title: 'Policy approvata', model: 'gemini/gemini-3.7-flash', summary: 'Consenso, rischio e fattibilità risultano coerenti.', handoff: ['Verdetto sintetico', 'Punti di forza'] },
    { id: 'preview-4', at: 4, stage: 'review', status: 'passed', title: 'Seconda validazione completata', model: 'openrouter/openrouter/free', summary: 'La strategia è applicabile con il budget dichiarato.', handoff: ['Esito revisione', 'Checklist budget'] },
    { id: 'preview-5', at: 5, stage: 'deterministic', status: 'passed', title: 'Controllo finale dei guardrail', summary: 'Nessun modello può oltrepassare i limiti verificati.' },
    { id: 'preview-6', at: 6, stage: 'complete', status: 'passed', title: 'Strategia pronta', summary: 'La policy validata può partire in shadow.' },
  ],
};

export default function Autopilot() {
  const [token, setToken] = useState(() => getControlToken());
  const [baseUrl, setBase] = useState(() => getBaseUrl());
  const [state, setState] = useState<AutopilotState | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [safeStopping, setSafeStopping] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [verifiedWorkerOrigin, setVerifiedWorkerOrigin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [liveConfirmation, setLiveConfirmation] = useState('');
  const [livePersistenceAcknowledged, setLivePersistenceAcknowledged] = useState(false);
  const [liveActivationId, setLiveActivationId] = useState('');
  const [activatingLive, setActivatingLive] = useState(false);
  const [recoveryPreview, setRecoveryPreview] = useState<LiveRecoveryPreparationResult | null>(null);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [selectedRecoveryRunId, setSelectedRecoveryRunId] = useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [executingRecovery, setExecutingRecovery] = useState(false);
  const [remember, setRemember] = useState(() => (
    isTokenRemembered()
    || (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches)
  ));
  const [connected, setConnected] = useState(false);
  const [editingConnection, setEditingConnection] = useState(() => !getControlToken());
  const [storageWarning, setStorageWarning] = useState(false);
  const onboardingQuery = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('onboarding')
    : null;
  const activeStrategyPreview = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('preview') === 'active-strategy';
  const [onboardingOpen, setOnboardingOpen] = useState(Boolean(onboardingQuery));
  const [onboardingPortfolios, setOnboardingPortfolios] = useState<StrategyOnboardingPortfolio[] | undefined>();
  const [strategyBundle, setStrategyBundle] = useState<GuidedStrategyBundle<StrategyOnboardingDraft> | null>(null);
  const [strategyTrace, setStrategyTrace] = useState<StrategyTraceEvent[]>([]);
  const [activeTab, setActiveTab] = useState('panoramica');
  const [activatedStrategyName, setActivatedStrategyName] = useState('');
  const [reviewingSavedStrategy, setReviewingSavedStrategy] = useState(false);
  const refreshSequence = useRef(0);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setReviewingSavedStrategy(false);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('onboarding');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const openOnboarding = useCallback(() => {
    setStrategyBundle(null);
    setStrategyTrace([]);
    setActivatedStrategyName('');
    setReviewingSavedStrategy(false);
    setOnboardingOpen(true);
  }, []);

  const openSavedStrategy = useCallback(() => {
    setReviewingSavedStrategy(true);
    setOnboardingOpen(true);
  }, []);

  const openLiveConfirmation = useCallback(() => {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      toast.error('Questo browser non può creare un identificatore sicuro per la run Live. Aggiornalo e riprova.');
      return;
    }
    setLiveActivationId(crypto.randomUUID());
    setLiveConfirmation('');
    setLivePersistenceAcknowledged(false);
    setConfirmLive(true);
  }, []);

  const setLiveDialogOpen = useCallback((open: boolean) => {
    if (activatingLive && !open) return;
    setConfirmLive(open);
    if (!open) {
      setLiveConfirmation('');
      setLivePersistenceAcknowledged(false);
      setLiveActivationId('');
    }
  }, [activatingLive]);

  const refresh = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!getControlToken()) {
      setState(null);
      setConnected(false);
      setVerifiedWorkerOrigin(null);
      setEditingConnection(true);
      return false;
    }
    const requestId = ++refreshSequence.current;
    if (!background) setLoading(true);
    setError(null);
    try {
      // Lo stato è la fonte critica per modalità e stop remoto. Lo storico è
      // opzionale: un suo errore non deve far sparire capitale e interruttore.
      const runsRequest = background
        ? Promise.resolve(null)
        : autopilot.runs(40).then((value) => value, () => null);
      const nextState = await autopilot.state();
      if (requestId !== refreshSequence.current) return false;
      setState(nextState);
      setRuns(Array.isArray(nextState.recentRuns) ? nextState.recentRuns : []);
      setConnected(true);
      setVerifiedWorkerOrigin(getBaseUrl());
      setEditingConnection(false);
      setLastRefreshedAt(Date.now());
      // Lo storico prosegue senza trattenere refresh e comandi di emergenza.
      void runsRequest.then((nextRuns) => {
        if (nextRuns && requestId === refreshSequence.current) setRuns(nextRuns.runs);
      });
      return true;
    } catch (caught) {
      if (requestId !== refreshSequence.current) return false;
      setConnected(false);
      if (!background) setEditingConnection(true);
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  const connect = useCallback(async () => {
    const previousBaseUrl = getBaseUrl();
    const previousToken = getControlToken();
    const previousRemember = isTokenRemembered();
    const hadVerifiedState = Boolean(state && verifiedWorkerOrigin);
    setConnected(false);
    try {
      const normalizedBaseUrl = setBaseUrl(baseUrl);
      setBase(normalizedBaseUrl);
      const persisted = setControlToken(token.trim(), remember);
      setStorageWarning(!persisted);
      const success = await refresh();
      if (success) {
        setEditingConnection(false);
        toast.success('Autopilot connesso. Dati del Worker caricati.');
      } else if (hadVerifiedState) {
        // Non lasciare mai uno snapshot del vecchio Worker abbinato alle nuove
        // credenziali: ripristiniamo la connessione verificata e la ricontrolliamo.
        const restoredBaseUrl = setBaseUrl(previousBaseUrl);
        setControlToken(previousToken, previousRemember);
        setBase(restoredBaseUrl);
        setToken(previousToken);
        const restored = await refresh({ background: true });
        if (restored) {
          setEditingConnection(false);
          toast.warning('Nuova connessione non valida: è stata ripristinata quella precedente.');
        }
      }
    } catch (caught) {
      setConnected(hadVerifiedState && getBaseUrl() === verifiedWorkerOrigin);
      setEditingConnection(true);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [baseUrl, token, remember, refresh, state, verifiedWorkerOrigin]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasRemoteState = Boolean(state);
  useEffect(() => {
    if (!hasRemoteState || !getControlToken()) return;
    const update = () => void refresh({ background: true });
    const intervalId = window.setInterval(update, 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') update();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [hasRemoteState, refresh]);

  useEffect(() => {
    if (state?.config && !state.config.onboardingComplete && getControlToken()) setOnboardingOpen(true);
  }, [state]);

  useEffect(() => {
    if (!onboardingOpen || !getControlToken()) return;
    let cancelled = false;
    void autopilot.agentPortfolios()
      .then(({ portfolios }) => {
        if (cancelled) return;
        const activeId = state?.config?.activeAgentPortfolioId;
        const verified = Boolean(state?.agentBindingVerified);
        setOnboardingPortfolios(portfolios.map((portfolio) => ({
          id: portfolio.id,
          name: portfolio.name,
          subtitle: portfolio.id === activeId && verified ? 'Agent Portfolio verificato' : 'Agent Portfolio esistente',
          status: portfolio.id === activeId && verified ? 'connected' : 'needs-token',
        })));
      })
      .catch(() => {
        if (!cancelled) setOnboardingPortfolios(undefined);
      });
    return () => { cancelled = true; };
  }, [onboardingOpen, state?.config?.activeAgentPortfolioId, state?.agentBindingVerified]);

  const guarded = async (label: string, task: () => Promise<unknown>) => {
    setLoading(true);
    try {
      const result = await task() as { status?: string; error?: string; reason?: string; runId?: string; warming?: boolean; busy?: boolean };
      if (result?.status === 'error') toast.error(`Run fallita: ${result.error ?? 'errore sconosciuto'}`);
      else if (result?.status === 'blocked' && result.busy) toast.info(result.error ?? 'Un’altra run è già in corso. Nessun secondo ciclo è stato avviato.');
      else if (result?.status === 'blocked' && result.warming) toast.info(result.reason ?? 'Storici in preparazione: ripeti il ciclo fra poco.');
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

  const safeStop = async () => {
    setSafeStopping(true);
    try {
      if (!verifiedWorkerOrigin || getBaseUrl() !== verifiedWorkerOrigin) {
        throw new Error('Connessione Worker non verificata: aggiorna lo stato prima di inviare lo stop.');
      }
      const result = await autopilot.safeStop('arresto remoto dalla dashboard');
      // La risposta del comando è autoritativa. Invalidiamo qualunque refresh
      // precedente, così una risposta lenta non può ridisegnare lo stato live.
      refreshSequence.current += 1;
      setState((current) => current ? { ...current, config: result.config } : current);
      setConnected(true);
      setError(null);
      setLastRefreshedAt(Date.now());
      toast.success('Autopilot arrestato: modalità Shadow e freeze attivi.');
      void refresh({ background: true });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSafeStopping(false);
    }
  };

  const prepareRecovery = async () => {
    setLoading(true);
    try {
      if (!verifiedWorkerOrigin || getBaseUrl() !== verifiedWorkerOrigin) {
        throw new Error('Connessione Worker non verificata: aggiorna lo stato prima di preparare la ripresa.');
      }
      const safetyRevision = Number(config?.safetyRevision);
      if (!Number.isInteger(safetyRevision) || safetyRevision < 0) {
        throw new Error('Revisione di sicurezza assente: aggiorna lo stato prima di preparare la ripresa.');
      }
      const result = await autopilot.prepareRecovery({
        safetyRevision,
        confirmation: LIVE_RECOVERY_PREPARE_CONFIRMATION,
      });
      refreshSequence.current += 1;
      setState((current) => current ? { ...current, config: result.config } : current);
      if (result.status === 'ready') {
        const selected = result.selectedSourceRunId ?? result.candidates?.[0]?.sourceRunId ?? '';
        setRecoveryPreview(result);
        setSelectedRecoveryRunId(selected);
        setRecoveryConfirmation('');
        setRecoveryAcknowledged(false);
        setRecoveryDialogOpen(true);
        toast.success(`Verifica completata: ${result.alreadyAcquired ?? 0} acquisti già riconosciuti`, {
          description: [
            result.warnings?.[0],
            'Nessun ordine inviato. L’agente resta congelato finché non scegli e confermi il piano da completare.',
          ].filter(Boolean).join(' '),
          duration: 12_000,
        });
      } else {
        toast.warning(result.reason ?? 'Recovery non ancora pronta', {
          description: result.unresolved?.slice(0, 4).join(' · ') || 'L’agente resta congelato e nessun ordine viene inviato.',
          duration: 15_000,
        });
      }
      await refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const executeRecovery = async () => {
    if (
      !recoveryPreview
      || !selectedRecoveryRunId
      || recoveryConfirmation !== LIVE_RECOVERY_EXECUTE_CONFIRMATION
      || !recoveryAcknowledged
    ) return;
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      toast.error('Questo browser non può creare un identificatore sicuro per la recovery.');
      return;
    }
    setExecutingRecovery(true);
    setLoading(true);
    try {
      const safetyRevision = Number(recoveryPreview.config.safetyRevision);
      if (!Number.isInteger(safetyRevision) || safetyRevision < 0) {
        throw new Error('Revisione di sicurezza assente: ripeti la verifica degli acquisti.');
      }
      const result = await autopilot.executeRecovery({
        activationId: crypto.randomUUID(),
        sourceRunId: selectedRecoveryRunId,
        safetyRevision,
        confirmation: LIVE_RECOVERY_EXECUTE_CONFIRMATION,
        acknowledgePersistentLive: true,
      });
      const detailMessage = result.error ?? result.reason ?? '';
      if (result.safetyPersisted === false) {
        toast.error('ALLARME CRITICO: arresto non confermato. Verifica subito eToro e non ripetere la recovery.', { duration: Infinity });
      } else if (result.status === 'ok' && result.recoveryCompleted) {
        toast.success('Piano completato sui dati aggiornati. Gli acquisti già presenti non sono stati ripetuti e l’Autopilot resta Live.');
        setRecoveryDialogOpen(false);
        setRecoveryPreview(null);
      } else if (result.status === 'frozen') {
        toast.error(`Recovery fermata e agente congelato: ${detailMessage || 'verifica la run eToro'}`);
      } else {
        toast.warning(`Recovery non completata: ${detailMessage || 'apri il dettaglio della run'}`);
      }
      if (result.persistenceWarning) toast.warning(result.persistenceWarning, { duration: 20_000 });
      await refresh();
      if (result.runId) {
        setActiveTab('storico');
        await openRun(result.runId);
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExecutingRecovery(false);
      setLoading(false);
    }
  };

  const openRun = async (id: string) => {
    try { setDetail(await autopilot.run(id)); } catch (caught) { toast.error(caught instanceof Error ? caught.message : String(caught)); }
  };

  const activateLiveNow = async () => {
    if (!liveActivationId || liveConfirmation !== LIVE_CONFIRMATION || !livePersistenceAcknowledged) return;
    setActivatingLive(true);
    setLoading(true);
    try {
      const result = await autopilot.activateLive({
        activationId: liveActivationId,
        confirmation: liveConfirmation,
        acknowledgePersistentLive: livePersistenceAcknowledged,
      });
      const resultMessage = result.error ?? result.reason ?? 'nessun dettaglio disponibile';
      if (result.safetyPersisted === false) {
        toast.error('ALLARME CRITICO: arresto di sicurezza non confermato', {
          description: 'Il Worker non ha potuto salvare Shadow + Frozen. Non assumere che gli invii siano fermi: controlla subito ordini e posizioni su eToro e prova “Arresta in sicurezza” dalla dashboard.',
          duration: Infinity,
        });
      } else if (result.status === 'frozen') {
        toast.error(`Esecuzione fermata e Autopilot congelato in Shadow: ${resultMessage}`);
      } else if (result.status === 'error') {
        toast.error(result.mode === 'live'
          ? `Run fallita, ma la modalità risulta Live: ${resultMessage}. Usa “Arresta in sicurezza” se non vuoi i cicli futuri.`
          : `Run Live fallita prima dell’attivazione: ${resultMessage}`);
      } else if (result.status === 'blocked') {
        toast.warning(result.mode === 'live'
          ? `Live è attiva, ma l’esecuzione immediata è stata bloccata: ${resultMessage}`
          : `Live non è stata attivata: ${resultMessage}`);
      } else if (result.action === 'none' || result.plan?.orderCount === 0) {
        toast.success('Live attivata: il portfolio era già entro le bande, quindi questa run non ha inviato ordini.');
      } else if (result.decisionSource === 'reused-dry-run') {
        toast.success('Live attivata: decisione del dry-run riutilizzata e ordini reali elaborati sui dati aggiornati.');
      } else {
        toast.success('Live attivata: nuova analisi completata e ciclo reale eseguito.');
      }
      if (result.persistenceWarning) {
        toast.warning('Esito Live non salvato per un replay affidabile', {
          description: `${result.persistenceWarning} Controlla la run e non avviare una nuova attivazione per compensare.`,
          duration: 20_000,
        });
      }
      await refresh();
      if (result.runId) {
        setActiveTab('storico');
        await openRun(result.runId);
      }
      setConfirmLive(false);
      setLiveConfirmation('');
      setLivePersistenceAcknowledged(false);
      setLiveActivationId('');
    } catch (caught) {
      // Il dialog resta aperto e conserva activationId: riprovare è sicuro
      // anche se il Worker avesse concluso la prima richiesta senza risposta.
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      setActivatingLive(false);
    }
  };

  const generateGuidedStrategy = async (answers: StrategyOnboardingAnswers): Promise<StrategyOnboardingDraft> => {
    setStrategyTrace([]);
    if (!getControlToken()) {
      toast.info('Anteprima locale pronta. Collega il Worker prima di attivarla.');
      return createStrategyOnboardingPreview(answers);
    }
    let bundle: GuidedStrategyBundle<StrategyOnboardingDraft>;
    try {
      bundle = await autopilot.strategyDraftStream<StrategyOnboardingDraft>(
        answers as unknown as Record<string, unknown>,
        (event) => setStrategyTrace((current) => [...current.filter((item) => item.id !== event.id), event]),
      );
    } catch (caught) {
      if (!(caught instanceof AutopilotError) || ![404, 405].includes(caught.status)) throw caught;
      bundle = await autopilot.strategyDraft<StrategyOnboardingDraft>(answers as unknown as Record<string, unknown>);
    }
    setStrategyBundle(bundle);
    setStrategyTrace(bundle.collaboration?.trace ?? []);
    if (bundle.generation.source === 'ai') toast.success(`Strategia generata da ${bundle.generation.model}`);
    else toast.info('Strategia sicura generata deterministicamente: i provider AI non erano disponibili.');
    return bundle.draft;
  };

  const activateGuidedStrategy = async (draft: StrategyOnboardingDraft, answers: StrategyOnboardingAnswers) => {
    if (!getControlToken()) throw new Error('Collega prima il Worker con il CONTROL_TOKEN. La bozza locale non è stata attivata.');
    const selected = onboardingPortfolios?.find((portfolio) => portfolio.id === answers.portfolioId);
    const isVerified = selected?.status === 'connected'
      || (state?.config?.activeAgentPortfolioId === answers.portfolioId && Boolean(state?.agentBindingVerified));
    if (!isVerified) {
      const generated = await autopilot.generateAgentToken(answers.portfolioId, selected?.name);
      toast.success(`Token ${generated.hint} verificato sul portfolio selezionato.`);
    }
    let bundle = strategyBundle;
    const effectiveAnswers = answers;
    if (!bundle) {
      bundle = await autopilot.strategyDraft<StrategyOnboardingDraft>(effectiveAnswers as unknown as Record<string, unknown>);
      setStrategyBundle(bundle);
    }
    const activation = await autopilot.activateStrategy<StrategyOnboardingDraft>({
      answers: effectiveAnswers as unknown as Record<string, unknown>,
      strategySpec: bundle.strategySpec,
      portfolioId: answers.portfolioId,
      generatedBy: bundle.generation.model ?? bundle.generation.source,
      reviewMaxDrawdownPct: draft.riskRangePct,
      collaboration: bundle.collaboration,
    });
    await refresh();
    setActivatedStrategyName(draft.strategyName);
    setActiveTab('strategia');
    closeOnboarding();
    toast.success(`“${draft.strategyName}” è attiva in shadow. Nessun ordine reale verrà inviato.${activation.telegramQueued ? ' Riepilogo Telegram in invio.' : ''}`);
  };

  const config = state?.config;
  const mode = config?.executionMode ?? 'shadow';
  const frozen = Boolean(config?.frozen);
  const safelyStopped = frozen && mode === 'shadow';
  const dryRunForLive = state?.liveActivation?.dryRun ?? null;
  const willReuseDryRun = Boolean(dryRunForLive?.reusable);
  const selectedRecoveryCandidate: LiveRecoveryPlanCandidate | null = recoveryPreview?.candidates
    ?.find((candidate) => candidate.sourceRunId === selectedRecoveryRunId) ?? null;
  const detailReconciliationRows = reconciliationRows(detail?.logs);
  const workerOrigin = getBaseUrl()
    || (typeof window !== 'undefined' ? window.location.origin : 'stessa origine');
  const realRuns = config?.realCapitalTrackingStartedAt
    ? runs.filter((run) => run.started_at >= Number(config.realCapitalTrackingStartedAt))
    : [];

  const requiredCredentials = (state?.credentials ?? []).filter((item) => item.required);
  const credentialsOk = requiredCredentials.length > 0 && requiredCredentials.every((item) => item.configured);
  const hasRun = realRuns.length > 0;
  const showConnectionForm = editingConnection || !state;

  if (activeStrategyPreview) {
    const previewDraft = createStrategyOnboardingPreview(DEFAULT_STRATEGY_ONBOARDING_ANSWERS);
    const previewConfig = {
      ...(state?.config ?? {}),
      executionMode: 'shadow',
      budgetEur: DEFAULT_STRATEGY_ONBOARDING_ANSWERS.budgetEur,
    } as AutopilotState['config'];
    const previewNow = Date.now();
    const previewCurve = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin(index / 2.4) * 54;
      const equity = 10000 + index * 17 + wave;
      return { at: previewNow - (17 - index) * 86_400_000, equity_usd: equity, invested_usd: equity * .97, cash_usd: equity * .03, hwm_usd: Math.max(10000, equity) };
    });
    return (
      <div className="min-h-screen bg-[#f8f7f1] p-3 sm:p-6">
        <ActiveStrategyDashboard
          config={previewConfig}
          draft={previewDraft}
          answers={DEFAULT_STRATEGY_ONBOARDING_ANSWERS}
          collaboration={PREVIEW_COLLABORATION}
          equityCurve={previewCurve}
          onReview={() => undefined}
          onDryRun={() => undefined}
        />
      </div>
    );
  }

  const steps = [
    { done: Boolean(state), label: 'Connetti la dashboard al Worker' },
    { done: credentialsOk, label: 'Inserisci le credenziali obbligatorie' },
    { done: state?.notificationsActive ?? false, label: 'Collega Telegram (facoltativo ma consigliato)' },
    { done: hasRun, label: 'Lancia la prima run in shadow' },
  ];

  if (onboardingOpen) {
    const showReview = reviewingSavedStrategy || onboardingQuery === 'review';
    const previewAnswers = DEFAULT_STRATEGY_ONBOARDING_ANSWERS;
    const savedAnswers = state?.config?.guidedOnboardingAnswers as Partial<StrategyOnboardingAnswers> | null | undefined;
    const initialAnswers = {
      ...previewAnswers,
      ...(reviewingSavedStrategy ? savedAnswers : null),
      budgetEur: reviewingSavedStrategy
        ? savedAnswers?.budgetEur ?? state?.config?.budgetEur ?? previewAnswers.budgetEur
        : state?.config?.budgetEur ?? previewAnswers.budgetEur,
      strategyName: reviewingSavedStrategy
        ? savedAnswers?.strategyName ?? state?.config?.strategyName ?? previewAnswers.strategyName
        : state?.config?.strategyName || previewAnswers.strategyName,
      portfolioId: reviewingSavedStrategy
        ? savedAnswers?.portfolioId ?? state?.config?.activeAgentPortfolioId ?? previewAnswers.portfolioId
        : state?.config?.activeAgentPortfolioId || previewAnswers.portfolioId,
    };
    const savedDraft = state?.config?.strategyDraft as StrategyOnboardingDraft | null | undefined;
    return (
      <div className="fixed inset-y-0 left-0 right-0 z-50 overflow-y-auto bg-[#faf9f5] md:left-16 xl:left-[232px]">
        <Toaster position="top-right" richColors />
        <button
          type="button"
          onClick={closeOnboarding}
          className="fixed right-4 top-3 z-[60] grid size-9 place-items-center rounded-full border border-[#233a2c1f] bg-white/90 text-[#56645c] shadow-sm backdrop-blur transition-colors hover:text-[#0d5434] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d5434]"
          aria-label="Chiudi onboarding e torna ad Autopilot"
          title="Torna ad Autopilot"
        >
          <X className="size-4" />
        </button>
        <StrategyOnboarding
          portfolios={onboardingPortfolios}
          initialAnswers={initialAnswers}
          initialStep={showReview ? 'review' : 'goals'}
          initialDraft={showReview ? savedDraft ?? createStrategyOnboardingPreview(initialAnswers) : null}
          onGenerate={generateGuidedStrategy}
          onActivate={activateGuidedStrategy}
          generationTrace={strategyTrace}
          collaboration={strategyBundle?.collaboration ?? state?.config?.strategyCollaboration ?? null}
          readOnly={reviewingSavedStrategy && Boolean(savedDraft)}
        />
      </div>
    );
  }

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
        <Button size="sm" onClick={openOnboarding}>
          <Bot className="size-4" /> Nuova strategia guidata
        </Button>
      </motion.div>

      {/* Connessione */}
      <motion.div {...stagger(1)} className="col-span-12">
        <Card>
          <CardHeader className="pb-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base text-text-0">
                <Lock className="size-4 text-agent" /> Connessione al Worker
                {connected && state ? <Badge className="bg-gain/15 text-gain hover:bg-gain/15">Connesso</Badge> : null}
              </CardTitle>
              <CardDescription className="text-text-1">
                {connected && state
                  ? <>Connessione verificata con <code className="rounded bg-bg-2 px-1">{workerOrigin}</code>. Lo stato qui sotto arriva dal Worker.</>
                  : <>
                    Il <strong className="text-text-0">CONTROL_TOKEN</strong> è la password dell’agente, quella che hai generato con <code className="rounded bg-bg-2 px-1">openssl rand -base64 32</code> e
                    caricato con <code className="rounded bg-bg-2 px-1">wrangler secret put</code>. Puoi conservarla su questo dispositivo per il controllo da telefono.
                  </>}
            </CardDescription>
            </div>
            {!showConnectionForm ? (
              <Button variant="outline" size="sm" onClick={() => setEditingConnection(true)}>
                Cambia connessione
              </Button>
            ) : null}
          </CardHeader>
          {showConnectionForm ? (
            <>
              <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="grid gap-1.5">
                  <Label htmlFor="ap-base" className="text-text-0">URL del Worker</Label>
                  <Input id="ap-base" value={baseUrl} onChange={(event) => setBase(event.target.value)} placeholder="vuoto = stessa origine del sito" />
                  <p className="text-[11px] leading-relaxed text-text-2">
                    Usa solo l’origine, per esempio <code>https://etorodashboard…workers.dev</code>. Se incolli <code>/autopilot</code>,
                    il percorso viene rimosso automaticamente; sul sito pubblicato puoi lasciare il campo vuoto.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ap-token" className="text-text-0">CONTROL_TOKEN</Label>
                  <Input id="ap-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="incolla il token" />
                </div>
                <Button onClick={() => void connect()} disabled={!token.trim() || loading}>
                  {loading ? <RefreshCw className="size-4 animate-spin" /> : null} Connetti
                </Button>
              </CardContent>
              <CardContent className="pt-0">
                <label className="flex items-start gap-2 text-xs text-text-1">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-current"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  <span>
                    Ricorda su questo dispositivo. Consigliato su telefono, dove il browser scarica le schede in background e
                    altrimenti dovresti reinserire il token ogni volta. Il token resta su questo dispositivo ed è trasmesso soltanto
                    all’origine del Worker mostrata sopra, per autenticare le richieste.
                  </span>
                </label>
                {storageWarning && (
                  <p className="mt-2 text-xs text-warn">
                    Il browser non ha permesso di salvare il token (navigazione privata o restrizioni di storage). La connessione
                    funziona lo stesso, ma dovrai reinserirlo se ricarichi la pagina.
                  </p>
                )}
              </CardContent>
            </>
          ) : null}
        </Card>
      </motion.div>

      {!connected && !error && (
        <motion.div {...stagger(2)} className="col-span-12">
          <Alert>
            <Lock className="size-4" />
            <AlertTitle>Non connesso</AlertTitle>
            <AlertDescription>
              Incolla il CONTROL_TOKEN qui sopra e premi Connetti. È il segreto che hai caricato sul Worker con
              <code className="mx-1 rounded bg-bg-2 px-1">wrangler secret put CONTROL_TOKEN</code>.
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

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
          <motion.div {...stagger(3)} className="col-span-12">
            <Alert>
              <Radio className="size-4" />
              <AlertTitle>Stato condiviso tra i tuoi dispositivi</AlertTitle>
              <AlertDescription>
                Strategia, portfolio, capitale, drawdown e modalità sono salvati nel Worker/D1: ricompaiono su ogni dispositivo
                collegato a <code className="rounded bg-bg-2 px-1">{workerOrigin}</code> con lo stesso CONTROL_TOKEN. Le pagine
                Panoramica, Portfolio e Agent generico restano invece locali al singolo browser.
              </AlertDescription>
            </Alert>
          </motion.div>

          <motion.div
            {...stagger(3)}
            className="sticky top-14 z-20 col-span-12 rounded-xl border border-hairline-strong bg-bg-0/95 p-3 shadow-lg backdrop-blur md:hidden"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-text-0">
                    {config.strategyName || config.activeAgentPortfolioName || 'Autopilot'}
                  </span>
                  <Badge className={cn(mode === 'live' ? 'bg-loss/15 text-loss' : 'bg-agent/15 text-agent')}>{mode.toUpperCase()}</Badge>
                  {frozen ? <Badge className="bg-loss/15 text-loss">FROZEN</Badge> : null}
                  {!connected ? <Badge className="bg-warn/15 text-warn">OFFLINE</Badge> : null}
                </div>
                <p className="mt-1 text-[11px] text-text-1">
                  {fmtEur(config.lastManagedCapitalEur || null)} · drawdown {fmtPct(state.drawdownPct)} · aggiornato {fmtDate(lastRefreshedAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="shrink-0"
                disabled={safeStopping || safelyStopped}
                onClick={() => void safeStop()}
              >
                {safeStopping ? <RefreshCw className="size-4 animate-spin" /> : <ShieldAlert className="size-4" />}
                {safelyStopped ? 'Arrestato' : 'Arresta'}
              </Button>
            </div>
          </motion.div>

          {/* KPI */}
          <motion.div {...stagger(3)} className="col-span-12 grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-1"><CardDescription className="text-text-1">Capitale reale Agent</CardDescription></CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums text-text-0">{fmtEur(config.lastManagedCapitalEur || null)}</div>
                <p className="text-xs text-text-1">Ultima lettura del mirror eToro · {fmtUsd(state.equityUsd)}</p>
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
            <Tabs value={activeTab} onValueChange={setActiveTab}>
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
                          disabled={loading || active}
                          onClick={() => {
                            if (item.id === 'live') {
                              openLiveConfirmation();
                              return;
                            }
                            const nextMode = item.id;
                            void guarded(`Modalità ${item.title}`, () => autopilot.setMode(nextMode));
                          }}
                          className={cn(
                            'rounded-lg border p-3 text-left transition disabled:cursor-default',
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
                          {frozen
                            ? config?.recoveryRequired
                              ? 'Recovery richiesta: il Worker controllerà gli ordini già inviati e due letture del portfolio. Poi potrai scegliere il piano originale, vedere il residuo per asset e confermare soltanto gli ordini mancanti.'
                              : 'Nessuna nuova run può generare ordini. Verifica comunque su eToro quelli già accettati o in volo prima di riattivare.'
                            : 'Blocca subito nuovi invii. Gli ordini già accettati o in volo potrebbero non essere annullabili e vanno verificati su eToro.'}
                        </p>
                      </div>
                      {frozen ? (
                        <Button variant="outline" size="sm" disabled={loading} onClick={() => {
                          if (config?.recoveryRequired) {
                            void prepareRecovery();
                            return;
                          }
                          void guarded('Agente riattivato in Shadow', () => {
                            const safetyRevision = Number(config?.safetyRevision);
                            if (!Number.isInteger(safetyRevision) || safetyRevision < 0) {
                              return Promise.reject(new Error('Revisione di sicurezza assente: aggiorna lo stato prima di sbloccare.'));
                            }
                            return autopilot.unfreeze({ safetyRevision });
                          });
                        }}>
                          {loading ? <RefreshCw className="size-4 animate-spin" /> : <Unlock className="size-4" />}
                          {config?.recoveryRequired ? 'Verifica acquisti · scegli piano' : 'Sblocca in Shadow'}
                        </Button>
                      ) : (
                        <Button variant="destructive" size="sm" disabled={safeStopping} onClick={() => void safeStop()}>
                          {safeStopping ? <RefreshCw className="size-4 animate-spin" /> : <ShieldAlert className="size-4" />} Arresta in sicurezza
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="guida" className="pt-4"><HowItWorks /></TabsContent>

              <TabsContent value="strategia" className="space-y-4 pt-4">
                {config.onboardingComplete && config.strategyDraft ? (
                  <ActiveStrategyDashboard
                    config={config}
                    draft={config.strategyDraft as unknown as StrategyOnboardingDraft}
                    answers={config.guidedOnboardingAnswers as Partial<StrategyOnboardingAnswers> | null | undefined}
                    collaboration={config.strategyCollaboration ?? null}
                    equityCurve={state.equityCurve ?? []}
                    loading={loading}
                    onReview={openSavedStrategy}
                    onDryRun={() => void guarded('Run dry-run completata', () => autopilot.trigger('rebalance', 'dry-run'))}
                  />
                ) : config.onboardingComplete ? (
                  <Alert>
                    <CircleCheck className="size-4" />
                    <AlertTitle>
                      {activatedStrategyName ? `“${activatedStrategyName}” salvata e attiva` : `Strategia “${config.strategyName || 'guidata'}” attiva`}
                    </AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>
                        È salvata nella configurazione persistente del Worker e resta attiva anche a browser chiuso. Qui trovi il profilo, i guardrail e il pool generato dalle tue scelte. Il pool è il catalogo ammesso:
                        a ogni ciclo lo screening crea la shortlist e l’AI propone i pesi finali, che devono sommare al 100%.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {config.strategyDraft && (
                          <Button type="button" size="sm" variant="outline" onClick={openSavedStrategy}>
                            <Eye className="size-4" /> Rivedi scheda completa
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={loading}
                          onClick={() => void guarded('Run dry-run completata', () => autopilot.trigger('rebalance', 'dry-run'))}
                        >
                          <FlaskConical className="size-4" /> Prova un ciclo completo in dry-run
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <ProfileSelector current={config.strategyProfile} onApplied={async () => { await refresh(); }} />
                <GuardrailsEditor config={config} onSaved={async () => { await refresh(); }} />
              </TabsContent>

              <TabsContent value="watcher" className="pt-4"><WatcherPanel /></TabsContent>

              <TabsContent value="credenziali" className="pt-4">
                <CredentialsSection
                  credentials={state.credentials ?? []}
                  notificationsActive={state.notificationsActive}
                  onChanged={async () => { await refresh(); }}
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
                          <TableHead className="text-right">Capitale reale</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {realRuns.length === 0 && (
                          <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-text-1">Nessuna run registrata.</TableCell></TableRow>
                        )}
                        {realRuns.map((run) => (
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
                                  affidabilità {detail.proposal.parsed.confidence.toFixed(2)} (minimo {config.minConfidence})
                                </Badge>
                                {detail.proposal.attempts.some((attempt) => attempt.ok && attempt.reasoningTier === 'basic-fallback') ? (
                                  <Badge variant="outline" className="border-warn/40 text-warn">Fallback: i reasoning model precedenti non erano validi</Badge>
                                ) : null}
                                {detail.improvement && <Badge variant="outline">Revisione di {detail.improvement.sourceModel ?? 'un piano precedente'}</Badge>}
                              </div>
                              <p className="text-xs leading-relaxed text-text-1">
                                L’affidabilità è la stima prudenziale del modello sulla qualità della decisione rispetto a non cambiare nulla. Non dipende dalla grandezza del capitale; sotto il minimo il piano resta visibile, ma non può produrre ordini.
                              </p>
                              {Array.isArray(detail.proposal.attempts) && detail.proposal.attempts.length > 0 ? (
                                <details className="rounded-xl border border-hairline bg-bg-0 p-3">
                                  <summary className="cursor-pointer text-xs font-medium text-text-0">
                                    Percorso modelli · priorità reasoning
                                  </summary>
                                  <p className="mt-2 text-xs leading-relaxed text-text-2">
                                    L’ordine qui sotto è quello realmente eseguito. Un modello fallback viene usato soltanto se quelli più forti sopra di lui non hanno prodotto una proposta valida.
                                  </p>
                                  <div className="mt-2">
                                    <CopyTechnicalReportButton attempts={detail.proposal.attempts} runId={detail.run.id} />
                                  </div>
                                  <div className="mt-2 space-y-1.5">
                                    {detail.proposal.attempts.map((attempt, index) => (
                                      <ProposalAttemptRow key={`${attempt.provider ?? 'provider'}-${attempt.model}-${attempt.format ?? 'attempt'}-${index}`} attempt={attempt} />
                                    ))}
                                  </div>
                                </details>
                              ) : null}
                              <p className="text-sm leading-relaxed text-text-0">{detail.proposal.parsed.rationale}</p>
                              <div>
                                <p className="mb-1 text-xs text-text-1">Allocazione proposta</p>
                                <div className="flex flex-wrap gap-2">
                                  {allocationRows(detail.proposal.parsed.targetWeights).map(({ symbol, percentage }) => (
                                    <Badge key={symbol} variant="outline" className="tabular-nums">{symbol} {percentage.toFixed(1)}%</Badge>
                                  ))}
                                </div>
                              </div>
                              {detail.proposal.parsed.risks.length > 0 && (
                                <p className="text-sm text-text-1">
                                  <span className="text-text-0">Rischi segnalati: </span>{detail.proposal.parsed.risks.join(' · ')}
                                </p>
                              )}
                              {detail.proposal.parsed.repairs && detail.proposal.parsed.repairs.length > 0 && (
                                <div className="rounded-xl border border-warn/30 bg-warn/5 p-3">
                                  <p className="text-sm font-medium text-text-0">Correzione aritmetica applicata</p>
                                  {detail.proposal.parsed.repairs.map((repair) => (
                                    <p key={repair.code} className="mt-1 text-xs leading-relaxed text-text-1">{repair.message}</p>
                                  ))}
                                  <p className="mt-1 text-xs text-text-2">La correzione non approva il piano: tutti i guardrail restano obbligatori.</p>
                                </div>
                              )}
                              {detail.validation && !detail.validation.ok && (
                                <div className="rounded-xl border border-agent/25 bg-agent/5 p-4">
                                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                      <p className="text-sm font-medium text-text-0">Il piano si può correggere</p>
                                      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-1">
                                        Una nuova revisione riceve gli errori dei guardrail, prova prima un altro provider disponibile e riparte dai dati di mercato aggiornati. È sempre un dry-run: non invia ordini reali.
                                      </p>
                                    </div>
                                    <Button
                                      type="button"
                                      className="shrink-0 gap-2"
                                      disabled={loading}
                                      onClick={() => void guarded('Nuova revisione completata', () => autopilot.improveRun(detail.run!.id))}
                                    >
                                      <Sparkles className="size-4" /> Migliora piano
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-sm text-loss">{detail.proposal?.error ?? 'Nessuna proposta: questa run non ha coinvolto il modello.'}</p>
                              {Array.isArray(detail.proposal?.attempts) && detail.proposal.attempts.length > 0 && (
                                <>
                                  <div className="rounded-xl border border-warn/30 bg-warn/5 p-4">
                                    <p className="text-sm font-medium text-text-0">Run fermata in sicurezza</p>
                                    <p className="mt-1 text-xs leading-relaxed text-text-1">
                                      {summarizeProposalFailure(detail.proposal.attempts)}
                                    </p>
                                    <Button
                                      type="button"
                                      size="sm"
                                      className="mt-3 gap-2"
                                      disabled={loading}
                                      onClick={() => void guarded('Nuovo tentativo completato', () => autopilot.retryRun(detail.run!.id))}
                                    >
                                      <RefreshCw className="size-4" /> Correggi e riprova in shadow
                                    </Button>
                                  </div>
                                  <div className="space-y-2 rounded-lg bg-bg-0 p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-xs text-text-1">Tentativi per modello, in ordine:</p>
                                      <CopyTechnicalReportButton attempts={detail.proposal.attempts} runId={detail.run.id} />
                                    </div>
                                    {detail.proposal.attempts.map((attempt, index) => (
                                      <ProposalAttemptRow key={`${attempt.provider ?? 'provider'}-${attempt.model}-${attempt.format ?? 'attempt'}-${index}`} attempt={attempt} explainError />
                                    ))}
                                  </div>
                                </>
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
                              {detail.validation.plan?.targets && (
                                <div className="pt-2">
                                  <p className="mb-2 text-xs text-text-1">Allocazione dopo i guardrail deterministici</p>
                                  <div className="flex flex-wrap gap-2">
                                    {allocationRows(detail.validation.plan.targets).map(({ symbol, percentage }) => (
                                      <Badge key={symbol} variant="outline" className="tabular-nums">{symbol} {percentage.toFixed(1)}%</Badge>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </>
                          ) : <p className="text-sm text-text-1">Validazione non eseguita.</p>}
                        </TabsContent>

                        <TabsContent value="ordini" className="pt-4">
                          <div className="space-y-5">
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
                                      <TableCell className="text-right tabular-nums text-text-0">
                                        {fmtUsd(order.amount_usd)} <span className="block text-[10px] text-text-2">capitale reale</span>
                                      </TableCell>
                                      <TableCell><Badge variant="outline">{order.state}</Badge></TableCell>
                                      <TableCell className="max-w-[280px] truncate text-xs text-text-1">{order.message}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            )}

                            {detailReconciliationRows.length > 0 ? (
                              <div className="rounded-xl border border-hairline bg-bg-2/40 p-3">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <p className="text-sm font-medium text-text-0">Origine della divergenza</p>
                                    <p className="text-xs text-text-1">Confronto fra peso atteso dopo gli ordini e ultima lettura eToro.</p>
                                  </div>
                                  <Badge variant={detailReconciliationRows[0].divergence > Number(config?.reconcileTolerancePct ?? 0.05) ? 'destructive' : 'outline'}>
                                    massimo {fmtPct(detailReconciliationRows[0].divergence, 2)} · {detailReconciliationRows[0].symbol}
                                  </Badge>
                                </div>
                                <Table>
                                  <TableHeader>
                                    <TableRow><TableHead>Strumento</TableHead><TableHead className="text-right">Atteso</TableHead><TableHead className="text-right">Letto su eToro</TableHead><TableHead className="text-right">Scarto</TableHead></TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {detailReconciliationRows.map((row) => (
                                      <TableRow key={row.symbol}>
                                        <TableCell className="font-medium text-text-0">{row.symbol}</TableCell>
                                        <TableCell className="text-right tabular-nums">{fmtPct(row.expectedWeight, 2)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{fmtPct(row.actualWeight, 2)}</TableCell>
                                        <TableCell className={cn('text-right tabular-nums', row.divergence > Number(config?.reconcileTolerancePct ?? 0.05) ? 'text-loss' : 'text-text-0')}>{fmtPct(row.divergence, 2)}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            ) : null}
                          </div>
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

      <AlertDialog open={recoveryDialogOpen} onOpenChange={(open) => {
        if (executingRecovery && !open) return;
        setRecoveryDialogOpen(open);
        if (!open) {
          setRecoveryConfirmation('');
          setRecoveryAcknowledged(false);
        }
      }}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-text-0">
              <ShieldAlert className="size-5 text-warn" /> Verifica e completa il piano originale
            </AlertDialogTitle>
            <AlertDialogDescription>
              L’anteprima non ha inviato ordini e l’agente è ancora congelato. Scegli quale piano validato raggiungere: al momento della conferma il Worker rilegge eToro e compra o vende soltanto il delta ancora mancante.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {recoveryPreview?.orderSummary?.length ? (
            <div className="rounded-xl border border-gain/25 bg-gain/5 p-3">
              <p className="text-sm font-medium text-text-0">Ordini della run interrotta verificati su eToro</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {recoveryPreview.orderSummary.map((order, index) => (
                  <div key={`${order.symbol}-${index}`} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-bg-1/70 px-3 py-2 text-xs">
                    <span className="font-medium text-text-0">{order.symbol} · {order.side === 'buy' ? 'acquisto' : 'vendita'}</span>
                    <span className="text-right tabular-nums text-text-1">
                      richiesto {fmtUsd(order.amountUsd)} · eseguito {fmtUsd(order.filledUsd)}
                      <span className="ml-1 block text-[10px] uppercase">{order.state}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label className="text-text-0">Piano da completare</Label>
            <div className="grid gap-2">
              {(recoveryPreview?.candidates ?? []).map((candidate) => {
                const selected = candidate.sourceRunId === selectedRecoveryRunId;
                return (
                  <button
                    key={candidate.sourceRunId}
                    type="button"
                    disabled={executingRecovery}
                    onClick={() => setSelectedRecoveryRunId(candidate.sourceRunId)}
                    className={cn(
                      'min-w-0 overflow-hidden rounded-xl border p-3 text-left transition-colors',
                      selected ? 'border-agent bg-agent/10' : 'border-hairline bg-bg-2/40 hover:border-hairline-strong',
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-0">
                        {candidate.sourceType === 'live' ? 'Piano Live interrotto' : 'Bilanciamento dry-run'} · {fmtDate(candidate.finishedAt)}
                        {candidate.recommended ? <Badge className="bg-agent/15 text-agent hover:bg-agent/15">Consigliato</Badge> : null}
                      </span>
                      <span className="text-xs tabular-nums text-text-1">{candidate.residualOrderCount} residui · {fmtUsd(candidate.residualUsd)}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-text-1">{candidate.model ?? 'modello non registrato'} · affidabilità {fmtPct(candidate.confidence)}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {selectedRecoveryCandidate ? (
            <div className="rounded-xl border border-hairline bg-bg-2/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-text-0">Obiettivo, già presente e residuo</p>
                  <p className="text-xs text-text-1">Gli importi sono una fotografia: prima degli invii saranno ricalcolati sul portfolio reale aggiornato.</p>
                </div>
                <Badge variant="outline">capitale {fmtUsd(recoveryPreview?.snapshot?.equityUsd)}</Badge>
              </div>
              <div className="grid gap-2 sm:hidden">
                {selectedRecoveryCandidate.residualPreview.map((row) => (
                  <div key={row.symbol} className="rounded-lg border border-hairline bg-bg-1/70 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-text-0">{row.symbol}</span>
                      <span className={cn('text-sm font-medium tabular-nums', row.actionable ? row.side === 'buy' ? 'text-gain' : 'text-loss' : 'text-text-2')}>
                        {row.actionable ? `${row.side === 'buy' ? '+' : '−'}${fmtUsd(row.residualUsd)}` : 'completo'}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-text-1">
                      <span>Obiettivo<strong className="mt-0.5 block font-medium tabular-nums text-text-0">{fmtPct(row.targetWeight, 1)} · {fmtUsd(row.targetUsd)}</strong></span>
                      <span>Già presente<strong className="mt-0.5 block font-medium tabular-nums text-text-0">{fmtPct(row.actualWeight, 1)} · {fmtUsd(row.actualUsd)}</strong></span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden max-h-72 overflow-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Asset</TableHead><TableHead className="text-right">Obiettivo</TableHead><TableHead className="text-right">Già presente</TableHead><TableHead className="text-right">Da completare</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedRecoveryCandidate.residualPreview.map((row) => (
                      <TableRow key={row.symbol}>
                        <TableCell className="font-medium text-text-0">{row.symbol}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPct(row.targetWeight, 1)}<span className="block text-[10px] text-text-2">{fmtUsd(row.targetUsd)}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPct(row.actualWeight, 1)}<span className="block text-[10px] text-text-2">{fmtUsd(row.actualUsd)}</span></TableCell>
                        <TableCell className={cn('text-right tabular-nums', row.actionable ? row.side === 'buy' ? 'text-gain' : 'text-loss' : 'text-text-2')}>
                          {row.actionable ? `${row.side === 'buy' ? '+' : '−'}${fmtUsd(row.residualUsd)}` : 'completo'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

          <Alert>
            <ShieldAlert className="size-4" />
            <AlertTitle>Recovery con Live persistente</AlertTitle>
            <AlertDescription>
              Non viene chiesta una nuova decisione all’AI. Gli ordini già riconosciuti riducono il residuo; gli ordini ambigui bloccano tutto. Dopo una riconciliazione riuscita la modalità resta Live per i cicli successivi.
            </AlertDescription>
          </Alert>

          <div className="grid gap-2">
            <Label htmlFor="recovery-confirmation" className="text-text-0">
              Digita manualmente <code className="rounded bg-bg-2 px-1.5 py-0.5 text-loss">{LIVE_RECOVERY_EXECUTE_CONFIRMATION}</code>
            </Label>
            <Input
              id="recovery-confirmation"
              value={recoveryConfirmation}
              onChange={(event) => setRecoveryConfirmation(event.target.value)}
              onPaste={(event) => event.preventDefault()}
              autoComplete="off"
              spellCheck={false}
              disabled={executingRecovery}
              placeholder={LIVE_RECOVERY_EXECUTE_CONFIRMATION}
              className="font-mono"
            />
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/5 p-3 text-sm leading-relaxed text-text-0">
            <Checkbox
              id="recovery-persistent-live-confirmation"
              checked={recoveryAcknowledged}
              onCheckedChange={(value) => setRecoveryAcknowledged(value === true)}
              disabled={executingRecovery}
              className="mt-0.5"
            />
            <Label htmlFor="recovery-persistent-live-confirmation" className="cursor-pointer font-normal leading-relaxed">
              Confermo il piano selezionato e capisco che verranno inviati ordini reali soltanto per il residuo ricalcolato; al termine l’Autopilot resterà in modalità Live.
            </Label>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={executingRecovery}>Lascia congelato</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-9 whitespace-normal py-2"
              disabled={
                executingRecovery
                || !selectedRecoveryCandidate
                || recoveryConfirmation !== LIVE_RECOVERY_EXECUTE_CONFIRMATION
                || !recoveryAcknowledged
              }
              onClick={() => void executeRecovery()}
            >
              {executingRecovery ? <RefreshCw className="size-4 animate-spin" /> : <Radio className="size-4" />}
              {executingRecovery ? 'Verifica e completamento in corso…' : 'Completa soltanto il residuo'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmLive} onOpenChange={setLiveDialogOpen}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-loss">
              <Radio className="size-5" /> Attivare Live ed eseguire adesso?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Questa conferma avvia subito un ciclo che può inviare ordini reali. Non è un semplice cambio di modalità.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {willReuseDryRun && dryRunForLive ? (
            <div className="rounded-xl border border-gain/30 bg-gain/5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="bg-gain/15 text-gain hover:bg-gain/15">Decisione dry-run riutilizzabile</Badge>
                {dryRunForLive.model ? <Badge variant="outline" className="max-w-full truncate">{dryRunForLive.model}</Badge> : null}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-text-0">
                Verrà riutilizzata soltanto la decisione AI del dry-run del {fmtDate(dryRunForLive.finishedAt)}, valida fino al {fmtDate(dryRunForLive.expiresAt)}.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-1">
                {dryRunForLive.orderCount} ordini simulati · affidabilità {fmtPct(dryRunForLive.confidence)} · turnover {fmtPct(dryRunForLive.turnoverPct)}.
                Il Worker rileggerà comunque il portfolio, ricalcolerà importi e ordini e ripeterà tutti i controlli prima dell’invio reale.
                Se la decisione scade o diventa incompatibile prima della conferma, rifarà automaticamente l’analisi AI.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-agent/30 bg-agent/5 p-4">
              <Badge variant="outline">Nuova analisi necessaria</Badge>
              <p className="mt-2 text-sm leading-relaxed text-text-0">
                {dryRunForLive
                  ? `La decisione del dry-run più recente non verrà riutilizzata: ${explainLiveReuseReason(dryRunForLive.reason)}.`
                  : 'Non c’è una decisione dry-run riutilizzabile.'}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-1">
                Il Worker farà automaticamente una nuova analisi AI sui dati aggiornati. Attiverà Live e invierà gli ordini reali soltanto se proposta, guardrail e controlli eToro risultano validi.
              </p>
            </div>
          )}

          <Alert variant="destructive">
            <ShieldAlert className="size-4" />
            <AlertTitle>La modalità resta Live</AlertTitle>
            <AlertDescription>
              Dopo questo ciclo anche le esecuzioni future alla cadenza configurata potranno inviare ordini reali. “Arresta in sicurezza” blocca nuovi invii da qualsiasi dispositivo, ma non può annullare ordini già accettati o in volo: in quel caso controlla eToro.
            </AlertDescription>
          </Alert>

          <div className="grid gap-2">
            <Label htmlFor="live-confirmation" className="text-text-0">
              Digita manualmente <code className="rounded bg-bg-2 px-1.5 py-0.5 text-loss">{LIVE_CONFIRMATION}</code>
            </Label>
            <Input
              id="live-confirmation"
              value={liveConfirmation}
              onChange={(event) => setLiveConfirmation(event.target.value)}
              onPaste={(event) => event.preventDefault()}
              autoComplete="off"
              spellCheck={false}
              disabled={activatingLive}
              placeholder={LIVE_CONFIRMATION}
              className="font-mono"
            />
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-loss/30 bg-loss/5 p-3 text-sm leading-relaxed text-text-0">
            <Checkbox
              id="live-persistence-confirmation"
              checked={livePersistenceAcknowledged}
              onCheckedChange={(value) => setLivePersistenceAcknowledged(value === true)}
              disabled={activatingLive}
              className="mt-0.5"
            />
            <Label htmlFor="live-persistence-confirmation" className="cursor-pointer font-normal leading-relaxed">
              Confermo che, dopo questa esecuzione, il Worker resterà in modalità Live e potrà inviare altri ordini reali finché non lo arresterò o cambierò modalità.
            </Label>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={activatingLive}>Annulla</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-9 whitespace-normal py-2"
              disabled={
                activatingLive
                || !liveActivationId
                || liveConfirmation !== LIVE_CONFIRMATION
                || !livePersistenceAcknowledged
              }
              onClick={() => void activateLiveNow()}
            >
              {activatingLive ? <RefreshCw className="size-4 animate-spin" /> : <Radio className="size-4" />}
              {activatingLive
                ? 'Attivazione e ciclo in corso…'
                : willReuseDryRun ? 'Usa il dry-run ed esegui Live' : 'Ricalcola ed esegui Live'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
