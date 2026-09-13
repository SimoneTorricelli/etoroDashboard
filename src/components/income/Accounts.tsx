import { Plus, Trash2, Wallet } from 'lucide-react';
import { Field, inputClass, NumberField } from './Fields';
import { emptyYield } from '@/lib/income/engine';
import type { YieldInput } from '@/lib/income/engine';
import type { IncomeState } from '@/lib/income/storage';

const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-hairline bg-bg-1 px-3 py-2 text-sm text-text-0 hover:bg-bg-2';
function Advanced({ value, patch, currency }: { value: YieldInput; patch: (p: Partial<YieldInput>) => void; currency: string }) {
  return <details className="mt-4 border-t border-hairline pt-3"><summary className="cursor-pointer text-xs text-text-2">Condizioni particolari · facoltative</summary><div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <NumberField label={`Costi annui · ${currency}`} value={value.annualFees} onChange={n => patch({ annualFees: n ?? 0 })} />
    <NumberField label={`Saldo minimo remunerato · ${currency}`} value={value.minimum} onChange={n => patch({ minimum: n ?? 0 })} />
    <NumberField label={`Massimale remunerato · ${currency}`} value={value.cap} placeholder="Nessun limite" onChange={cap => patch({ cap })} />
    <Field label="Scadenza promozione, solo se prevista"><input className={inputClass} type="date" value={value.validUntil} onChange={e => patch({ validUntil: e.target.value })} /></Field>
    <Field label="Note del prodotto"><input className={inputClass} value={value.source} maxLength={500} onChange={e => patch({ source: e.target.value })} /></Field>
    <label className="text-xs text-text-1"><input type="checkbox" className="mr-2" checked={value.rateType === 'APY'} onChange={e => patch({ rateType: e.target.checked ? 'APY' : 'APR' })} />Il rendimento pubblicato comprende già gli interessi reinvestiti in un anno.</label>
  </div></details>;
}
export function CashSettings({ value, cash, patch, compact = false }: { value: YieldInput; cash: number | null; patch: (p: Partial<YieldInput>) => void; compact?: boolean }) {
  return <section className={`card-surface ${compact ? 'p-4' : 'p-5 sm:p-6'}`}>
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3"><span className="rounded-xl bg-gain/10 p-3 text-gain"><Wallet size={20} /></span><div><h2 className="font-medium text-text-0">Il contante eToro</h2><p className="mt-1 text-sm text-text-1">{cash === null ? 'Saldo letto automaticamente quando il conto è collegato' : `${new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD' }).format(cash)} · saldo letto da eToro`}</p><p className="mt-1 text-xs text-gain">Interessi attivi · come hai indicato</p></div></div>
      <div className="w-full sm:w-52"><NumberField label="Il tuo tasso annuo lordo · %" value={value.rate} max={100} placeholder="Inserisci il tasso" onChange={rate => patch({ rate, active: 'active', rateType: 'APR', source: 'Tasso comunicato dal titolare', asOf: new Date().toISOString().slice(0, 10), validUntil: '' })} /></div>
    </div>
    <p className="mt-3 text-xs text-text-2">Rimane valido finché lo cambi. Saldo aggiornato automaticamente; non devi inserire date o fare conversioni.</p>
    {!compact && <Advanced value={value} patch={patch} currency="USD" />}
  </section>;
}
export function Accounts({ state, cash, patch }: { state: IncomeState; cash: number | null; patch: (p: Partial<IncomeState>) => void }) {
  return <div className="space-y-5">
    <CashSettings value={state.cash} cash={cash} patch={p => patch({ cash: { ...state.cash, ...p } })} />
    <section className="card-surface p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-medium text-text-0">Tutto il tuo capitale, anche fuori da eToro</h2><p className="mt-1 text-sm text-text-1">Per ogni conto bastano nome, saldo e tasso annuo. Le condizioni rimangono salvate fino al prossimo aggiornamento.</p></div><button type="button" className={button} disabled={state.external.length >= 50} onClick={() => patch({ external: [...state.external, { ...emptyYield(), active: 'active', source: 'Condizioni comunicate dal titolare', asOf: new Date().toISOString().slice(0, 10), id: crypto.randomUUID(), name: '', kind: 'interest', capital: null, currency: 'EUR' }] })}><Plus size={16} />Aggiungi conto</button></div>
      {!state.external.length && <div className="mt-5 rounded-xl border border-dashed border-hairline p-8 text-center"><p className="text-text-0">Hai un conto deposito o altra liquidità remunerata?</p><p className="mt-2 text-sm text-text-2">Aggiungila qui: contribuirà alla rendita attuale e al piano di crescita.</p></div>}
      <div className="mt-5 space-y-4">{state.external.map((account, i) => {
        const update = (p: Partial<typeof account>) => patch({ external: state.external.map(a => a.id === account.id ? { ...a, ...p } : a) });
        return <article className="rounded-xl border border-hairline p-4" key={account.id}><div className="mb-4 flex items-center justify-between"><p className="text-sm font-medium text-text-0">{account.name || `Nuovo conto ${i + 1}`}</p><button type="button" className="rounded-lg p-2 text-text-2 hover:bg-loss/5 hover:text-loss" aria-label={`Rimuovi ${account.name || `conto ${i + 1}`}`} onClick={() => patch({ external: state.external.filter(a => a.id !== account.id) })}><Trash2 size={16} /></button></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Field label="Nome del conto"><input required className={inputClass} value={account.name} maxLength={100} placeholder="Es. conto deposito" onChange={e => update({ name: e.target.value })} /></Field><NumberField required label="Saldo del conto" value={account.capital} onChange={capital => update({ capital })} /><NumberField required label="Tasso annuo lordo · %" value={account.rate} max={100} onChange={rate => update({ rate, active: 'active', asOf: new Date().toISOString().slice(0, 10), source: account.source || 'Condizioni comunicate dal titolare' })} /><Field label="Valuta"><select className={inputClass} value={account.currency} onChange={e => update({ currency: e.target.value as 'EUR' | 'USD' })}><option>EUR</option><option>USD</option></select></Field></div>
          <div className="mt-4 max-w-xs"><Field label="Categoria della rendita"><select className={inputClass} value={account.kind} onChange={e => update({ kind: e.target.value as 'interest' | 'other' })}><option value="interest">Interessi su un conto</option><option value="other">Altra rendita sul capitale</option></select></Field></div><Advanced value={account} patch={update} currency={account.currency} />
        </article>;
      })}</div>
    </section>
    <section className="card-surface p-5 sm:p-6"><h2 className="text-lg font-medium text-text-0">Lordo o netto: una scelta, non decine di campi</h2><p className="mt-2 text-sm text-text-1">Il lordo è disponibile subito. Per simulare il netto puoi applicare una percentuale fiscale comune; non è una liquidazione delle imposte del conto.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Mostra gli importi"><select className={inputClass} value={state.basis} onChange={e => patch({ basis: e.target.value as 'gross' | 'net' })}><option value="gross">Al lordo delle imposte</option><option value="net">Netto con la mia ipotesi fiscale</option></select></Field>{state.basis === 'net' && <NumberField required label="Percentuale fiscale ipotizzata · %" value={state.globalTaxPct} max={100} placeholder="Da indicare una sola volta" onChange={globalTaxPct => patch({ globalTaxPct })} />}</div></section>
  </div>;
}
