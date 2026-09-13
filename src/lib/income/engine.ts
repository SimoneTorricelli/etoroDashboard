import type { Portfolio, Position } from '../data/types';

export type IncomeKind = 'dividend' | 'interest' | 'staking' | 'other';
export type Activation = 'unknown' | 'active' | 'inactive';
export interface YieldInput {
  rate: number | null;
  rateType: 'APR' | 'APY';
  taxPct: number | null;
  annualFees: number;
  active: Activation;
  source: string;
  asOf: string;
  validUntil: string;
  cap: number | null;
  minimum: number;
}
export interface DividendInput {
  annualPerShare: number | null;
  currency: string;
  taxPct: number | null;
  source: string;
  asOf: string;
}
export interface StakingInput extends YieldInput {
  sharePct: number | null;
  rateBasis: 'network' | 'provider';
  eligible: boolean;
  eligibleFrom: string;
  minimumRewardUsd: number;
}
export interface ExternalAccount extends YieldInput {
  id: string;
  name: string;
  kind: 'interest' | 'other';
  capital: number | null;
  currency: 'EUR' | 'USD';
}
export interface IncomeLine {
  id: string;
  label: string;
  kind: IncomeKind;
  capitalEur: number | null;
  annualGross: number | null;
  annualNet: number | null;
  potentialGross?: number | null;
  thresholdCapitalEur?: number | null;
  reason: string;
  source: string;
  asOf: string;
}
export const STAKING_SYMBOLS = ['ADA', 'SOL', 'ETH', 'NEAR', 'POL', 'TRX', 'DOT', 'SUI', 'ATOM', 'AVAX'];
export const emptyYield = (): YieldInput => ({ rate: null, rateType: 'APR', taxPct: null, annualFees: 0, active: 'unknown', source: '', asOf: '', validUntil: '', cap: null, minimum: 0 });
export const emptyDividend = (): DividendInput => ({ annualPerShare: null, currency: '', taxPct: null, source: '', asOf: '' });
export const emptyStaking = (): StakingInput => ({ ...emptyYield(), sharePct: null, rateBasis: 'provider', eligible: false, eligibleFrom: '', minimumRewardUsd: 1 });
export const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const percent = (n: unknown): n is number => validNumber(n) && n <= 100;
export function euros(amount: number | null, currency: string, eurUsd: number | null, rates: Record<string, number> = {}): number | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  if (amount === 0) return 0;
  if (currency === 'EUR') return amount;
  if (currency === 'USD' && eurUsd !== null && eurUsd > 0 && Number.isFinite(eurUsd)) return amount / eurUsd;
  const rate = currency === 'GBX' ? (rates.GBP ?? 0) * 100 : rates[currency];
  if (rate > 0 && Number.isFinite(rate)) return amount / rate;
  return null;
}
export function payoutRate(rate: number, type: 'APR' | 'APY'): number {
  // Monthly withdrawals: APY cannot be used as a nominal annual cash yield.
  return type === 'APY' ? Math.expm1(Math.log1p(rate / 100) / 12) * 12 : rate / 100;
}
export function netIncome(gross: number | null, tax: number | null, fees = 0): number | null {
  if (gross === 0 && validNumber(fees)) return fees === 0 ? 0 : -fees;
  return gross === null || !percent(tax) || !validNumber(fees) ? null : gross * (1 - tax / 100) - fees;
}
export function allPositions(portfolio: Portfolio | null): Position[] {
  const positions = [...(portfolio?.positions ?? []), ...(portfolio?.copyPortfolios ?? []).flatMap(c => c.positions.map(p => ({ ...p, source: 'copy' as const, copyId: c.copyId })))];
  const seen = new Set<string>();
  return positions.filter(p => {
    const key = `${p.copyId ?? 'direct'}:${p.positionId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function positionCapital(positions: Position[]): number | null {
  if (positions.some(p => !validNumber(p.currentValue))) return null;
  return positions.reduce((s, p) => s + p.currentValue!, 0);
}
export function dividendLine(symbol: string, positions: Position[], rule: DividendInput, fx: number | null, rates: Record<string, number> = {}): IncomeLine {
  const eligible = positions.filter(p => p.isBuy && p.leverage === 1 && p.isCFD !== true && p.assetClass !== 'cfd');
  const units = eligible.reduce((s, p) => s + p.units, 0);
  const annual = !eligible.length ? 0 : validNumber(rule.annualPerShare) && eligible.every(p => validNumber(p.units)) && rule.source.trim() && rule.asOf
    ? euros(units * rule.annualPerShare, rule.currency, fx, rates) : null;
  return { id: `dividend:${symbol}`, label: symbol, kind: 'dividend', capitalEur: euros(positionCapital(eligible), 'USD', fx),
    annualGross: annual, annualNet: netIncome(annual, rule.taxPct), source: rule.source, asOf: rule.asOf,
    reason: !eligible.length ? 'Nessuna posizione long senza leva eleggibile; CFD esclusi' : annual === null ? 'Completa dividendo annuo per quota, valuta, fonte e data' : 'Stima annua sulle quote attuali; distribuzioni e possesso futuro possono cambiare', };
}
export function interestLine(id: string, label: string, balance: number | null, currency: string, rule: YieldInput, fx: number | null, today: string, kind: IncomeKind = 'interest'): IncomeLine {
  let annual: number | null = null;
  let reason = 'Completa saldo, tasso, attivazione, fonte e data';
  const capital = euros(balance, currency, fx);
  if (rule.active === 'inactive') { annual = 0; reason = 'Remunerazione disattivata (dichiarazione utente)'; }
  else if (rule.validUntil && rule.validUntil < today) reason = 'Tasso scaduto: aggiorna le condizioni';
  else if (rule.asOf > today) reason = 'La data del tasso è futura';
  else if (rule.active === 'active' && validNumber(balance) && validNumber(rule.rate) && rule.rate <= 100 && rule.source.trim() && rule.asOf) {
    const eligible = balance < rule.minimum ? 0 : Math.min(balance, rule.cap ?? balance);
    annual = euros(eligible * payoutRate(rule.rate, rule.rateType), currency, fx);
    reason = balance < rule.minimum ? 'Saldo inferiore alla soglia remunerata' : 'Saldo e tasso costanti, prelievo mensile degli interessi; proiezione a 12 mesi';
  }
  return { id, label, kind, capitalEur: capital, annualGross: annual, annualNet: netIncome(annual, rule.taxPct, euros(rule.annualFees, currency, fx) ?? Number.NaN), reason, source: rule.source, asOf: rule.asOf };
}
export function stakingLine(symbol: string, positions: Position[], rule: StakingInput, fx: number | null, today: string): IncomeLine {
  const eligible = positions.filter(p => p.isBuy && p.leverage === 1 && p.isCFD !== true && p.assetClass === 'crypto');
  const value = positionCapital(eligible);
  const capital = euros(value, 'USD', fx);
  const share = rule.rateBasis === 'provider' ? 1 : percent(rule.sharePct) ? rule.sharePct / 100 : null;
  const rate = percent(rule.rate) && share !== null ? payoutRate(rule.rate, rule.rateType) * share : null;
  const potential = capital !== null && rate !== null ? capital * rate : null;
  let annual: number | null = null;
  let reason = 'Verifica attivazione, idoneità, data inizio premi, fonte e tasso';
  if (!STAKING_SYMBOLS.includes(symbol) || !eligible.length) { annual = 0; reason = 'Asset o posizione non supportati dalle regole registrate'; }
  else if (rule.active === 'inactive') { annual = 0; reason = 'Staking non attivo (dichiarazione utente)'; }
  else if (rule.validUntil && rule.validUntil < today) reason = 'Tasso scaduto: aggiorna le condizioni';
  else if (rule.active === 'active' && rule.eligible && rule.eligibleFrom && rule.source.trim() && rule.asOf && rule.asOf <= today && potential !== null) {
    if (rule.eligibleFrom > today) { annual = 0; reason = `In attesa: premi dal ${rule.eligibleFrom}`; }
    else if (value !== null && rate !== null && value * rate / 12 <= rule.minimumRewardUsd) { annual = 0; reason = 'Premio mensile stimato sotto o alla soglia: accredito non conteggiato'; }
    else { annual = potential; reason = 'Reward stimata in token, valorizzata ai prezzi attuali; non è liquidità EUR'; }
  }
  return { id: `staking:${symbol}`, label: symbol, kind: 'staking', capitalEur: capital, annualGross: annual,
    annualNet: netIncome(annual, rule.taxPct, euros(rule.annualFees, 'USD', fx) ?? Number.NaN), potentialGross: potential,
    thresholdCapitalEur: rate && rate > 0 ? euros(rule.minimumRewardUsd * 12 / rate, 'USD', fx) : null,
    reason, source: rule.source, asOf: rule.asOf };
}
export function summarize(lines: IncomeLine[], basis: 'gross' | 'net') {
  const values = lines.map(l => basis === 'gross' ? l.annualGross : l.annualNet);
  const known = values.filter((n): n is number => n !== null && Number.isFinite(n));
  return { monthly: known.length ? known.reduce((s, n) => s + n, 0) / 12 : null, missing: values.length - known.length, count: known.length };
}
export interface Allocation { kind: IncomeKind; weight: number; rate: number | null; taxPct: number | null; }
export function scenario(target: number, capital: number, reserve: number, additional: number, allocations: Allocation[], basis: 'gross' | 'net') {
  const errors: string[] = [];
  if (![target, capital, reserve, additional].every(validNumber)) errors.push('Importi non validi');
  if (reserve > capital + additional) errors.push('La riserva supera il capitale disponibile');
  if (allocations.some(a => !percent(a.weight)) || Math.abs(allocations.reduce((s, a) => s + a.weight, 0) - 100) > 0.001) errors.push('Le percentuali del capitale devono sommare 100%');
  if (allocations.some(a => a.weight > 0 && (!percent(a.rate) || (basis === 'net' && !percent(a.taxPct))))) errors.push('Completa rendimenti e ipotesi fiscali delle quote attive');
  const rates = allocations.map(a => a.weight === 0 ? 0 : (a.rate ?? 0) / 100 * (basis === 'net' ? 1 - (a.taxPct ?? 0) / 100 : 1));
  const weightedRate = allocations.reduce((s, a, i) => s + a.weight / 100 * rates[i], 0);
  const available = Math.max(0, capital + additional - reserve);
  const required = errors.length || weightedRate <= 0 ? null : target * 12 / weightedRate;
  const breakdown = allocations.map((a, i) => ({ kind: a.kind, capital: available * a.weight / 100, monthly: available * a.weight / 100 * rates[i] / 12, requiredCapital: required === null ? null : required * a.weight / 100 }));
  const stressRate = allocations.reduce((s, a, i) => s + a.weight / 100 * (a.kind === 'interest' ? Math.max(0, (a.rate ?? 0) - 1) / 100 * (basis === 'net' ? 1 - (a.taxPct ?? 0) / 100 : 1) : rates[i] * (a.kind === 'staking' ? 0.6 * 0.7 : 0.7)), 0);
  return { errors, available, weightedRate, required, additionalRequired: required === null ? null : Math.max(0, required - available), monthly: errors.length ? null : available * weightedRate / 12, stressMonthly: errors.length ? null : available * stressRate / 12, breakdown };
}

// Ledger: decimal strings -> integer micro-units. Round only once per EUR event.
const SCALE = 100000000n;
export function decimal(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(value)) throw new Error('Importo non valido: usa il punto decimale, massimo 8 cifre decimali');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
  return negative ? -result : result;
}
export interface IncomeEvent {
  id: string; account: string; kind: IncomeKind; status: 'paid' | 'accrued' | 'declared';
  date: string; currency: 'EUR' | 'USD'; gross: string; withholding: string; fees: string; fx: string; source: string;
}
export function eventCents(event: IncomeEvent): number {
  const net = decimal(event.gross) - decimal(event.withholding) - decimal(event.fees);
  const fx = event.currency === 'EUR' ? SCALE : decimal(event.fx);
  if (fx <= 0n) throw new Error('Cambio storico EUR/USD mancante o non valido');
  const numerator = net * 100n;
  const abs = numerator < 0n ? -numerator : numerator;
  const cents = (abs + fx / 2n) / fx * (numerator < 0n ? -1n : 1n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Importo troppo grande');
  return Number(cents);
}
export function validateEvent(raw: Record<string, string>): IncomeEvent {
  if (!raw.id?.trim() || !raw.account?.trim() || !raw.source?.trim()) throw new Error('ID, conto e fonte sono obbligatori');
  if (!['dividend', 'interest', 'staking', 'other'].includes(raw.kind)) throw new Error('Tipo rendita non valido');
  if (!['paid', 'accrued', 'declared'].includes(raw.status)) throw new Error('Stato non valido');
  if (!['EUR', 'USD'].includes(raw.currency)) throw new Error('Il registro cash accetta EUR/USD. Le reward in token restano separate.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date) || !Number.isFinite(Date.parse(raw.date)) || new Date(raw.date).toISOString().slice(0, 10) !== raw.date) throw new Error('Data non valida');
  if (raw.kind === 'staking') throw new Error('Importa come other solo la vendita della reward: lo staking in token non è incasso cash');
  const event: IncomeEvent = { id: raw.id.trim(), account: raw.account.trim(), kind: raw.kind as IncomeKind, status: raw.status as IncomeEvent['status'], date: raw.date, currency: raw.currency as 'EUR' | 'USD', gross: raw.gross, withholding: raw.withholding || '0', fees: raw.fees || '0', fx: raw.fx || '', source: raw.source.trim() };
  eventCents(event);
  if (decimal(event.withholding) < 0n || decimal(event.fees) < 0n) throw new Error('Ritenute e costi devono essere positivi; usa lordo negativo per uno storno');
  return event;
}
export function mergeEvents(existing: IncomeEvent[], incoming: IncomeEvent[]): IncomeEvent[] {
  const map = new Map(existing.map(e => [JSON.stringify([e.account, e.id]), e]));
  for (const e of incoming) {
    const key = JSON.stringify([e.account, e.id]);
    const old = map.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(e)) throw new Error(`Conflitto per ${e.id}: registra una rettifica con nuovo ID`);
    map.set(key, e);
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}
