/** Public market references. Fixed hosts, no credentials, no arbitrary URLs. */
import { fundReference, parseFundReference } from './income-funds.js';
const TTL = 12 * 3600;
const FX_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const MARKETS = { MI: 'bit', DE: 'etr', L: 'lon', PA: 'epa', MC: 'bme', AS: 'ams', NV: 'ams', T: 'tyo', BR: 'ebr', LS: 'eli', ST: 'sto', CO: 'cph', HE: 'hel', OL: 'osl', SW: 'swx', HK: 'hkg', TO: 'tsx', AX: 'asx' };
export function dividendReference(symbol, kind = 'stock') {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,24}$/.test(symbol) || !['stock', 'etf'].includes(kind)) throw new Error('Strumento non valido');
  // eToro's US suffix names the same US listing, not a foreign-market ADR.
  if (symbol.endsWith('.US')) {
    const ticker = symbol.slice(0, -3);
    if (!/^[A-Z0-9][A-Z0-9-]*(?:\.[AB])?$/.test(ticker)) throw new Error('Ticker USA non valido');
    return dividendReference(ticker, kind);
  }
  const suffix = symbol.split('.').at(-1);
  const exchange = MARKETS[suffix];
  if (exchange) {
    const ticker = symbol.slice(0, -(suffix.length + 1));
    if (!ticker) throw new Error('Ticker non valido');
    return { url: `https://stockanalysis.com/quote/${exchange}/${ticker}/dividend/`, ticker, exchange };
  }
  // Dot share classes, e.g. BRK.B, are preserved. Unknown exchange suffixes
  // cannot silently become a US listing with the same base ticker.
  if (symbol.includes('.') && !/\.[AB]$/.test(symbol)) throw new Error('Mercato non ancora coperto dal collegamento automatico');
  return { url: `https://stockanalysis.com/${kind === 'etf' ? 'etf' : 'stocks'}/${symbol.toLowerCase().replace('.', '-')}/dividend/`, ticker: symbol, exchange: null };
}
function stringField(block, name) {
  const match = block.match(new RegExp(`(?:^|[,{])\\s*${name}:((?:"(?:[^"\\\\]|\\\\.)*"))`));
  return match ? JSON.parse(match[1]) : null;
}
function amount(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(?:[A-Z]{2,3}\s*|[$€£¥])?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)(?:\s+[A-Z]{3})?$/);
  const result = match ? Number(match[1].replaceAll(',', '')) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : null;
}
/** Read narrowly scoped structured fields; never execute the page's JavaScript. */
function referenceInfo(html, reference) {
  const info = html.match(/data:\{info:\{([\s\S]{1,12000}?)\}\},uses:/)?.[1];
  const ticker = info && (stringField(info, 'ticker') || (reference.exchange ? stringField(info, 'symbol') : null));
  const sameTicker = ticker?.toUpperCase().replace('-', '.') === reference.ticker.toUpperCase().replace('-', '.');
  if (!sameTicker) throw new Error('Identità del titolo non confermata dalla fonte');
  if (reference.exchange && stringField(info, 'exchange_code')?.toLowerCase() !== reference.exchange) throw new Error('Mercato del titolo non confermato');
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1];
  if (canonical !== reference.url) throw new Error('La fonte ha restituito una quotazione diversa');
  return info;
}
export function parseDividendReference(html, symbol, reference, now = Date.now()) {
  const info = referenceInfo(html, reference);
  const currencies = info.match(/curr:\{([^}]+)\}/)?.[1] ?? '';
  const table = html.match(/infoTable:\{([^}]{1,3000})\}/)?.[1];
  if (!table) throw new Error('Struttura della fonte cambiata');
  // US ETF pages omit curr. Require the US market, visible USD designation
  // and dollar-denominated distribution; a bare dollar sign is insufficient.
  const usEtfUsd = !reference.exchange && /\/etf\//.test(reference.url)
    && ['NYSEARCA', 'NASDAQ', 'NYSE'].includes(stringField(info, 'exchange'))
    && />\s*(?:NYSEARCA|NASDAQ|NYSE):[^<]*· USD\s*</.test(html)
    && stringField(table, 'annual')?.startsWith('$');
  const currency = stringField(currencies, 'dividend') || (usEtfUsd ? 'USD' : null);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('Valuta del dividendo assente');
  const box = html.match(/data:\{infoBox:((?:"(?:[^"\\]|\\.)*"))/)?.[1];
  const description = box ? JSON.parse(box) : '';
  const historyBlock = html.match(/\},history:\[([\s\S]{0,30000}?)\],chartData:/)?.[1];
  let annualPerShare = amount(stringField(table, 'annual'));
  const noHistory = /There is no dividend history available for /i.test(description) && historyBlock === '';
  const noRecent = /has not paid any dividends in the past year and the next ex-dividend date is unknown\./.test(description);
  if (annualPerShare === null && (noHistory || noRecent)) annualPerShare = 0;
  if (annualPerShare === null) throw new Error('Dividendo annuo non disponibile nella fonte');
  if ((noHistory || noRecent) && annualPerShare !== 0) throw new Error('Importo annuo in conflitto con l’assenza di dividendi');
  const rows = [];
  for (const match of (historyBlock ?? '').matchAll(/\{([^{}]+)\}/g)) {
    const exDate = stringField(match[1], 'dt'); const pay = stringField(match[1], 'pay');
    const value = amount(stringField(match[1], 'amt'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate ?? '') || value === null) continue;
    rows.push({ symbol, exDate, paymentDate: /^\d{4}-\d{2}-\d{2}$/.test(pay ?? '') ? pay : null, amountPerShare: value, currency, annualPerShare });
  }
  const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  if (noRecent && rows.some(row => row.exDate >= cutoff.toISOString().slice(0, 10))) throw new Error('La dichiarazione di assenza dividendi è in conflitto con lo storico');
  const seen = new Map();
  for (const row of rows) {
    const old = seen.get(row.exDate);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) throw new Error('Distribuzioni in conflitto nella fonte');
    seen.set(row.exDate, row);
  }
  return {
    symbol, currency, annualPerShare, frequency: stringField(table, 'frequency'),
    status: noHistory ? 'no_history' : 'available', method: noRecent ? 'no_payments_last_year' : 'provider_annual',
    source: reference.url, provider: 'Stock Analysis',
    asOf: now, sourceUpdatedAt: html.match(/lastUpdated:"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null,
    rows: [...seen.values()],
  };
}
export function parseDividendStatistics(html, symbol, reference, now = Date.now()) {
  const info = referenceInfo(html, reference);
  const block = html.match(/dividends:\{text:((?:"(?:[^"\\]|\\.)*")),data:\[([\s\S]{0,8000}?)\]\}/);
  const message = block ? JSON.parse(block[1]) : '';
  const currencies = info.match(/curr:\{([^}]+)\}/)?.[1] ?? '';
  // Some non-payers have no dividend currency. The main currency is used only
  // to express a confirmed zero, never to convert a payment.
  const currency = stringField(currencies, 'dividend') || stringField(currencies, 'main');
  const names = [reference.ticker, stringField(info, 'name'), stringField(info, 'titleName')].filter(Boolean);
  if (!names.some(name => message === `${name} does not appear to pay any dividends at this time.`)
    || !/id:"dps",title:"Dividend Per Share",value:"n\/a"/.test(block?.[2] ?? '')
    || !currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('Assenza di distribuzioni non confermata dalla fonte');
  return { symbol, currency, annualPerShare: 0, frequency: null, status: 'available', method: 'no_current_distribution',
    source: reference.url, provider: 'Stock Analysis', asOf: now, sourceUpdatedAt: null, rows: [] };
}
async function boundedText(url, limit, fetcher) {
  // workerd rejects redirect: 'error'. Inspect redirects without following
  // them, keeping the fixed-host and exact-listing checks intact.
  const res = await fetcher(url, { signal: AbortSignal.timeout(15000), redirect: 'manual', headers: { accept: 'text/html,application/xml,text/xml;q=0.9' } });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(`La fonte ha risposto con un reindirizzamento non seguito (HTTP ${res.status})`);
  }
  if (!res.ok) { await res.body?.cancel(); const error = new Error(`Fonte momentaneamente non disponibile (HTTP ${res.status})`); error.status = res.status; throw error; }
  if (!res.body) throw new Error('Risposta vuota');
  const reader = res.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Risposta della fonte troppo grande'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export function parseEcbRates(xml, now = Date.now()) {
  const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || now - Date.parse(date) > 7 * 86400000 || Date.parse(date) > now) throw new Error('Cambi BCE non aggiornati');
  const rates = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const n = Number(m[2]); if (n > 0 && Number.isFinite(n)) rates[m[1]] = n;
  }
  if (!rates.USD) throw new Error('Cambio USD non disponibile');
  return { rates, date, source: FX_URL, asOf: now };
}
export async function incomeReference(request, env, fetcher = fetch) {
  if (request.method !== 'GET') return Response.json({ error: 'Metodo non consentito' }, { status: 405 });
  const url = new URL(request.url); const isFx = url.pathname.endsWith('/fx');
  let ref; let fund; const symbol = url.searchParams.get('symbol') ?? '';
  try { if (!isFx) { ref = dividendReference(symbol, url.searchParams.get('kind') ?? 'stock'); fund = fundReference(symbol); if (fund) ref = fund; } }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  // New generation also invalidates cached runtime errors from the old fetch.
  const key = isFx ? 'income:ecb:v2' : `income:dividend:v4:${symbol}:${ref.url}`;
  try {
    let cached = null; try { cached = await env.STATE?.get(key, 'json'); } catch { /* Cache is optional. */ }
    if (cached && Date.now() - cached.asOf < (cached.error ? 600 : TTL) * 1000) {
      return Response.json(cached, { status: cached.error ? 502 : 200 });
    }
    let result;
    try {
      const text = await boundedText(isFx ? FX_URL : ref.url, isFx ? 50000 : fund ? 5000000 : 600000, fetcher);
      result = isFx ? parseEcbRates(text) : fund ? parseFundReference(text, symbol, fund) : parseDividendReference(text, symbol, ref);
    } catch (error) {
      if (isFx || fund || error.status !== 404) throw error;
      const statistics = { ...ref, url: ref.url.replace(/\/dividend\/$/, '/statistics/') };
      result = parseDividendStatistics(await boundedText(statistics.url, 900000, fetcher), symbol, statistics);
    }
    try { await env.STATE?.put(key, JSON.stringify(result), { expirationTtl: TTL }); } catch { /* Still return the fetched data. */ }
    return Response.json(result, { headers: { 'cache-control': 'public, max-age=1800' } });
  } catch (error) {
    const result = { error: error.message || 'Recupero automatico temporaneamente non disponibile', symbol, asOf: Date.now(), source: ref?.url ?? FX_URL };
    try { await env.STATE?.put(key, JSON.stringify(result), { expirationTtl: 600 }); } catch { /* Best effort. */ }
    return Response.json(result, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
