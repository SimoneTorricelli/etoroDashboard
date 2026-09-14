import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/finance/lifetime-profit.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { calculateLifetimeProfit: calculate, validateProfitHistory: validate, parseProfitAmount } = await import(moduleUrl);
const today = '2026-09-14';
const row = (through, deposits, withdrawals, equity, unrealized = null, adjustments = 0) => ({ through, deposits, withdrawals, equity, unrealized, adjustments, source: 'Estratto eToro' });
const history = years => ({ version: 1, startYear: 2023, sinceInception: true, openingEquity: 0, openingUnrealized: 0, years });

test('reinvestment and withdrawal do not erase or double-count earned profits', () => {
  const points = calculate(history([
    row('2023-12-31', 10000, 0, 12000, 0),
    row('2024-12-31', 0, 1000, 11000, 0),
    row('2025-12-31', 0, 0, 13000, 2000),
    row(today, 0, 0, 13000, 0), // Close and reinvest: equity unchanged, realized rises.
  ]), today);
  assert.deepEqual(points.map(p => p.cumulativeProfit), [2000, 2000, 4000, 4000]);
  assert.deepEqual(points.map(p => p.annualProfit), [2000, 0, 2000, 0]);
  assert.deepEqual(points.map(p => p.realizedProfit), [2000, 2000, 2000, 4000]);
});

test('return of capital, added capital and withdrawals exceeding contributions', () => {
  assert.equal(calculate(history([row('2023-12-31', 10000, 4000, 6000)]), today)[0].cumulativeProfit, 0);
  assert.equal(calculate(history([row('2023-12-31', 15000, 0, 15000)]), today)[0].cumulativeProfit, 0);
  assert.equal(calculate(history([row('2023-12-31', 10000, 15000, 0, 0)]), today)[0].cumulativeProfit, 5000);
});

test('fees, losses, dividends and negative unrealized P&L reconcile without clamping', () => {
  const point = calculate(history([row('2023-12-31', 10000, 1000, 8800, -500)]), today)[0];
  assert.equal(point.cumulativeProfit, -200);
  assert.equal(point.realizedProfit, 300); // +400 credited income minus 100 costs, -500 still open.
});

test('external capital transfers and bonuses are neutralized in either direction', () => {
  assert.equal(calculate(history([row('2023-12-31', 10000, 0, 12500, 0, 2000)]), today)[0].cumulativeProfit, 500);
  assert.equal(calculate(history([row('2023-12-31', 10000, 0, 8500, 0, -2000)]), today)[0].cumulativeProfit, 500);
});

test('partial history subtracts opening equity and change in unrealized profit', () => {
  const point = calculate({ ...history([row('2023-12-31', 2000, 1000, 14500, 2300)]), sinceInception: false, openingEquity: 12000, openingUnrealized: 2000 }, today)[0];
  assert.equal(point.cumulativeProfit, 1500);
  assert.equal(point.realizedProfit, 1200);
});

test('missing open P&L is unknown, including a missing baseline', () => {
  assert.equal(calculate(history([row('2023-12-31', 100, 0, 110)]), today)[0].realizedProfit, null);
  assert.equal(calculate({ ...history([row('2023-12-31', 100, 0, 110, 0)]), sinceInception: false, openingUnrealized: null }, today)[0].realizedProfit, null);
});

test('refuse incomplete, duplicated, invalid and future annual coverage', () => {
  const bad = [
    history([row('2024-12-31', 0, 0, 1)]),
    history([row('2023-12-31', 0, 0, 1), row('2025-12-31', 0, 0, 1)]),
    history([row('2023-12-31', 0, 0, 1), row('2023-12-31', 0, 0, 1)]),
    history([row('2023-10-01', 0, 0, 1), row('2024-12-31', 0, 0, 1)]),
    history([row('2023-02-30', 0, 0, 1)]),
    { ...history([row('2026-09-15', 0, 0, 1)]), startYear: 2026 },
    { ...history([row('2023-12-31', 0, 0, 1)]), openingEquity: 10 },
    history([null]), history([{}]),
  ];
  for (const input of bad) { assert.ok(validate(input, today).length); assert.throws(() => calculate(input, today)); }
});

test('require explicit finite flows and source, reject tampered backups', () => {
  for (const patch of [{ deposits: null }, { deposits: NaN }, { withdrawals: -10 }, { equity: Infinity }, { adjustments: '0' }, { source: '' }, { unrealized: undefined }]) {
    assert.ok(validate(history([{ ...row('2023-12-31', 0, 0, 0, 0), ...patch }]), today).length);
  }
  assert.ok(validate({ ...history([]), version: 99 }, today).length);
  assert.ok(validate(null, today).length);
});

test('chronological results and the annual/cumulative identity survive shuffled input', () => {
  const points = calculate(history([row('2024-12-31', 500, 700, 1100), row('2023-12-31', 1000, 0, 1200)]), today);
  assert.deepEqual(points.map(p => p.year), [2023, 2024]);
  assert.equal(points.reduce((sum, p) => sum + p.annualProfit, 0), points.at(-1).cumulativeProfit);
});

test('money inputs accept comma decimals and grouped formats, never guess malformed amounts', () => {
  for (const [raw, expected] of [['1.234,56', 1234.56], ['1,234.56', 1234.56], ['1234,5', 1234.5], ['-100,25', -100.25], ['0', 0], [' $ 25.00 ', 25]]) assert.equal(parseProfitAmount(raw), expected);
  for (const raw of ['', '1,234', '1.234', '12,34,56', 'Infinity', '1e5', '1,2.3', 'abc']) assert.ok(Number.isNaN(parseProfitAmount(raw)), raw);
});

const storageSource = await readFile(new URL('../src/lib/finance/profit-storage.ts', import.meta.url), 'utf8');
const storageCompiled = ts.transpileModule(storageSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("'./lifetime-profit'", JSON.stringify(moduleUrl));
const { loadProfitHistory, saveProfitHistory } = await import(`data:text/javascript;base64,${Buffer.from(storageCompiled).toString('base64')}`);
test('storage round trip is scoped, validates data and preserves corrupt originals', () => {
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const data = history([row('2023-12-31', 10000, 1000, 11000, 0)]);
  saveProfitHistory('account-a', data);
  assert.deepEqual(loadProfitHistory('account-a').history, data);
  assert.equal(loadProfitHistory('account-b').history.years.length, 0);
  values.set('corrupt', '{broken');
  assert.ok(loadProfitHistory('corrupt').error);
  assert.equal(values.get('corrupt'), '{broken');
  assert.throws(() => saveProfitHistory('account-a', history([row('2023-12-31', NaN, 0, 0)])));
  assert.deepEqual(loadProfitHistory('account-a').history, data);
});
test('storage failures surface rather than claiming successful persistence', () => {
  globalThis.localStorage = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Quota'); } };
  assert.ok(loadProfitHistory('account').error);
  assert.throws(() => saveProfitHistory('account', history([])), /Quota/);
});
