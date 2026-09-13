import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { incomeReference, dividendReference, parseDividendReference, parseDividendStatistics, parseEcbRates } from '../worker/lib/income-reference.js';
import { fundReference, parseFundReference } from '../worker/lib/income-funds.js';
import { fundFixture, goldFixture, statisticsFixture } from './fixtures/income-reference.mjs';
import { freeSearch, freeData } from './fixtures/income-free.mjs';
import worker from '../worker/index.js';
async function load(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const s = await load('../src/lib/income/storage.ts');
const { projectIncome } = await load('../src/lib/income/projection.ts');
const { parseIncomeNumber } = await load('../src/lib/income/numbers.ts');
const e = await load('../src/lib/income/engine.ts');
const p = await load('../src/lib/income/providers.ts');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const base = { capital: 10000, reserve: 0, additional: 0, monthlyContribution: 0, annualRate: 6, reinvestPct: 100, months: 60, targetMonthly: 100 };
function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
test('Italian comma, decimal point and properly grouped amounts; malformed values rejected', () => {
  assert.equal(parseIncomeNumber('2,5'), 2.5); assert.equal(parseIncomeNumber('2.5'), 2.5);
  assert.equal(parseIncomeNumber('1.234,56'), 1234.56); assert.equal(parseIncomeNumber(''), null);
  assert.equal(parseIncomeNumber('0,'), 0); assert.equal(parseIncomeNumber(',5'), .5);
  for (const v of ['-1', '1.2,3', '1,2,3', 'NaN', 'Infinity', '1e3', '12 euro']) assert.ok(Number.isNaN(parseIncomeNumber(v)), v);
});
test('compound growth at 1, 2 and 5 years matches closed formula', () => {
  const r = projectIncome(base);
  assert.deepEqual(r.errors, []);
  for (const m of [12, 24, 60]) { close(r.points[m].capital, 10000 * 1.005 ** m); close(r.points[m].monthlyIncome, r.points[m].capital * .005); }
});
test('end-of-month contributions do not earn interest early; reserve stays uninvested', () => {
  const r = projectIncome({ ...base, reserve: 2000, additional: 500, monthlyContribution: 100 });
  close(r.points[1].capital, 10500 + 8500 * .005 + 100);
  close(r.points[12].capital, 2000 + 8500 * 1.005 ** 12 + 100 * (1.005 ** 12 - 1) / .005);
  close(r.points[12].contributions, 11700);
});
test('withdrawals and partial reinvestment never double count income', () => {
  for (const share of [0, 35, 100]) {
    const r = projectIncome({ ...base, reinvestPct: share });
    for (const point of r.points) { close(point.earned, point.reinvested + point.withdrawn); close(point.capital, point.contributions + point.reinvested); assert.ok(point.prudent <= point.capital + 1e-7); }
  }
  const noCompound = projectIncome({ ...base, reinvestPct: 0 });
  close(noCompound.points[60].capital, 10000); close(noCompound.points[60].withdrawn, 3000);
});
test('zero rate and target dates remain explicit; invalid inputs cannot draw a curve', () => {
  const r = projectIncome({ ...base, annualRate: 0, monthlyContribution: 100 });
  assert.equal(r.points[60].capital, 16000); assert.equal(r.targetMonth, null);
  assert.equal(projectIncome({ ...base, targetMonthly: 50 }).targetMonth, 0);
  assert.equal(projectIncome({ ...base, targetMonthly: 50.1 }).targetMonth, 1);
  for (const patch of [{ capital: NaN }, { annualRate: -1 }, { reinvestPct: 101 }, { months: 601 }, { months: 1.5 }, { reserve: 10001 }]) assert.ok(projectIncome({ ...base, ...patch }).errors.length);
});
test('v1 migration retains user inputs, enables declared cash, gross default and no per-token verification', () => {
  const initial = s.initialState(); const old = { ...initial, version: 1, basis: 'net', target: 150, cash: { ...initial.cash, rate: 2.5, active: 'unknown', validUntil: '2020-01-01' } };
  const migrated = s.migrateIncome(old);
  assert.equal(migrated.cash.rate, 2.5); assert.equal(migrated.cash.active, 'active'); assert.equal(migrated.cash.validUntil, '');
  assert.equal(migrated.target, 150); assert.equal(migrated.basis, 'gross'); assert.equal(migrated.stakingMode, 'not_earning');
  assert.throws(() => s.migrateIncome({ ...old, target: -1 }));
});
test('save verifies readback and reload; broken history cannot block current data', () => {
  globalThis.localStorage = storage(); localStorage.setItem('test', JSON.stringify(s.initialState())); localStorage.setItem('test.revisions', '{broken');
  const saved = s.saveIncome('test', { ...s.initialState(), monthlyContribution: 123.45 });
  assert.ok(saved.savedAt > 0); assert.equal(s.loadIncome('test').state.monthlyContribution, 123.45);
  assert.equal(s.loadIncome('test').error, ''); assert.equal(JSON.parse(localStorage.getItem('test.revisions')).length, 1);
});
test('blocked writes and failed readback throw rather than claiming save success', () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('Quota'); } };
  assert.throws(() => s.saveIncome('test', s.initialState()), /Quota/);
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  assert.throws(() => s.saveIncome('test', s.initialState()), /confermato/);
});
test('corrupt original is backed up before replacement; invalid edits do not replace it', () => {
  globalThis.localStorage = storage(); localStorage.setItem('test', '{broken');
  assert.ok(s.loadIncome('test').error); assert.equal(localStorage.getItem('test'), '{broken');
  assert.throws(() => s.saveIncome('test', { ...s.initialState(), target: -1 })); assert.equal(localStorage.getItem('test'), '{broken');
  s.saveIncome('test', s.initialState()); assert.equal(localStorage.getItem('test.backup'), '{broken');
});
const fixture = ({ symbol = 'AAPL', ticker = symbol, annual = '$1.08', currency = 'USD', noHistory = false, history, kind = 'stock' } = {}) => {
  const ref = dividendReference(symbol, kind);
  return `<link rel="canonical" href="${ref.url}">data:{info:{ticker:"${ticker}",exchange_code:"${ref.exchange?.toUpperCase() ?? ''}",curr:{price:"GBX",dividend:"${currency}"}}},uses:{};data:{infoBox:"${noHistory ? 'There is no dividend history available for Test.' : 'Published annual dividend.'}",infoTable:{annual:"${annual}",frequency:"Quarterly"},history:[${history ?? (noHistory ? '' : '{dt:"2026-08-10",amt:"$0.27",pay:"2026-08-20"}')}],chartData:[],lastUpdated:"2026-08-10"}`;
};
test('reference locks market identity and never sends an unknown suffix to the US', () => {
  assert.match(dividendReference('ENEL.MI').url, /quote\/bit\/ENEL/); assert.match(dividendReference('SAP.DE').url, /quote\/etr\/SAP/);
  assert.match(dividendReference('VTI', 'etf').url, /\/etf\/vti/); assert.match(dividendReference('BRK.B').url, /brk-b/);
  for (const symbol of ['../secret', 'ABC.UNKNOWN', 'https://example.com', 'aapl']) assert.throws(() => dividendReference(symbol));
  assert.throws(() => parseDividendReference(fixture({ ticker: 'MSFT' }), 'AAPL', dividendReference('AAPL')), /Identità/);
  assert.throws(() => parseDividendReference(fixture().replace('/stocks/aapl/', '/stocks/msft/'), 'AAPL', dividendReference('AAPL')), /quotazione/);
});
test('eToro Japan, Amsterdam and US suffixes preserve exact market and payout currency', () => {
  for (const [symbol, ticker, exchange, currency, annual] of [['6758.T', '6758', 'tyo', 'JPY', '35.00 JPY'], ['ASML.NV', 'ASML', 'ams', 'EUR', '€7.50'], ['CVX.US', 'CVX', null, 'USD', '$7.12']]) {
    const ref = dividendReference(symbol); assert.equal(ref.exchange, exchange); assert.equal(ref.ticker, ticker);
    const parsed = parseDividendReference(fixture({ symbol, ticker, currency, annual }), symbol, ref);
    assert.equal(parsed.symbol, symbol); assert.equal(parsed.currency, currency); assert.ok(parsed.annualPerShare > 0);
  }
  for (const symbol of ['AAPL.US.US', 'ENEL.MI.US', 'ABC.UNKNOWN.US']) assert.throws(() => dividendReference(symbol));
});
test('explicit no payments in last year permits old history but rejects contradictions', () => {
  const ref = dividendReference('AMD'); const now = Date.parse('2026-09-13');
  const html = fixture({ symbol: 'AMD', annual: 'n/a', history: '{dt:"1995-04-27",amt:"0.005"}' }).replace('Published annual dividend.', 'AMD has not paid any dividends in the past year and the next ex-dividend date is unknown.');
  const parsed = parseDividendReference(html, 'AMD', ref, now);
  assert.equal(parsed.annualPerShare, 0); assert.equal(parsed.method, 'no_payments_last_year');
  assert.throws(() => parseDividendReference(html.replace('1995-04-27', '2026-08-01'), 'AMD', ref, now), /conflitto/);
  assert.throws(() => parseDividendReference(html.replace('annual:"n/a"', 'annual:"$1"'), 'AMD', ref, now), /conflitto/);
});
test('statistics confirms a non-payer by identity, explicit statement and no dividend per share', () => {
  const ref = { ...dividendReference('CLSK'), url: 'https://stockanalysis.com/stocks/clsk/statistics/' };
  assert.equal(parseDividendStatistics(statisticsFixture(), 'CLSK', ref).annualPerShare, 0);
  for (const html of [statisticsFixture().replaceAll('does not appear to pay', 'may pay'), statisticsFixture().replace('value:"n/a"', 'value:"$2"'), statisticsFixture().replace('ticker:"CLSK"', 'ticker:"MSFT"'), statisticsFixture().replace('name:"CleanSpark"', 'name:"Other"'), statisticsFixture().replace('/clsk/statistics/', '/other/statistics/')]) assert.throws(() => parseDividendStatistics(html, 'CLSK', ref));
});
test('free provider refuses upstream failure or malformed data without fabricating a fallback', async () => {
  const request = new Request('https://local/api/income/dividend?symbol=CLSK'); const calls = [];
  const identity = { symbol: 'CLSK', exchange: 'XNAS', isin: 'US18452B2097' };
  const result = await incomeReference(request, {}, async url => { calls.push(url); return Response.json(url.includes('?') ? freeSearch(identity) : freeData(identity, true)); });
  assert.equal(result.status, 200); assert.equal((await result.json()).method, 'no_current_distribution'); assert.equal(calls.length, 2);
  for (const status of [301, 302, 307, 308, 403, 429, 500]) {
    let count = 0; const response = await incomeReference(request, {}, async () => { count++; return new Response(null, { status, headers: { location: 'https://elsewhere.example/' } }); });
    assert.equal(response.status, 502); assert.equal(count, 1);
  }
  let count = 0; const invalid = await incomeReference(request, {}, async () => { count++; return new Response('<html>Unavailable</html>'); });
  assert.equal(invalid.status, 502); assert.equal(count, 1);
});
test('accumulating ETFs require the current issuer policy, exact ISIN, product and listing', () => {
  for (const symbol of ['CNDX.L', 'CBU0.L', 'DTLA.L', 'CSP1.L', '2B76.DE']) {
    const parsed = parseFundReference(fundFixture(symbol), symbol, fundReference(symbol));
    assert.equal(parsed.annualPerShare, 0); assert.equal(parsed.method, 'accumulating'); assert.equal(parsed.currency, 'USD');
  }
  const symbol = 'CNDX.L'; const ref = fundReference(symbol);
  for (const html of [fundFixture(symbol, { isin: { value: 'WRONG' } }), fundFixture(symbol, { useOfProfitsCode: { value: 'Distributing' } }), fundFixture(symbol).replace('CNDX.L', 'CNX1.L'), fundFixture(symbol).replaceAll('253741', '253743'), '<html>Accumulating IE00B53SZB19 CNDX.L</html>']) assert.throws(() => parseFundReference(html, symbol, ref));
});
test('gold ETC requires explicit issuer distribution None and exact product identity', () => {
  const ref = fundReference('8PSG.DE'); assert.equal(parseFundReference(goldFixture(), '8PSG.DE', ref).method, 'non_distributing');
  for (const html of [goldFixture().replace('None', 'Monthly'), goldFixture().replace(ref.isin, 'XS2183935274'), goldFixture().replace('physical-gold-etc.html', 'physical-gold-eur-hedged-etc.html')]) assert.throws(() => parseFundReference(html, '8PSG.DE', ref));
  assert.equal(fundReference('UNKNOWN.DE'), null);
});
test('issuer route fetches one fixed URL and uses a new cache generation for the redirect fix', async () => {
  const calls = []; const keys = []; const symbol = 'CNDX.L';
  const response = await incomeReference(new Request(`https://local/api/income/dividend?symbol=${symbol}&kind=etf`), { STATE: { get: async key => { keys.push(key); return null; }, put: async key => { keys.push(key); } } }, async (url, opts) => { calls.push(url); assert.equal(opts.redirect, 'manual'); return new Response(fundFixture()); });
  assert.equal(response.status, 200); assert.deepEqual(calls, [fundReference(symbol).url]); assert.ok(keys.every(key => key.startsWith('income:dividend:v6:')));
});
test('annual published amount is not guessed from one payment; payout currency differs from quote', () => {
  const d = parseDividendReference(fixture(), 'AAPL', dividendReference('AAPL'));
  assert.equal(d.annualPerShare, 1.08); assert.equal(d.rows.length, 1); assert.equal(d.rows[0].amountPerShare, .27);
  const uk = parseDividendReference(fixture({ symbol: 'VOD.L', ticker: 'VOD', annual: '£0.041', currency: 'GBP' }), 'VOD.L', dividendReference('VOD.L'));
  assert.equal(uk.currency, 'GBP'); close(e.euros(uk.annualPerShare * 100, uk.currency, 1.25, { GBP: .8 }), 5.125);
  close(e.euros(410, 'GBX', 1.25, { GBP: .8 }), 5.125);
});
test('no history is zero only when explicitly stated; missing, malformed, conflicting records fail', () => {
  const ref = dividendReference('AAPL');
  assert.equal(parseDividendReference(fixture({ annual: 'n/a', noHistory: true }), 'AAPL', ref).status, 'no_history');
  assert.throws(() => parseDividendReference(fixture({ annual: 'n/a' }), 'AAPL', ref));
  assert.throws(() => parseDividendReference('<html>Unavailable</html>', 'AAPL', ref));
  assert.throws(() => parseDividendReference(fixture({ history: '{dt:"2026-08-10",amt:"$1"},{dt:"2026-08-10",amt:"$2"}' }), 'AAPL', ref), /conflitto/);
});
test('ECB reference rejects stale, future and incomplete rates', () => {
  const xml = '<Cube time="2026-09-11"><Cube currency="USD" rate="1.25"/><Cube currency="GBP" rate="0.8"/></Cube>';
  const now = Date.parse('2026-09-13'); assert.deepEqual(parseEcbRates(xml, now).rates, { EUR: 1, USD: 1.25, GBP: .8 });
  assert.throws(() => parseEcbRates(xml, Date.parse('2026-09-20'))); assert.throws(() => parseEcbRates(xml, Date.parse('2026-09-10')));
  assert.throws(() => parseEcbRates(xml.replace('USD', 'CAD'), now));
});
test('public handler uses fixed host without account headers, optional cache, bounded response', async () => {
  const request = new Request('https://local/api/income/dividend?symbol=AAPL', { headers: { authorization: 'private-token' } });
  const env = { STATE: { get: async () => null, put: async () => { throw new Error('KV unavailable'); } } };
  const response = await incomeReference(request, env, async (url, options) => { assert.ok(url.startsWith('https://api.divvydiary.com/symbols')); assert.equal(options.redirect, 'manual'); assert.ok(!JSON.stringify(options).includes('private-token')); return Response.json(url.includes('?') ? freeSearch() : freeData()); });
  assert.equal(response.status, 200); assert.equal((await response.json()).annualPerShare, 1.06);
  assert.equal((await incomeReference(request, {}, async () => new Response('x'.repeat(600001)))).status, 502);
  assert.equal((await incomeReference(request, {}, async () => new Response('', { status: 403 }))).status, 502);
  assert.equal((await incomeReference(new Request(request, { method: 'POST' }), {})).status, 405);
});
test('access denials and rate limits remain unknown and have a distinct diagnostic', async () => {
  const request = new Request('https://local/api/income/dividend?symbol=AAPL');
  for (const [status, code] of [[403, 'upstream_access_denied'], [406, 'upstream_access_denied'], [429, 'upstream_rate_limited'], [503, 'upstream_unavailable']]) {
    const response = await incomeReference(request, {}, async () => new Response(null, { status }));
    const body = await response.json(); assert.equal(response.status, 502); assert.equal(body.code, code); assert.equal(body.annualPerShare, undefined);
    assert.equal(p.referenceFailure(body, 502).code, code);
    assert.equal(p.referenceFailure({ error: body.error }, 502).code, code);
  }
  assert.equal(p.referenceFailure({ error: 'Mercato non coperto' }, 400).code, 'upstream_unavailable');
});
test('worker route returns cached reference without trading proxy, database or secrets', async () => {
  const cached = { symbol: 'AAPL', annualPerShare: 1.08, asOf: Date.now() };
  const response = await worker.fetch(new Request('https://local/api/income/dividend?symbol=AAPL'), { STATE: { get: async () => cached } }, {});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), cached);
});
test('automatic fetch covers all symbols with two-request bound, isolates failures and caches', async () => {
  globalThis.localStorage = storage(); const oldFetch = globalThis.fetch; const oldWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://local' } }; let active = 0, maximum = 0, calls = 0;
  const output = new Map(); const instruments = Array.from({ length: 35 }, (_, i) => ({ symbol: `T${i}`, kind: 'stock' }));
  try {
    globalThis.fetch = async url => { calls++; active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 1)); active--; const symbol = new URL(url).searchParams.get('symbol');
      return symbol === 'T2' ? Response.json({ error: 'Temporarily unavailable' }, { status: 502 }) : Response.json({ symbol, annualPerShare: 1, currency: 'USD', status: 'available', asOf: Date.now(), source: 'https://divvydiary.com/en/US0378331005', rows: [] }); };
    await p.fetchAutomaticDividends(instruments, { proxyUrl: 'https://local' }, new AbortController().signal, (symbol, result) => output.set(symbol, result));
    assert.equal(output.size, 35); assert.equal(calls, 35); assert.ok(maximum <= 2); assert.equal(output.get('T2').data, null); assert.ok(output.get('T2').error); assert.equal(output.get('T34').data.annualPerShare, 1);
    calls = 0; await p.fetchAutomaticDividends(instruments.filter(i => i.symbol !== 'T2'), { proxyUrl: 'https://local' }, new AbortController().signal, () => {}); assert.equal(calls, 0);
  } finally { globalThis.fetch = oldFetch; globalThis.window = oldWindow; }
});

test('European source variant uses symbol plus exchange_code; wrong exchange rejected', () => {
  const html = fixture({ symbol: 'ENEL.MI', ticker: 'ENEL', annual: '€0.49', currency: 'EUR' }).replace('ticker:"ENEL"', 'symbol:"ENEL"');
  const ref = dividendReference('ENEL.MI');
  assert.equal(parseDividendReference(html, 'ENEL.MI', ref).annualPerShare, .49);
  assert.throws(() => parseDividendReference(html.replace('exchange_code:"BIT"', 'exchange_code:"LON"'), 'ENEL.MI', ref), /Mercato/);
});
test('US ETF variant needs exchange, visible USD and distribution amount currency together', () => {
  const html = fixture({ symbol: 'VTI', kind: 'etf', annual: '$3.90' }).replace('curr:{price:"GBX",dividend:"USD"}', 'exchange:"NYSEARCA"') + '<div>NYSEARCA: VTI · Real-Time Price · USD</div>';
  const ref = dividendReference('VTI', 'etf');
  assert.equal(parseDividendReference(html, 'VTI', ref).currency, 'USD');
  assert.throws(() => parseDividendReference(html.replace('· USD', '· CAD'), 'VTI', ref), /Valuta/);
});

test('monthly contribution for target reaches that income at the selected horizon', () => {
  for (const reinvestPct of [0, 50, 100]) for (const months of [12, 24, 60]) {
    const input = { ...base, reserve: 1000, additional: 500, reinvestPct, months };
    const required = projectIncome(input).points.at(-1).contributionForTarget;
    assert.ok(required > 0);
    const reached = projectIncome({ ...input, monthlyContribution: required }).points.at(-1);
    close(reached.monthlyIncome, 100);
  }
  assert.equal(projectIncome({ ...base, annualRate: 0 }).points.at(-1).contributionForTarget, null);
  assert.equal(projectIncome({ ...base, targetMonthly: 0 }).points.at(-1).contributionForTarget, 0);
});
