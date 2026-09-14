import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/data/EtoroProfitHistory.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { fetchEtoroProfitHistory: fetchHistory, mergeProfitHistory, parseProfitTrades, parseOpenProfit, profitByYear, profitByMonth } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const now = Date.parse('2026-09-14T12:00:00Z');
const once = rows => { let called = false; return async () => { if (called) return []; called = true; return rows; }; };
const trade = (id, profit = 1, extra = {}) => ({ positionId: id, closeTimestamp: '2026-06-01T12:00:00Z', netProfit: profit, orderId: id, units: 1, ...extra });

test('all-time request follows every page, including the terminal empty page', async () => {
  const paths = [];
  const history = await fetchHistory(async path => { paths.push(path); return paths.length === 1 ? Array.from({ length: 500 }, (_, i) => trade(i + 1)) : []; }, undefined, now);
  assert.equal(history.trades.length, 500); assert.equal(history.rangeLimited, false);
  assert.ok(paths[0].includes('minDate=2000-01-01')); assert.ok(paths[1].includes('page=2'));
});

test('pagination counts overlap once, preserves distinct partial closes and losses', async () => {
  const first = Array.from({ length: 500 }, (_, i) => trade(i + 1));
  let page = 0;
  const history = await fetchHistory(async () => ++page === 1 ? first : page === 2 ? [first[0], trade(1, -20, { units: 0.5 }), trade(501, 50, { socialTradeId: 42 })] : [], undefined, now);
  assert.equal(history.trades.length, 502);
  const [year] = profitByYear(history);
  assert.equal(year.profit, 530); assert.equal(year.manual, 480); assert.equal(year.copy, 50);
});

test('reinvestment and withdrawals cannot erase realized gains or add returned capital', async () => {
  const history = await fetchHistory(once([trade(1, 2000, { investment: 10000, closeTimestamp: '2023-05-01T12:00:00Z' }), trade(2, -500, { investment: 12000, closeTimestamp: '2025-05-01T12:00:00Z' })]), undefined, now);
  assert.deepEqual(profitByYear(history).map(row => [row.year, row.profit, row.cumulative]), [[2023, 2000, 2000], [2024, 0, 2000], [2025, -500, 1500], [2026, 0, 1500]]);
});

test('net profits are used once: fees and mirror closed-profit totals are not added again', async () => {
  const history = await fetchHistory(once([trade(1, 90, { fees: 10, socialTradeId: 42 })]), undefined, now);
  assert.equal(profitByYear(history)[0].profit, 90);
});

test('explicit date-range refusal falls back with visible limited coverage', async () => {
  const paths = [];
  const history = await fetchHistory(async path => {
    paths.push(path);
    if (paths.length === 1) throw new Error('eToro API 400: date range exceeds 365 days');
    return paths.length === 2 ? [trade(1)] : [];
  }, undefined, now);
  assert.equal(history.rangeLimited, true); assert.equal(history.from, '2025-09-15');
  assert.equal(paths.length, 3); assert.ok(paths[1].includes('minDate=2025-09-15&page=1'));
});

test('auth, quota, network and unrelated bad requests never produce a misleading fallback', async () => {
  for (const message of ['eToro API 401: unauthorized', 'eToro API 429: quota', 'network offline', 'eToro API 400: missing header']) {
    let calls = 0;
    await assert.rejects(fetchHistory(async () => { calls++; throw new Error(message); }, undefined, now));
    assert.equal(calls, 1);
  }
});

test('fail closed when pagination repeats, changes data or fails midway', async () => {
  const first = Array.from({ length: 500 }, (_, i) => trade(i + 1));
  await assert.rejects(fetchHistory(async () => first, undefined, now), /stessa pagina/);
  let page = 0;
  await assert.rejects(fetchHistory(async () => ++page === 1 ? first : [trade(1, 9)], undefined, now), /cambiato/);
  page = 0;
  await assert.rejects(fetchHistory(async () => { if (++page === 1) return first; throw new Error('timeout'); }, undefined, now), /timeout/);
});

test('abort prevents further pages and publishing a partially read result', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(fetchHistory(async () => { calls++; controller.abort(); return [trade(1)]; }, controller.signal, now), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('malformed and missing values are not converted into zero profits', () => {
  for (const patch of [{ netProfit: null }, { netProfit: '' }, { netProfit: true }, { netProfit: Infinity }, { closeTimestamp: null }, { closeTimestamp: '2027-01-01' }, { positionId: null }]) {
    assert.throws(() => parseProfitTrades([trade(1, 1, patch)], now));
  }
  assert.throws(() => parseProfitTrades({ error: 'Unauthorized' }, now));
  assert.equal(parseProfitTrades({ items: [trade(1, 0)] }, now).trades[0].profit, 0);
});

test('empty history is a verified empty result, not a fabricated point', async () => {
  const history = await fetchHistory(async () => [], undefined, now);
  assert.equal(history.trades.length, 0); assert.deepEqual(profitByYear(history), []);
});

test('current open profit excludes closed mirror results and duplicate positions', () => {
  const position = { positionId: 1, unrealizedPnL: { pnL: 25 } };
  assert.equal(parseOpenProfit({ clientPortfolio: { positions: [position], mirrors: [{ positions: [position, { positionId: 2, unrealizedPnL: { pnL: -10 } }], closedPositionsNetProfit: 1000 }] } }), 15);
  assert.equal(parseOpenProfit({ positions: [], mirrors: [] }), 0);
  assert.equal(parseOpenProfit({ positions: [{}], mirrors: [] }), null);
  assert.equal(parseOpenProfit({ positions: [], mirrors: [{}] }), null);
  assert.equal(parseOpenProfit({ error: 'unauthorized' }), null);
  assert.equal(parseOpenProfit({ positions: [position, { positionId: 1, unrealizedPnL: { pnL: 100 } }], mirrors: [] }), null);
});

test('monthly chart carries earned gains through inactive months and year boundaries', async () => {
  const history = await fetchHistory(once([trade(1, 100, { closeTimestamp: '2025-12-10T12:00:00Z' }), trade(2, -40, { closeTimestamp: '2026-02-10T12:00:00Z' })]), undefined, now);
  const months = profitByMonth(history);
  assert.deepEqual(months.slice(0, 3), [{ label: '2025-12', cumulative: 100 }, { label: '2026-01', cumulative: 100 }, { label: '2026-02', cumulative: 60 }]);
  assert.equal(months.at(-1).label, '2026-09'); assert.equal(months.at(-1).cumulative, 60);
});

test('short broker pages do not truncate the history', async () => {
  let page = 0;
  const history = await fetchHistory(async () => ++page <= 3 ? [trade(page)] : [], undefined, now);
  assert.equal(page, 4); assert.equal(history.trades.length, 3);
});

test('incremental sync preserves older gains, applies corrections and never upgrades limited coverage', async () => {
  const old = await fetchHistory(once([trade(1, 100, { closeTimestamp: '2025-05-01T12:00:00Z' }), trade(2, 20, { closeTimestamp: '2026-09-14T10:00:00Z' })]), undefined, now);
  const next = await fetchHistory(once([trade(2, 25, { closeTimestamp: '2026-09-14T10:00:00Z' })]), undefined, now, undefined, '2026-09-13');
  const merged = mergeProfitHistory(old, next);
  assert.equal(merged.trades.length, 2); assert.equal(profitByYear(merged).at(-1).cumulative, 125);
  assert.equal(mergeProfitHistory({ ...old, rangeLimited: true }, next).rangeLimited, true);
  assert.equal(mergeProfitHistory(old, { ...next, trades: [old.trades[0], ...next.trades] }).trades.length, 2);
  assert.throws(() => mergeProfitHistory(old, { ...next, from: '2026-10-01' }), /non continuo/);
});
