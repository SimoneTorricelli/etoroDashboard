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
  version: z.literal(1), target: number, basis: z.enum(['gross', 'net']), fxOverride: number.nullable(), capitalOverride: number.nullable(), reserve: number, additional: number,
  dividends: z.record(z.string(), dividendSchema), staking: z.record(z.string(), stakingSchema), cash: yieldSchema,
  external: z.array(externalSchema).max(50), events: z.array(eventSchema).max(10000),
  allocations: z.array(z.object({ kind: z.enum(['dividend', 'interest', 'staking', 'other']), weight: number.max(100), rate: pct, taxPct: pct })).length(4),
});
export interface IncomeState {
  version: 1; target: number; basis: 'gross' | 'net'; fxOverride: number | null; capitalOverride: number | null; reserve: number; additional: number;
  dividends: Record<string, DividendInput>; staking: Record<string, StakingInput>; cash: YieldInput; external: ExternalAccount[]; events: IncomeEvent[]; allocations: Allocation[];
}
export const initialState = (): IncomeState => ({ version: 1, target: 100, basis: 'net', fxOverride: null, capitalOverride: null, reserve: 0, additional: 0, dividends: {}, staking: {}, cash: emptyYield(), external: [], events: [], allocations: [
  { kind: 'dividend', weight: 50, rate: 4, taxPct: null }, { kind: 'interest', weight: 50, rate: 2.5, taxPct: null },
  { kind: 'staking', weight: 0, rate: 5, taxPct: null }, { kind: 'other', weight: 0, rate: 2, taxPct: null },
] });
export function loadIncome(key: string): { state: IncomeState; error: string } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { state: initialState(), error: '' };
    const state = stateSchema.parse(JSON.parse(raw));
    state.events.forEach(e => validateEvent(e));
    return { state, error: '' };
  } catch { return { state: initialState(), error: 'Dati locali non leggibili: esporta il backup prima di modificare. Il salvataggio è sospeso.' }; }
}
export function saveIncome(key: string, state: IncomeState) {
  const parsed = stateSchema.parse(state);
  const old = localStorage.getItem(key);
  // Versioned snapshots of rules and settings; ledger lives only in the main record.
  const revisionsKey = `${key}.revisions`;
  const revisions = JSON.parse(localStorage.getItem(revisionsKey) || '[]');
  if (old) {
    const { events: _events, ...previous } = JSON.parse(old);
    void _events;
    localStorage.setItem(revisionsKey, JSON.stringify([...revisions, { at: Date.now(), state: previous }].slice(-30)));
  }
  localStorage.setItem(key, JSON.stringify(parsed));
}
