import { useId, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Ban,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  CircleAlert,
  Coins,
  Globe2,
  HeartPulse,
  Info,
  Landmark,
  Layers3,
  Leaf,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import './strategy-onboarding.css';

export type StrategyOnboardingStep = 'goals' | 'preferences' | 'guardrails' | 'review';
export type StrategyObjective = 'balanced-growth' | 'dividends' | 'capital-preservation' | 'tactical';
export type StrategyMacroPreference =
  | 'global-equities'
  | 'technology'
  | 'healthcare'
  | 'crypto-large-cap'
  | 'bonds'
  | 'commodities';
export type StrategyCryptoPreference = 'none' | 'majors' | 'broad' | 'meme-opt-in';

export interface StrategyOnboardingPortfolio {
  id: string;
  name: string;
  subtitle?: string;
  balanceEur?: number;
  status?: 'connected' | 'needs-token' | 'unavailable';
}

export interface StrategyOnboardingAnswers {
  portfolioId: string;
  strategyName: string;
  objective: StrategyObjective;
  horizonMonths: number;
  budgetEur: number;
  macroPreferences: StrategyMacroPreference[];
  cryptoPreference: StrategyCryptoPreference;
  excludeMemeCoins: boolean;
  maxHoldings: number;
  cashTargetPct: number;
  maxDrawdownPct: number;
  maxAssetPct: number;
  maxSectorPct: number;
  maxTurnoverPct: number;
  minHoldingDays: number;
  shadowDays: number;
}

export interface StrategyAllocationSlice {
  key: string;
  label: string;
  weightPct: number;
  color?: string;
}

export interface StrategyOnboardingScenario {
  horizonMonths: number;
  favorablePct: number;
  medianPct: number;
  adversePct: number;
}

export interface StrategyOnboardingGuardrails {
  maxDrawdownPct: number;
  maxAssetPct: number;
  maxSectorPct: number;
  minCashPct: number;
  maxTurnoverPct: number;
  minHoldingDays: number;
  maxHoldings: number;
}

export interface StrategyOnboardingReason {
  title: string;
  detail: string;
  kind?: 'growth' | 'diversification' | 'adaptive';
}

export interface StrategyOnboardingDraft {
  strategyName: string;
  summary: string;
  allocations: StrategyAllocationSlice[];
  scenario: StrategyOnboardingScenario;
  riskRangePct: number;
  guardrails: StrategyOnboardingGuardrails;
  reasons: StrategyOnboardingReason[];
  shadowDays: number;
}

export interface StrategyOnboardingProps {
  className?: string;
  portfolios?: StrategyOnboardingPortfolio[];
  initialAnswers?: Partial<StrategyOnboardingAnswers>;
  initialDraft?: StrategyOnboardingDraft | null;
  initialStep?: StrategyOnboardingStep;
  onGenerate?: (answers: StrategyOnboardingAnswers) => Promise<StrategyOnboardingDraft>;
  onActivate?: (draft: StrategyOnboardingDraft, answers: StrategyOnboardingAnswers) => Promise<void>;
  onStepChange?: (step: StrategyOnboardingStep) => void;
}

const DEFAULT_PORTFOLIO: StrategyOnboardingPortfolio = {
  id: '0405bc2a-2bd1-443b-9000-8e6846fe6d10',
  name: 'Portfolio 0405bc2a',
  subtitle: 'Agent Portfolio esistente',
  status: 'connected',
};

// Public preview data is colocated with the component so the browser review route
// and the live onboarding always render the exact same defaults.
// eslint-disable-next-line react-refresh/only-export-components
export const DEFAULT_STRATEGY_ONBOARDING_ANSWERS: StrategyOnboardingAnswers = {
  portfolioId: DEFAULT_PORTFOLIO.id,
  strategyName: 'Dinamico consapevole',
  objective: 'balanced-growth',
  horizonMonths: 12,
  budgetEur: 5_000,
  macroPreferences: ['global-equities', 'technology', 'healthcare', 'crypto-large-cap'],
  cryptoPreference: 'majors',
  excludeMemeCoins: true,
  maxHoldings: 20,
  cashTargetPct: 3,
  maxDrawdownPct: 24,
  maxAssetPct: 12,
  maxSectorPct: 35,
  maxTurnoverPct: 28,
  minHoldingDays: 14,
  shadowDays: 14,
};

const STEPS: Array<{ id: StrategyOnboardingStep; label: string }> = [
  { id: 'goals', label: 'Obiettivi' },
  { id: 'preferences', label: 'Preferenze' },
  { id: 'guardrails', label: 'Guardrail' },
  { id: 'review', label: 'Revisione' },
];

const STEP_INDEX: Record<StrategyOnboardingStep, number> = {
  goals: 0,
  preferences: 1,
  guardrails: 2,
  review: 3,
};

const OBJECTIVES: Array<{
  id: StrategyObjective;
  title: string;
  copy: string;
  Icon: typeof TrendingUp;
}> = [
  {
    id: 'balanced-growth',
    title: 'Crescita bilanciata',
    copy: 'Crescita del capitale con oscillazioni controllate.',
    Icon: TrendingUp,
  },
  {
    id: 'dividends',
    title: 'Dividendi',
    copy: 'Qualità, distribuzioni e rotazione più contenuta.',
    Icon: Coins,
  },
  {
    id: 'capital-preservation',
    title: 'Protezione del capitale',
    copy: 'Diversificazione difensiva e perdita massima più stretta.',
    Icon: ShieldCheck,
  },
  {
    id: 'tactical',
    title: 'Dinamico',
    copy: 'Più libertà tattica, con guardrail deterministici.',
    Icon: Zap,
  },
];

const MACRO_OPTIONS: Array<{
  id: StrategyMacroPreference;
  label: string;
  copy: string;
  defaultWeight: number;
  color: string;
  Icon: typeof Globe2;
}> = [
  { id: 'global-equities', label: 'Azioni globali', copy: 'Mercati sviluppati e leader globali', defaultWeight: 45, color: '#075d3b', Icon: Globe2 },
  { id: 'technology', label: 'Tecnologia', copy: 'Software, semiconduttori e infrastruttura', defaultWeight: 25, color: '#75a58a', Icon: Zap },
  { id: 'healthcare', label: 'Salute', copy: 'Farmaceutica, medtech e servizi sanitari', defaultWeight: 15, color: '#6d9dd8', Icon: HeartPulse },
  { id: 'crypto-large-cap', label: 'Crypto large cap', copy: 'Solo asset liquidi e consolidati', defaultWeight: 10, color: '#e8c36f', Icon: Coins },
  { id: 'bonds', label: 'Obbligazionario', copy: 'Stabilità e protezione nei regimi avversi', defaultWeight: 8, color: '#aa98ca', Icon: Landmark },
  { id: 'commodities', label: 'Materie prime', copy: 'Oro e asset reali per diversificare', defaultWeight: 8, color: '#c47f61', Icon: Leaf },
];

const ALLOCATION_COLORS: Record<string, string> = Object.fromEntries(
  MACRO_OPTIONS.map((item) => [item.id, item.color]),
);

const CASH_COLOR = '#c8c9c7';
const BOND_COLOR = '#aa98ca';
const NUMBER_FORMAT = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });

function buildAllocation(answers: StrategyOnboardingAnswers): StrategyAllocationSlice[] {
  const selected = MACRO_OPTIONS.filter((item) => answers.macroPreferences.includes(item.id));
  const includesBonds = selected.some((item) => item.id === 'bonds');
  const stabilizerPct = includesBonds ? 0 : Math.min(2, Math.max(0, 100 - answers.cashTargetPct));
  const availablePct = Math.max(0, 100 - answers.cashTargetPct - stabilizerPct);
  const sourceTotal = selected.reduce((sum, item) => sum + item.defaultWeight, 0) || 1;
  const slices: StrategyAllocationSlice[] = selected.map((item) => ({
    key: item.id,
    label: item.label,
    weightPct: Math.round((item.defaultWeight / sourceTotal) * availablePct),
    color: item.color,
  }));
  const currentTotal = slices.reduce((sum, item) => sum + item.weightPct, 0);
  if (slices.length > 0) slices[0] = { ...slices[0], weightPct: slices[0].weightPct + availablePct - currentTotal };
  if (stabilizerPct > 0) slices.push({ key: 'bonds', label: 'Obbligazionario', weightPct: stabilizerPct, color: BOND_COLOR });
  if (answers.cashTargetPct > 0) slices.push({ key: 'cash', label: 'Liquidità', weightPct: answers.cashTargetPct, color: CASH_COLOR });
  return slices.filter((item) => item.weightPct > 0);
}

// eslint-disable-next-line react-refresh/only-export-components
export function createStrategyOnboardingPreview(answers: StrategyOnboardingAnswers): StrategyOnboardingDraft {
  const objectiveCopy: Record<StrategyObjective, string> = {
    'balanced-growth': 'Crescita bilanciata con controllo del rischio',
    dividends: 'Flussi di qualità con bassa rotazione',
    'capital-preservation': 'Preservazione con diversificazione difensiva',
    tactical: 'Adattività tattica entro limiti rigorosi',
  };
  const favorableBase = answers.objective === 'tactical' ? 22 : answers.objective === 'capital-preservation' ? 11 : 18;
  const horizonFactor = Math.sqrt(Math.max(6, answers.horizonMonths) / 12);

  return {
    strategyName: answers.strategyName.trim() || 'Dinamico consapevole',
    summary: objectiveCopy[answers.objective],
    allocations: buildAllocation(answers),
    scenario: {
      horizonMonths: answers.horizonMonths,
      favorablePct: Math.round(favorableBase * horizonFactor),
      medianPct: Math.round(favorableBase * 0.42 * horizonFactor),
      adversePct: -answers.maxDrawdownPct,
    },
    riskRangePct: answers.maxDrawdownPct,
    guardrails: {
      maxDrawdownPct: answers.maxDrawdownPct,
      maxAssetPct: answers.maxAssetPct,
      maxSectorPct: answers.maxSectorPct,
      minCashPct: answers.cashTargetPct,
      maxTurnoverPct: answers.maxTurnoverPct,
      minHoldingDays: answers.minHoldingDays,
      maxHoldings: answers.maxHoldings,
    },
    reasons: [
      {
        title: 'Crescita bilanciata con controllo del rischio',
        detail: 'Combina esposizione azionaria globale e settoriale con protezioni dinamiche per gestire la volatilità.',
        kind: 'growth',
      },
      {
        title: 'Diversificazione intelligente',
        detail: 'Distribuisce l’allocazione tra asset e settori con gestione della correlazione e limiti di concentrazione.',
        kind: 'diversification',
      },
      {
        title: 'Adattiva al mercato',
        detail: 'Ribilanciamenti guidati da segnali quantitativi e trend di mercato, sempre nel rispetto dei guardrail.',
        kind: 'adaptive',
      },
    ],
    shadowDays: answers.shadowDays,
  };
}

function ScenarioTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: string | number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const favorable = payload.find((item) => item.dataKey === 'positiveOuter')?.value;
  const adverse = payload.find((item) => item.dataKey === 'negativeOuter')?.value;
  return (
    <div className="so-chart-tooltip">
      <strong>Mese {label}</strong>
      <span>Fascia favorevole +{Number(favorable ?? 0).toFixed(1)}%</span>
      <span>Fascia avversa {Number(adverse ?? 0).toFixed(1)}%</span>
    </div>
  );
}

function buildScenarioData(favorablePct: number, adversePct: number, horizonMonths: number) {
  const points = 6;
  return Array.from({ length: points }, (_, index) => {
    const progress = index / (points - 1);
    const curved = Math.pow(progress, 1.22);
    return {
      month: Math.round(horizonMonths * progress),
      positiveOuter: favorablePct * curved,
      positiveInner: favorablePct * 0.56 * curved,
      negativeInner: adversePct * 0.55 * curved,
      negativeOuter: adversePct * curved,
    };
  });
}

function reasonIcon(kind: StrategyOnboardingReason['kind']) {
  if (kind === 'diversification') return ShieldCheck;
  if (kind === 'adaptive') return Target;
  return TrendingUp;
}

function portfolioStatusCopy(status: StrategyOnboardingPortfolio['status']) {
  if (status === 'needs-token') return 'Token operativo da verificare';
  if (status === 'unavailable') return 'Temporaneamente non disponibile';
  return 'Agent Portfolio esistente';
}

export function StrategyOnboarding({
  className,
  portfolios,
  initialAnswers,
  initialDraft = null,
  initialStep = 'goals',
  onGenerate,
  onActivate,
  onStepChange,
}: StrategyOnboardingProps) {
  const idPrefix = useId().replace(/:/g, '');
  const availablePortfolios = portfolios?.length ? portfolios : [DEFAULT_PORTFOLIO];
  const firstPortfolioId = initialAnswers?.portfolioId ?? availablePortfolios[0]?.id ?? DEFAULT_PORTFOLIO.id;
  const [answers, setAnswers] = useState<StrategyOnboardingAnswers>(() => ({
    ...DEFAULT_STRATEGY_ONBOARDING_ANSWERS,
    ...initialAnswers,
    portfolioId: firstPortfolioId,
  }));
  const [step, setStepState] = useState<StrategyOnboardingStep>(initialStep);
  const [draft, setDraft] = useState<StrategyOnboardingDraft | null>(initialDraft);
  const [reviewRiskPct, setReviewRiskPct] = useState(initialDraft?.riskRangePct ?? answers.maxDrawdownPct);
  const [busy, setBusy] = useState<'generating' | 'activating' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);

  const stepIndex = STEP_INDEX[step];
  const selectedPortfolio = availablePortfolios.find((item) => item.id === answers.portfolioId) ?? availablePortfolios[0] ?? DEFAULT_PORTFOLIO;
  const selectedMacro = MACRO_OPTIONS.filter((item) => answers.macroPreferences.includes(item.id));
  const scenarioData = useMemo(() => {
    if (!draft) return [];
    return buildScenarioData(draft.scenario.favorablePct, -reviewRiskPct, draft.scenario.horizonMonths);
  }, [draft, reviewRiskPct]);

  const setStep = (next: StrategyOnboardingStep) => {
    setError(null);
    setStepState(next);
    onStepChange?.(next);
  };

  const patchAnswers = <K extends keyof StrategyOnboardingAnswers>(key: K, value: StrategyOnboardingAnswers[K]) => {
    setAnswers((current) => ({ ...current, [key]: value }));
    setActivated(false);
    setError(null);
  };

  const toggleMacro = (preference: StrategyMacroPreference) => {
    setAnswers((current) => ({
      ...current,
      macroPreferences: current.macroPreferences.includes(preference)
        ? current.macroPreferences.filter((item) => item !== preference)
        : [...current.macroPreferences, preference],
    }));
    setActivated(false);
    setError(null);
  };

  const setCryptoPreference = (value: StrategyCryptoPreference) => {
    setAnswers((current) => ({
      ...current,
      cryptoPreference: value,
      // Le meme coin richiedono un opt-in inequivocabile; tornando a un altro
      // livello il vincolo duro viene ripristinato automaticamente.
      excludeMemeCoins: value !== 'meme-opt-in',
      macroPreferences: value === 'none'
        ? current.macroPreferences.filter((item) => item !== 'crypto-large-cap')
        : current.macroPreferences.includes('crypto-large-cap')
          ? current.macroPreferences
          : [...current.macroPreferences, 'crypto-large-cap'],
    }));
    setActivated(false);
    setError(null);
  };

  const goalValid = Boolean(answers.portfolioId && answers.strategyName.trim().length >= 3 && answers.budgetEur >= 50);
  const preferencesValid = answers.macroPreferences.length > 0;

  const next = async () => {
    if (step === 'goals') {
      if (!goalValid) {
        setError('Completa portfolio, nome strategia e budget prima di continuare.');
        return;
      }
      setStep('preferences');
      return;
    }
    if (step === 'preferences') {
      if (!preferencesValid) {
        setError('Scegli almeno una preferenza di investimento.');
        return;
      }
      setStep('guardrails');
      return;
    }
    if (step === 'guardrails') {
      setBusy('generating');
      setError(null);
      try {
        const generated = onGenerate
          ? await onGenerate(answers)
          : await Promise.resolve(createStrategyOnboardingPreview(answers));
        setDraft(generated);
        setReviewRiskPct(generated.riskRangePct);
        setStep('review');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Non è stato possibile generare la strategia. Riprova.');
      } finally {
        setBusy(null);
      }
    }
  };

  const back = () => {
    if (stepIndex === 0 || busy) return;
    setStep(STEPS[stepIndex - 1]?.id ?? 'goals');
  };

  const activate = async () => {
    if (!draft || busy) return;
    const currentDraft: StrategyOnboardingDraft = {
      ...draft,
      riskRangePct: reviewRiskPct,
      scenario: { ...draft.scenario, adversePct: -reviewRiskPct },
    };
    setBusy('activating');
    setError(null);
    try {
      if (onActivate) await onActivate(currentDraft, answers);
      else await Promise.resolve();
      setDraft(currentDraft);
      setActivated(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Attivazione non riuscita. La strategia non è stata avviata.');
    } finally {
      setBusy(null);
    }
  };

  const cashPct = draft?.allocations.find((item) => item.key === 'cash')?.weightPct ?? answers.cashTargetPct;

  return (
    <section className={cn('strategy-onboarding', className)} aria-labelledby={`${idPrefix}-title`}>
      <header className="so-progress" aria-label="Avanzamento configurazione strategia">
        <ol>
          {STEPS.map((item, index) => {
            const completed = index < stepIndex;
            const active = item.id === step;
            const reachable = completed || active || (item.id === 'review' && Boolean(draft));
            return (
              <li key={item.id} data-active={active || undefined} data-completed={completed || undefined}>
                <button
                  type="button"
                  disabled={!reachable || busy !== null}
                  aria-current={active ? 'step' : undefined}
                  aria-label={`${item.label}, passo ${index + 1} di ${STEPS.length}${completed ? ', completato' : active ? ', corrente' : ''}`}
                  onClick={() => reachable && setStep(item.id)}
                >
                  <span className="so-step-marker" aria-hidden>
                    {completed ? <Check size={16} strokeWidth={2.4} /> : index + 1}
                  </span>
                  <span>{item.label}</span>
                </button>
                {index < STEPS.length - 1 ? <span className="so-step-line" aria-hidden /> : null}
              </li>
            );
          })}
        </ol>
      </header>

      <div className={cn('so-stage', step === 'review' && 'so-stage--review')}>
        {step === 'goals' ? (
          <div className="so-form-layout">
            <main className="so-form-main">
              <div className="so-page-heading">
                <span className="so-eyebrow"><Sparkles size={15} aria-hidden /> Il tuo punto di partenza</span>
                <h1 id={`${idPrefix}-title`}>Che cosa vuoi ottenere?</h1>
                <p>Partiamo dal tuo obiettivo, poi l’AI costruirà una strategia coerente senza scegliere al posto tuo quanto rischio accettare.</p>
              </div>

              <div className="so-section-block">
                <div className="so-section-title">
                  <div><span>1</span></div>
                  <div>
                    <h2>Portfolio da gestire</h2>
                    <p>Puoi applicare la strategia a un Agent Portfolio esistente.</p>
                  </div>
                </div>
                <label className="so-field-label" htmlFor={`${idPrefix}-portfolio`}>Portfolio selezionato</label>
                <div className="so-portfolio-select">
                  <span className="so-portfolio-icon" aria-hidden><BriefcaseBusiness size={22} /></span>
                  <div className="so-portfolio-select-copy">
                    <select
                      id={`${idPrefix}-portfolio`}
                      value={answers.portfolioId}
                      onChange={(event) => patchAnswers('portfolioId', event.target.value)}
                    >
                      {availablePortfolios.map((portfolio) => (
                        <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>
                      ))}
                    </select>
                    <span>{selectedPortfolio.subtitle ?? portfolioStatusCopy(selectedPortfolio.status)}</span>
                    <small>{selectedPortfolio.id}</small>
                  </div>
                  <span className={cn('so-connection-chip', selectedPortfolio.status === 'needs-token' && 'is-warning')}>
                    <span aria-hidden /> {selectedPortfolio.status === 'needs-token' ? 'Token da verificare' : 'Connesso'}
                  </span>
                </div>
              </div>

              <div className="so-section-block">
                <div className="so-section-title">
                  <div><span>2</span></div>
                  <div>
                    <h2>Obiettivo principale</h2>
                    <p>Scegli la direzione; esposizioni e pesi verranno generati in seguito.</p>
                  </div>
                </div>
                <div className="so-choice-grid so-choice-grid--objectives">
                  {OBJECTIVES.map(({ id, title, copy, Icon }) => (
                    <label key={id} className="so-choice-card" data-selected={answers.objective === id || undefined}>
                      <input
                        type="radio"
                        name={`${idPrefix}-objective`}
                        value={id}
                        checked={answers.objective === id}
                        onChange={() => patchAnswers('objective', id)}
                      />
                      <span className="so-choice-card-icon" aria-hidden><Icon size={20} /></span>
                      <strong>{title}</strong>
                      <small>{copy}</small>
                      <span className="so-choice-check" aria-hidden><Check size={14} /></span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="so-two-columns">
                <div className="so-field">
                  <label htmlFor={`${idPrefix}-strategy-name`}>Nome strategia</label>
                  <div className="so-input-with-icon">
                    <input
                      id={`${idPrefix}-strategy-name`}
                      value={answers.strategyName}
                      minLength={3}
                      onChange={(event) => patchAnswers('strategyName', event.target.value)}
                    />
                    <Pencil size={16} aria-hidden />
                  </div>
                  <small>Lo potrai cambiare anche dopo.</small>
                </div>
                <div className="so-field">
                  <label htmlFor={`${idPrefix}-budget`}>Budget gestito</label>
                  <div className="so-money-input">
                    <span aria-hidden>€</span>
                    <input
                      id={`${idPrefix}-budget`}
                      type="number"
                      min={50}
                      step={50}
                      value={answers.budgetEur}
                      onChange={(event) => patchAnswers('budgetEur', Math.max(0, Number(event.target.value)))}
                    />
                  </div>
                  <small>Serve a dimensionare posizioni e ordini.</small>
                </div>
              </div>

              <fieldset className="so-segment-fieldset">
                <legend>Orizzonte</legend>
                <div className="so-segments">
                  {[6, 12, 24, 36].map((months) => (
                    <label key={months} data-selected={answers.horizonMonths === months || undefined}>
                      <input
                        type="radio"
                        name={`${idPrefix}-horizon`}
                        checked={answers.horizonMonths === months}
                        onChange={() => patchAnswers('horizonMonths', months)}
                      />
                      {months === 12 ? '1 anno' : months < 12 ? `${months} mesi` : `${months / 12} anni`}
                    </label>
                  ))}
                </div>
              </fieldset>
            </main>

            <aside className="so-side-note">
              <div className="so-side-note-icon"><Activity size={22} aria-hidden /></div>
              <p className="so-side-kicker">Profilo in costruzione</p>
              <h2>{OBJECTIVES.find((item) => item.id === answers.objective)?.title}</h2>
              <p>Con {NUMBER_FORMAT.format(answers.budgetEur)} € su un orizzonte di {answers.horizonMonths} mesi, ogni limite verrà tradotto anche in importi reali.</p>
              <dl>
                <div><dt>Portfolio</dt><dd>{selectedPortfolio.name}</dd></div>
                <div><dt>Modalità iniziale</dt><dd>Shadow</dd></div>
                <div><dt>Ordini reali</dt><dd>Nessuno</dd></div>
              </dl>
              <div className="so-reassurance"><ShieldCheck size={17} aria-hidden /> L’AI propone; i guardrail hanno sempre diritto di veto.</div>
            </aside>
          </div>
        ) : null}

        {step === 'preferences' ? (
          <div className="so-form-layout">
            <main className="so-form-main">
              <div className="so-page-heading">
                <span className="so-eyebrow"><Layers3 size={15} aria-hidden /> Universo dinamico</span>
                <h1 id={`${idPrefix}-title`}>Dove può cercare l’AI?</h1>
                <p>Scegli macro-aree ed esclusioni. L’AI selezionerà gli strumenti migliori nel tempo, senza una whitelist rigida di ticker.</p>
              </div>

              <div className="so-section-block">
                <div className="so-section-title">
                  <div><span>1</span></div>
                  <div>
                    <h2>Preferenze di investimento</h2>
                    <p>Non sono pesi finali: indicano dove il motore può costruire la shortlist.</p>
                  </div>
                </div>
                <div className="so-choice-grid so-choice-grid--macro">
                  {MACRO_OPTIONS.map(({ id, label, copy, Icon }) => {
                    const selected = answers.macroPreferences.includes(id);
                    return (
                      <label key={id} className="so-choice-card so-choice-card--macro" data-selected={selected || undefined}>
                        <input type="checkbox" checked={selected} onChange={() => toggleMacro(id)} />
                        <span className="so-choice-card-icon" aria-hidden><Icon size={19} /></span>
                        <strong>{label}</strong>
                        <small>{copy}</small>
                        <span className="so-choice-check" aria-hidden><Check size={14} /></span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="so-section-block">
                <div className="so-section-title">
                  <div><span>2</span></div>
                  <div>
                    <h2>Esposizione crypto</h2>
                    <p>Le categorie più speculative richiedono un consenso esplicito.</p>
                  </div>
                </div>
                <fieldset className="so-radio-list">
                  <legend className="so-visually-hidden">Livello di esposizione crypto</legend>
                  {([
                    ['none', 'Nessuna crypto', 'Esclude l’intera classe dal portafoglio.'],
                    ['majors', 'Solo large cap', 'Bitcoin, Ethereum, Solana e asset comparabili per liquidità.'],
                    ['broad', 'Large cap e altcoin', 'Amplia la shortlist, mantenendo filtri di liquidità.'],
                    ['meme-opt-in', 'Include meme coin', 'Massima volatilità; resta soggetta a un cap dedicato.'],
                  ] as Array<[StrategyCryptoPreference, string, string]>).map(([value, title, copy]) => (
                    <label key={value} data-selected={answers.cryptoPreference === value || undefined}>
                      <input
                        type="radio"
                        name={`${idPrefix}-crypto`}
                        checked={answers.cryptoPreference === value}
                        onChange={() => setCryptoPreference(value)}
                      />
                      <span><strong>{title}</strong><small>{copy}</small></span>
                      <span className="so-radio-indicator" aria-hidden />
                    </label>
                  ))}
                </fieldset>
                <label className="so-exclusion-toggle">
                  <input
                    type="checkbox"
                    checked={answers.excludeMemeCoins}
                    disabled={answers.cryptoPreference === 'meme-opt-in'}
                    onChange={(event) => patchAnswers('excludeMemeCoins', event.target.checked)}
                  />
                  <span className="so-toggle-track" aria-hidden><span /></span>
                  <span><strong><Ban size={16} aria-hidden /> Meme coin escluse</strong><small>Vincolo duro: nessun modello può aggirarlo.</small></span>
                </label>
              </div>

              <div className="so-two-columns">
                <div className="so-field">
                  <label htmlFor={`${idPrefix}-holdings`}>Ampiezza massima</label>
                  <select
                    id={`${idPrefix}-holdings`}
                    value={answers.maxHoldings}
                    onChange={(event) => patchAnswers('maxHoldings', Number(event.target.value))}
                  >
                    <option value={8}>Fino a 8 posizioni</option>
                    <option value={12}>Fino a 12 posizioni</option>
                    <option value={20}>Fino a 20 posizioni</option>
                  </select>
                  <small>Il numero effettivo dipenderà da budget e minimi eToro.</small>
                </div>
                <div className="so-field so-range-field">
                  <label htmlFor={`${idPrefix}-cash`}>Liquidità target <output>{answers.cashTargetPct}%</output></label>
                  <input
                    id={`${idPrefix}-cash`}
                    type="range"
                    min={0}
                    max={15}
                    step={1}
                    value={answers.cashTargetPct}
                    onChange={(event) => patchAnswers('cashTargetPct', Number(event.target.value))}
                    aria-describedby={`${idPrefix}-cash-help`}
                  />
                  <small id={`${idPrefix}-cash-help`}>Resta disponibile per nuovi ingressi e ribilanciamenti.</small>
                </div>
              </div>
            </main>

            <aside className="so-side-note so-side-note--preferences">
              <div className="so-side-note-icon"><Globe2 size={22} aria-hidden /></div>
              <p className="so-side-kicker">Mandato all’AI</p>
              <h2>{selectedMacro.length} aree consentite</h2>
              <div className="so-mini-tags">
                {selectedMacro.map((item) => <span key={item.id}><item.Icon size={14} aria-hidden /> {item.label}</span>)}
              </div>
              <p>L’universo resta dinamico: ticker e pesi possono cambiare, ma solo dentro queste preferenze e i guardrail del passo successivo.</p>
              <div className="so-reassurance"><CheckCircle2 size={17} aria-hidden /> Le posizioni aperte saranno sempre considerate prima di nuove entrate.</div>
            </aside>
          </div>
        ) : null}

        {step === 'guardrails' ? (
          <div className="so-form-layout">
            <main className="so-form-main">
              <div className="so-page-heading">
                <span className="so-eyebrow"><LockKeyhole size={15} aria-hidden /> Limiti deterministici</span>
                <h1 id={`${idPrefix}-title`}>Quanto rischio è accettabile?</h1>
                <p>Questi limiti non sono suggerimenti per l’AI: il codice li applica sempre e blocca ogni proposta fuori confine.</p>
              </div>

              <div className="so-risk-card">
                <div className="so-risk-card-heading">
                  <div>
                    <span>Perdita massima tollerata</span>
                    <strong>−{answers.maxDrawdownPct}%</strong>
                  </div>
                  <p>Su {NUMBER_FORMAT.format(answers.budgetEur)} € equivale a circa <strong>−{NUMBER_FORMAT.format(answers.budgetEur * answers.maxDrawdownPct / 100)} €</strong>.</p>
                </div>
                <label htmlFor={`${idPrefix}-drawdown`} className="so-visually-hidden">Perdita massima tollerata, percentuale</label>
                <input
                  id={`${idPrefix}-drawdown`}
                  className="so-risk-range"
                  type="range"
                  min={10}
                  max={30}
                  step={1}
                  value={answers.maxDrawdownPct}
                  onChange={(event) => patchAnswers('maxDrawdownPct', Number(event.target.value))}
                  aria-describedby={`${idPrefix}-drawdown-scale`}
                />
                <div id={`${idPrefix}-drawdown-scale`} className="so-range-scale" aria-hidden>
                  <span>Conservativo<strong>−10%</strong></span>
                  <span>Moderato<strong>−20%</strong></span>
                  <span>Aggressivo<strong>−30%</strong></span>
                </div>
              </div>

              <div className="so-guardrail-grid">
                <label>
                  <span>Esposizione per asset</span>
                  <div><input type="number" min={1} max={50} value={answers.maxAssetPct} onChange={(event) => patchAnswers('maxAssetPct', Number(event.target.value))} /><b>% max</b></div>
                  <small>Evita concentrazione su un singolo titolo.</small>
                </label>
                <label>
                  <span>Limite per settore</span>
                  <div><input type="number" min={5} max={80} value={answers.maxSectorPct} onChange={(event) => patchAnswers('maxSectorPct', Number(event.target.value))} /><b>% max</b></div>
                  <small>Blocca accumuli eccessivi nello stesso tema.</small>
                </label>
                <label>
                  <span>Turnover per ciclo</span>
                  <div><input type="number" min={1} max={100} value={answers.maxTurnoverPct} onChange={(event) => patchAnswers('maxTurnoverPct', Number(event.target.value))} /><b>% max</b></div>
                  <small>Contiene rotazione, spread e rumore.</small>
                </label>
                <label>
                  <span>Detenzione minima</span>
                  <div><input type="number" min={0} max={365} value={answers.minHoldingDays} onChange={(event) => patchAnswers('minHoldingDays', Number(event.target.value))} /><b>giorni</b></div>
                  <small>Riduce il ping-pong sulle posizioni recenti.</small>
                </label>
                <label>
                  <span>Periodo iniziale shadow</span>
                  <div><input type="number" min={1} max={60} value={answers.shadowDays} onChange={(event) => patchAnswers('shadowDays', Number(event.target.value))} /><b>giorni</b></div>
                  <small>Nessun ordine reale durante questo periodo.</small>
                </label>
                <div className="so-guardrail-static">
                  <span>Leva finanziaria</span>
                  <strong><Ban size={16} aria-hidden /> Sempre esclusa</strong>
                  <small>Solo ordini buy/sell senza leva.</small>
                </div>
              </div>
            </main>

            <aside className="so-side-note so-side-note--guardrails">
              <div className="so-side-note-icon"><SlidersHorizontal size={22} aria-hidden /></div>
              <p className="so-side-kicker">Riepilogo guardrail</p>
              <h2>Protezione attiva</h2>
              <dl className="so-guardrail-summary">
                <div><dt>Drawdown massimo</dt><dd>−{answers.maxDrawdownPct}%</dd></div>
                <div><dt>Singolo asset</dt><dd>{answers.maxAssetPct}%</dd></div>
                <div><dt>Settore</dt><dd>{answers.maxSectorPct}%</dd></div>
                <div><dt>Liquidità minima</dt><dd>{answers.cashTargetPct}%</dd></div>
                <div><dt>Posizioni</dt><dd>fino a {answers.maxHoldings}</dd></div>
                <div><dt>Avvio</dt><dd>{answers.shadowDays}gg shadow</dd></div>
              </dl>
              <div className="so-reassurance"><LockKeyhole size={17} aria-hidden /> Il modello non può modificare né ignorare questi valori.</div>
            </aside>
          </div>
        ) : null}

        {step === 'review' && draft ? (
          <div className="so-review-grid">
            <main className="so-review-copy">
              <div className="so-page-heading so-page-heading--review">
                <span className="so-eyebrow"><CheckCircle2 size={15} aria-hidden /> Profilo generato</span>
                <h1 id={`${idPrefix}-title`}>Strategia pronta</h1>
                <p>La strategia è stata generata rispettando obiettivi e guardrail. Rivedi i dettagli e avviala prima in modalità shadow.</p>
              </div>

              <div className="so-selected-portfolio">
                <span className="so-portfolio-icon" aria-hidden><BriefcaseBusiness size={22} /></span>
                <div><small>Portfolio selezionato</small><strong>{selectedPortfolio.name}</strong><span>{selectedPortfolio.subtitle ?? portfolioStatusCopy(selectedPortfolio.status)}</span></div>
                <button type="button" onClick={() => setStep('goals')}>Cambia portfolio</button>
              </div>

              <div className="so-review-section">
                <span className="so-review-label">Nome strategia</span>
                <h2>{draft.strategyName} <Pencil size={16} aria-hidden /></h2>
              </div>

              <div className="so-review-section">
                <span className="so-review-label">Preferenze di investimento</span>
                <div className="so-preference-tags">
                  {selectedMacro.map((item) => <span key={item.id}><item.Icon size={15} aria-hidden /> {item.label}</span>)}
                  {answers.excludeMemeCoins ? <span><Ban size={15} aria-hidden /> Meme coin escluse</span> : null}
                </div>
              </div>

              <div className="so-review-section so-review-section--reasons">
                <span className="so-review-label">Perché questa strategia</span>
                <div className="so-reasons">
                  {draft.reasons.map((reason) => {
                    const Icon = reasonIcon(reason.kind);
                    return (
                      <div key={reason.title}>
                        <span aria-hidden><Icon size={20} /></span>
                        <p><strong>{reason.title}</strong><small>{reason.detail}</small></p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="so-active-guardrails">
                <span aria-hidden><LockKeyhole size={25} /></span>
                <div>
                  <strong>Guardrail attivi</strong>
                  <p>La strategia è vincolata ai limiti che hai definito.</p>
                  <small>Rischio massimo · Drawdown massimo · Esposizione per asset · Limiti per settore · Liquidità minima · Orizzonte temporale</small>
                </div>
                <button type="button" onClick={() => setStep('guardrails')}>Visualizza dettagli</button>
              </div>
            </main>

            <aside className="so-review-preview">
              <section className="so-preview-section so-allocation-section">
                <h2>Anteprima portafoglio <Info size={15} aria-label="Allocazione target indicativa" /></h2>
                <div className="so-allocation-layout">
                  <div className="so-donut" role="img" aria-label={`Allocazione target con ${cashPct}% di liquidità`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart accessibilityLayer>
                        <Pie
                          data={draft.allocations}
                          dataKey="weightPct"
                          nameKey="label"
                          innerRadius="62%"
                          outerRadius="100%"
                          paddingAngle={1}
                          stroke="#fffdf7"
                          strokeWidth={2}
                          isAnimationActive
                        >
                          {draft.allocations.map((slice) => (
                            <Cell key={slice.key} fill={slice.color ?? ALLOCATION_COLORS[slice.key] ?? '#7e9c8a'} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value) => `${Number(value)}%`} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="so-donut-center" aria-hidden>
                      <span>Liquidità target</span>
                      <strong>{cashPct}%</strong>
                      <small>Fino a {draft.guardrails.maxHoldings}<br />posizioni</small>
                    </div>
                  </div>
                  <ul className="so-allocation-legend">
                    {draft.allocations.map((slice) => (
                      <li key={slice.key}>
                        <span style={{ backgroundColor: slice.color ?? ALLOCATION_COLORS[slice.key] ?? '#7e9c8a' }} aria-hidden />
                        <span>{slice.label}</span>
                        <strong>{slice.weightPct}%</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>

              <section className="so-preview-section so-scenario-section">
                <h2>Scenari <small>(orizzonte {draft.scenario.horizonMonths} mesi)</small> <Info size={15} aria-label="Scenari modellizzati, non previsioni" /></h2>
                <div className="so-scenario-layout">
                  <div className="so-fan-chart" role="img" aria-label={`Scenario favorevole più ${draft.scenario.favorablePct} per cento, scenario avverso meno ${reviewRiskPct} per cento`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={scenarioData} margin={{ top: 8, right: 4, bottom: 2, left: 4 }} accessibilityLayer>
                        <CartesianGrid vertical={false} stroke="#e7e2d8" strokeDasharray="2 5" />
                        <XAxis dataKey="month" hide />
                        <YAxis hide domain={[-Math.max(25, reviewRiskPct), Math.max(20, draft.scenario.favorablePct)]} />
                        <ReferenceLine y={0} stroke="#738079" strokeDasharray="5 4" />
                        <Area type="monotone" dataKey="positiveOuter" stroke="#6b976e" fill="#b9ccb6" fillOpacity={0.38} strokeWidth={1.2} isAnimationActive />
                        <Area type="monotone" dataKey="positiveInner" stroke="#3f7d55" fill="#709b70" fillOpacity={0.42} strokeWidth={1.2} isAnimationActive />
                        <Area type="monotone" dataKey="negativeOuter" stroke="#ef745d" fill="#f7c1b4" fillOpacity={0.45} strokeWidth={1.2} isAnimationActive />
                        <Area type="monotone" dataKey="negativeInner" stroke="#e65e48" fill="#ef8c78" fillOpacity={0.4} strokeWidth={1.2} isAnimationActive />
                        <Tooltip content={<ScenarioTooltip />} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="so-scenario-values">
                    <div><span>Scenario favorevole</span><strong>+{draft.scenario.favorablePct}%</strong></div>
                    <div><span>Scenario avverso</span><strong>−{reviewRiskPct}%</strong></div>
                  </div>
                </div>
                <p className="so-model-note">Intervalli modellizzati su dati storici: non sono una previsione e non includono tasse o costi futuri.</p>
              </section>

              <section className="so-preview-section so-review-risk">
                <label htmlFor={`${idPrefix}-review-risk`}>Intervallo di rischio stimato <small>({draft.scenario.horizonMonths}M)</small> <Info size={15} aria-hidden /></label>
                <input
                  id={`${idPrefix}-review-risk`}
                  className="so-risk-range"
                  type="range"
                  min={10}
                  max={30}
                  step={1}
                  value={reviewRiskPct}
                  onChange={(event) => setReviewRiskPct(Number(event.target.value))}
                  aria-describedby={`${idPrefix}-review-risk-help`}
                />
                <div className="so-range-scale" aria-hidden>
                  <span>Conservativo<strong>−10%</strong></span>
                  <span>Moderato<strong>−20%</strong></span>
                  <span>Aggressivo<strong>−30%</strong></span>
                </div>
                <p id={`${idPrefix}-review-risk-help`}>Puoi stringere il limite prima di attivare; il nuovo valore sarà applicato alla bozza.</p>
              </section>

              <button className="so-activate-button" type="button" disabled={busy !== null || activated} onClick={() => void activate()}>
                {busy === 'activating' ? <LoaderCircle className="so-spin" size={22} aria-hidden /> : activated ? <CheckCircle2 size={22} aria-hidden /> : <Play size={22} aria-hidden />}
                {busy === 'activating' ? 'Attivazione in corso…' : activated ? 'Strategia attivata in shadow' : 'Avvia in modalità shadow'}
              </button>
              <p className={cn('so-shadow-note', activated && 'is-success')}>
                <ShieldCheck size={16} aria-hidden />
                {activated
                  ? `Attiva in shadow: monitoraggio avviato per ${draft.shadowDays} giorni.`
                  : `La strategia opererà in shadow per ${draft.shadowDays} giorni. Nessun ordine reale verrà eseguito.`}
              </p>
            </aside>
          </div>
        ) : null}

        {step === 'review' && !draft ? (
          <div className="so-empty-review">
            <CircleAlert size={30} aria-hidden />
            <h1 id={`${idPrefix}-title`}>La bozza non è ancora pronta</h1>
            <p>Completa obiettivi, preferenze e guardrail per generare la strategia.</p>
            <button type="button" onClick={() => setStep('goals')}>Inizia dagli obiettivi</button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="so-error" role="alert">
          <CircleAlert size={18} aria-hidden />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Chiudi messaggio di errore">Chiudi</button>
        </div>
      ) : null}

      {step !== 'review' ? (
        <footer className="so-footer-actions">
          <button className="so-secondary-button" type="button" disabled={stepIndex === 0 || busy !== null} onClick={back}>
            <ArrowLeft size={17} aria-hidden /> Indietro
          </button>
          <p aria-live="polite">
            {busy === 'generating' ? 'L’AI sta generando la strategia e verificando i guardrail…' : `Passo ${stepIndex + 1} di ${STEPS.length}`}
          </p>
          <button
            className="so-primary-button"
            type="button"
            disabled={busy !== null || (step === 'goals' && !goalValid) || (step === 'preferences' && !preferencesValid)}
            onClick={() => void next()}
          >
            {busy === 'generating' ? <LoaderCircle className="so-spin" size={18} aria-hidden /> : step === 'guardrails' ? <Sparkles size={18} aria-hidden /> : null}
            {busy === 'generating' ? 'Generazione…' : step === 'guardrails' ? 'Genera strategia' : 'Continua'}
            {busy !== 'generating' ? <ArrowRight size={17} aria-hidden /> : null}
          </button>
        </footer>
      ) : null}

      <span className="so-live-region" aria-live="polite">
        {activated ? 'Strategia attivata correttamente in modalità shadow.' : ''}
      </span>
    </section>
  );
}

export default StrategyOnboarding;
