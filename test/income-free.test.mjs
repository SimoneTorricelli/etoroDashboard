import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freeReference, resolveFreeIdentity, parseFreeDividend, freeDividend, reconcileMufg, MUFG_URL } from '../worker/lib/income-free.js';
import { freeSearch, freeData, appleIdentity } from './fixtures/income-free.mjs';
const now = Date.parse('2026-09-13T12:00:00Z');
test('exact market resolution separates Tokyo/Taiwan and Amsterdam/US depositary receipts', () => {
  const jp = { symbol: '8411', exchange: 'XTKS', isin: 'JP3885780001' };
  const tw = { symbol: '8411', exchange: 'XTAI', isin: 'KYG525911072' };
  assert.equal(resolveFreeIdentity({ symbols: [tw, jp], total: 2 }, freeReference('8411.T')).isin, jp.isin);
  const nl = { symbol: 'ASML', exchange: 'XAMS', isin: 'NL0010273215' };
  const us = { symbol: 'ASML', exchange: 'XNAS', isin: 'USN070592100' };
  assert.equal(resolveFreeIdentity({ symbols: [us, nl], total: 2 }, freeReference('ASML.NV')).isin, nl.isin);
  assert.equal(resolveFreeIdentity({ symbols: [nl, us], total: 2 }, freeReference('ASML')).isin, us.isin);
  assert.equal(freeReference('CVX.US').ticker, 'CVX');
  for (const symbol of ['AAPL.US.US', 'ENEL.MI.US', '../secret', 'ABC.UNKNOWN']) assert.throws(() => freeReference(symbol));
});
test('ambiguous, truncated or inexact searches never pick the first result', () => {
  const ref = freeReference('AAPL');
  for (const body of [{ ...freeSearch(), total: 200 }, freeSearch({ ...appleIdentity, symbol: 'AAPY' }), { symbols: [appleIdentity, { ...appleIdentity, isin: 'CA03785Y1007' }], total: 2 }, { symbols: [], total: 0 }]) assert.throws(() => resolveFreeIdentity(body, ref));
});
test('trailing annual sum excludes forecasts, future announcements and old events', () => {
  const data = freeData(appleIdentity, false, now);
  data.dividends.push({ id: 98, exDate: '2026-10-10', amount: 999, currency: 'USD', forecast: false });
  data.dividends.push({ id: 99, exDate: '2026-09-01', amount: 999, currency: 'USD', forecast: true });
  const out = parseFreeDividend(data, 'AAPL', appleIdentity, now);
  assert.equal(out.annualPerShare, 1.06); assert.equal(out.rows.length, 4); assert.equal(out.currency, 'USD'); assert.equal(out.method, 'confirmed_trailing_12m');
  assert.notEqual(out.annualPerShare, data.dividendRate); // rounded forward estimate is deliberately not used
});
test('split-adjusted amounts are not adjusted again; quote currency is irrelevant', () => {
  const identity = { symbol: '8001', exchange: 'XTKS', isin: 'JP3143600009' };
  const data = { ...freeData(identity, false, now), dividendCurrency: 'JPY', currency: 'EUR', splits: [{ date: '2025-12-29', ratioFrom: 5, ratioTo: 1 }], dividends: [
    { id: 1, exDate: '2025-09-29', amount: 20, currency: 'JPY', forecast: false },
    { id: 2, exDate: '2026-03-30', amount: 22, currency: 'JPY', forecast: false },
  ] };
  assert.equal(parseFreeDividend(data, '8001.T', identity, now).annualPerShare, 42);
  assert.equal(parseFreeDividend(data, '8001.T', identity, now).currency, 'JPY');
});
test('minor currency units are normalized; conflicting currencies and records fail', () => {
  const data = freeData(appleIdentity, false, now); data.dividends.forEach(row => { row.currency = 'GBp'; row.amount = 1; });
  const out = parseFreeDividend(data, 'AAPL', appleIdentity, now); assert.equal(out.currency, 'GBP'); assert.equal(out.annualPerShare, .04);
  const conflict = structuredClone(data); conflict.dividends[0].currency = 'JPY'; assert.throws(() => parseFreeDividend(conflict, 'AAPL', appleIdentity, now), /Valute/);
  const duplicate = freeData(appleIdentity, false, now); duplicate.dividends.push({ ...duplicate.dividends[0], amount: 99 }); assert.throws(() => parseFreeDividend(duplicate, 'AAPL', appleIdentity, now), /conflitto/);
  const repeated = freeData(appleIdentity, false, now); repeated.dividends.push({ ...repeated.dividends[0] }); assert.equal(parseFreeDividend(repeated, 'AAPL', appleIdentity, now).annualPerShare, 1.06);
  const separate = freeData(appleIdentity, false, now); separate.dividends.push({ ...separate.dividends[0], id: 999 }); assert.throws(() => parseFreeDividend(separate, 'AAPL', appleIdentity, now), /conflitto/);
});
test('suspended dividend needs an explicit zero rate and existing history; unknown is not zero', () => {
  const identity = { isin: 'SE0012673267', symbol: 'EVO', exchange: 'XSTO' };
  const data = { ...freeData(identity, false, now), dividendFrequency: 'annually', dividendRate: 0, dividendCurrency: 'EUR', dividends: [{ id: 1, exDate: '2025-05-12', amount: 2.8, currency: 'EUR', forecast: false }] };
  assert.equal(parseFreeDividend(data, 'EVO.ST', identity, now).annualPerShare, 0);
  for (const patch of [{ dividendRate: null }, { dividendRate: 2.8 }, { dividends: [] }]) assert.throws(() => parseFreeDividend({ ...data, ...patch }, 'EVO.ST', identity, now), /Storico/);
  assert.throws(() => parseFreeDividend({ ...data, dividends: [...data.dividends, { exDate: '2026-10-01', amount: 1, forecast: false }] }, 'EVO.ST', identity, now), /conflitto/);
});
test('verified identity exceptions separate London ordinary shares, ADRs and Canadian dual listings', () => {
  for (const [symbol, isin] of Object.entries({ 'BHP.L': 'AU000000BHP4', BABA: 'US01609W1027', BNS: 'CA0641491075', CLS: 'CA15101Q2071', 'BP.L': 'GB0007980591', 'ENGI.PA': 'FR0010208488' })) assert.equal(freeReference(symbol).isin, isin);
  assert.equal(freeReference('BP').isin, null); assert.equal(freeReference('BHP').isin, null);
  assert.equal(freeReference('C.US').isin, freeReference('C').isin);
});
test('MUFG obsolete forecast is reconciled with actual issuer table and never counted twice', async () => {
  const identity = { isin: 'JP3902900004', symbol: '8306', exchange: 'XTKS' };
  const data = { ...freeData(identity, false, now), dividendCurrency: 'JPY', dividends: [
    { id: 1, exDate: '2025-09-29', payDate: '2025-12-05', amount: 35, currency: 'JPY', forecast: false },
    { id: 2, exDate: '2026-03-30', payDate: '2026-06-30', amount: 39, currency: 'JPY', forecast: false },
    { id: 3, exDate: '2026-03-30', payDate: '2026-06-29', amount: 51, currency: 'JPY', forecast: false },
  ] };
  const html = readFileSync(new URL('./fixtures/income-mufg.html', import.meta.url), 'utf8');
  assert.throws(() => parseFreeDividend(data, '8306.T', identity, now), /conflitto/);
  const fixed = reconcileMufg(data, html, now);
  assert.equal(parseFreeDividend(fixed, '8306.T', identity, now).annualPerShare, 86);
  assert.equal(data.dividends.length, 3);
  for (const bad of [html.replace('¥51', '¥52'), html.replace('Ended Mar.', 'Ending Mar.'), html.replace('¥51', '¥51 (Forecast)')]) assert.throws(() => reconcileMufg(data, bad, now), /ufficiale/);
  const result = await freeDividend('8306.T', freeReference('8306.T'), async url => url.includes('?') ? freeSearch(identity) : data, now, async url => { assert.equal(url, MUFG_URL); return html; });
  assert.equal(result.annualPerShare, 86); assert.equal(result.source, MUFG_URL);
});
test('no distribution requires explicit none; missing history never becomes zero', () => {
  assert.equal(parseFreeDividend(freeData(appleIdentity, true), 'AAPL', appleIdentity).annualPerShare, 0);
  const missing = { ...freeData(), dividends: [] }; assert.throws(() => parseFreeDividend(missing, 'AAPL', appleIdentity), /Storico/);
  const contradictory = freeData(appleIdentity, true, now); contradictory.dividends.push({ exDate: '2026-10-10', amount: 1, forecast: false }); assert.throws(() => parseFreeDividend(contradictory, 'AAPL', appleIdentity, now), /conflitto/);
  for (const patch of [{ isin: 'US0231351067' }, { symbol: 'AMZN' }, { exchange: 'XAMS' }]) assert.throws(() => parseFreeDividend({ ...freeData(), ...patch }, 'AAPL', appleIdentity));
});
test('free requests contain only a public symbol or ISIN; known fund skips search', async () => {
  const urls = [];
  const out = await freeDividend('AAPL', freeReference('AAPL'), async url => { urls.push(url); return url.includes('?') ? freeSearch() : freeData(); });
  assert.equal(out.annualPerShare, 1.06); assert.equal(urls.length, 2); assert.ok(urls.every(url => url.startsWith('https://api.divvydiary.com/symbols')));
  const fixed = freeReference('8PSG.DE', 'etf', 'IE00B579F325');
  let calls = 0; const result = await freeDividend('8PSG.DE', fixed, async url => { calls++; assert.equal(url, fixed.url); return freeData({ symbol: 'SGLD', exchange: 'XLON', isin: 'IE00B579F325' }, true); });
  assert.equal(calls, 1); assert.equal(result.annualPerShare, 0);
});
