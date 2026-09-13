// Public, unauthenticated market data. Only exact ticker + market matches,
// then an exact ISIN lookup. Never select the first search result by name.
const MARKETS = { US: ['XNAS', 'XNYS', 'ARCX', 'XASE', 'BATS'], MI: ['XMIL'], DE: ['XETR', 'XFRA'], L: ['XLON'], PA: ['XPAR'], MC: ['XMAD'], AS: ['XAMS'], NV: ['XAMS'], T: ['XTKS'], BR: ['XBRU'], LS: ['XLIS'], ST: ['XSTO'], CO: ['XCSE'], HE: ['XHEL'], OL: ['XOSL'], SW: ['XSWX'], HK: ['XHKG'], TO: ['XTSE'], AX: ['XASX'] };
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
// Public identity exceptions, verified 2026-09-13 (see docs/rendite-gratuite-2026-09-13.md).
// The provider stores one primary listing per ISIN; dual listings must not be
// confused with ADRs, preferred shares or similarly named instruments.
const IDENTITIES = {
  'ADM.L': 'GB00B02J6398', AEP: 'US0255371017', 'ANE.MC': 'ES0105563003',
  'AV.L': 'GB00BPQY8M80', BABA: 'US01609W1027', 'BATS.L': 'GB0002875804',
  'BHP.L': 'AU000000BHP4', BE: 'US0937121079', BNS: 'CA0641491075',
  'BP.L': 'GB0007980591', C: 'US1729674242', CLS: 'CA15101Q2071',
  ENB: 'CA29250N1050', 'ENGI.PA': 'FR0010208488', ETR: 'US29364G1031',
  'EVO.ST': 'SE0012673267', EXC: 'US30161N1019',
};
export const MUFG_URL = 'https://www.mufg.jp/english/ir/stock/dividend/index.html';
export function freeReference(symbol, kind = 'stock', knownIsin = null) {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,24}$/.test(symbol) || !['stock', 'etf'].includes(kind)) throw new Error('Strumento non valido');
  let ticker = symbol; let market = 'US';
  const suffix = symbol.split('.').at(-1);
  if (Object.hasOwn(MARKETS, suffix)) { market = suffix; ticker = symbol.slice(0, -(suffix.length + 1)); }
  if (!/^[A-Z0-9][A-Z0-9-]*(?:\.[AB])?$/.test(ticker)) throw new Error('Mercato o ticker non coperto dal collegamento gratuito');
  knownIsin ||= IDENTITIES[symbol] || (market === 'US' ? IDENTITIES[ticker] : null) || null;
  if (knownIsin && !ISIN.test(knownIsin)) throw new Error('ISIN non valido');
  return { ticker, exchanges: MARKETS[market], isin: knownIsin,
    url: knownIsin ? `https://api.divvydiary.com/symbols/${knownIsin}` : `https://api.divvydiary.com/symbols?search=${encodeURIComponent(ticker)}&limit=100` };
}
export function resolveFreeIdentity(body, ref) {
  if (!Array.isArray(body?.symbols) || !Number.isInteger(body.total) || body.total !== body.symbols.length || body.total > 100) throw new Error('Ricerca del titolo incompleta: identità non confermata');
  const canonical = ticker => ticker?.toUpperCase().replace('-', '.');
  const matches = body.symbols.filter(row => canonical(row.symbol) === canonical(ref.ticker) && ref.exchanges.includes(row.exchange) && ISIN.test(row.isin));
  const unique = new Set(matches.map(row => row.isin));
  if (unique.size !== 1) throw new Error(unique.size ? 'Più strumenti corrispondono al ticker: identità ambigua' : 'Quotazione non trovata nella fonte gratuita');
  return matches[0];
}
function day(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
}
function cashCurrency(value) {
  if (value === 'GBp' || value === 'GBX') return { currency: 'GBP', divisor: 100 };
  if (value === 'ZAc') return { currency: 'ZAR', divisor: 100 };
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? { currency: value, divisor: 1 } : null;
}
export function parseFreeDividend(body, symbol, identity, now = Date.now()) {
  if (!body || body.isin !== identity.isin || !ISIN.test(body.isin) || !Array.isArray(body.dividends)
    || (identity.symbol && (body.symbol !== identity.symbol || body.exchange !== identity.exchange))) throw new Error('ISIN o identità della distribuzione non confermati');
  const today = new Date(now).toISOString().slice(0, 10);
  const cutoffDate = new Date(now); cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear() - 1);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const rows = new Map(); let hasFuture = false; let currency = null;
  for (const event of body.dividends) {
    const exDate = day(event?.exDate);
    if (!exDate) throw new Error('Data del dividendo non valida');
    if (event.forecast === true || exDate <= cutoff) continue;
    if (event.forecast !== false || typeof event.amount !== 'number' || !Number.isFinite(event.amount) || event.amount < 0) throw new Error('Dividendo non confermato o importo non valido');
    if (exDate > today) { hasFuture ||= event.amount > 0; continue; }
    const denomination = cashCurrency(event.currency);
    if (!denomination || (currency && denomination.currency !== currency)) throw new Error('Valute dei dividendi mancanti o in conflitto');
    currency = denomination.currency;
    const paymentDate = event.payDate === null || event.payDate === undefined ? null : day(event.payDate);
    if (event.payDate != null && !paymentDate) throw new Error('Data di pagamento non valida');
    const row = { symbol, exDate, paymentDate, amountPerShare: event.amount / denomination.divisor, currency, eventId: event.id ?? null };
    // Two records on one ex-date could be a duplicate or separate special
    // dividends. Without an unambiguous event type, refuse to double count.
    const previous = rows.get(exDate);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Distribuzioni in conflitto nella fonte');
    rows.set(exDate, row);
  }
  // A zero annual rate with an existing, older confirmed history also describes
  // a suspension (e.g. Evolution 2026). An empty history alone is never zero.
  const stopped = body.dividendRate === 0 && rows.size === 0 && body.dividends.some(event => event.forecast === false && event.exDate <= cutoff && event.amount > 0);
  const noCurrent = (body.dividendFrequency === 'none' && (body.dividendRate === null || body.dividendRate === 0)) || stopped;
  if (noCurrent && hasFuture) throw new Error('Assenza di dividendi in conflitto con eventi annunciati');
  let annualPerShare;
  if (noCurrent) { annualPerShare = 0; currency = cashCurrency(body.dividendCurrency)?.currency || 'EUR'; }
  else {
    if (!rows.size || !currency) throw new Error('Storico recente dei dividendi non disponibile');
    // DivvyDiary documents split-adjusted history. Do not adjust it a second
    // time (e.g. Itochu: 20 + 22 JPY after the 5-for-1 split, not 100 + 22).
    annualPerShare = [...rows.values()].reduce((sum, row) => sum + row.amountPerShare, 0);
    if (!Number.isFinite(annualPerShare)) throw new Error('Totale dividendi non valido');
  }
  return { symbol, isin: body.isin, currency, annualPerShare, frequency: body.dividendFrequency,
    status: 'available', method: noCurrent ? 'no_current_distribution' : 'confirmed_trailing_12m',
    source: `https://divvydiary.com/en/${body.isin}`, provider: 'DivvyDiary', asOf: now, sourceUpdatedAt: null,
    periodStart: cutoff, periodEnd: today, rows: [...rows.values()].map(row => ({ ...row, annualPerShare })) };
}
// MUFG's feed has contained an obsolete forecast marked confirmed alongside
// the final amount. Reconcile against the issuer's actual fiscal-year table,
// never by choosing the newest record, the largest amount or a hardcoded value.
export function reconcileMufg(body, html, now = Date.now()) {
  if (body.isin !== 'JP3902900004' || !html.includes('Dividends per common share')) throw new Error('Identità del prospetto MUFG non confermata');
  const actual = new Map();
  for (const match of html.matchAll(/<tr[^>]*>\s*<th[^>]*>Fiscal Year Ended Mar\. (\d{4})<\/th>([\s\S]*?)<\/tr>/g)) {
    const cells = [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
    const amounts = cells.map(cell => !/forecast/i.test(cell) ? Number(cell.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]) : NaN);
    if (amounts.length === 3 && amounts.every(Number.isFinite) && Math.abs(amounts[0] - amounts[1] - amounts[2]) < 1e-8) actual.set(Number(match[1]), amounts);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const groups = new Map(); const retained = [];
  for (const event of body.dividends) {
    if (event.forecast === true || event.exDate <= cutoff.toISOString().slice(0, 10) || event.exDate > today) { retained.push(event); continue; }
    const group = groups.get(event.exDate) || []; group.push(event); groups.set(event.exDate, group);
  }
  for (const [exDate, events] of groups) {
    if (!day(exDate)) throw new Error('Data MUFG non valida');
    const year = Number(exDate.slice(0, 4)); const month = Number(exDate.slice(5, 7));
    const expected = month === 3 ? actual.get(year)?.[2] : month === 9 ? actual.get(year + 1)?.[1] : undefined;
    const matches = events.filter(event => event.forecast === false && event.currency === 'JPY' && event.amount === expected);
    if (matches.length !== 1) throw new Error('Dividendo MUFG non confermato dal prospetto ufficiale');
    retained.push(matches[0]);
  }
  return { ...body, dividends: retained };
}
export async function freeDividend(symbol, ref, readJson, now = Date.now(), readText) {
  const identity = ref.isin ? { isin: ref.isin } : resolveFreeIdentity(await readJson(ref.url), ref);
  let body = await readJson(`https://api.divvydiary.com/symbols/${identity.isin}`);
  const mufg = identity.isin === 'JP3902900004';
  if (mufg) {
    if (!readText) throw new Error('Riscontro ufficiale MUFG non disponibile');
    body = reconcileMufg(body, await readText(MUFG_URL), now);
  }
  const result = parseFreeDividend(body, symbol, identity, now);
  return mufg ? { ...result, source: MUFG_URL, provider: 'MUFG / DivvyDiary' } : result;
}
