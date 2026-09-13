import type { LiveSettings } from '../settings';
export interface IncomeDividend {
  symbol: string; exDate: string; paymentDate: string | null; amountPerShare: number;
  annualPerShare: number | null; currency: string | null;
}
export interface CalendarResult { rows: IncomeDividend[]; asOf: number; source: string; note: string; coverage: string; }
export interface AutomaticDividend {
  symbol: string; annualPerShare: number; currency: string; status: 'available' | 'no_history';
  source: string; provider: string; asOf: number; sourceUpdatedAt: string | null;
  frequency: string | null; method: string; rows: IncomeDividend[];
}
export interface ReferenceFx { rates: Record<string, number>; date: string; source: string; asOf: number; }
export interface DividendLookup { loading: boolean; data: AutomaticDividend | null; error: string; }
function validReference(data: AutomaticDividend | null, symbol: string): data is AutomaticDividend {
  return !!data && data.symbol === symbol && Number.isFinite(data.annualPerShare) && data.annualPerShare >= 0
    && /^[A-Z]{3}$/.test(data.currency) && Array.isArray(data.rows) && Number.isFinite(data.asOf)
    && data.asOf <= Date.now() + 300000 && Date.now() - data.asOf < TTL
    && ['available', 'no_history'].includes(data.status) && typeof data.source === 'string'
    && ['https://stockanalysis.com/', 'https://www.ishares.com/', 'https://www.invesco.com/'].some(host => data.source.startsWith(host));
}
function referenceBase(settings: LiveSettings) {
  return (import.meta.env?.DEV ? window.location.origin : settings.proxyUrl || window.location.origin).replace(/\/+$/, '');
}
async function referenceJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Il collegamento automatico richiede il Worker aggiornato.');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Fonte non disponibile (${response.status})`);
  return body;
}
export async function fetchReferenceFx(settings: LiveSettings, signal: AbortSignal): Promise<ReferenceFx> {
  const body = await referenceJson(`${referenceBase(settings)}/api/income/fx`, signal);
  if (!body.rates || !(body.rates.USD > 0) || typeof body.date !== 'string') throw new Error('Cambi automatici non disponibili');
  return body;
}
export async function fetchAutomaticDividends(
  instruments: { symbol: string; kind: 'stock' | 'etf' }[], settings: LiveSettings, signal: AbortSignal,
  onResult: (symbol: string, result: DividendLookup) => void, force = false,
) {
  const queue = [...new Map(instruments.map(i => [i.symbol, i])).values()];
  // Two requests at a time; all held symbols are covered, with no silent 30-symbol cut.
  async function consume() {
    while (queue.length && !signal.aborted) {
      const item = queue.shift()!;
      const key = `torino.income.reference.v2:${item.kind}:${item.symbol}`;
      try {
        let data: AutomaticDividend | null = null;
        if (!force) try {
          const c = JSON.parse(localStorage.getItem(key) || 'null');
          if (validReference(c, item.symbol)) data = c;
        } catch { /* Optional public cache. */ }
        if (!data) {
          const query = new URLSearchParams({ symbol: item.symbol, kind: item.kind });
          data = await referenceJson(`${referenceBase(settings)}/api/income/dividend?${query}`, signal);
        }
        if (!validReference(data, item.symbol)) throw new Error('Dati automatici non coerenti o non aggiornati');
        try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* Optional public cache. */ }
        if (!signal.aborted) onResult(item.symbol, { data, loading: false, error: '' });
      } catch (error) {
        if (!signal.aborted) onResult(item.symbol, { data: null, loading: false, error: error instanceof Error ? error.message : 'Recupero temporaneamente non disponibile' });
      }
    }
  }
  await Promise.all([consume(), consume()]);
}
const TTL = 12 * 3600000;
function cacheRead(key: string): CalendarResult | null {
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); return c && Array.isArray(c.rows) && typeof c.asOf === 'number' && Date.now() - c.asOf < TTL ? c : null; } catch { return null; }
}
function cacheWrite(key: string, value: CalendarResult) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Public reference cache is optional. */ } }
export async function fetchIncomeCalendar(settings: LiveSettings, signal: AbortSignal): Promise<CalendarResult> {
  const response = await fetch(`${settings.proxyUrl.replace(/\/+$/, '')}/api/income/calendar`, { signal });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Pubblica il Worker aggiornato per collegare il calendario gratuito');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  if (!Array.isArray(body.rows) || typeof body.asOf !== 'number') throw new Error('Formato calendario non valido');
  return body;
}
export async function fetchFmpIncome(symbols: string[], apiKey: string, signal: AbortSignal, force = false): Promise<CalendarResult> {
  const cacheKey = `torino.income.fmp.v1:${[...new Set(symbols)].sort().join(',')}`;
  const cached = !force ? cacheRead(cacheKey) : null;
  if (cached) return cached;
  const rows: IncomeDividend[] = [];
  const errors: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  for (const symbol of [...new Set(symbols)].slice(0, 30)) {
    const url = new URL('https://financialmodelingprep.com/stable/dividends');
    url.searchParams.set('symbol', symbol); url.searchParams.set('apikey', apiKey);
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('Dati non disponibili per il piano FMP');
      const validAmount = (n: unknown) => n !== null && n !== '' && (typeof n === 'number' || typeof n === 'string') && Number.isFinite(Number(n)) && Number(n) >= 0;
      const candidates = body.filter((r: Record<string, unknown>) => r && r.symbol === symbol && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && validAmount(r.dividend));
      const unique = new Map();
      for (const item of candidates) {
        const key = `${item.symbol}:${item.date}`;
        if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(item)) throw new Error('Eventi dividendo in conflitto: verifica la fonte');
        unique.set(key, item);
      }
      const items = [...unique.values()];
      const historical = items.filter(r => r.date >= cutoff.toISOString().slice(0, 10) && r.date <= today);
      // No returned history means unknown, never zero. Do not annualize a single payment.
      const annual = historical.length ? historical.reduce((s, r) => s + Number(validAmount(r.adjDividend) ? r.adjDividend : r.dividend), 0) : null;
      for (const item of items) rows.push({ symbol, exDate: item.date, paymentDate: item.paymentDate || null, amountPerShare: Number(item.dividend), annualPerShare: annual, currency: typeof item.currency === 'string' ? item.currency.toUpperCase() : null });
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(`${symbol}: ${error instanceof Error ? error.message : 'non disponibile'}`);
    }
  }
  const result = { rows, asOf: Date.now(), source: 'https://financialmodelingprep.com/stable/dividends', coverage: 'partial', note: `Dividendo trailing: somma degli eventi restituiti negli ultimi 12 mesi (rettificati per split quando disponibili), non previsione garantita. ${symbols.length > 30 ? 'Limite 30 simboli per aggiornamento. ' : ''}${errors.join('; ')}` };
  if (rows.length && !errors.length) cacheWrite(cacheKey, result);
  return result;
}
