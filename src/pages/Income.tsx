import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Check, CircleDollarSign, Coins, Download, Landmark, RefreshCw, Save, Sparkles, Target, Wallet } from 'lucide-react';
import { useAppData } from '@/lib/data/store';
import { allPositions, dividendLine, emptyDividend, euros, interestLine, netIncome, positionCapital, scenario, STAKING_SYMBOLS, summarize } from '@/lib/income/engine';
import type { DividendInput, IncomeKind, IncomeLine } from '@/lib/income/engine';
import { loadIncome, saveIncome, stateSchema } from '@/lib/income/storage';
import type { IncomeState } from '@/lib/income/storage';
import { fetchAutomaticDividends, fetchReferenceFx } from '@/lib/income/providers';
import type { DividendLookup, ReferenceFx } from '@/lib/income/providers';
import { Field, inputClass, NumberField } from '@/components/income/Fields';
import { Accounts, CashSettings } from '@/components/income/Accounts';
import { Forecast } from '@/components/income/Forecast';
import { IncomeLedger } from '@/components/income/Ledger';
import { autopilot } from '@/lib/agent/autopilot-api';

const names: Record<IncomeKind, string> = { dividend: 'Dividendi', interest: 'Interessi', staking: 'Staking crypto', other: 'Altre rendite' };
const icons = { dividend: CircleDollarSign, interest: Landmark, staking: Coins, other: Wallet };
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
const num = (n: number) => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 5 }).format(n);
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-hairline bg-bg-1 px-3 py-2 text-sm text-text-0 hover:bg-bg-2 disabled:opacity-50';
const saveButton = 'inline-flex items-center justify-center gap-2 rounded-lg bg-gain px-4 py-2 text-sm font-medium text-white hover:opacity-90';
function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="card-surface p-5 sm:p-6"><h2 className="mb-4 text-lg font-medium text-text-0">{title}</h2>{children}</section>; }
function download(value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `rendite-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Income() {
  const { settings } = useAppData();
  const [scope, setScope] = useState<{ owner: string; key: string } | null>(null);
  const owner = `${settings.live.proxyUrl}|${settings.live.userKey}`;
  useEffect(() => {
    let cancelled = false;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)).then(buffer => {
      const hash = Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
      if (!cancelled) setScope({ owner, key: `torino.income.v1.${hash}` });
    });
    return () => { cancelled = true; };
  }, [owner]);
  return scope?.owner === owner ? <IncomeWorkspace key={scope.key} storageKey={scope.key} /> : <p className="text-text-1">Caricamento rendite…</p>;
}

function IncomeWorkspace({ storageKey }: { storageKey: string }) {
  const { portfolio, fxRate, settings, refresh, status } = useAppData();
  const [loaded] = useState(() => loadIncome(storageKey));
  const [state, setState] = useState<IncomeState>(loaded.state);
  const [saved, setSaved] = useState<IncomeState>(loaded.state);
  const [saveError, setSaveError] = useState(loaded.error);
  const [saveMessage, setSaveMessage] = useState('');
  const [formEdited, setFormEdited] = useState(false);
  const [tab, setTab] = useState('oggi');
  const [references, setReferences] = useState<Record<string, DividendLookup>>({});
  const [referenceFx, setReferenceFx] = useState<ReferenceFx | null>(null);
  const [fxError, setFxError] = useState('');
  const [refBusy, setRefBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ai, setAi] = useState<{ context: string; text: string; model: string; usage?: unknown } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const dirty = formEdited || JSON.stringify(state) !== JSON.stringify(saved);
  const patch = (update: Partial<IncomeState>) => { setState(s => ({ ...s, ...update })); setSaveMessage(''); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const today = new Date().toISOString().slice(0, 10);
  const positions = allPositions(portfolio);
  const stocks = [...new Set(positions.filter(p => ['stock', 'etf', 'cfd'].includes(p.assetClass)).map(p => p.symbol))].sort();
  const cryptos = [...new Set(positions.filter(p => p.assetClass === 'crypto').map(p => p.symbol))].sort();
  const requestKey = JSON.stringify(stocks.flatMap(symbol => {
    const eligible = positions.find(p => p.symbol === symbol && p.isBuy && p.leverage === 1 && p.isCFD !== true && p.assetClass !== 'cfd');
    return eligible ? [{ symbol, kind: eligible.assetClass === 'etf' ? 'etf' : 'stock' }] : [];
  }));
  useEffect(() => {
    const controller = new AbortController();
    const run = async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setRefBusy(true);
      await Promise.allSettled([
        fetchAutomaticDividends(JSON.parse(requestKey), settings.live, controller.signal, (symbol, value) => setReferences(old => ({ ...old, [symbol]: value })), revision > 0),
        fetchReferenceFx(settings.live, controller.signal).then(value => { if (!controller.signal.aborted) { setReferenceFx(value); setFxError(''); } }).catch(error => { if (!controller.signal.aborted) setFxError(error instanceof Error ? error.message : 'Cambi non disponibili'); }),
      ]);
      if (!controller.signal.aborted) setRefBusy(false);
    };
    void run(); return () => controller.abort();
  }, [requestKey, settings.live, revision]);
  const fx = state.fxOverride ?? (fxRate && Date.now() - fxRate.timestamp < 86400000 ? fxRate.rate : referenceFx?.rates.USD ?? null);
  const crossRates = referenceFx?.rates ?? {};
  const tax = state.basis === 'net' ? state.globalTaxPct : null;
  function dividendRule(symbol: string): DividendInput {
    const auto = references[symbol]?.data;
    return auto ? { annualPerShare: auto.annualPerShare, currency: auto.currency, source: auto.source, asOf: new Date(auto.asOf).toISOString().slice(0, 10), taxPct: tax }
      : { ...(state.dividends[symbol] ?? emptyDividend()), taxPct: tax };
  }
  const dividendLines = stocks.map(symbol => {
    const line = dividendLine(symbol, positions.filter(p => p.symbol === symbol), dividendRule(symbol), fx, crossRates);
    if (line.annualGross === null) line.reason = references[symbol]?.error || (refBusy ? 'Recupero automatico in corso' : 'Fonte automatica non disponibile');
    else if (references[symbol]?.data?.status === 'no_history') line.reason = 'Non risultano distribuzioni nello storico della fonte';
    return line;
  });
  const cryptoCapital = euros(positionCapital(positions.filter(p => p.assetClass === 'crypto')), 'USD', fx);
  const cryptoAnnual = state.stakingMode === 'not_earning' ? 0 : euros(state.stakingMonthlyUsd === null ? null : state.stakingMonthlyUsd * 12, 'USD', fx);
  const staking: IncomeLine = { id: 'staking', label: 'Staking eToro', kind: 'staking', capitalEur: cryptoCapital, annualGross: cryptoAnnual, annualNet: netIncome(cryptoAnnual, tax), source: 'Indicazione del titolare', asOf: today,
    reason: state.stakingMode === 'not_earning' ? 'Nessun premio attuale, come hai indicato' : 'Premi medi indicati, valorizzati in EUR; i token non sono un accredito di contante' };
  const cashRule = { ...state.cash, active: 'active' as const, taxPct: tax, source: state.cash.source || 'Tasso comunicato dal titolare', asOf: state.cash.asOf || today };
  const lines: IncomeLine[] = [...dividendLines,
    interestLine('cash', 'Liquidità eToro', portfolio?.cash ?? null, 'USD', cashRule, fx, today),
    ...(cryptos.length ? [staking] : []),
    ...state.external.map(a => interestLine(a.id, a.name || 'Conto da completare', a.capital, a.currency, { ...a, taxPct: tax, active: a.active === 'unknown' ? 'active' : a.active, source: a.source || 'Condizioni comunicate dal titolare', asOf: a.asOf || today }, fx, today, a.kind)),
  ];
  const summary = summarize(lines, state.basis);
  if (state.basis === 'net' && tax === null) summary.monthly = null;
  const externalCapital = state.external.every(a => euros(a.capital, a.currency, fx) !== null) ? state.external.reduce((s, a) => s + euros(a.capital, a.currency, fx)!, 0) : null;
  const brokerCapital = portfolio ? euros(portfolio.totalValue, 'USD', fx) : null;
  const autoCapital = externalCapital !== null ? brokerCapital !== null ? brokerCapital + externalCapital : state.external.length ? externalCapital : null : null;
  const capital = state.capitalOverride ?? autoCapital;
  const allocations = state.allocations.map(a => ({ ...a, taxPct: tax }));
  const plan = scenario(state.target, capital ?? 0, state.reserve, state.additional, allocations, state.basis);
  const planReady = capital !== null && plan.errors.length === 0;
  const currentRate = capital !== null && capital > 0 && summary.monthly !== null ? summary.monthly * 12 / capital * 100 : capital === 0 && summary.monthly === 0 ? 0 : null;
  const projectionRate = state.projectionMode === 'plan' ? planReady ? plan.weightedRate * 100 : null : currentRate;
  const covered = JSON.parse(requestKey).filter((i: { symbol: string }) => references[i.symbol]?.data).length;
  const requested = JSON.parse(requestKey).length;
  const annualAmount = (line: IncomeLine) => state.basis === 'gross' ? line.annualGross : line.annualNet;
  const progress = summary.monthly === null ? 0 : state.target > 0 ? Math.min(100, Math.max(0, summary.monthly / state.target * 100)) : 100;
  const aiContext = JSON.stringify({ target: state.target, basis: state.basis, capital: plan.available, knownMonthly: summary.monthly, missingSources: summary.missing + (portfolio ? 0 : 1), allocations });
  function selectTab(next: string) { if (form.current?.reportValidity()) setTab(next); }
  function save() {
    setSaveMessage(''); setSaveError('');
    if (!form.current?.reportValidity()) { setSaveError('Correggi i campi evidenziati prima di salvare.'); return; }
    if (state.external.some(a => !a.name.trim() || a.capital === null || a.rate === null)) { setTab('conti'); setSaveError('Completa nome, saldo e tasso dei conti aggiunti.'); return; }
    if (state.basis === 'net' && state.globalTaxPct === null) { setTab('conti'); setSaveError('Per il netto serve la percentuale fiscale ipotizzata.'); return; }
    if (state.fxOverride === 0) { setTab('piano'); setSaveError('Il cambio deve essere maggiore di zero.'); return; }
    if (!stateSchema.safeParse(state).success) { setSaveError('Alcuni valori non sono validi. Controlla importi e percentuali.'); return; }
    try {
      const confirmed = saveIncome(storageKey, state); setState(confirmed); setSaved(confirmed); setFormEdited(false); setSaveMessage('Dati validati e salvati in questo browser.');
    } catch { setSaveError('Il browser non ha confermato il salvataggio. La bozza è ancora qui: riprova oppure esportala.'); }
  }
  async function synchronize() {
    setRefreshBusy(true); setRevision(n => n + 1);
    try { await refresh(); } catch { if (mounted.current) setMessage('Aggiornamento eToro non riuscito. Le fonti pubbliche vengono recuperate separatamente.'); }
    finally { if (mounted.current) setRefreshBusy(false); }
  }
  async function explain() {
    setAiBusy(true); setMessage('');
    try { const result = await autopilot.incomeAdvice(JSON.parse(aiContext)); if (mounted.current) setAi({ ...result, context: aiContext }); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Analisi AI non disponibile'); }
    finally { if (mounted.current) setAiBusy(false); }
  }
  function useCurrentMix() {
    const groups = (Object.keys(names) as IncomeKind[]).map(kind => {
      const group = lines.filter(l => l.kind === kind);
      const amount = group.reduce((s, l) => s + (l.capitalEur ?? 0), 0);
      const annual = group.some(l => l.annualGross === null) ? null : group.reduce((s, l) => s + l.annualGross!, 0);
      return { kind, amount, rate: annual !== null && amount > 0 ? annual / amount * 100 : amount === 0 ? 0 : null };
    });
    const total = groups.reduce((s, g) => s + g.amount, 0);
    if (!total) { setMessage('Il mix attuale sarà disponibile quando sarà caricato il capitale.'); return; }
    const next = groups.map(g => ({ kind: g.kind, weight: Math.floor(g.amount / total * 100), rate: g.rate, taxPct: null }));
    next.reduce((best, a) => a.weight > best.weight ? a : best).weight += 100 - next.reduce((s, a) => s + a.weight, 0);
    patch({ allocations: next, projectionMode: 'plan' }); setMessage('Mix ricavato dal capitale riconosciuto nelle quattro categorie. I rendimenti non disponibili restano vuoti.');
  }
  const forecast = <Forecast state={state} capital={capital} annualRate={projectionRate} incomplete={state.projectionMode === 'current' && (summary.missing > 0 || !portfolio)} patch={patch} />;
  return <form ref={form} noValidate onInput={() => { setFormEdited(true); setSaveMessage(''); }} onSubmit={e => { e.preventDefault(); save(); }} className="space-y-6 pb-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="overline text-gain">Centro rendite</p><h1 className="mt-2 font-display text-3xl tracking-tight text-text-0 sm:text-4xl">Fai crescere la tua rendita.</h1><p className="mt-3 max-w-2xl text-sm text-text-1">Il punto di partenza, il tuo obiettivo e il percorso per avvicinarlo. Tutto in un unico prospetto.</p></div><div className="flex gap-2"><button type="button" className={button} disabled={refreshBusy || refBusy} onClick={() => void synchronize()}><RefreshCw size={15} className={refreshBusy || refBusy ? 'animate-spin' : ''} />Aggiorna</button><button type="submit" className={saveButton}><Save size={15} />Salva modifiche</button></div></header>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><p className={dirty ? 'text-warning' : 'text-text-2'}>{dirty ? 'Modifiche da salvare · stai vedendo l’anteprima' : state.savedAt ? `Salvato ${new Date(state.savedAt).toLocaleString('it-IT')} · valori validati` : 'Imposta il tuo tasso e premi Salva modifiche'}</p><p className="text-text-2">{refBusy ? `Aggiornamento fonti · ${covered}/${requested} titoli` : requested ? `${covered}/${requested} titoli con fonte automatica` : 'Dividendi sincronizzati dai titoli del portafoglio'}</p></div>
    {saveError && <p role="alert" className="rounded-xl border border-loss/25 bg-loss/5 p-4 text-sm text-loss">{saveError}</p>}
    {saveMessage && <p role="status" className="flex items-center gap-2 rounded-xl border border-gain/20 bg-gain/5 p-4 text-sm text-gain"><Check size={16} />{saveMessage}</p>}
    {message && <p role="status" className="rounded-xl border border-hairline p-4 text-sm text-text-1">{message}</p>}
    {!portfolio && <p className="rounded-xl border border-hairline bg-bg-2 p-4 text-sm text-text-1">{status === 'connecting' ? 'Caricamento del portafoglio eToro…' : 'Il portafoglio eToro non è disponibile in questa sessione.'} Puoi già simulare con altri conti. <Link className="text-gain underline" to="/impostazioni">Collegamento eToro</Link></p>}
    {portfolio && Date.now() - portfolio.asOf > 86400000 && <p className="text-xs text-warning">Il prospetto usa lo snapshot eToro del {new Date(portfolio.asOf).toLocaleString('it-IT')}. Premi Aggiorna per riallineare saldi e quantità.</p>}
    <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr_1fr]">
      <section className="relative overflow-hidden rounded-2xl bg-[#173F35] p-6 text-white"><div className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full border-[24px] border-white/5" /><p className="text-xs font-medium uppercase tracking-[0.12em] text-white/65">La tua rendita oggi · {state.basis === 'gross' ? 'lorda' : 'netta stimata'}</p><div className="mt-4 flex items-baseline gap-2"><strong className="text-4xl font-semibold tracking-tight sm:text-5xl">{money(summary.monthly)}</strong><span className="text-sm text-white/60">/mese</span></div><p className="mt-3 text-sm text-white/70">{summary.monthly !== null ? `${money(summary.monthly * 12)} su base annua` : 'In attesa del saldo e dei tassi'}</p><div className="mt-5 border-t border-white/15 pt-3 text-xs text-white/65">Media mensile stimata{summary.missing > 0 ? ' · copertura parziale' : ''}. Gli accrediti seguono le date effettive.</div></section>
      <section className="card-surface p-6"><div className="flex items-center justify-between"><p className="overline">Il tuo obiettivo</p><Target size={20} className="text-gain" /></div><p className="mt-4 text-3xl font-semibold text-text-0">{money(state.target)}<span className="ml-1 text-sm font-normal text-text-2">/mese</span></p><div className="mt-5 h-2 overflow-hidden rounded-full bg-bg-3"><div className="h-full rounded-full bg-gain transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-3 flex justify-between text-xs"><span className="text-text-2">{progress.toLocaleString('it-IT', { maximumFractionDigits: 1 })}% raggiunto sulla stima</span><button type="button" className="text-gain" onClick={() => selectTab('piano')}>Modifica obiettivo</button></div></section>
      <section className="card-surface p-6"><p className="overline">Il prossimo passo</p><p className="mt-4 text-3xl font-semibold text-text-0">{money(summary.monthly === null ? null : Math.max(0, state.target - summary.monthly))}<span className="ml-1 text-sm font-normal text-text-2">/mese</span></p><p className="mt-3 text-sm text-text-1">La rendita aggiuntiva per raggiungere il tuo obiettivo.</p><button type="button" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-gain" onClick={() => selectTab('piano')}>Costruisci il percorso<ArrowUpRight size={16} /></button></section>
    </div>
    <nav className="flex gap-1 overflow-x-auto border-b border-hairline" aria-label="Sezioni rendite">{[['oggi', 'Oggi e domani'], ['piano', 'Il mio piano'], ['conti', 'Conti e tassi'], ['dati', 'Dati e accrediti']].map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => selectTab(id)} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === id ? 'border-gain font-medium text-gain' : 'border-transparent text-text-2 hover:text-text-0'}`}>{label}</button>)}</nav>
    {tab === 'oggi' && <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{(Object.keys(names) as IncomeKind[]).map(kind => { const group = lines.filter(l => l.kind === kind); const s = summarize(group, state.basis); const Icon = icons[kind]; return <section key={kind} className="card-surface p-5"><div className="flex items-center justify-between text-text-1"><p className="text-sm">{names[kind]}</p><Icon size={18} className="text-gain" /></div><p className="mt-3 text-2xl font-semibold text-text-0">{money(kind === 'staking' && state.stakingMode === 'not_earning' ? 0 : s.monthly ?? (!group.length && (portfolio || kind === 'other') ? 0 : null))}<span className="ml-1 text-xs font-normal text-text-2">/mese</span></p><p className="mt-2 text-xs text-text-2">{kind === 'staking' && state.stakingMode === 'not_earning' ? 'Nessun premio attuale, come indicato' : s.missing ? 'Stima parziale · dati in aggiornamento' : kind === 'dividend' ? 'Sulle quote attuali, da fonti automatiche' : kind === 'interest' ? 'eToro e conti remunerati' : 'Nel tuo prospetto'}</p></section>; })}</div>
      {<CashSettings compact value={state.cash} cash={portfolio?.cash ?? null} patch={p => patch({ cash: { ...state.cash, ...p } })} />}
      <p className="text-xs text-text-2">Il grafico usa {state.projectionMode === 'current' ? 'i rendimenti della situazione attuale' : 'il mix ipotizzato nel tuo piano'}. <button type="button" className="text-gain underline" onClick={() => selectTab('piano')}>Cambia le ipotesi</button></p>
      {forecast}
      <div className="grid gap-4 md:grid-cols-2"><button type="button" onClick={() => selectTab('piano')} className="card-surface flex items-center justify-between gap-4 p-5 text-left"><div><p className="font-medium text-text-0">Quanto capitale serve per {money(state.target)}/mese?</p><p className="mt-2 text-sm text-text-2">Scegli il mix, confronta la rendita e simula i versamenti.</p></div><ArrowUpRight className="shrink-0 text-gain" /></button><button type="button" onClick={() => selectTab('conti')} className="card-surface flex items-center justify-between gap-4 p-5 text-left"><div><p className="font-medium text-text-0">Hai capitale anche su altri conti?</p><p className="mt-2 text-sm text-text-2">Bastano saldo e tasso per includerlo nel prospetto.</p></div><ArrowUpRight className="shrink-0 text-gain" /></button></div>
    </>}
    {tab === 'conti' && <Accounts state={state} cash={portfolio?.cash ?? null} patch={patch} />}
    {tab === 'piano' && <>
      <Panel title="Il traguardo e le risorse"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><NumberField label="Obiettivo mensile · EUR" value={state.target} onChange={n => patch({ target: n ?? 0 })} /><NumberField label="Capitale da aggiungere subito · EUR" value={state.additional} onChange={n => patch({ additional: n ?? 0 })} /><NumberField label="Riserva senza rendimento · EUR" value={state.reserve} onChange={n => patch({ reserve: n ?? 0 })} /><Field label="Rendimenti usati nel grafico"><select className={inputClass} value={state.projectionMode} onChange={e => patch({ projectionMode: e.target.value as 'current' | 'plan' })}><option value="current">Quelli della situazione attuale</option><option value="plan">Quelli del mix qui sotto</option></select></Field></div><p className="mt-4 text-sm text-text-1">Capitale rilevato: <strong className="text-text-0">{money(autoCapital)}</strong>. Il piano ipotizza il reimpiego del capitale disponibile, esclusa la riserva.</p><details className="mt-4 text-xs text-text-2"><summary className="cursor-pointer">Personalizza capitale e cambio · facoltativo</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><NumberField label="Capitale iniziale alternativo · EUR" value={state.capitalOverride} placeholder="Usa il capitale rilevato" onChange={capitalOverride => patch({ capitalOverride })} /><NumberField label="Dollari per 1 euro" value={state.fxOverride} placeholder="Cambio automatico" onChange={fxOverride => patch({ fxOverride })} /></div></details></Panel>
      <Panel title="Il mix con cui vuoi costruire la rendita"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-sm text-text-1">Distribuisci il capitale tra le fonti. I tassi iniziali sono esempi modificabili, non offerte disponibili o rendimenti promessi.</p><button type="button" className={button} onClick={useCurrentMix}>Usa il mix attuale</button></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{state.allocations.map((a, i) => <div className="rounded-xl border border-hairline p-4" key={a.kind}><p className="mb-4 font-medium text-text-0">{names[a.kind]}</p><div className="space-y-4"><NumberField label="Quota del capitale · %" value={a.weight} max={100} onChange={n => patch({ projectionMode: 'plan', allocations: state.allocations.map((v, j) => i === j ? { ...v, weight: n ?? 0 } : v) })} /><NumberField label="Rendimento annuo lordo ipotizzato · %" value={a.rate} max={100} onChange={rate => patch({ projectionMode: 'plan', allocations: state.allocations.map((v, j) => i === j ? { ...v, rate } : v) })} /></div></div>)}</div><p className={`mt-4 text-sm ${Math.abs(state.allocations.reduce((s, a) => s + a.weight, 0) - 100) < 0.001 ? 'text-gain' : 'text-loss'}`}>Totale allocato: {num(state.allocations.reduce((s, a) => s + a.weight, 0))}% / 100%</p>{plan.errors.map(error => <p key={error} className="mt-2 text-sm text-loss">{error}</p>)}</Panel>
      <Panel title="Cosa richiede il tuo obiettivo"><div className="grid gap-5 sm:grid-cols-3"><div><p className="text-xs text-text-2">Rendita del mix con il capitale disponibile</p><p className="mt-2 text-2xl font-semibold text-gain">{money(planReady ? plan.monthly : null)}<span className="ml-1 text-sm font-normal">/mese</span></p></div><div><p className="text-xs text-text-2">Capitale produttivo per il traguardo</p><p className="mt-2 text-2xl font-semibold text-text-0">{money(plan.errors.length ? null : plan.required)}</p></div><div><p className="text-xs text-text-2">Capitale che manca oggi</p><p className="mt-2 text-2xl font-semibold text-text-0">{money(planReady ? plan.additionalRequired : null)}</p></div></div><div className="mt-5 divide-y divide-hairline">{plan.breakdown.filter(b => state.allocations.find(a => a.kind === b.kind)!.weight > 0).map(b => <div className="flex flex-wrap justify-between gap-2 py-3 text-sm" key={b.kind}><span className="text-text-1">{names[b.kind]}</span><span className="text-text-0">{money(plan.errors.length ? null : b.requiredCapital)} per il traguardo <span className="text-text-2">· {money(planReady ? b.capital : null)} nel mix attuale</span></span></div>)}</div><p className="mt-3 text-xs text-text-2">Calcolo a rendimenti costanti. Il grafico aggiunge tempo e reinvestimento. La disponibilità dei prodotti, i limiti remunerati, i costi di spostamento e le soglie staking vanno applicati prima di realizzare lo scenario.</p></Panel>
      {forecast}
      <Panel title="Leggi il piano con l’AI"><p className="mb-4 text-sm text-text-1">L’AI interpreta questi numeri e propone priorità, alternative e punti da chiarire. I calcoli restano quelli del prospetto. Si avvia solo quando lo richiedi.</p><button type="button" className={button} disabled={aiBusy || !planReady || summary.monthly === null} onClick={() => void explain()}><Sparkles size={16} />{aiBusy ? 'Analisi in corso…' : 'Analizza il mio piano'}</button>{ai && <div className="mt-5 space-y-3"><p className="text-xs text-text-2">{ai.model}{ai.context !== aiContext ? ' · ipotesi cambiate: aggiorna l’analisi' : ''}</p><p className="whitespace-pre-wrap text-sm leading-relaxed text-text-1">{ai.text}</p></div>}</Panel>
    </>}
    {tab === 'dati' && <>
      <Panel title="Dividendi: recupero automatico"><p className="mb-5 text-sm text-text-1">Il dividendo annuo pubblicato viene moltiplicato per le quote eleggibili attuali, incluse quelle nei portafogli copiati. Le fonti possono usare un importo annuo prospettico o storico: è una stima, distinta dagli accrediti ricevuti.</p>{!stocks.length ? <p className="text-sm text-text-2">I titoli compariranno automaticamente dopo il caricamento del portafoglio.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-text-2"><tr><th className="pb-3 pr-4">Titolo</th><th className="pb-3 pr-4">Dividendo annuo / quota</th><th className="pb-3 pr-4">Media mensile stimata</th><th className="pb-3">Fonte e aggiornamento</th></tr></thead><tbody className="divide-y divide-hairline">{dividendLines.map(line => { const data = references[line.label]?.data; const rule = dividendRule(line.label); return <tr key={line.id}><td className="py-4 pr-4 align-top font-medium text-text-0">{line.label}</td><td className="py-4 pr-4 align-top text-text-1">{rule.annualPerShare === null ? line.annualGross === 0 ? 'Non applicabile' : refBusy ? 'In recupero' : 'Non disponibile' : `${num(rule.annualPerShare)} ${rule.currency}`}<p className="mt-1 max-w-xs text-xs text-text-2">{line.reason}</p></td><td className="py-4 pr-4 align-top text-text-0">{money(annualAmount(line) === null ? null : annualAmount(line)! / 12)}</td><td className="py-4 align-top text-xs text-text-2">{data ? <><a className="text-gain underline" href={data.source} target="_blank" rel="noreferrer">Stock Analysis</a><p className="mt-1">Letto {new Date(data.asOf).toLocaleString('it-IT')}</p>{data.sourceUpdatedAt && <p>Dati fonte: {data.sourceUpdatedAt}</p>}</> : line.annualGross === 0 && rule.annualPerShare === null ? <>Posizione esclusa dal calcolo</> : rule.source ? <>Dato salvato in precedenza · {rule.source}</> : <>Fonte temporaneamente non disponibile. Usa Aggiorna per riprovare.</>}</td></tr>; })}</tbody></table></div>}<p className="mt-4 text-xs text-text-2">Una fonte non disponibile rimane esclusa dal totale e viene segnalata: non è convertita in un dividendo di zero. Nessuna chiave aggiuntiva richiesta.</p></Panel>
      <Panel title="Staking eToro"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-3xl font-semibold text-text-0">{money(state.stakingMode === 'not_earning' ? 0 : annualAmount(staking) === null ? null : annualAmount(staking)! / 12)}<span className="ml-1 text-sm font-normal text-text-2">/mese</span></p><p className="mt-3 text-sm text-text-1">{staking.reason}.</p></div><a href="https://www.etoro.com/it/crypto/staking/" target="_blank" rel="noreferrer" className="text-xs text-gain underline">Regole ufficiali eToro</a></div><p className="mt-4 text-xs text-text-2">Crypto rilevate: {cryptos.join(', ') || 'nessuna in questa sessione'}. Asset presenti nella lista supportata: {cryptos.filter(s => STAKING_SYMBOLS.includes(s)).join(', ') || 'nessuno'}. L’idoneità dell’asset non equivale a premi attivi nel conto.</p><details className="mt-5 border-t border-hairline pt-4"><summary className="cursor-pointer text-sm text-text-1">La mia situazione staking è cambiata</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Premi attuali"><select className={inputClass} value={state.stakingMode} onChange={e => patch({ stakingMode: e.target.value as IncomeState['stakingMode'] })}><option value="not_earning">Non ricevo premi, come già indicato</option><option value="earning">Ho iniziato a ricevere premi</option></select></Field>{state.stakingMode === 'earning' && <NumberField required label="Valore medio dei premi mensili · USD" value={state.stakingMonthlyUsd} onChange={stakingMonthlyUsd => patch({ stakingMonthlyUsd })} />}</div><p className="mt-3 text-xs text-text-2">L’API disponibile non espone lo storico completo dei premi o l’attivazione del conto. Registriamo una sola indicazione complessiva, senza chiederti di verificare ogni moneta.</p></details></Panel>
      <Panel title="Da dove arrivano i numeri"><div className="grid gap-4 text-sm sm:grid-cols-2"><div><p className="font-medium text-text-0">Saldo e quantità</p><p className="mt-2 text-text-1">Portafoglio eToro della sessione. Interessi attivi in base alla tua indicazione; tasso modificabile in Conti e tassi.</p></div><div><p className="font-medium text-text-0">Cambio in euro</p><p className="mt-2 text-text-1">{state.fxOverride !== null ? 'Cambio personalizzato' : fxRate && Date.now() - fxRate.timestamp < 86400000 ? 'Cambio della sessione' : 'Cambio di riferimento BCE'}: {fx ? `${num(fx)} USD per EUR` : 'non disponibile'}. {referenceFx && `Riferimenti multivaluta del ${referenceFx.date}.`}</p>{fxError && <p className="mt-1 text-xs text-text-2">{fxError}</p>}</div></div></Panel>
      <IncomeLedger events={state.events} onChange={events => patch({ events })} />
    </>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4 text-xs text-text-2"><p>Preferenze salvate in questo browser, per questo collegamento eToro. Le stime non sono accrediti.</p><button type="button" className={button} onClick={() => download({ exportedAt: new Date().toISOString(), state, lines, references, fx, plan: planReady ? plan : null })}><Download size={14} />Esporta prospetto</button></footer>
    {dirty && <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gain/25 bg-bg-0 p-4 shadow-lg"><p className="text-sm text-text-1">Anteprima aggiornata. Salva per ritrovare le tue scelte.</p><button type="submit" className={saveButton}><Save size={15} />Salva modifiche</button></div>}
  </form>;
}
