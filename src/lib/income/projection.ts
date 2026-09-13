export interface ProjectionInput {
  capital: number; reserve: number; additional: number; monthlyContribution: number;
  annualRate: number; reinvestPct: number; months: number; targetMonthly: number;
}
export interface ProjectionPoint {
  month: number; capital: number; contributions: number; earned: number; withdrawn: number;
  reinvested: number; monthlyIncome: number; prudent: number;
  contributionForTarget: number | null;
}
/** Nominal distributable annual rate. Contributions arrive at month end.
 * Price appreciation is zero; no double counting of withdrawn income. */
export function projectIncome(input: ProjectionInput) {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) errors.push(`Valore non valido: ${key}`);
  }
  if (input.annualRate > 100 || input.reinvestPct > 100) errors.push('Percentuali fuori intervallo');
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 600) errors.push('Orizzonte non valido');
  if (input.reserve > input.capital + input.additional) errors.push('La riserva supera il capitale disponibile');
  if (errors.length) return { errors, points: [] as ProjectionPoint[], targetMonth: null as number | null };
  const { reserve, monthlyContribution, annualRate, reinvestPct, targetMonthly } = input;
  const initial = input.capital + input.additional;
  let invested = initial - reserve, prudent = invested, earned = 0, withdrawn = 0, reinvested = 0;
  let targetMonth = invested * annualRate / 1200 >= targetMonthly ? 0 : null;
  const points: ProjectionPoint[] = [];
  for (let month = 0; month <= input.months; month++) {
    if (month) {
      const income = invested * annualRate / 1200;
      earned += income; reinvested += income * reinvestPct / 100; withdrawn += income * (1 - reinvestPct / 100);
      invested += income * reinvestPct / 100 + monthlyContribution;
      prudent += prudent * annualRate * 0.7 / 1200 * reinvestPct / 100 + monthlyContribution;
    }
    const compoundRate = annualRate / 1200 * reinvestPct / 100;
    const growthDelta = Math.expm1(month * Math.log1p(compoundRate));
    const growth = 1 + growthDelta;
    const annuity = compoundRate ? growthDelta / compoundRate : month;
    const targetCapital = targetMonthly === 0 ? 0 : annualRate > 0 ? targetMonthly * 1200 / annualRate : null;
    const gap = targetCapital === null ? null : Math.max(0, targetCapital - (initial - reserve) * growth);
    const contributionForTarget = gap === 0 ? 0 : gap !== null && annuity > 0 ? gap / annuity : null;
    const point = { month, capital: invested + reserve, contributions: initial + monthlyContribution * month,
      earned, withdrawn, reinvested, monthlyIncome: invested * annualRate / 1200, prudent: prudent + reserve, contributionForTarget };
    if (targetMonth === null && point.monthlyIncome >= targetMonthly) targetMonth = month;
    points.push(point);
  }
  return { errors, points, targetMonth };
}
