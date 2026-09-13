import type { ReactNode } from 'react';
import type { YieldInput } from '@/lib/income/engine';
export const inputClass = 'mt-1 w-full min-w-0 rounded-lg border border-hairline bg-bg-2 px-3 py-2 text-sm text-text-0 focus:outline-none focus:ring-2 focus:ring-gain';
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block min-w-0 text-xs text-text-1">{label}{children}</label>; }
export function NumberField({ label, value, onChange, max }: { label: string; value: number | null; onChange: (n: number | null) => void; max?: number }) {
  return <Field label={label}><input className={inputClass} type="number" min="0" max={max} step="any" placeholder="Da completare" lang="it" value={value ?? ''} onChange={e => { const n = e.currentTarget.valueAsNumber; onChange(Number.isFinite(n) && n >= 0 && (max === undefined || n <= max) ? n : null); }} /></Field>;
}
export function YieldFields({ value, onChange, currency = 'EUR', includeLimits = true }: { value: YieldInput; onChange: (patch: Partial<YieldInput>) => void; currency?: string; includeLimits?: boolean }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Field label="Remunerazione nel conto"><select className={inputClass} value={value.active} onChange={e => onChange({ active: e.target.value as YieldInput['active'] })}><option value="unknown">Da verificare</option><option value="active">Attiva, confermata da me</option><option value="inactive">Non attiva / nessun premio</option></select></Field>
    <NumberField label="Tasso annuo lordo %" value={value.rate} max={100} onChange={rate => onChange({ rate })} />
    <Field label="Convenzione tasso"><select className={inputClass} value={value.rateType} onChange={e => onChange({ rateType: e.target.value as YieldInput['rateType'] })}><option>APR</option><option>APY</option></select></Field>
    <NumberField label="Prelievo fiscale effettivo ipotizzato %" value={value.taxPct} max={100} onChange={taxPct => onChange({ taxPct })} />
    <Field label="Fonte / condizioni applicabili"><input className={inputClass} value={value.source} maxLength={500} placeholder="Link o estratto del conto" onChange={e => onChange({ source: e.target.value })} /></Field>
    <Field label="Tasso valido dal"><input className={inputClass} type="date" value={value.asOf} onChange={e => onChange({ asOf: e.target.value })} /></Field>
    <Field label="Scadenza tasso (se presente)"><input className={inputClass} type="date" value={value.validUntil} onChange={e => onChange({ validUntil: e.target.value })} /></Field>
    <NumberField label={`Costi annui ${currency}`} value={value.annualFees} onChange={n => onChange({ annualFees: n ?? 0 })} />
    {includeLimits && <NumberField label={`Soglia minima saldo ${currency}`} value={value.minimum} onChange={n => onChange({ minimum: n ?? 0 })} />}
    {includeLimits && <NumberField label={`Massimale remunerato ${currency} (vuoto = nessuno)`} value={value.cap} onChange={cap => onChange({ cap })} />}
  </div>;
}
