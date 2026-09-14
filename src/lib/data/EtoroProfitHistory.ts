/** Automatic, read-only retrieval. Cash account transactions are NOT the trading ledger. */
export interface ProfitTrade {
  id: string;
  positionId: string;
  closedAt: string;
  profit: number;
  copy: boolean;
}
export interface AutomaticProfitHistory {
  version: 2;
  trades: ProfitTrade[];
  from: string;
  through: string;
  asOf: number;
  rangeLimited: boolean;
  openPnl?: number | null;
  openPnlAsOf?: number;
}
export type ProfitRequest = (path: string, signal?: AbortSignal) => Promise<unknown>;
const FULL_HISTORY_FROM = '2000-01-01';
const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pick = (row: Record<string, unknown>, ...keys: string[]) => keys.map(key => row[key]).find(value => value !== undefined && value !== null);

/** Sum only open positions, never mirrors.closedPositionsNetProfit or account P&L. */
export function parseOpenProfit(body: unknown): number | null {
  const envelope = record(body);
  const account = record(pick(envelope, 'clientPortfolio', 'ClientPortfolio', 'portfolio', 'Portfolio') ?? envelope);
  const manual = pick(account, 'positions', 'Positions');
  const mirrors = pick(account, 'mirrors', 'Mirrors', 'copyPortfolios', 'CopyPortfolios');
  if (!Array.isArray(manual) || !Array.isArray(mirrors)) return null;
  const positions = [...manual];
  for (const mirror of mirrors) {
    const copied = pick(record(mirror), 'positions', 'Positions');
    if (!Array.isArray(copied)) return null;
    positions.push(...copied);
  }
  let total = 0;
  const seen = new Map<string, number>();
  for (const position of positions) {
    const row = record(position);
    const unrealized = pick(row, 'unrealizedPnL', 'UnrealizedPnL', 'unrealizedPnl');
    const value = pick(record(unrealized), 'pnL', 'PnL', 'pnl') ?? (typeof unrealized === 'number' ? unrealized : undefined) ?? pick(row, 'pnL', 'PnL', 'pnl', 'netProfit');
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const id = pick(row, 'positionId', 'PositionId', 'PositionID');
    if (id != null) {
      const key = String(id);
      if (seen.has(key)) { if (seen.get(key) !== value) return null; continue; }
      seen.set(key, value);
    }
    total += value;
  }
  return total;
}

export function profitByMonth(history: AutomaticProfitHistory) {
  if (!history.trades.length) return [];
  const sums = new Map<string, number>();
  for (const trade of history.trades) {
    const month = trade.closedAt.slice(0, 7);
    sums.set(month, (sums.get(month) ?? 0) + trade.profit);
  }
  const cursor = new Date(`${[...sums.keys()].sort()[0]}-01T00:00:00Z`);
  const result: Array<{ label: string; cumulative: number }> = [];
  let cumulative = 0;
  while (cursor.toISOString().slice(0, 7) <= history.through.slice(0, 7)) {
    const label = cursor.toISOString().slice(0, 7);
    cumulative += sums.get(label) ?? 0;
    result.push({ label, cumulative });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

export function parseProfitTrades(body: unknown, now: number): { trades: ProfitTrade[]; rowCount: number } {
  const envelope = record(body);
  const rows = Array.isArray(body) ? body : pick(envelope, 'items', 'Items', 'trades', 'Trades');
  if (!Array.isArray(rows)) throw new Error('eToro ha restituito uno storico non riconosciuto. Il profitto non è stato calcolato.');
  const trades = rows.map((value): ProfitTrade => {
    const row = record(value);
    const position = pick(row, 'positionId', 'PositionId', 'PositionID');
    const rawProfit = pick(row, 'netProfit', 'NetProfit');
    const timestamp = pick(row, 'closeTimestamp', 'CloseTimestamp');
    const profit = typeof rawProfit === 'number' || typeof rawProfit === 'string' && rawProfit.trim() ? Number(rawProfit) : NaN;
    const closed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if ((typeof position !== 'number' && typeof position !== 'string') || !String(position).trim() || !Number.isFinite(profit) || !Number.isFinite(closed) || closed > now + 60_000) {
      throw new Error('Operazione eToro priva di identificativo, data o profitto valido. Sincronizzazione interrotta per evitare un totale errato.');
    }
    const closedAt = new Date(closed).toISOString();
    // A position may be closed in several portions; do not collapse partial closes.
    const id = JSON.stringify([String(position), closedAt, String(pick(row, 'orderId', 'OrderId') ?? ''), String(pick(row, 'units', 'Units') ?? '')]);
    return { id, positionId: String(position), closedAt, profit, copy: Number(pick(row, 'socialTradeId', 'SocialTradeId', 'mirrorId', 'MirrorId') ?? 0) > 0 };
  });
  return { trades, rowCount: rows.length };
}

function rangeError(error: unknown): boolean {
  // Do not turn authorization, quota or network failures into an apparently successful short history.
  return error instanceof Error && /(?:\b400\b|\b422\b)/.test(error.message) && /date|range|period|year|giorn|anno|365|364/i.test(error.message);
}

export async function fetchEtoroProfitHistory(request: ProfitRequest, signal?: AbortSignal, now = Date.now(), onProgress?: (count: number, pages: number) => void, startFrom = FULL_HISTORY_FROM): Promise<AutomaticProfitHistory> {
  const through = new Date(now).toISOString().slice(0, 10);
  let from = startFrom;
  let rangeLimited = false;
  const trades = new Map<string, ProfitTrade>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    signal?.throwIfAborted();
    let body: unknown;
    try {
      body = await request(`api/v1/trading/info/trade/history?minDate=${from}&page=${page}&pageSize=${PAGE_SIZE}`, signal);
    } catch (error) {
      if (page !== 1 || rangeLimited || !rangeError(error)) throw error;
      from = new Date(now - 364 * 86_400_000).toISOString().slice(0, 10);
      rangeLimited = true;
      body = await request(`api/v1/trading/info/trade/history?minDate=${from}&page=1&pageSize=${PAGE_SIZE}`, signal);
    }
    signal?.throwIfAborted();
    const parsed = parseProfitTrades(body, now);
    let added = 0;
    for (const trade of parsed.trades) {
      const previous = trades.get(trade.id);
      if (previous && (previous.profit !== trade.profit || previous.copy !== trade.copy)) throw new Error('Lo storico eToro è cambiato durante la lettura. Riprova la sincronizzazione.');
      if (!previous) { trades.set(trade.id, trade); added += 1; }
    }
    onProgress?.(trades.size, page);
    // Some broker deployments cap pageSize silently. Only an empty page proves
    // exhaustion; a short page must not hide the rest of the account's history.
    if (parsed.rowCount === 0) return { version: 2, trades: [...trades.values()].sort((a, b) => a.closedAt.localeCompare(b.closedAt)), from, through, asOf: now, rangeLimited };
    if (!added) throw new Error('eToro ripete la stessa pagina dello storico. Il totale incompleto non viene pubblicato.');
  }
  throw new Error('Lo storico supera il limite di sincronizzazione. Il totale incompleto non viene pubblicato.');
}

/** Replace the re-read interval, so corrections/removals do not accumulate duplicates. */
export function mergeProfitHistory(previous: AutomaticProfitHistory, next: AutomaticProfitHistory): AutomaticProfitHistory {
  if (next.from > previous.through || next.through < previous.through) throw new Error('Intervallo di aggiornamento non continuo. Serve una nuova sincronizzazione completa.');
  const trades = [...previous.trades.filter(trade => trade.closedAt.slice(0, 10) < next.from), ...next.trades.filter(trade => trade.closedAt.slice(0, 10) >= next.from)];
  return { ...next, from: previous.from < next.from ? previous.from : next.from, rangeLimited: next.from <= previous.from ? next.rangeLimited : previous.rangeLimited, trades: trades.sort((a, b) => a.closedAt.localeCompare(b.closedAt)) };
}

export function profitByYear(history: AutomaticProfitHistory) {
  const years = new Map<number, { year: number; profit: number; manual: number; copy: number; count: number; cumulative: number }>();
  for (const trade of history.trades) {
    const year = Number(trade.closedAt.slice(0, 4));
    const entry = years.get(year) ?? { year, profit: 0, manual: 0, copy: 0, count: 0, cumulative: 0 };
    entry.profit += trade.profit; entry[trade.copy ? 'copy' : 'manual'] += trade.profit; entry.count += 1;
    years.set(year, entry);
  }
  if (years.size) {
    const first = Math.min(...years.keys());
    for (let year = first; year <= Number(history.through.slice(0, 4)); year += 1) {
      if (!years.has(year)) years.set(year, { year, profit: 0, manual: 0, copy: 0, count: 0, cumulative: 0 });
    }
  }
  let cumulative = 0;
  return [...years.values()].sort((a, b) => a.year - b.year).map(entry => ({ ...entry, cumulative: cumulative += entry.profit }));
}
