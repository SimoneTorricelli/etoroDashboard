export interface DeclaredDividend {
  symbol: string;
  exDate: string;
  paymentDate?: string;
  recordDate?: string;
  amountPerShare: number;
  currency: string;
}

const CACHE_KEY = 'torino.declared-dividends.v1';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseRows(data: unknown, symbols: Set<string>): DeclaredDividend[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const symbol = String(row.symbol ?? row.Symbol ?? '').toUpperCase();
    const exDate = String(row.date ?? row.exDividendDate ?? row.exDate ?? '');
    const amountPerShare = Number(row.dividend ?? row.adjDividend ?? row.amount ?? 0);
    if (!symbols.has(symbol) || !/^\d{4}-\d{2}-\d{2}/.test(exDate) || !(amountPerShare > 0)) return [];
    return [{
      symbol,
      exDate: exDate.slice(0, 10),
      paymentDate: String(row.paymentDate ?? row.payDate ?? '') || undefined,
      recordDate: String(row.recordDate ?? '') || undefined,
      amountPerShare,
      currency: String(row.currency ?? 'USD').toUpperCase(),
    }];
  }).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

export function loadDeclaredDividends(symbols: string[]): DeclaredDividend[] {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { savedAt?: number; symbols?: string[]; rows?: DeclaredDividend[] } | null;
    if (!cached?.savedAt || Date.now() - cached.savedAt > CACHE_TTL_MS) return [];
    const wanted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
    return (cached.rows ?? []).filter((row) => wanted.has(row.symbol));
  } catch {
    return [];
  }
}

export async function fetchDeclaredDividends(apiKey: string, symbols: string[], signal?: AbortSignal): Promise<DeclaredDividend[]> {
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (!apiKey.trim() || normalized.length === 0) return [];
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 365);
  const url = new URL('https://financialmodelingprep.com/stable/dividends-calendar');
  url.searchParams.set('from', isoDate(from));
  url.searchParams.set('to', isoDate(to));
  url.searchParams.set('apikey', apiKey.trim());
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Calendario dividendi non disponibile (HTTP ${response.status}).`);
  const data = await response.json() as unknown;
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const message = String(record['Error Message'] ?? record.message ?? '');
    if (message) throw new Error(message);
  }
  const rows = parseRows(data, new Set(normalized));
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), symbols: normalized, rows })); } catch { /* cache best effort */ }
  return rows;
}
