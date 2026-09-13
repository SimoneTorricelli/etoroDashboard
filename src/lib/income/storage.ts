import { z } from 'zod';
import { emptyYield, validateEvent } from './engine';
import type { Allocation, DividendInput, ExternalAccount, IncomeEvent, StakingInput, YieldInput } from './engine';
const number = z.number().finite().nonnegative();
const pct = number.max(100).nullable();
const yieldSchema = z.object({ rate: pct, rateType: z.enum(['APR', 'APY']), taxPct: pct, annualFees: number, active: z.enum(['unknown', 'active', 'inactive']), source: z.string().max(500), asOf: z.string(), validUntil: z.string(), cap: number.nullable(), minimum: number });
const dividendSchema = z.object({ annualPerShare: number.nullable(), currency: z.string().max(10), taxPct: pct, source: z.string().max(500), asOf: z.string() });
const stakingSchema = yieldSchema.extend({ sharePct: pct, rateBasis: z.enum(['network', 'provider']), eligible: z.boolean(), eligibleFrom: z.string(), minimumRewardUsd: number });
const externalSchema = yieldSchema.extend({ id: z.string(), name: z.string().max(100), kind: z.enum(['interest', 'other']), capital: number.nullable(), currency: z.enum(['EUR', 'USD']) });
const eventSchema = z.object({ id: z.string(), account: z.string(), kind: z.enum(['dividend', 'interest', 'staking', 'other']), status: z.enum(['paid', 'accrued', 'declared']), date: z.string(), currency: z.enum(['EUR', 'USD']), gross: z.string(), withholding: z.string(), fees: z.string(), fx: z.string(), source: z.string() });
export const stateSchema = z.object({
  version: z.literal(2), savedAt: number, globalTaxPct: pct, monthlyContribution: number, reinvestPct: number.max(100), horizon: z.union([z.literal(12), z.literal(24), z.literal(60)]), projectionMode: z.enum(['current', 'plan']), stakingMode: z.enum(['not_earning', 'earning']), stakingMonthlyUsd: number.nullable(), target: number, basis: z.enum(['gross', 'net']), fxOverride: number.nullable(), capitalOverride: number.nullable(), reserve: number, additional: number,
  dividends: z.record(z.string(), dividendSchema), staking: z.record(z.string(), stakingSchema), cash: yieldSchema,
  external: z.array(externalSchema).max(50), events: z.array(eventSchema).max(10000),
  allocations: z.array(z.object({ kind: z.enum(['dividend', 'interest', 'staking', 'other']), weight: number.max(100), rate: pct, taxPct: pct })).length(4),
});
export interface IncomeState {
  version: 2; savedAt: number; globalTaxPct: number | null; monthlyContribution: number; reinvestPct: number; horizon: 12 | 24 | 60; projectionMode: 'current' | 'plan'; stakingMode: 'not_earning' | 'earning'; stakingMonthlyUsd: number | null; target: number; basis: 'gross' | 'net'; fxOverride: number | null; capitalOverride: number | null; reserve: number; additional: number;
  dividends: Record<string, DividendInput>; staking: Record<string, StakingInput>; cash: YieldInput; external: ExternalAccount[]; events: IncomeEvent[]; allocations: Allocation[];
}
export const initialState = (): IncomeState => ({ version: 2, savedAt: 0, globalTaxPct: null, monthlyContribution: 0, reinvestPct: 100, horizon: 60, projectionMode: 'current', stakingMode: 'not_earning', stakingMonthlyUsd: null, target: 100, basis: 'gross', fxOverride: null, capitalOverride: null, reserve: 0, additional: 0, dividends: {}, staking: {}, cash: { ...emptyYield(), active: 'active', source: 'Tasso annuo comunicato dal titolare', asOf: new Date().toISOString().slice(0, 10) }, external: [], events: [], allocations: [
  { kind: 'dividend', weight: 50, rate: 4, taxPct: null }, { kind: 'interest', weight: 50, rate: 2.5, taxPct: null },
  { kind: 'staking', weight: 0, rate: 5, taxPct: null }, { kind: 'other', weight: 0, rate: 2, taxPct: null },
] });
export function loadIncome(key: string): { state: IncomeState; error: string } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { state: initialState(), error: '' };
    const state = migrateIncome(JSON.parse(raw));
    state.events.forEach(e => validateEvent({ ...e }));
    return { state, error: '' };
  } catch { return { state: initialState(), error: 'Il vecchio salvataggio non è leggibile. Il contenuto originale è conservato; puoi salvare una nuova configurazione.' }; }
}
export function migrateIncome(raw: unknown): IncomeState {
  const value = raw as Record<string, unknown>;
  if (!value || ![1, 2].includes(Number(value.version))) throw new Error('Versione dati non riconosciuta');
  if (value.version === 2) return stateSchema.parse(value);
  const merged = { ...initialState(), ...value, version: 2, basis: 'gross' };
  const oldCash = value.cash as YieldInput | undefined;
  merged.cash = { ...initialState().cash, ...oldCash, active: 'active', validUntil: '',
    source: oldCash?.source || 'Tasso annuo comunicato dal titolare', asOf: oldCash?.asOf || new Date().toISOString().slice(0, 10) };
  return stateSchema.parse(merged);
}
export function saveIncome(key: string, state: IncomeState): IncomeState {
  const parsed = stateSchema.parse({ ...state, savedAt: Date.now() });
  parsed.events.forEach(validateEvent);
  const serialized = JSON.stringify(parsed);
  const old = localStorage.getItem(key);
  // Corrupt input is kept before replacement. Failure must be visible to the user.
  if (old) {
    try { migrateIncome(JSON.parse(old)); }
    catch { localStorage.setItem(`${key}.backup`, old); }
  }
  localStorage.setItem(key, serialized);
  if (localStorage.getItem(key) !== serialized) throw new Error('Salvataggio non confermato dal browser');
  // The history is optional: a broken/full history must never block the main save.
  if (old && old !== serialized) try {
    const revisionsKey = `${key}.revisions`;
    let revisions: unknown[] = [];
    try { const value = JSON.parse(localStorage.getItem(revisionsKey) || '[]'); if (Array.isArray(value)) revisions = value; } catch { /* Rebuild optional history. */ }
    const { events: _events, ...previous } = JSON.parse(old); void _events;
    localStorage.setItem(revisionsKey, JSON.stringify([...revisions, { at: Date.now(), state: previous }].slice(-10)));
  } catch { /* The verified main record is already durable. */ }
  return parsed;
}
