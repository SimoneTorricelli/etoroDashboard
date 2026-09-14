/** Cash-flow reconciliation for the USD trading account, never the open-position cost basis. */
export interface ProfitYear {
  through: string;
  deposits: number;
  withdrawals: number;
  /** Other external capital entering (+) or leaving (-), e.g. transferred securities. */
  adjustments: number;
  equity: number;
  unrealized: number | null;
  source: string;
}

export interface ProfitHistory {
  version: 1;
  startYear: number;
  sinceInception: boolean;
  openingEquity: number;
  openingUnrealized: number | null;
  years: ProfitYear[];
}

export interface ProfitPoint extends ProfitYear {
  year: number;
  annualProfit: number;
  cumulativeProfit: number;
  realizedProfit: number | null;
  totalDeposits: number;
  totalWithdrawals: number;
  totalAdjustments: number;
}

export function emptyProfitHistory(today = new Date().toISOString().slice(0, 10)): ProfitHistory {
  return { version: 1, startYear: Number(today.slice(0, 4)), sinceInception: false, openingEquity: 0, openingUnrealized: null, years: [] };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const nonnegative = (value: unknown) => finite(value) && value >= 0;
const optionalNumber = (value: unknown) => value === null || finite(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Also validates imported/local data; missing cash flows must not silently become zero. */
export function validateProfitHistory(value: unknown, today = new Date().toISOString().slice(0, 10)): string[] {
  if (!value || typeof value !== 'object') return ['Formato dello storico non valido.'];
  const h = value as ProfitHistory;
  const errors: string[] = [];
  if (h.version !== 1 || typeof h.sinceInception !== 'boolean' || !Number.isInteger(h.startYear) || h.startYear < 1900 || h.startYear > Number(today.slice(0, 4))) errors.push('Anno iniziale o formato non valido.');
  if (!nonnegative(h.openingEquity) || !optionalNumber(h.openingUnrealized)) errors.push('Controlla il valore iniziale e il P&L aperto iniziale.');
  if (h.sinceInception && (h.openingEquity !== 0 || h.openingUnrealized !== 0)) errors.push('Dall’apertura del conto, il valore iniziale e il P&L iniziale devono essere zero.');
  if (!Array.isArray(h.years) || h.years.length > 200) return [...errors, 'Elenco degli anni non valido.'];
  let expectedYear = h.startYear;
  const rows = [...h.years].sort((a, b) => String(a?.through).localeCompare(String(b?.through)));
  rows.forEach((row, index) => {
    if (!row || !validDate(row.through)) { errors.push(`Riepilogo ${index + 1}: data non valida.`); return; }
    const year = Number(row.through.slice(0, 4));
    if (year !== expectedYear) errors.push(`Serve un solo riepilogo per ogni anno, senza buchi: atteso ${expectedYear}.`);
    expectedYear = year + 1;
    if (row.through > today) errors.push(`${year}: la data non può essere futura.`);
    if (index < rows.length - 1 && !row.through.endsWith('-12-31')) errors.push(`${year}: completa l’anno al 31 dicembre prima di aggiungere il successivo.`);
    if (!nonnegative(row.deposits) || !nonnegative(row.withdrawals) || !finite(row.adjustments) || !nonnegative(row.equity) || !optionalNumber(row.unrealized)) errors.push(`${year}: inserisci importi validi; versamenti, prelievi e valore conto non possono essere negativi.`);
    if (typeof row.source !== 'string' || !row.source.trim() || row.source.length > 500) errors.push(`${year}: indica la fonte dei dati (massimo 500 caratteri).`);
  });
  return [...new Set(errors)];
}

export function calculateLifetimeProfit(history: ProfitHistory, today?: string): ProfitPoint[] {
  const errors = validateProfitHistory(history, today);
  if (errors.length) throw new Error(errors.join(' '));
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalAdjustments = 0;
  let previousEquity = history.openingEquity;
  return [...history.years].sort((a, b) => a.through.localeCompare(b.through)).map(row => {
    totalDeposits += row.deposits;
    totalWithdrawals += row.withdrawals;
    totalAdjustments += row.adjustments;
    const cumulativeProfit = row.equity - history.openingEquity + totalWithdrawals - totalDeposits - totalAdjustments;
    const annualProfit = row.equity - previousEquity + row.withdrawals - row.deposits - row.adjustments;
    previousEquity = row.equity;
    return {
      ...row, year: Number(row.through.slice(0, 4)), annualProfit, cumulativeProfit,
      realizedProfit: row.unrealized !== null && history.openingUnrealized !== null
        ? cumulativeProfit - row.unrealized + history.openingUnrealized : null,
      totalDeposits, totalWithdrawals, totalAdjustments,
    };
  });
}

/** Accept comma decimals and explicit Italian/English thousands grouping; reject ambiguous groups. */
export function parseProfitAmount(raw: string): number {
  const text = raw.trim().replace(/[$\s]/g, '');
  let normalized = text;
  if (/^[+-]?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(text)) normalized = text.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d{1,3}(,\d{3})+\.\d{1,2}$/.test(text)) normalized = text.replace(/,/g, '');
  else if (/^[+-]?\d+(?:[.,]\d{1,2})?$/.test(text)) normalized = text.replace(',', '.');
  else return NaN;
  const value = Number(normalized);
  return finite(value) ? value : NaN;
}
