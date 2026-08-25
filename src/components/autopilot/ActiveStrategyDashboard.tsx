import { useMemo } from 'react';
import {
  Activity,
  ArrowUpRight,
  BriefcaseBusiness,
  Check,
  Clock3,
  Eye,
  FlaskConical,
  Gauge,
  Globe2,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AutopilotConfig, EquityPoint, StrategyCollaboration } from '@/lib/agent/autopilot-api';
import type { StrategyOnboardingAnswers, StrategyOnboardingDraft } from './StrategyOnboarding';
import { StrategyCollaborationTrace } from './StrategyCollaborationTrace';
import './active-strategy-dashboard.css';

interface ActiveStrategyDashboardProps {
  config: AutopilotConfig;
  draft: StrategyOnboardingDraft;
  answers?: Partial<StrategyOnboardingAnswers> | null;
  collaboration?: StrategyCollaboration | null;
  equityCurve?: EquityPoint[];
  loading?: boolean;
  onReview?: () => void;
  onDryRun?: () => void;
}

const PREFERENCE_LABEL: Record<string, string> = {
  'global-equities': 'Azioni globali',
  technology: 'Tecnologia',
  healthcare: 'Salute',
  'crypto-large-cap': 'Crypto large cap',
  bonds: 'Obbligazionario',
  commodities: 'Materie prime',
};

const EUR = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const USD = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function buildScenarioData(favorablePct: number, adversePct: number, horizonMonths: number) {
  const steps = Math.max(4, Math.min(12, horizonMonths));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    const curve = Math.pow(progress, 0.86);
    return {
      month: Math.round(progress * horizonMonths),
      favorable: favorablePct * curve,
      median: (favorablePct * 0.45) * curve,
      adverse: adversePct * curve,
    };
  });
}

function formatTime(at: number) {
  return new Date(at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ActiveStrategyDashboard({
  config,
  draft,
  answers,
  collaboration,
  equityCurve = [],
  loading = false,
  onReview,
  onDryRun,
}: ActiveStrategyDashboardProps) {
  const budgetEur = Number(answers?.budgetEur ?? config.budgetEur) || 0;
  const preferences = (answers?.macroPreferences ?? []).map((item) => PREFERENCE_LABEL[item] ?? item);
  const scenario = useMemo(
    () => buildScenarioData(draft.scenario.favorablePct, draft.scenario.adversePct, draft.scenario.horizonMonths),
    [draft.scenario],
  );
  const performance = useMemo(() => {
    const valid = equityCurve.filter((point) => Number(point.equity_usd) > 0).slice(-60);
    if (!valid.length) return [];
    const base = Number(valid[0].equity_usd);
    return valid.map((point) => {
      const pct = base > 0 ? (Number(point.equity_usd) / base - 1) * 100 : 0;
      return {
        at: point.at,
        label: formatTime(point.at),
        virtualUsd: Number(point.equity_usd),
        realEur: budgetEur * (1 + pct / 100),
        pct,
      };
    });
  }, [budgetEur, equityCurve]);
  const latest = performance.at(-1);
  const latestPoint = equityCurve.at(-1);
  const currentPct = latest?.pct ?? 0;
  const statusLabel = config.executionMode === 'live' ? 'Live' : config.executionMode === 'dry-run' ? 'Dry-run' : 'Shadow';

  return (
    <section className="asd-shell" aria-labelledby="active-strategy-title">
      <header className="asd-hero">
        <div>
          <p className="asd-eyebrow"><Sparkles size={14} aria-hidden /> Strategia applicata</p>
          <h2 id="active-strategy-title">{draft.strategyName}</h2>
          <p>{draft.summary}</p>
        </div>
        <div className="asd-hero-actions">
          <span className="asd-mode"><span aria-hidden /> {statusLabel}</span>
          {onReview ? <button type="button" onClick={onReview}><Eye size={16} aria-hidden /> Rivedi strategia</button> : null}
          {onDryRun ? <button className="is-primary" type="button" disabled={loading} onClick={onDryRun}><FlaskConical size={16} aria-hidden /> Prova in dry-run</button> : null}
        </div>
      </header>

      <div className="asd-preferences">
        <span><Globe2 size={15} aria-hidden /> Preferenze di investimento</span>
        <div>
          {preferences.length ? preferences.map((preference) => <span key={preference}><Check size={12} aria-hidden /> {preference}</span>) : <span>Universo dinamico guidato dalla policy</span>}
          {answers?.cryptoPreference ? <span>Crypto: {answers.cryptoPreference === 'none' ? 'escluse' : answers.cryptoPreference === 'majors' ? 'solo large cap' : answers.cryptoPreference === 'broad' ? 'large cap e altcoin' : 'meme coin abilitate'}</span> : null}
          <span>Fino a {draft.guardrails.maxHoldings} posizioni</span>
        </div>
      </div>

      <div className="asd-overview-grid">
        <article className="asd-panel asd-allocation-panel">
          <div className="asd-panel-heading">
            <div><p>Composizione obiettivo</p><h3>Allocazione strategica</h3></div>
            <span><BriefcaseBusiness size={15} aria-hidden /> {EUR.format(budgetEur)} reali</span>
          </div>
          <div className="asd-allocation-layout">
            <div className="asd-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={draft.allocations} dataKey="weightPct" nameKey="label" innerRadius="62%" outerRadius="89%" paddingAngle={2} stroke="none">
                    {draft.allocations.map((slice) => <Cell key={slice.key} fill={slice.color ?? '#0d6040'} />)}
                  </Pie>
                  <Tooltip formatter={(value) => [`${Number(value)}%`, 'Peso obiettivo']} />
                </PieChart>
              </ResponsiveContainer>
              <div><strong>{100 - (draft.allocations.find((item) => item.key === 'cash')?.weightPct ?? 0)}%</strong><span>investito</span></div>
            </div>
            <ul>
              {draft.allocations.map((slice) => (
                <li key={slice.key}><span style={{ background: slice.color ?? '#0d6040' }} aria-hidden /><p>{slice.label}</p><strong>{slice.weightPct}%</strong></li>
              ))}
            </ul>
          </div>
        </article>

        <article className="asd-panel asd-scenario-panel">
          <div className="asd-panel-heading">
            <div><p>Forchetta, non promessa</p><h3>Scenari a {draft.scenario.horizonMonths} mesi</h3></div>
            <span><Gauge size={15} aria-hidden /> rischio max {draft.riskRangePct}%</span>
          </div>
          <div className="asd-scenario-values">
            <div><span>Favorevole</span><strong>+{draft.scenario.favorablePct.toFixed(1)}%</strong></div>
            <div><span>Mediano</span><strong>{draft.scenario.medianPct >= 0 ? '+' : ''}{draft.scenario.medianPct.toFixed(1)}%</strong></div>
            <div className="is-adverse"><span>Avverso</span><strong>{draft.scenario.adversePct.toFixed(1)}%</strong></div>
          </div>
          <div className="asd-scenario-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={scenario} margin={{ top: 8, right: 4, bottom: 0, left: -22 }}>
                <defs>
                  <linearGradient id="asdPositive" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#4b9b72" stopOpacity={0.27} /><stop offset="100%" stopColor="#4b9b72" stopOpacity={0.02} /></linearGradient>
                  <linearGradient id="asdNegative" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d17b64" stopOpacity={0.03} /><stop offset="100%" stopColor="#d17b64" stopOpacity={0.24} /></linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#dfe7df" strokeDasharray="3 5" />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#708078' }} axisLine={false} tickLine={false} tickFormatter={(value) => `${value}M`} />
                <YAxis tick={{ fontSize: 10, fill: '#708078' }} axisLine={false} tickLine={false} tickFormatter={(value) => `${value}%`} />
                <ReferenceLine y={0} stroke="#a6b2aa" />
                <Area type="monotone" dataKey="favorable" stroke="#2c8058" fill="url(#asdPositive)" strokeWidth={2} />
                <Line type="monotone" dataKey="median" stroke="#6b7b72" strokeDasharray="4 4" dot={false} />
                <Area type="monotone" dataKey="adverse" stroke="#ba6751" fill="url(#asdNegative)" strokeWidth={2} />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Scenario']} labelFormatter={(value) => `Mese ${value}`} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>
      </div>

      <article className="asd-panel asd-performance-panel">
        <div className="asd-panel-heading">
          <div><p>Andamento dell’Agent Portfolio</p><h3>Movimento dalla prima rilevazione</h3></div>
          <span><Clock3 size={15} aria-hidden /> Aggiornato all’ultimo snapshot</span>
        </div>
        <div className="asd-performance-layout">
          <div className="asd-performance-kpis">
            <div><span>Capitale reale stimato</span><strong>{EUR.format(latest?.realEur ?? budgetEur)}</strong><small>Replica proporzionale della performance virtuale</small></div>
            <div><span>Performance osservata</span><strong className={currentPct < 0 ? 'is-negative' : 'is-positive'}>{currentPct >= 0 ? '+' : ''}{currentPct.toFixed(2)}%</strong><small>Dalla prima rilevazione disponibile</small></div>
            <div><span>Base virtuale eToro</span><strong>{latest ? USD.format(latest.virtualUsd) : 'In attesa'}</strong><small>È un conto virtuale, non il tuo capitale reale</small></div>
          </div>
          <div className="asd-performance-chart">
            {performance.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={performance} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
                  <defs><linearGradient id="asdPerformance" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#14704a" stopOpacity={0.28} /><stop offset="100%" stopColor="#14704a" stopOpacity={0.02} /></linearGradient></defs>
                  <CartesianGrid vertical={false} stroke="#dfe7df" strokeDasharray="3 5" />
                  <XAxis dataKey="label" minTickGap={54} tick={{ fontSize: 9, fill: '#718078' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#718078' }} axisLine={false} tickLine={false} tickFormatter={(value) => `${value}%`} />
                  <ReferenceLine y={0} stroke="#a7b3ab" />
                  <Area type="monotone" dataKey="pct" stroke="#0d6040" fill="url(#asdPerformance)" strokeWidth={2.4} activeDot={{ r: 4 }} />
                  <Tooltip formatter={(value, name) => name === 'pct' ? [`${Number(value).toFixed(2)}%`, 'Performance'] : [value, name]} labelFormatter={(_, payload) => payload?.[0]?.payload ? `${payload[0].payload.label} · ${EUR.format(payload[0].payload.realEur)}` : ''} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="asd-chart-empty"><Activity size={24} aria-hidden /><strong>Serve un altro snapshot</strong><span>Con due rilevazioni mostreremo qui la curva reale della strategia.</span></div>
            )}
          </div>
        </div>
        <footer>
          <ShieldCheck size={15} aria-hidden />
          L’importo in euro è una stima proporzionale: eToro espone circa {latestPoint ? USD.format(latestPoint.equity_usd) : '10.000 USD'} virtuali, mentre il capitale reale gestito resta {EUR.format(budgetEur)}.
        </footer>
      </article>

      <div className="asd-lower-grid">
        <StrategyCollaborationTrace collaboration={collaboration} compact />
        <article className="asd-guardrails">
          <div><ShieldCheck size={19} aria-hidden /><span><small>Protezione attiva</small><strong>Guardrail deterministici</strong></span></div>
          <dl>
            <div><dt>Perdita massima</dt><dd>−{draft.guardrails.maxDrawdownPct}%</dd></div>
            <div><dt>Tetto per asset</dt><dd>{draft.guardrails.maxAssetPct}%</dd></div>
            <div><dt>Tetto per settore</dt><dd>{draft.guardrails.maxSectorPct}%</dd></div>
            <div><dt>Turnover per ciclo</dt><dd>{draft.guardrails.maxTurnoverPct}%</dd></div>
            <div><dt>Detenzione minima</dt><dd>{draft.guardrails.minHoldingDays} giorni</dd></div>
            <div><dt>Modalità iniziale</dt><dd>{statusLabel}</dd></div>
          </dl>
          <p><WalletCards size={15} aria-hidden /> Gli ordini sono calcolati dinamicamente sul budget e sul numero effettivo di posizioni.</p>
          <p><ArrowUpRight size={15} aria-hidden /> Nel ciclo operativo news e strategia passano al primo modello disponibile; i guardrail restano sempre l’ultima parola.</p>
        </article>
      </div>
    </section>
  );
}

export default ActiveStrategyDashboard;
