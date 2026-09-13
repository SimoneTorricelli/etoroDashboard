import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { fundFixture } from './fixtures/income-reference.mjs';
import { fundReference } from '../worker/lib/income-funds.js';
import { freeSearch, freeData } from './fixtures/income-free.mjs';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const built = await build({ entryPoints: [fileURLToPath(new URL('../worker/index.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
async function runtime(handler) {
  const options = convertV4MiniflareOptions({ name: 'income-runtime-test', script: built.outputFiles[0].text, modules: true, compatibilityDate: config.compatibility_date, cf: false, logRequests: false });
  options.workers[0].dev.unsafeRegisterWorker = false;
  options.workers[0].dev.outboundService = { type: 'fetcher', handler };
  return new Miniflare(options);
}
// The Worker executes its real global fetch in workerd. Only the upstream
// service is replaced; Node's fetch cannot hide unsupported RequestInit modes.
test('workerd executes uncached dividend and FX fetches with the production compatibility date', async () => {
  const calls = [];
  const mf = await runtime(request => {
    calls.push(request.url);
    assert.equal(request.headers.get('authorization'), null);
    if (request.url === 'https://api.divvydiary.com/symbols?search=AAPL&limit=100') return Response.json(freeSearch());
    if (request.url === 'https://api.divvydiary.com/symbols/US0378331005') return Response.json(freeData());
    if (request.url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') return new Response(`<Cube time="${new Date().toISOString().slice(0, 10)}"><Cube currency="USD" rate="1.25"/></Cube>`);
    throw new Error('Unexpected outbound request');
  });
  try {
    const dividend = await mf.dispatchFetch('https://local/api/income/dividend?symbol=AAPL', { headers: { authorization: 'not-for-upstream' } });
    const body = await dividend.json(); assert.equal(dividend.status, 200, JSON.stringify(body)); assert.equal(body.annualPerShare, 1.06);
    const fx = await mf.dispatchFetch('https://local/api/income/fx'); assert.equal(fx.status, 200); assert.equal((await fx.json()).rates.USD, 1.25);
    assert.equal(calls.length, 3);
  } finally { await mf.dispose(); }
});
test('workerd refuses upstream redirects without visiting their destination', async () => {
  const calls = [];
  const mf = await runtime(request => { calls.push(request.url); return new Response(null, { status: 302, headers: { location: 'https://unexpected.example/other' } }); });
  try {
    const response = await mf.dispatchFetch('https://local/api/income/dividend?symbol=AAPL');
    assert.equal(response.status, 502); assert.match((await response.json()).error, /reindirizzamento/);
    assert.deepEqual(calls, ['https://api.divvydiary.com/symbols?search=AAPL&limit=100']);
  } finally { await mf.dispose(); }
});
test('workerd labels source access denial and never fabricates a dividend', async () => {
  const mf = await runtime(() => new Response(null, { status: 403 }));
  try {
    const response = await mf.dispatchFetch('https://local/api/income/dividend?symbol=AAPL');
    const body = await response.json();
    assert.equal(response.status, 502); assert.equal(body.code, 'upstream_access_denied'); assert.equal(body.annualPerShare, undefined);
  } finally { await mf.dispose(); }
});
test('workerd fetches issuer policies and the free source by exact ISIN', async () => {
  const calls = [];
  const mf = await runtime(request => {
    calls.push(request.url);
    if (request.url === fundReference('CNDX.L').url) return new Response(fundFixture());
    if (request.url === 'https://api.divvydiary.com/symbols/IE00B579F325') return Response.json(freeData({ symbol: 'SGLD', exchange: 'XLON', isin: 'IE00B579F325' }, true));
    if (request.url === 'https://api.divvydiary.com/symbols?search=CLSK&limit=100') return Response.json(freeSearch({ symbol: 'CLSK', exchange: 'XNAS', isin: 'US18452B2097' }));
    if (request.url === 'https://api.divvydiary.com/symbols/US18452B2097') return Response.json(freeData({ symbol: 'CLSK', exchange: 'XNAS', isin: 'US18452B2097' }, true));
    throw new Error('Unexpected upstream');
  });
  try {
    for (const [symbol, method] of [['CNDX.L', 'accumulating'], ['8PSG.DE', 'no_current_distribution'], ['CLSK', 'no_current_distribution']]) {
      const response = await mf.dispatchFetch(`https://local/api/income/dividend?symbol=${symbol}`);
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.method, method); assert.equal(body.annualPerShare, 0);
    }
    assert.equal(calls.length, 4);
  } finally { await mf.dispose(); }
});
