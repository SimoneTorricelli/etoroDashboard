import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
  Check, ChevronRight, CircleDollarSign, CloudDownload, ExternalLink, Info, Loader2,
  KeyRound, ListChecks, LockKeyhole, Play, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Sparkles, Target, WalletCards,
} from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { hasLiveCredentials } from '@/lib/settings';
import type { DisplayCurrency } from '@/lib/settings';
import { useAppData } from '@/lib/data/store';
import {
  clearAgentSessionToken, createAgentPortfolio, createAgentUserToken, executeAgentAllocationPlan, listAgentPortfolios,
  loadAgentSessionToken, summarizeAgentOrderReceipts, validateAgentAllocationPlan, verifyAgentOrderExecutions,
} from '@/lib/agent/etoro-agent-api';
import type { AgentOrderExecutionResult, AgentPlanValidation, RemoteAgentPortfolio } from '@/lib/agent/etoro-agent-api';
import {
  allocationPreview, buildStrategyOrderPlan, createStrategyDraft, getStrategyTemplate, loadStrategyPortfolios, saveStrategyPortfolios,
  STRATEGY_SIMULATION_MODEL_VERSION, STRATEGY_TEMPLATES, validateStrategyPortfolio,
} from '@/lib/agent/strategy-portfolios';
import type { StrategyOrderPlan, StrategyPortfolioConfig, StrategyTemplate } from '@/lib/agent/strategy-portfolios';
import { logReturnStats, projectPercentiles } from '@/lib/finance/scenario';

const riskLabel: Record<StrategyTemplate['risk'], string> = {
  basso: 'Rischio più contenuto',
  medio: 'Rischio intermedio',
  alto: 'Rischio alto',
  'molto-alto': 'Rischio molto alto',
};

const accentClasses: Record<StrategyTemplate['accent'], { border: string; text: string; bg: string }> = {
  gain: { border: 'border-gain/40', text: 'text-gain', bg: 'bg-gain/10' },
  info: { border: 'border-info/40', text: 'text-info', bg: 'bg-info/10' },
  agent: { border: 'border-agent/40', text: 'text-agent', bg: 'bg-agent/10' },
  warn: { border: 'border-warn/40', text: 'text-warn', bg: 'bg-warn/10' },
  loss: { border: 'border-loss/40', text: 'text-loss', bg: 'bg-loss/10' },
};

const statusClasses: Record<StrategyPortfolioConfig['status'], string> = {
  bozza: 'bg-bg-2 text-text-2',
  pronto: 'bg-info/10 text-info',
  simulato: 'bg-agent/10 text-agent',
  'da inizializzare': 'bg-warn/10 text-warn',
  attivo: 'bg-gain/10 text-gain',
  'in pausa': 'bg-warn/10 text-warn',
};

function money(value: number, currency: DisplayCurrency): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}

function inputMoney(value: number, fromUsd: (usd: number) => number): number {
  const converted = fromUsd(value);
  return Number.isFinite(converted) ? Math.round(converted * 100) / 100 : 0;
}

function numberInput(onChange: (value: number) => void) {
  return (event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value) || 0);
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1).replace('.', ',')}%`;
}

const rebalanceLabel: Record<StrategyPortfolioConfig['rebalance'], string> = {
  giornaliero: 'giornaliera',
  settimanale: 'settimanale',
  mensile: 'mensile',
};

function StrategySimulationPanel({
  portfolio,
  fromUsd,
  displayCurrency,
}: {
  portfolio: StrategyPortfolioConfig;
  fromUsd(usd: number): number;
  displayCurrency: DisplayCurrency;
}) {
  const [months, setMonths] = useState(18);
  const simulation = portfolio.simulation;
  if (!simulation) return <p className="mt-2 text-caption text-text-2">Rendimento, perdita e scenari saranno calcolati su dati reali dopo la simulazione.</p>;

  const safeAnnualMedian = Math.max(-99.9, simulation.p50Pct) / 100;
  const meanLog = simulation.dailyMeanLog ?? Math.log(1 + safeAnnualMedian) / 252;
  const volatilityLog = simulation.dailyVolatilityLog ?? (simulation.volatilityPct / 100) / Math.sqrt(252);
  const projection = projectPercentiles(portfolio.budgetUsd, { meanLog, volatilityLog }, months);
  const historicalEnd = portfolio.budgetUsd * (1 + simulation.returnPct / 100);
  const historyMonths = Math.max(1, Math.round(simulation.observations / 21));
  const horizonLabel = months === 12 ? '1 anno' : months === 18 ? '18 mesi' : `${months / 12} anni`;
  const scenarioCards = [
    { key: 'P10', title: 'Scenario debole', value: projection.p10, change: projection.p10ChangePct, copy: '10% degli esiti sotto', tone: 'text-loss' },
    { key: 'P50', title: 'Scenario mediano', value: projection.p50, change: projection.p50ChangePct, copy: '50% sopra e 50% sotto', tone: 'text-text-0' },
    { key: 'P90', title: 'Scenario forte', value: projection.p90, change: projection.p90ChangePct, copy: 'Solo 10% degli esiti sopra', tone: 'text-gain' },
  ];

  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Metric label={`Test storico · ${historyMonths} mesi`} value={pct(simulation.returnPct)} />
        <Metric label="Perdita massima osservata" value={`−${simulation.maxDrawdownPct.toFixed(1).replace('.', ',')}%`} />
        <Metric label="Oscillazione annua" value={`${simulation.volatilityPct.toFixed(1).replace('.', ',')}%`} />
      </div>
      <div className="mt-2 rounded-md bg-bg-1 px-2.5 py-2 text-caption text-text-1">
        Nel periodo testato, un budget iniziale di <span className="font-mono text-text-0">{money(fromUsd(portfolio.budgetUsd), displayCurrency)}</span> sarebbe diventato <span className={cn('font-mono', historicalEnd >= portfolio.budgetUsd ? 'text-gain' : 'text-loss')}>{money(fromUsd(historicalEnd), displayCurrency)}</span>. È un confronto storico, non una previsione.
      </div>
      <div className="mt-2 rounded-md border border-info/20 bg-info/5 px-2.5 py-2 text-micro leading-relaxed text-text-1">
        <span className="font-medium text-info">Capitalizzazione composta attiva.</span>{' '}
        Ogni variazione si applica al saldo aggiornato: 200 € → +5% = 210 € → +5% = 220,50 €. Le perdite funzionano allo stesso modo. Nel test i pesi vengono riportati al target con frequenza <span className="font-medium text-text-0">{rebalanceLabel[portfolio.rebalance]}</span>.
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-caption font-medium text-text-0">Capitale possibile tra {horizonLabel}</p><p className="text-micro text-text-2">Partenza: {money(fromUsd(portfolio.budgetUsd), displayCurrency)} · nessun nuovo versamento</p></div>
        <div className="flex overflow-x-auto rounded-md border border-hairline bg-bg-0 p-0.5" aria-label="Orizzonte simulazione strategia">
          {[12, 18, 24, 36].map((value) => <button key={value} type="button" onClick={() => setMonths(value)} className={cn('shrink-0 rounded px-2 py-1 text-micro', months === value ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1')}>{value === 12 ? '1A' : value === 18 ? '18M' : `${value / 12}A`}</button>)}
        </div>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {scenarioCards.map((card) => <div key={card.key} className="rounded-md border border-hairline bg-bg-0 p-2.5"><div className="text-micro font-medium text-text-1">{card.key} · {card.title}</div><div className={cn('mt-1 font-mono text-body-strong', card.tone)}>{money(fromUsd(card.value), displayCurrency)}</div><div className={cn('font-mono text-micro', card.tone)}>{pct(card.change)}</div><p className="mt-1 text-micro text-text-2">{card.copy}</p></div>)}
      </div>
      {Math.abs(projection.p50ChangePct) < 2 ? <p className="mt-2 rounded-md border border-warn/25 bg-warn/5 px-2.5 py-2 text-micro text-warn">P50 resta vicino al budget perché il rendimento geometrico del campione è vicino a zero ({pct(simulation.annualizedMedianPct ?? simulation.p50Pct)} annuo). Non significa che il saldo rimarrà fermo.</p> : null}
      <div className="mt-2 rounded-md border border-hairline bg-bg-1 p-2">
        <p className={cn('text-micro font-medium', simulation.coveragePct >= 80 ? 'text-gain' : 'text-warn')}>Copertura dati storici: {simulation.coveragePct}% dei pesi · {simulation.coveragePct >= 80 ? 'attivazione consentita' : 'serve almeno 80% per attivare'}</p>
        <p className="mt-1 text-micro text-text-2">{simulation.assets?.map((asset) => `${asset.symbol} ${asset.weightPct}%: ${asset.status === 'coperto' ? `${asset.observations} giorni` : asset.status === 'cash' ? 'liquidità' : asset.status === 'non-trovato' ? 'non disponibile per questo account eToro' : asset.status === 'errore-dati' ? 'dati temporaneamente non disponibili' : 'storico insufficiente'}`).join(' · ')}</p>
        {simulation.partial ? <p className="mt-1 text-micro text-text-2">Non è copertura geografica: indica quanto del capitale target ha uno storico utilizzabile. La parte senza dati resta ferma, quindi capitale finale e percentili descrivono solo un modello parziale.</p> : null}
      </div>
      <p className="mt-2 text-micro leading-relaxed text-text-2">P10/P50/P90 sono percentili della distribuzione costruita dalle variazioni giornaliere del test. Non includono dividendi, tasse, costi, nuovi versamenti o futuri ribilanciamenti.</p>
    </div>
  );
}

export function StrategyPortfolioStudio({
  fromUsd,
  toUsd,
  displayCurrency,
  realExecutionActive,
}: {
  fromUsd(usd: number): number;
  toUsd(value: number): number;
  displayCurrency: DisplayCurrency;
  realExecutionActive: boolean;
}) {
  const { settings, instruments, getCandles, searchInstruments } = useAppData();
  const [portfolios, setPortfolios] = useState<StrategyPortfolioConfig[]>(() => loadStrategyPortfolios());
  const [editing, setEditing] = useState<StrategyPortfolioConfig | null>(null);
  const [confirming, setConfirming] = useState<StrategyPortfolioConfig | null>(null);
  const [ackReal, setAckReal] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteAgentPortfolio[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [simulatingId, setSimulatingId] = useState<string | null>(null);
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [planPortfolio, setPlanPortfolio] = useState<StrategyPortfolioConfig | null>(null);
  const [orderPlan, setOrderPlan] = useState<StrategyOrderPlan | null>(null);
  const [ackToken, setAckToken] = useState(false);
  const [ackOrders, setAckOrders] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [validatingPlan, setValidatingPlan] = useState(false);
  const [checkingOrders, setCheckingOrders] = useState(false);
  const [planValidation, setPlanValidation] = useState<AgentPlanValidation | null>(null);
  const [executionResult, setExecutionResult] = useState<AgentOrderExecutionResult | null>(null);
  const [remoteBindings, setRemoteBindings] = useState<Record<string, string>>({});

  useEffect(() => saveStrategyPortfolios(portfolios), [portfolios]);

  const currencySymbol = displayCurrency === 'EUR' ? '€' : '$';
  const liveReady = hasLiveCredentials(settings);

  const openEditor = (templateId: string) => {
    const existing = portfolios.find((portfolio) => portfolio.templateId === templateId && !portfolio.etoroAgentPortfolioId);
    setEditing(existing ? { ...existing } : createStrategyDraft(templateId));
  };

  const updateEditing = <K extends keyof StrategyPortfolioConfig>(key: K, value: StrategyPortfolioConfig[K]) => {
    setEditing((current) => current ? { ...current, [key]: value, updatedAt: Date.now() } : current);
  };

  const saveDraft = () => {
    if (!editing) return;
    const validation = validateStrategyPortfolio(editing);
    if (!validation.valid) {
      toast.error('Controlla i limiti del portafoglio', { description: validation.errors[0] });
      return;
    }
    const next = { ...editing, status: 'pronto' as const, simulation: undefined, updatedAt: Date.now() };
    setPortfolios((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [...current, next]);
    setEditing(null);
    toast.success(`Strategia ${getStrategyTemplate(next.templateId).name} salvata`, { description: 'Nessun ordine è stato inviato.' });
  };

  const syncRemote = useCallback(async (showFeedback = true) => {
    if (!liveReady) {
      if (showFeedback) toast.error('Configura prima le chiavi e il proxy nella sezione Impostazioni.');
      return;
    }
    setRemoteLoading(true);
    try {
      const result = await listAgentPortfolios(settings.live);
      setRemote(result);
      setPortfolios((current) => current.map((portfolio) => {
        if (!portfolio.etoroAgentPortfolioId) return portfolio;
        const match = result.find((item) => item.id === portfolio.etoroAgentPortfolioId);
        return match ? {
          ...portfolio,
          virtualBalanceUsd: match.virtualBalanceUsd ?? portfolio.virtualBalanceUsd,
          tokenAvailable: match.tokenAvailable || portfolio.tokenAvailable,
        } : portfolio;
      }));
      setRemoteChecked(true);
      if (showFeedback) toast.success(`${result.length} Agent Portfolio trovati su eToro`);
    } catch (error) {
      if (showFeedback) toast.error('Impossibile leggere gli Agent Portfolio', { description: error instanceof Error ? error.message : 'Errore del proxy o di eToro' });
    } finally {
      setRemoteLoading(false);
    }
  }, [liveReady, settings.live]);

  useEffect(() => {
    if (!liveReady || remoteChecked) return;
    void syncRemote(false);
  }, [liveReady, remoteChecked, syncRemote]);

  const simulateStrategy = async (portfolio: StrategyPortfolioConfig) => {
    const template = getStrategyTemplate(portfolio.templateId);
    const allocations = template.allocations.filter((allocation) => allocation.symbol !== 'Cash');
    setSimulatingId(portfolio.id);
    try {
      const resolved = (await Promise.all(allocations.map(async (allocation) => {
        const local = instruments.find((item) => item.symbol.toUpperCase() === allocation.symbol.toUpperCase());
        const remote = local ? [] : await searchInstruments(allocation.symbol);
        const instrument = local ?? remote.find((item) => item.symbol.toUpperCase() === allocation.symbol.toUpperCase());
        return instrument ? { allocation, instrument } : null;
      }))).filter((item): item is NonNullable<typeof item> => item != null);
      if (resolved.length === 0) throw new Error('Nessun asset della strategia è disponibile nel catalogo eToro.');
      const settled = await Promise.allSettled(resolved.map(async ({ allocation, instrument }) => ({ allocation, candles: await getCandles(instrument.instrumentId, 'OneDay', 756) })));
      const valid = settled.flatMap((entry) => entry.status === 'fulfilled' && entry.value.candles.length >= 60 ? [entry.value] : []);
      const failedSymbols = new Set(settled.flatMap((entry, index) => entry.status === 'rejected' ? [resolved[index].allocation.symbol] : []));
      const coveragePct = valid.reduce((sum, item) => sum + item.allocation.weightPct, template.allocations.find((allocation) => allocation.symbol === 'Cash')?.weightPct ?? 0);
      if (valid.length === 0) throw new Error('Nessun asset ha almeno 60 candele giornaliere disponibili.');
      const candleMaps = valid.map((item) => ({ ...item, prices: new Map(item.candles.map((candle) => [candle.time, candle.close])) }));
      const commonTimes = [...candleMaps[0].prices.keys()].filter((time) => candleMaps.every((item) => item.prices.has(time))).sort((a, b) => a - b);
      if (commonTimes.length < 60) throw new Error('Gli asset non hanno almeno 60 sedute storiche comuni.');
      const observations = commonTimes.length;
      const cashWeight = (template.allocations.find((allocation) => allocation.symbol === 'Cash')?.weightPct ?? 0) / 100;
      const missingWeight = Math.max(0, (100 - coveragePct) / 100);
      const rebalanceEvery = portfolio.rebalance === 'giornaliero' ? 1 : portfolio.rebalance === 'settimanale' ? 5 : 21;
      const units = new Map(candleMaps.map((item) => [item.allocation.symbol, (item.allocation.weightPct / 100) / (item.prices.get(commonTimes[0]) ?? 1)]));
      let cashBalance = cashWeight + missingWeight;
      const values: number[] = [];
      commonTimes.forEach((time, index) => {
        const value = cashBalance + candleMaps.reduce((sum, item) => sum + (units.get(item.allocation.symbol) ?? 0) * (item.prices.get(time) ?? 0), 0);
        values.push(value);
        if (index < commonTimes.length - 1 && (index + 1) % rebalanceEvery === 0) {
          cashBalance = value * (cashWeight + missingWeight);
          for (const item of candleMaps) {
            const price = item.prices.get(time) ?? 0;
            if (price > 0) units.set(item.allocation.symbol, (value * item.allocation.weightPct / 100) / price);
          }
        }
      });
      let peak = values[0];
      let maxDrawdownPct = 0;
      const returns: number[] = [];
      for (let index = 1; index < values.length; index += 1) {
        peak = Math.max(peak, values[index]);
        maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - values[index]) / peak) * 100 : 0);
        if (values[index - 1] > 0) returns.push(values[index] / values[index - 1] - 1);
      }
      const mean = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
      const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
      const volatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
      const returnPct = (values[values.length - 1] / values[0] - 1) * 100;
      const stats = logReturnStats(values);
      if (!stats) throw new Error('Servono almeno 20 variazioni valide per costruire gli scenari.');
      const annualProjection = projectPercentiles(1, stats, 12);
      const simulation = {
        modelVersion: STRATEGY_SIMULATION_MODEL_VERSION,
        returnPct,
        maxDrawdownPct,
        volatilityPct,
        p10Pct: annualProjection.p10ChangePct,
        p50Pct: annualProjection.p50ChangePct,
        p90Pct: annualProjection.p90ChangePct,
        dailyMeanLog: stats.meanLog,
        dailyVolatilityLog: stats.volatilityLog,
        annualizedMedianPct: stats.annualizedMedianPct,
        coveragePct,
        observations,
        partial: coveragePct < 80,
        assets: template.allocations.map((allocation) => {
          if (allocation.symbol === 'Cash') return { symbol: allocation.symbol, weightPct: allocation.weightPct, status: 'cash' as const, observations };
          const found = resolved.find((item) => item.allocation.symbol === allocation.symbol);
          const covered = valid.find((item) => item.allocation.symbol === allocation.symbol);
          return {
            symbol: allocation.symbol,
            weightPct: allocation.weightPct,
            status: covered ? 'coperto' as const : failedSymbols.has(allocation.symbol) ? 'errore-dati' as const : found ? 'senza-storico' as const : 'non-trovato' as const,
            observations: covered?.candles.length ?? 0,
          };
        }),
        asOf: Date.now(),
      };
      setPortfolios((current) => current.map((item) => item.id === portfolio.id ? { ...item, status: 'simulato', simulation, updatedAt: Date.now() } : item));
      if (coveragePct >= 80) toast.success('Simulazione strategia completata', { description: `${observations} osservazioni reali · copertura ${coveragePct}%` });
      else toast.warning('Simulazione parziale completata', { description: `${coveragePct}% dei pesi coperti. Il restante ${100 - coveragePct}% è stato mantenuto costante e l’attivazione resta bloccata.` });
    } catch (error) {
      toast.error('Simulazione strategia non disponibile', { description: error instanceof Error ? error.message : 'Dati storici insufficienti.' });
    } finally {
      setSimulatingId(null);
    }
  };

  const activateRemote = async () => {
    if (!confirming || confirming.status !== 'simulato' || !confirming.simulation || confirming.simulation.coveragePct < 80 || !realExecutionActive || !ackReal) return;
    setCreatingId(confirming.id);
    try {
      const created = await createAgentPortfolio(settings.live, confirming);
      setPortfolios((current) => current.map((item) => item.id === confirming.id ? {
        ...item,
        status: 'da inizializzare',
        etoroAgentPortfolioId: created.id,
        mirrorId: created.mirrorId,
        virtualBalanceUsd: created.virtualBalanceUsd,
        tokenAvailable: created.tokenAvailable,
        activatedAt: Date.now(),
        updatedAt: Date.now(),
      } : item));
      setRemote((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setRemoteChecked(true);
      setConfirming(null);
      setAckReal(false);
      toast.success(`${confirming.name} creato su eToro`, {
        description: 'Budget collegato. Nessun asset è ancora stato acquistato: ora prepara e conferma il piano iniziale.',
      });
    } catch (error) {
      toast.error('Creazione Agent Portfolio non riuscita', { description: error instanceof Error ? error.message : 'Errore del proxy o di eToro' });
    } finally {
      setCreatingId(null);
    }
  };

  const prepareInitialPlan = async (portfolio: StrategyPortfolioConfig) => {
    const template = getStrategyTemplate(portfolio.templateId);
    const remoteMatch = remote.find((item) => item.id === portfolio.etoroAgentPortfolioId);
    const virtualBalanceUsd = portfolio.virtualBalanceUsd ?? remoteMatch?.virtualBalanceUsd ?? 0;
    if (!(virtualBalanceUsd > 0)) {
      toast.error('Dati operativi Agent non disponibili', { description: 'Premi “Leggi da eToro” e riprova.' });
      return;
    }
    setPlanningId(portfolio.id);
    try {
      const symbols = template.allocations.filter((allocation) => allocation.symbol !== 'Cash').map((allocation) => allocation.symbol);
      const resolvedEntries = await Promise.all(symbols.map(async (symbol) => {
        const local = instruments.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
        const candidates = local ? [local] : await searchInstruments(symbol);
        const exact = candidates.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
        return [symbol.toUpperCase(), exact?.instrumentId ?? 0] as const;
      }));
      const plan = buildStrategyOrderPlan(portfolio, virtualBalanceUsd, Object.fromEntries(resolvedEntries));
      setPlanPortfolio(portfolio);
      setOrderPlan(plan);
      setPlanValidation(null);
      setExecutionResult(portfolio.initializationOrders?.length
        ? summarizeAgentOrderReceipts(portfolio.initializationOrders, plan.scale)
        : null);
      setAckToken(false);
      setAckOrders(false);
      const token = loadAgentSessionToken(portfolio.etoroAgentPortfolioId ?? '');
      if (token && !portfolio.initializationOrders?.length && plan.orders.length > 0) {
        setValidatingPlan(true);
        try {
          setPlanValidation(await validateAgentAllocationPlan(settings.live, plan, token));
        } catch (error) {
          toast.error('Controllo pre-ordine non disponibile', { description: error instanceof Error ? error.message : 'Verifica eToro non riuscita.' });
        } finally {
          setValidatingPlan(false);
        }
      }
    } catch (error) {
      toast.error('Piano iniziale non disponibile', { description: error instanceof Error ? error.message : 'Impossibile risolvere gli strumenti.' });
    } finally {
      setPlanningId(null);
    }
  };

  const generateSessionToken = async () => {
    if (!planPortfolio?.etoroAgentPortfolioId || !orderPlan || !ackToken || tokenBusy) return;
    setTokenBusy(true);
    try {
      const token = await createAgentUserToken(settings.live, planPortfolio.etoroAgentPortfolioId, `${planPortfolio.name}-torino`);
      setPortfolios((current) => current.map((item) => item.id === planPortfolio.id ? { ...item, tokenAvailable: true, updatedAt: Date.now() } : item));
      setPlanPortfolio((current) => current ? { ...current, tokenAvailable: true } : current);
      setAckToken(false);
      setValidatingPlan(true);
      toast.success('Token operativo creato', { description: 'È custodito solo nella sessione di questa scheda.' });
      try {
        const validation = await validateAgentAllocationPlan(settings.live, orderPlan, token);
        setPlanValidation(validation);
        if (!validation.ok) toast.error('Il piano ha controlli bloccanti', { description: validation.blockingIssues[0] });
      } catch (error) {
        setPlanValidation(null);
        toast.error('Token creato, controllo pre-ordine non disponibile', { description: error instanceof Error ? error.message : 'Verifica eToro non riuscita.' });
      }
    } catch (error) {
      toast.error('Token Agent non creato', { description: error instanceof Error ? error.message : 'Errore eToro.' });
    } finally {
      setValidatingPlan(false);
      setTokenBusy(false);
    }
  };

  const checkCurrentPlan = async () => {
    if (!planPortfolio?.etoroAgentPortfolioId || !orderPlan || validatingPlan) return;
    const token = loadAgentSessionToken(planPortfolio.etoroAgentPortfolioId);
    if (!token) return;
    setValidatingPlan(true);
    setAckOrders(false);
    try {
      const validation = await validateAgentAllocationPlan(settings.live, orderPlan, token);
      setPlanValidation(validation);
      if (validation.ok) toast.success('Piano verificato', { description: 'Strumenti negoziabili e importi sopra i minimi eToro.' });
      else toast.error('Piano non inviabile', { description: validation.blockingIssues[0] });
    } catch (error) {
      setPlanValidation(null);
      toast.error('Controllo pre-ordine non disponibile', { description: error instanceof Error ? error.message : 'Verifica eToro non riuscita.' });
    } finally {
      setValidatingPlan(false);
    }
  };

  const persistExecutionResult = (portfolio: StrategyPortfolioConfig, result: AgentOrderExecutionResult) => {
    const checkedAt = Date.now();
    setExecutionResult(result);
    setPortfolios((current) => current.map((item) => item.id === portfolio.id ? {
      ...item,
      status: result.ok ? 'attivo' : 'da inizializzare',
      initializedAt: result.ok ? (item.initializedAt ?? checkedAt) : item.initializedAt,
      initializationOrders: result.receipts,
      lastInitializationCheckAt: checkedAt,
      updatedAt: checkedAt,
    } : item));
    setPlanPortfolio((current) => current?.id === portfolio.id ? {
      ...current,
      status: result.ok ? 'attivo' : 'da inizializzare',
      initializedAt: result.ok ? (current.initializedAt ?? checkedAt) : current.initializedAt,
      initializationOrders: result.receipts,
      lastInitializationCheckAt: checkedAt,
    } : current);
  };

  const executeInitialPlan = async () => {
    if (!planPortfolio?.etoroAgentPortfolioId || !orderPlan || !ackOrders || executingId) return;
    const token = loadAgentSessionToken(planPortfolio.etoroAgentPortfolioId);
    if (!token) {
      toast.error('Token operativo non disponibile in questa sessione');
      return;
    }
    setExecutingId(planPortfolio.id);
    try {
      const result = await executeAgentAllocationPlan(settings.live, orderPlan, token, planPortfolio.maxOrdersPerDay);
      persistExecutionResult(planPortfolio, result);
      setAckOrders(false);
      if (result.ok) toast.success('Allocazione iniziale eseguita', { description: `${result.filled} ordini verificati come eseguiti da eToro.` });
      else if (result.pending > 0) toast.warning('Ordini accettati, esecuzione da verificare', { description: `${result.filled} eseguiti · ${result.partial} parziali · ${result.pending} in attesa · ${result.failed} non riusciti.` });
      else toast.error('Allocazione iniziale incompleta', { description: `${result.filled} eseguiti · ${result.partial} parziali · ${result.failed} non riusciti · residuo stimato ${money(result.residualMirrorUsd, 'USD')}.` });
    } catch (error) {
      toast.error('Allocazione iniziale incompleta', { description: error instanceof Error ? error.message : 'Controlla gli ordini su eToro.' });
    } finally {
      setExecutingId(null);
    }
  };

  const checkExecutionStatus = async () => {
    if (!planPortfolio?.etoroAgentPortfolioId || !orderPlan || !executionResult || checkingOrders) return;
    const token = loadAgentSessionToken(planPortfolio.etoroAgentPortfolioId);
    if (!token) {
      toast.error('Token operativo non disponibile in questa sessione');
      return;
    }
    setCheckingOrders(true);
    try {
      const result = await verifyAgentOrderExecutions(settings.live, executionResult.receipts, token, orderPlan.scale);
      persistExecutionResult(planPortfolio, result);
      if (result.ok) toast.success('Tutti gli acquisti risultano eseguiti');
      else toast.info('Stato ordini aggiornato', { description: `${result.filled} eseguiti · ${result.partial} parziali · ${result.pending} in attesa · ${result.failed} non riusciti.` });
    } catch (error) {
      toast.error('Verifica ordini non riuscita', { description: error instanceof Error ? error.message : 'Errore eToro.' });
    } finally {
      setCheckingOrders(false);
    }
  };

  const bindRemotePortfolio = (remotePortfolio: RemoteAgentPortfolio) => {
    const localId = remoteBindings[remotePortfolio.id];
    if (!localId) return;
    setPortfolios((current) => current.map((item) => item.id === localId ? {
      ...item,
      status: 'da inizializzare',
      etoroAgentPortfolioId: remotePortfolio.id,
      mirrorId: remotePortfolio.mirrorId,
      virtualBalanceUsd: remotePortfolio.virtualBalanceUsd,
      tokenAvailable: remotePortfolio.tokenAvailable,
      activatedAt: item.activatedAt ?? Date.now(),
      updatedAt: Date.now(),
    } : item));
    toast.success(`${remotePortfolio.name} associato alla strategia locale`, { description: 'L’associazione è locale e non invia ordini.' });
  };

  const draftPreview = useMemo(() => editing ? allocationPreview(editing) : null, [editing]);

  return (
    <section className="col-span-12 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <WalletCards className="h-5 w-5 text-agent" aria-hidden />
            <h2 className="text-title text-text-0">Portafogli strategici</h2>
          </div>
          <p className="max-w-3xl text-caption text-text-1">
            Crea strategie separate, definisci budget e limiti per singola entrata, poi collegale a un Agent Portfolio reale su eToro.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void syncRemote(true)}
          disabled={remoteLoading}
          className="flex items-center gap-2 rounded-lg border border-hairline-strong px-3 py-2 text-caption text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0 disabled:cursor-wait disabled:opacity-60"
        >
          {remoteLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CloudDownload className="h-4 w-4" aria-hidden />}
          Leggi da eToro
        </button>
      </div>

      <div className="grid gap-2 rounded-xl border border-hairline bg-bg-0/50 p-3 text-micro md:grid-cols-3">
        <div className="rounded-lg bg-bg-1 p-3"><div className="flex items-center gap-1.5 font-medium text-gain"><CloudDownload className="h-3.5 w-3.5" aria-hidden /> Su eToro · multi-dispositivo</div><p className="mt-1 leading-relaxed text-text-2">Gli Agent Portfolio già creati vivono sull’account e vengono letti automaticamente anche da un altro telefono o computer.</p></div>
        <div className="rounded-lg bg-bg-1 p-3"><div className="flex items-center gap-1.5 font-medium text-warn"><WalletCards className="h-3.5 w-3.5" aria-hidden /> Nel browser corrente</div><p className="mt-1 leading-relaxed text-text-2">Bozze, pesi Torri e regole restano locali. Export/import permette il trasferimento manuale, ma non una sincronizzazione continua.</p></div>
        <div className="rounded-lg bg-bg-1 p-3"><div className="flex items-center gap-1.5 font-medium text-agent"><LockKeyhole className="h-3.5 w-3.5" aria-hidden /> AI e operatività 24/7</div><p className="mt-1 leading-relaxed text-text-2">Richiedono un processo sempre acceso. La soluzione prevista è estendere il tuo Cloudflare Worker con stato cifrato, pianificazione e controlli di rischio.</p></div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {STRATEGY_TEMPLATES.map((template) => {
          const style = accentClasses[template.accent];
          const configured = portfolios.some((portfolio) => portfolio.templateId === template.id);
          return (
            <div key={template.id} className={cn('card-surface flex min-h-[280px] flex-col border p-4', style.border)}>
              <div className="flex items-start justify-between gap-2">
                <div className={cn('flex h-9 w-9 items-center justify-center rounded-xl', style.bg)}>
                  <Sparkles className={cn('h-4 w-4', style.text)} aria-hidden />
                </div>
                {configured && <span className="rounded-full bg-gain/10 px-2 py-1 text-micro text-gain">Configurata</span>}
              </div>
              <h3 className="mt-3 text-body-strong text-text-0">{template.name}</h3>
              <p className={cn('mt-1 text-micro font-medium', style.text)}>{template.tagline}</p>
              <p className="mt-2 flex-1 text-caption leading-relaxed text-text-2">{template.description}</p>
              <div className="mt-3 rounded-lg border border-hairline bg-bg-0/60 p-2.5 text-micro text-text-2"><p><span className="text-text-1">Obiettivo:</span> {template.objective} · {template.horizon}</p><p className="mt-1"><span className="text-text-1">Asset:</span> {template.allocations.map((allocation) => `${allocation.symbol} ${allocation.weightPct}%`).join(' · ')}</p><p className="mt-1 text-warn">Stress ipotetico: fino a −{template.stressLossPct}% · non è una previsione</p></div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-micro text-text-2">{riskLabel[template.risk]}</span>
                <button
                  type="button"
                  onClick={() => openEditor(template.id)}
                  className={cn('flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-micro font-medium transition-colors', style.bg, style.text, 'hover:brightness-110')}
                >
                  {configured ? 'Modifica' : 'Configura'} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {portfolios.length > 0 && (
        <div className="card-surface density-pad p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-body-strong text-text-0">Le tue strategie</h3>
              <p className="text-caption text-text-2">Prima configuriamo i limiti; l’attivazione reale richiede un’ultima conferma.</p>
            </div>
            <span className="text-micro text-text-2">{portfolios.length} configurate</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {portfolios.map((portfolio) => {
              const template = getStrategyTemplate(portfolio.templateId);
              const preview = allocationPreview(portfolio);
              return (
                <div key={portfolio.id} className="rounded-xl border border-hairline bg-bg-1 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-body-strong text-text-0">{portfolio.name}</h4>
                        <span className={cn('max-w-[280px] rounded-full px-2 py-0.5 text-micro', statusClasses[portfolio.status])}>
                          {portfolio.status === 'da inizializzare' ? 'Creato · capitale allocato · in attesa di inizializzazione' : portfolio.status}
                        </span>
                      </div>
                      <p className="mt-1 text-caption text-text-2">{template.name} · {template.tagline}</p>
                    </div>
                    {portfolio.etoroAgentPortfolioId && <span className="font-mono text-micro text-gain">eToro #{portfolio.etoroAgentPortfolioId}</span>}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-caption sm:grid-cols-4">
                    <Metric label="Budget" value={money(fromUsd(portfolio.budgetUsd), displayCurrency)} />
                    <Metric label="Operativo" value={money(fromUsd(preview.operatingBudgetUsd), displayCurrency)} />
                    <Metric label="Max entrata" value={money(fromUsd(portfolio.maxOrderUsd), displayCurrency)} />
                    <Metric label="Posizioni" value={`${portfolio.maxPositions}`} />
                  </div>
                  <div className="mt-3 rounded-lg border border-hairline bg-bg-0/60 p-3">
                    <p className="text-micro text-text-2">Pesi target · {template.horizon} · controllo ribilanciamento {portfolio.rebalance}</p>
                    <p className="mt-1 text-caption text-text-1">{template.allocations.map((allocation) => `${allocation.symbol} ${allocation.weightPct}%`).join(' · ')}</p>
                    <StrategySimulationPanel portfolio={portfolio} fromUsd={fromUsd} displayCurrency={displayCurrency} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                    <span className="flex items-center gap-1.5 text-micro text-text-2"><Target className="h-3.5 w-3.5 text-agent" aria-hidden /> Fino a {preview.affordablePositions} posizioni finanziabili ai minimi impostati</span>
                    <div className="flex gap-2">
                      {portfolio.status !== 'attivo' && portfolio.status !== 'da inizializzare' ? <button type="button" onClick={() => void simulateStrategy(portfolio)} disabled={simulatingId === portfolio.id} className="flex items-center gap-1.5 rounded-lg border border-agent/40 px-2.5 py-1.5 text-micro text-agent hover:bg-agent/10 disabled:opacity-50">{simulatingId === portfolio.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />} Simula</button> : null}
                      {portfolio.status !== 'attivo' && portfolio.status !== 'da inizializzare' && (
                        <button
                          type="button"
                          onClick={() => openEditor(portfolio.templateId)}
                          className="rounded-lg border border-hairline-strong px-2.5 py-1.5 text-micro text-text-1 transition-colors hover:bg-bg-2"
                        >
                          Modifica limiti
                        </button>
                      )}
                      {portfolio.status === 'da inizializzare' ? (
                        <button
                          type="button"
                          onClick={() => void prepareInitialPlan(portfolio)}
                          disabled={planningId === portfolio.id}
                          className="flex items-center gap-1.5 rounded-lg bg-warn px-2.5 py-1.5 text-micro font-medium text-bg-0 transition-colors hover:bg-warn/90 disabled:opacity-50"
                        >
                          {planningId === portfolio.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ListChecks className="h-3.5 w-3.5" aria-hidden />}
                          Prepara acquisti
                        </button>
                      ) : portfolio.status !== 'attivo' ? (
                        <button
                          type="button"
                          onClick={() => { if (portfolio.status === 'simulato' && portfolio.simulation && portfolio.simulation.coveragePct >= 80) { setAckReal(false); setConfirming(portfolio); } }}
                          disabled={portfolio.status !== 'simulato' || !portfolio.simulation || portfolio.simulation.coveragePct < 80}
                          className="flex items-center gap-1.5 rounded-lg bg-agent px-2.5 py-1.5 text-micro font-medium text-bg-0 transition-colors hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Play className="h-3.5 w-3.5" aria-hidden /> {portfolio.status === 'simulato' && (portfolio.simulation?.coveragePct ?? 0) >= 80 ? 'Attiva su eToro' : portfolio.simulation ? 'Copertura insufficiente' : 'Simula prima'}
                        </button>
                      ) : (
                        <span className="flex items-center gap-1.5 rounded-lg bg-gain/10 px-2.5 py-1.5 text-micro text-gain"><Check className="h-3.5 w-3.5" aria-hidden /> Investito · esecuzioni verificate</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {remoteChecked && (
        <div className="card-surface density-pad p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-body-strong text-text-0">Agent Portfolio già presenti su eToro</h3>
              <p className="text-caption text-text-2">Lettura tramite il proxy configurato. Nessuna modifica viene eseguita da questo elenco.</p>
            </div>
            <button type="button" onClick={() => void syncRemote(true)} className="rounded-lg p-2 text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0" aria-label="Aggiorna Agent Portfolio">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {remote.length === 0 ? (
            <p className="rounded-lg border border-dashed border-hairline-strong p-4 text-caption text-text-2">Nessun Agent Portfolio restituito dall’account.</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {remote.map((item) => (
                <div key={item.id} className="rounded-lg border border-hairline bg-bg-1 px-3 py-3">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-caption font-medium text-text-0">{item.name}</p><p className="truncate font-mono text-micro text-text-2">ID {item.id}</p>{item.createdAt ? <p className="mt-1 text-micro text-text-2">Creato {new Date(item.createdAt).toLocaleString('it-IT')}</p> : null}</div><span className="shrink-0 rounded-full bg-gain/10 px-2 py-1 text-micro text-gain">Su eToro</span></div>
                  {portfolios.some((portfolio) => portfolio.etoroAgentPortfolioId === item.id) ? <p className="mt-2 flex items-center gap-1.5 text-micro text-gain"><Check className="h-3.5 w-3.5" aria-hidden /> Associato a Torri</p> : <div className="mt-3 flex gap-2"><select aria-label={`Strategia locale da associare a ${item.name}`} value={remoteBindings[item.id] ?? ''} onChange={(event) => setRemoteBindings((current) => ({ ...current, [item.id]: event.target.value }))} className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-bg-0 px-2 py-1.5 text-micro text-text-1"><option value="">Associa a…</option>{portfolios.filter((portfolio) => !portfolio.etoroAgentPortfolioId).map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name} · {getStrategyTemplate(portfolio.templateId).name}</option>)}</select><button type="button" disabled={!remoteBindings[item.id]} onClick={() => bindRemotePortfolio(item)} className="rounded-md border border-agent/40 px-2 py-1.5 text-micro font-medium text-agent hover:bg-agent/10 disabled:opacity-40">Collega</button></div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!liveReady && (
        <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-caption text-text-1">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>Puoi configurare e salvare le strategie anche ora. Per leggerle o crearle su eToro devi prima completare chiavi, proxy, ambiente <strong className="text-text-0">Real</strong> e permesso di scrittura in Impostazioni.</span>
        </div>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[680px]">
          {editing && draftPreview && <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5 text-agent" aria-hidden /> Configura {getStrategyTemplate(editing.templateId).name}</DialogTitle>
              <DialogDescription>Questi sono limiti del motore Torri. eToro riceverà il solo budget totale alla creazione dell’Agent Portfolio.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome Agent Portfolio" hint="6–10 caratteri">
                <Input value={editing.name} onChange={(event) => updateEditing('name', event.target.value)} maxLength={10} placeholder="Es. Dividend" />
              </Field>
              <Field label={`Budget reale (${currencySymbol})`} hint={`eToro invierà ${money(toUsd(editing.budgetUsd), 'USD')}`}>
                <Input type="number" min={1} step={50} value={inputMoney(editing.budgetUsd, fromUsd)} onChange={numberInput((value) => updateEditing('budgetUsd', Math.round(toUsd(value) * 100) / 100))} />
              </Field>
              <Field label={`Minimo per operazione (${currencySymbol})`} hint="Evita micro-ordini">
                <Input type="number" min={1} step={5} value={inputMoney(editing.minOrderUsd, fromUsd)} onChange={numberInput((value) => updateEditing('minOrderUsd', Math.round(toUsd(value) * 100) / 100))} />
              </Field>
              <Field label={`Massimo per operazione (${currencySymbol})`} hint="Tetto per singola entrata">
                <Input type="number" min={1} step={5} value={inputMoney(editing.maxOrderUsd, fromUsd)} onChange={numberInput((value) => updateEditing('maxOrderUsd', Math.round(toUsd(value) * 100) / 100))} />
              </Field>
              <Field label="Numero massimo posizioni" hint="Se arrivano 20 strumenti, ne limita la selezione">
                <Input type="number" min={1} max={100} step={1} value={editing.maxPositions} onChange={numberInput((value) => updateEditing('maxPositions', Math.max(1, Math.round(value))))} />
              </Field>
              <Field label="Riserva di liquidità (%)" hint="Resta non investita">
                <Input type="number" min={0} max={99} step={5} value={editing.cashReservePct} onChange={numberInput((value) => updateEditing('cashReservePct', Math.min(99, Math.max(0, value))))} />
              </Field>
              <Field label="Massimo ordini al giorno" hint="Kill switch operativo aggiuntivo">
                <Input type="number" min={1} max={100} step={1} value={editing.maxOrdersPerDay} onChange={numberInput((value) => updateEditing('maxOrdersPerDay', Math.max(1, Math.round(value))))} />
              </Field>
              <Field label="Ribilanciamento" hint="Cadenza target salvata. In questa versione non genera ancora ordini automatici.">
                <select value={editing.rebalance} onChange={(event) => updateEditing('rebalance', event.target.value as StrategyPortfolioConfig['rebalance'])} className="flex h-10 w-full rounded-lg border border-hairline-strong bg-bg-1 px-3 text-caption text-text-0 outline-none focus:border-agent">
                  <option value="giornaliero">Giornaliero</option><option value="settimanale">Settimanale</option><option value="mensile">Mensile</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-2 rounded-xl border border-agent/25 bg-agent/5 p-4 sm:grid-cols-3">
              <Metric label="Budget operativo" value={money(fromUsd(draftPreview.operatingBudgetUsd), displayCurrency)} />
              <Metric label="Divisione teorica" value={money(fromUsd(draftPreview.equalSplitUsd), displayCurrency)} />
              <Metric label="Cap massimo entrata" value={money(fromUsd(draftPreview.maxSingleEntryUsd), displayCurrency)} />
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-hairline bg-bg-1 p-3 text-micro text-text-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden /> Le regole non useranno leva: questo studio applicherà solamente ordini buy/sell entro i limiti definiti.</div>
            <DialogFooter>
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2">Annulla</button>
              <button type="button" onClick={saveDraft} className="rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90">Salva strategia</button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirming)} onOpenChange={(open) => { if (!open && !creatingId) { setConfirming(null); setAckReal(false); } }}>
        <DialogContent className="sm:max-w-[560px]">
          {confirming && <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-loss" aria-hidden /> Conferma attivazione reale</DialogTitle>
              <DialogDescription>Questa è l’ultima schermata prima della chiamata POST alle API Agent Portfolio di eToro.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-hairline bg-bg-1 p-4 text-caption"><Metric label="Portafoglio" value={confirming.name} /><Metric label="Budget reale" value={money(fromUsd(confirming.budgetUsd), displayCurrency)} /><Metric label="Min / max ordine" value={`${money(fromUsd(confirming.minOrderUsd), displayCurrency)} / ${money(fromUsd(confirming.maxOrderUsd), displayCurrency)}`} /><Metric label="Riserva" value={`${confirming.cashReservePct}%`} /></div>
              {!realExecutionActive && <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-caption text-warn"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Per sicurezza il pulsante è disabilitato: attiva Live + Real + Lettura e scrittura in Impostazioni.</div>}
              {realExecutionActive && <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-loss/50 bg-loss/5 p-3"><Checkbox checked={ackReal} onCheckedChange={(value) => setAckReal(value === true)} className="mt-0.5" /><span className="text-caption text-text-0">Confermo che eToro potrà prelevare {money(fromUsd(confirming.budgetUsd), displayCurrency)} dal conto reale e creare un Agent Portfolio con permesso di scrittura.</span></label>}
              <p className="flex items-start gap-2 text-micro text-text-2"><CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-agent" aria-hidden /> Il limite minimo/massimo per singolo ordine resta una regola del motore Torri; l’API di creazione eToro riceve il budget totale e i permessi reali.</p>
            </div>
            <DialogFooter>
              <button type="button" disabled={Boolean(creatingId)} onClick={() => { setConfirming(null); setAckReal(false); }} className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2">Annulla</button>
              <button type="button" disabled={!realExecutionActive || !ackReal || Boolean(creatingId)} onClick={() => void activateRemote()} className="flex items-center gap-2 rounded-lg bg-loss px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-loss/90 disabled:cursor-not-allowed disabled:opacity-40">
                {creatingId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />} Crea portafoglio reale
              </button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(planPortfolio && orderPlan)} onOpenChange={(open) => { if (!open && !executingId && !tokenBusy && !checkingOrders) { setPlanPortfolio(null); setOrderPlan(null); setPlanValidation(null); setExecutionResult(null); setAckOrders(false); setAckToken(false); } }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[720px]">
          {planPortfolio && orderPlan && <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><ListChecks className="h-5 w-5 text-warn" aria-hidden /> Allocazione iniziale · {planPortfolio.name}</DialogTitle>
              <DialogDescription>Anteprima reale degli acquisti. Aprire l’Agent Portfolio ha allocato il capitale, ma fino a questa conferma non compra alcun asset.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 sm:grid-cols-4">
              <Metric label="Capitale collegato" value={money(fromUsd(orderPlan.mirrorBudgetUsd), displayCurrency)} />
              <Metric label="Capitale da investire" value={money(fromUsd(orderPlan.orders.reduce((sum, item) => sum + item.mirrorAmountUsd, 0)), displayCurrency)} />
              <Metric label="Asset previsti" value={String(orderPlan.orders.length)} />
              <Metric label="Liquidità prevista" value={`${orderPlan.cashReservePct}%`} />
            </div>
            <div className="overflow-x-auto rounded-xl border border-hairline bg-bg-1">
              <div className="grid min-w-[640px] grid-cols-[1.1fr_auto_auto_1fr] gap-3 border-b border-hairline px-3 py-2 text-micro uppercase tracking-wide text-text-2"><span>Asset / peso</span><span>Importo reale</span><span>Invio</span><span>Controllo eToro</span></div>
              {orderPlan.orders.map((item) => {
                const check = planValidation?.checks.find((candidate) => candidate.instrumentId === item.instrumentId);
                return (
                  <div key={item.symbol} className="grid min-w-[640px] grid-cols-[1.1fr_auto_auto_1fr] items-center gap-3 border-b border-hairline px-3 py-3 last:border-b-0">
                    <div><p className="font-mono text-caption font-medium text-text-0">{item.symbol} · {item.weightPct.toFixed(1).replace('.', ',')}%</p><p className="text-micro text-text-2">Instrument ID {item.instrumentId}</p></div>
                    <span className="font-mono text-caption text-text-0">{money(fromUsd(item.mirrorAmountUsd), displayCurrency)}</span>
                    <span className="text-right font-mono text-caption text-agent">{item.chunks.length} {item.chunks.length === 1 ? 'ordine' : 'ordini'}</span>
                    <div className={cn('text-micro', !check ? 'text-text-2' : check.eligible ? 'text-gain' : 'text-loss')}>
                      {validatingPlan && !check ? 'Verifica…' : check ? check.detail : 'Da verificare'}
                      {check && check.minPositionExposureUsd > 0 ? <span className="block text-text-2">Minimo {money(check.minPositionExposureUsd, 'USD')}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {orderPlan.unresolvedSymbols.length > 0 && <div className="rounded-lg border border-loss/35 bg-loss/5 p-3 text-caption text-loss">Strumenti non risolti: {orderPlan.unresolvedSymbols.join(', ')}. Nessun ordine può essere inviato finché il piano non è completo.</div>}
            {orderPlan.totalOrders > planPortfolio.maxOrdersPerDay && <div className="rounded-lg border border-warn/35 bg-warn/5 p-3 text-caption text-warn">Il piano richiede {orderPlan.totalOrders} ordini, ma il limite giornaliero è {planPortfolio.maxOrdersPerDay}. Aumenta il limite o il massimo per singola entrata prima di procedere.</div>}
            <div className="rounded-xl border border-info/25 bg-info/5 p-3 text-caption text-text-1">
              <p className="font-medium text-info">Come vengono inviati gli ordini?</p>
              <p className="mt-1 leading-relaxed">Torri decide e mostra sempre pesi e importi reali. La conversione tecnica richiesta dall’Agent Portfolio avviene solo al momento dell’invio, senza alterare l’allocazione percentuale.</p>
            </div>
            {!loadAgentSessionToken(planPortfolio.etoroAgentPortfolioId ?? '') ? (
              <div className="space-y-2 rounded-xl border border-warn/30 bg-warn/5 p-3">
                <div className="flex items-start gap-2"><KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /><div><p className="text-caption font-medium text-text-0">Serve un nuovo token operativo</p><p className="text-micro text-text-2">Quello restituito alla creazione precedente non è recuperabile. Il nuovo segreto resterà solo in questa sessione e non finirà in localStorage.</p></div></div>
                <label className="flex cursor-pointer items-start gap-2 text-caption text-text-1"><Checkbox checked={ackToken} onCheckedChange={(value) => setAckToken(value === true)} /><span>Autorizzo la creazione di un token Agent con lettura e scrittura reali.</span></label>
                <button type="button" onClick={() => void generateSessionToken()} disabled={!ackToken || tokenBusy} className="inline-flex items-center gap-2 rounded-lg border border-warn/50 px-3 py-2 text-caption font-medium text-warn hover:bg-warn/10 disabled:opacity-40">{tokenBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />} Genera token per questa sessione</button>
              </div>
            ) : <div className="space-y-2 rounded-xl border border-gain/25 bg-gain/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden /><div><p className="text-caption font-medium text-text-0">Token del {planPortfolio.name} pronto in questa scheda</p><p className="text-micro text-text-2">Non viene esportato né salvato permanentemente. Lo stesso token verrà riutilizzato per verifiche e futuri ribilanciamenti durante questa sessione.</p></div></div>
                <div className="flex shrink-0 gap-1.5">{!executionResult ? <button type="button" onClick={() => void checkCurrentPlan()} disabled={validatingPlan} className="inline-flex items-center gap-1.5 rounded-lg border border-gain/40 px-2.5 py-1.5 text-micro text-gain hover:bg-gain/10 disabled:opacity-50">{validatingPlan ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Controlla minimi e mercati</button> : null}<button type="button" onClick={() => { clearAgentSessionToken(planPortfolio.etoroAgentPortfolioId ?? ''); setPlanValidation(null); setAckOrders(false); setPlanPortfolio((current) => current ? { ...current } : current); toast.success('Token rimosso da questa sessione'); }} disabled={Boolean(executingId) || checkingOrders} className="rounded-lg border border-hairline-strong px-2.5 py-1.5 text-micro text-text-2 hover:bg-bg-2 hover:text-text-0 disabled:opacity-40">Dimentica token</button></div>
              </div>
              {planValidation ? <div className={cn('rounded-lg px-2.5 py-2 text-micro', planValidation.ok ? 'bg-gain/10 text-gain' : 'bg-loss/10 text-loss')}>{planValidation.ok ? 'Piano verificato: strumenti negoziabili e importi sopra i minimi eToro.' : planValidation.blockingIssues.join(' · ')}</div> : null}
            </div>}
            {loadAgentSessionToken(planPortfolio.etoroAgentPortfolioId ?? '') && !executionResult && planValidation?.ok ? (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-loss/40 bg-loss/5 p-3"><Checkbox checked={ackOrders} onCheckedChange={(value) => setAckOrders(value === true)} className="mt-0.5" /><span className="text-caption text-text-0">Ho verificato strumenti, pesi, minimi e importi. Confermo separatamente l’invio di {orderPlan.totalOrders} ordini REALI attraverso l’Agent Portfolio.</span></label>
            ) : null}
            {executionResult ? <div className="space-y-3 rounded-xl border border-hairline bg-bg-1 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-caption font-medium text-text-0">Esito inizializzazione</p><p className="text-micro text-text-2">{executionResult.filled} eseguiti · {executionResult.partial} parziali · {executionResult.pending} in attesa · {executionResult.failed} non riusciti · residuo reale stimato {money(fromUsd(executionResult.residualMirrorUsd), displayCurrency)}</p></div><button type="button" onClick={() => void checkExecutionStatus()} disabled={checkingOrders || executionResult.ok} className="inline-flex items-center gap-1.5 rounded-lg border border-info/40 px-2.5 py-1.5 text-micro text-info hover:bg-info/10 disabled:opacity-40">{checkingOrders ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Ricontrolla esecuzioni</button></div>
              <div className="divide-y divide-hairline rounded-lg border border-hairline bg-bg-0">
                {executionResult.receipts.map((receipt, index) => <div key={`${receipt.referenceId}-${index}`} className="grid gap-1 px-3 py-2 text-micro sm:grid-cols-[1fr_auto]"><div><span className="font-mono font-medium text-text-0">{receipt.symbol}</span><span className="ml-2 text-text-2">{receipt.orderId ? `Ordine #${receipt.orderId}` : receipt.statusLabel}</span>{receipt.error ? <p className="mt-0.5 text-loss">{receipt.error}</p> : null}</div><div className={cn('font-mono', receipt.status === 'filled' ? 'text-gain' : receipt.status === 'pending' || receipt.status === 'accepted' || receipt.status === 'partially-filled' ? 'text-warn' : 'text-loss')}>{money(fromUsd(receipt.filledVirtualAmountUsd / orderPlan.scale), displayCurrency)} / {money(fromUsd(receipt.requestedVirtualAmountUsd / orderPlan.scale), displayCurrency)} · {receipt.statusLabel}</div></div>)}
              </div>
              {executionResult.ok ? <p className="flex items-center gap-1.5 text-caption text-gain"><Check className="h-4 w-4" aria-hidden /> Inizializzazione completata: il portafoglio è ora attivo.</p> : <p className="text-micro text-warn">Il portafoglio resta “in attesa di inizializzazione”. Non vengono reinviati automaticamente gli ordini residui: prima controlla l’esito su eToro.</p>}
            </div> : null}
            <DialogFooter>
              <button type="button" disabled={Boolean(executingId) || tokenBusy || checkingOrders} onClick={() => { setPlanPortfolio(null); setOrderPlan(null); setPlanValidation(null); setExecutionResult(null); }} className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-1 hover:bg-bg-2">{executionResult ? 'Chiudi' : 'Chiudi senza comprare'}</button>
              {!executionResult ? <button type="button" onClick={() => void executeInitialPlan()} disabled={!realExecutionActive || !ackOrders || !planValidation?.ok || !loadAgentSessionToken(planPortfolio.etoroAgentPortfolioId ?? '') || orderPlan.unresolvedSymbols.length > 0 || orderPlan.totalOrders === 0 || orderPlan.totalOrders > planPortfolio.maxOrdersPerDay || Boolean(executingId)} className="inline-flex items-center gap-2 rounded-lg bg-loss px-4 py-2 text-body-strong text-bg-0 hover:bg-loss/90 disabled:cursor-not-allowed disabled:opacity-40">{executingId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Conferma e invia acquisti</button> : null}
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-caption text-text-0">{label}</Label><div>{children}</div><p className="text-micro text-text-2">{hint}</p></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-micro text-text-2">{label}</p><p className="mt-0.5 text-caption font-medium tabular-nums text-text-0">{value}</p></div>;
}
