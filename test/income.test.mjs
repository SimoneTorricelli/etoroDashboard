import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { incomeAdviceContext } from '../worker/lib/income-advice.js';
import { parseCalendarRows, publicDividendCalendar } from '../worker/lib/income-market.js';
import worker from '../worker/index.js';
import { handleAgentApi } from '../worker/lib/api.js';
async function loadTs(path) {
  const compiled = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const e = await loadTs('../src/lib/income/engine.ts');
const p = await loadTs('../src/lib/income/providers.ts');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const today = '2026-09-13';
const yieldRule = { ...e.emptyYield(), active: 'active', rate: 4, taxPct: 25, source: 'Estratto', asOf: '2026-09-01' };
const position = { positionId: 1, instrumentId: 10, symbol: 'ABC', assetClass: 'stock', units: 2.5, currentValue: 100, isBuy: true, leverage: 1, isCFD: false };
test('100 EUR per month at 2,3,4,5,6,8 percent reproduces capital table', () => {
  for (const rate of [2, 3, 4, 5, 6, 8]) {
    const result = e.scenario(100, 5000, 0, 0, [{ kind: 'interest', weight: 100, rate, taxPct: 0 }], 'net');
    close(result.required, 1200 / (rate / 100)); close(result.monthly, 5000 * rate / 100 / 12);
  }
});
test('mixed example, protected reserve and stress do not duplicate capital', () => {
  const allocations = [{ kind: 'interest', weight: 40, rate: 2.5, taxPct: 0 }, { kind: 'dividend', weight: 50, rate: 4, taxPct: 0 }, { kind: 'staking', weight: 10, rate: 6, taxPct: 0 }];
  const result = e.scenario(100, 33000, 3000, 0, allocations, 'net');
  close(result.monthly, 90); close(result.required, 33333.3333333333); close(result.additionalRequired, 3333.3333333333);
  close(result.breakdown.reduce((s, a) => s + a.capital, 0), 30000); assert.ok(result.stressMonthly < result.monthly);
});
test('invalid weights, missing net taxes, negative amounts fail closed', () => {
  assert.ok(e.scenario(100, 5000, 0, 0, [{ kind: 'interest', weight: 90, rate: 3, taxPct: 0 }], 'gross').errors.length);
  assert.ok(e.scenario(100, 5000, 0, 0, [{ kind: 'interest', weight: 100, rate: 3, taxPct: null }], 'net').errors.length);
  assert.ok(e.scenario(100, -1, 0, 0, [], 'gross').errors.length);
});
test('unknown income is not zero; explicit zero is known; costs can produce negative net', () => {
  assert.equal(e.interestLine('a', 'A', 1000, 'EUR', e.emptyYield(), null, today).annualGross, null);
  assert.equal(e.interestLine('a', 'A', 1000, 'EUR', { ...yieldRule, active: 'inactive' }, null, today).annualNet, 0);
  assert.equal(e.interestLine('a', 'A', 1000, 'EUR', { ...yieldRule, rate: 0, annualFees: 10 }, null, today).annualNet, -10);
  assert.equal(e.summarize([{ annualNet: null }], 'net').monthly, null);
});
test('interest uses eligible cash only, caps, source dates and FX', () => {
  close(e.interestLine('a', 'A', 2000, 'USD', { ...yieldRule, cap: 1000 }, 1.25, today).annualGross, 32);
  assert.equal(e.interestLine('a', 'A', 2000, 'USD', yieldRule, null, today).annualGross, null);
  assert.equal(e.interestLine('a', 'A', 2000, 'USD', { ...yieldRule, validUntil: '2026-09-01' }, 1.25, today).annualGross, null);
  assert.equal(e.interestLine('a', 'A', 500, 'EUR', { ...yieldRule, minimum: 1000 }, null, today).annualGross, 0);
});
test('APY is converted to monthly payouts without reinvesting the same money', () => {
  close(e.payoutRate(12, 'APY'), 12 * (Math.pow(1.12, 1 / 12) - 1));
  assert.ok(e.payoutRate(12, 'APY') < 0.12);
});
test('fractional dividends, short/CFD exclusion and copy deduplication', () => {
  const d = { annualPerShare: 4, currency: 'USD', taxPct: 25, source: 'Issuer', asOf: today };
  close(e.dividendLine('ABC', [position, { ...position, isBuy: false }, { ...position, isCFD: true }], d, 1.25).annualNet, 6);
  assert.equal(e.dividendLine('ABC', [position], { ...d, currency: '' }, 1.25).annualGross, null);
  assert.equal(e.dividendLine('ABC', [{ ...position, isCFD: true }], d, 1.25).annualGross, 0);
  assert.equal(e.allPositions({ positions: [position], copyPortfolios: [{ copyId: '2', positions: [position, position] }] }).length, 2);
});
test('staking keeps activation, eligibility, provider share and minimum separate', () => {
  const pos = { ...position, symbol: 'SOL', assetClass: 'crypto', currentValue: 1000 };
  const rule = { ...e.emptyStaking(), ...yieldRule, rate: 6, eligible: true, eligibleFrom: '2026-08-01', rateBasis: 'network', sharePct: 65 };
  const line = e.stakingLine('SOL', [pos], rule, 1.25, today);
  close(line.annualGross, 31.2); close(line.thresholdCapitalEur, 12 / 0.039 / 1.25);
  close(e.stakingLine('SOL', [pos], { ...rule, rateBasis: 'provider' }, 1.25, today).annualGross, 48);
  assert.equal(e.stakingLine('SOL', [pos], { ...rule, active: 'unknown' }, 1.25, today).annualGross, null);
  assert.equal(e.stakingLine('SOL', [pos], { ...rule, active: 'inactive' }, 1.25, today).annualGross, 0);
  assert.equal(e.stakingLine('SOL', [pos], { ...rule, eligibleFrom: '2026-10-01' }, 1.25, today).annualGross, 0);
  assert.equal(e.stakingLine('SOL', [{ ...pos, currentValue: 10 }], rule, 1.25, today).annualGross, 0);
  assert.equal(e.stakingLine('BTC', [pos], rule, 1.25, today).annualGross, 0);
});
const raw = { id: 'one', account: 'etoro:main', kind: 'dividend', status: 'paid', date: today, currency: 'USD', gross: '12.34', withholding: '2.34', fees: '0.01', fx: '1.25', source: 'Statement 1' };
test('ledger preserves decimals, rounds once, handles negative reversals', () => {
  assert.equal(e.eventCents(e.validateEvent(raw)), 799);
  assert.equal(e.eventCents(e.validateEvent({ ...raw, currency: 'EUR', gross: '0.105', withholding: '0', fees: '0' })), 11);
  assert.equal(e.eventCents(e.validateEvent({ ...raw, currency: 'EUR', gross: '-0.105', withholding: '0', fees: '0' })), -11);
  assert.throws(() => e.validateEvent({ ...raw, fx: '0' }));
  assert.throws(() => e.validateEvent({ ...raw, date: '2026-02-30' }));
  assert.throws(() => e.validateEvent({ ...raw, kind: 'staking' }));
});
test('repeat import is idempotent; changed ID conflicts; declared stays declared', () => {
  const event = e.validateEvent(raw); const declared = e.validateEvent({ ...raw, id: 'two', status: 'declared' });
  const first = e.mergeEvents([], [event, declared]);
  assert.equal(e.mergeEvents(first, [event, declared]).length, 2);
  assert.equal(first.filter(e => e.status === 'paid').length, 1);
  assert.throws(() => e.mergeEvents(first, [{ ...event, gross: '50' }]));
});
test('public calendar refuses ambiguous rows, does not invent currency', () => {
  const row = { symbol: 'ABC', cells: ['ABC Company', 'Tech', '2026-09-15', '2026-09-30', '4', '1'] };
  const rows = parseCalendarRows([row, row]); assert.equal(rows.length, 1); assert.equal(rows[0].currency, null);
  assert.equal(parseCalendarRows([row, { ...row, cells: [...row.cells.slice(0, 4), '8', '1'] }]).length, 0);
  assert.equal(parseCalendarRows([{ ...row, cells: ['not a calendar'] }]).length, 0);
});
test('public calendar returns explicit unavailable on upstream denial', async () => {
  const oldFetch = globalThis.fetch;
  try { globalThis.fetch = async () => new Response('', { status: 403 }); const response = await publicDividendCalendar(new Request('https://local/api/income/calendar'), {}); assert.equal(response.status, 502); assert.match((await response.json()).error, /403/); }
  finally { globalThis.fetch = oldFetch; }
});
test('FMP history uses actual trailing payments and excludes future ex-dates', async () => {
  const oldFetch = globalThis.fetch;
  const now = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  try {
    globalThis.fetch = async () => Response.json([{ symbol: 'ABC', date: now, dividend: 0.25 }, { symbol: 'ABC', date: future, dividend: 0.3 }]);
    const result = await p.fetchFmpIncome(['ABC'], 'fake', new AbortController().signal);
    assert.equal(result.rows[0].annualPerShare, 0.25); assert.equal(result.rows[0].currency, null);
    globalThis.fetch = async () => Response.json([]);
    assert.equal((await p.fetchFmpIncome(['ABC'], 'fake', new AbortController().signal)).rows.length, 0);
  } finally { globalThis.fetch = oldFetch; }
});
test('AI receives allowlisted numbers and recalculated results, never arbitrary instructions', () => {
  const body = { target: 100, capital: 30000, basis: 'gross', knownMonthly: null, missingSources: 1, secret: 'do not forward', allocations: ['dividend', 'interest', 'staking', 'other'].map(kind => ({ kind, weight: 25, rate: 4, taxPct: null })) };
  const result = incomeAdviceContext(body); close(result.scenarioMonthlyEur, 100); assert.ok(!JSON.stringify(result).includes('do not forward'));
  assert.throws(() => incomeAdviceContext({ ...body, target: -1 }));
});
test('income AI endpoint rejects unauthorized, oversized and invalid requests before model calls', async () => {
  const env = { DB: {}, CONTROL_TOKEN: 'test-token' };
  const request = (body, auth = true) => new Request('https://local/agent/income/advice', { method: 'POST', headers: auth ? { authorization: 'Bearer test-token' } : {}, body });
  assert.equal((await handleAgentApi(request('{}', false), env, {}, '/agent/income/advice')).status, 401);
  assert.equal((await handleAgentApi(request('x'.repeat(17000)), env, {}, '/agent/income/advice')).status, 413);
  assert.equal((await handleAgentApi(request('{}'), env, {}, '/agent/income/advice')).status, 400);
});
test('calendar route returns cached public JSON without reaching trading proxy or DB', async () => {
  const cached = { rows: [{ symbol: 'ABC' }], source: 'eToro', asOf: Date.now() };
  const env = { STATE: { get: async () => cached } };
  const response = await worker.fetch(new Request('https://local/api/income/calendar'), env, {});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), cached);
  assert.equal((await worker.fetch(new Request('https://local/api/income/calendar', { headers: { origin: 'https://elsewhere' } }), env, {})).status, 403);
});
