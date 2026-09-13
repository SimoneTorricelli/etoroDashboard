import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { NumberField } from './Fields';
import { projectIncome } from '@/lib/income/projection';
import type { IncomeState } from '@/lib/income/storage';

const money = (n: number) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const monthlyMoney = (n: number) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(n);
export function Forecast({ state, capital, annualRate, incomplete, patch }: {
  state: IncomeState; capital: number | null; annualRate: number | null; incomplete: boolean; patch: (p: Partial<IncomeState>) => void;
}) {
  const forecast = capital !== null && annualRate !== null ? projectIncome({ capital, reserve: state.reserve, additional: state.additional,
    monthlyContribution: state.monthlyContribution, annualRate, reinvestPct: state.reinvestPct, months: 60, targetMonthly: state.target }) : null;
  const data = forecast?.points.slice(0, state.horizon + 1) ?? [];
  const end = data.at(-1);
  return <section className="card-surface overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-hairline p-5 sm:p-6">
      <div><p className="overline text-gain">Il tempo lavora con te</p><h2 className="mt-1 font-display text-2xl text-text-0">Il tuo capitale nel tempo</h2><p className="mt-2 max-w-2xl text-sm text-text-1">Versamenti e rendite reinvestite: scopri quanto pesa ogni scelta.</p></div>
      <div className="flex rounded-xl border border-hairline bg-bg-2 p-1" aria-label="Orizzonte proiezione">{([12, 24, 60] as const).map(n => <button type="button" aria-pressed={state.horizon === n} key={n} onClick={() => patch({ horizon: n })} className={`rounded-lg px-4 py-2 text-sm ${state.horizon === n ? 'bg-bg-0 text-text-0 shadow-sm' : 'text-text-2'}`}>{n / 12} {n === 12 ? 'anno' : 'anni'}</button>)}</div>
    </div>
    <div className="grid lg:grid-cols-[1fr_280px]">
      <div className="min-w-0 p-5 sm:p-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-xs text-text-2">Capitale stimato a {state.horizon / 12} {state.horizon === 12 ? 'anno' : 'anni'}</p><p className="mt-1 text-4xl font-semibold tracking-tight text-text-0">{end ? money(end.capital) : '—'}</p></div>
          {end && <div className="text-right"><p className="text-sm font-medium text-gain">+{money(end.reinvested)} reinvestiti</p><p className="mt-1 text-xs text-text-2">{money(end.contributions)} di capitale e versamenti</p></div>}
        </div>
        {end ? <div className="h-[280px] w-full" role="img" aria-label={`Proiezione a ${state.horizon / 12} ${state.horizon === 12 ? 'anno' : 'anni'}: capitale ${money(end.capital)}, di cui ${money(end.reinvested)} rendite reinvestite.`}>
          <ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <defs><linearGradient id="incomeGrowth" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.24} /><stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.01} /></linearGradient></defs>
            <CartesianGrid stroke="hsl(var(--border))" vertical={false} strokeDasharray="3 5" />
            <XAxis dataKey="month" axisLine={false} tickLine={false} minTickGap={35} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} tickFormatter={n => n === 0 ? 'Oggi' : `${n} mesi`} />
            <YAxis axisLine={false} tickLine={false} width={65} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} tickFormatter={n => n >= 1000 ? `${Math.round(n / 1000)}k €` : `${n} €`} domain={['auto', 'auto']} />
            <Tooltip contentStyle={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: 12, color: 'hsl(var(--foreground))' }} labelFormatter={n => Number(n) === 0 ? 'Oggi' : `Fra ${n} mesi`} formatter={value => money(Number(value))} />
            <Area name="Capitale con reinvestimento" type="monotone" dataKey="capital" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#incomeGrowth)" isAnimationActive={false} />
            <Line name="Rendimenti ridotti del 30%" type="monotone" dataKey="prudent" stroke="#6995AD" strokeDasharray="3 4" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line name="Capitale e versamenti" type="monotone" dataKey="contributions" stroke="hsl(var(--muted-foreground))" strokeDasharray="6 5" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </ComposedChart></ResponsiveContainer>
        </div> : <div className="flex h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-hairline px-6 text-center text-text-2"><TrendingUp className="mb-3 size-8 text-gain" /><p className="text-base text-text-0">Costruiamo la proiezione sui tuoi numeri</p><p className="mt-2 max-w-md text-sm">{forecast?.errors[0] || (capital === null ? 'Collega eToro, aggiungi un conto oppure imposta il capitale nelle ipotesi.' : 'Inserisci il tasso del contante o attendi il recupero dei dividendi.')}</p></div>}
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-text-2"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-gain" />Con reinvestimento</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-info" />Rendimenti −30%</span><span>— Capitale e versamenti</span></div>
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-hairline pt-4">{[12, 24, 60].map(m => { const p = forecast?.points[m]; return <div key={m}><p className="text-xs text-text-2">Fra {m / 12} {m === 12 ? 'anno' : 'anni'}</p><p className="mt-1 text-base font-semibold text-text-0">{p ? money(p.capital) : '—'}</p><p className="mt-1 text-xs text-gain">{p ? `${monthlyMoney(p.monthlyIncome)}/mese potenziali` : 'Da calcolare'}</p></div>; })}</div>
      </div>
      <div className="space-y-5 border-t border-hairline bg-bg-2/40 p-5 sm:p-6 lg:border-l lg:border-t-0">
        <div><p className="overline">Le tue leve</p><p className="mt-1 text-xs text-text-2">Il grafico si aggiorna mentre le cambi.</p></div>
        <NumberField label="Aggiungo ogni mese · EUR" value={state.monthlyContribution} onChange={n => patch({ monthlyContribution: n ?? 0 })} />
        <div><label className="flex justify-between text-xs text-text-1" htmlFor="income-reinvest">Reinvesto le rendite <strong className="text-text-0">{state.reinvestPct}%</strong></label><input id="income-reinvest" type="range" min={0} max={100} step={5} className="mt-3 w-full accent-gain" value={state.reinvestPct} onChange={e => patch({ reinvestPct: Number(e.target.value) })} /><p className="mt-1 text-xs text-text-2">{state.reinvestPct === 100 ? 'Tutte le rendite rimangono investite.' : `${100 - state.reinvestPct}% viene prelevato e non si somma al capitale.`}</p></div>
        <div className="rounded-xl border border-gain/20 bg-gain/5 p-4"><p className="text-xs text-text-1">Obiettivo {money(state.target)}/mese</p><p className="mt-2 text-base font-medium text-text-0">{forecast?.targetMonth === 0 ? 'Già raggiunto nello scenario' : forecast?.targetMonth != null ? `Potenziale fra ${forecast.targetMonth} mesi` : forecast?.points.length ? 'Oltre l’orizzonte di 5 anni' : 'In attesa dei dati'}</p><p className="mt-2 text-xs text-text-2">Rendita che il capitale potrebbe produrre, prima di scegliere quanto prelevare.</p></div>
        {end && end.withdrawn > 0 && <p className="text-xs text-text-1">Rendite prelevate nel periodo: <strong>{money(end.withdrawn)}</strong>, separate dal capitale.</p>}
        {end?.contributionForTarget != null && end.contributionForTarget > state.monthlyContribution && <div className="border-t border-hairline pt-4"><p className="text-xs text-text-1">Per puntare all’obiettivo entro {state.horizon / 12} {state.horizon === 12 ? 'anno' : 'anni'}</p><p className="mt-2 text-xl font-semibold text-text-0">{monthlyMoney(end.contributionForTarget)}<span className="ml-1 text-xs font-normal text-text-2">da versare /mese</span></p><p className="mt-2 text-xs text-text-2">{monthlyMoney(end.contributionForTarget - state.monthlyContribution)} in più rispetto ai versamenti impostati, con queste stesse ipotesi.</p></div>}
      </div>
    </div>
    <div className="border-t border-hairline px-5 py-4 text-xs text-text-2 sm:px-6">Ipotesi {state.basis === 'gross' ? 'al lordo delle imposte' : 'dopo la percentuale fiscale impostata'}: rendimento annuo {annualRate === null ? 'da calcolare' : `${annualRate.toLocaleString('it-IT', { maximumFractionDigits: 3 })}%`} costante, reinvestimento mensile, versamenti a fine mese, prezzi e cambi fermi. {incomplete ? 'Copertura parziale: le fonti non recuperate non contribuiscono al rendimento del modello. ' : ''}Il calendario reale dei pagamenti può differire. La linea prudente è una simulazione, non un intervallo di probabilità.</div>
  </section>;
}
