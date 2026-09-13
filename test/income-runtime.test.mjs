import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { fundFixture, goldFixture, statisticsFixture } from './fixtures/income-reference.mjs';
import { fundReference } from '../worker/lib/income-funds.js';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const built = await build({ entryPoints: [fileURLToPath(new URL('../worker/index.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const html = '<link rel="canonical" href="https://stockanalysis.com/stocks/aapl/dividend/">data:{info:{ticker:"AAPL",curr:{dividend:"USD"}}},uses:{};data:{infoBox:"Published annual dividend.",infoTable:{annual:"$1.08"},history:[{dt:"2026-08-10",amt:"$0.27"}],chartData:[]}';
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
    if (request.url === 'https://stockanalysis.com/stocks/aapl/dividend/') return new Response(html);
    if (request.url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') return new Response(`<Cube time="${new Date().toISOString().slice(0, 10)}"><Cube currency="USD" rate="1.25"/></Cube>`);
    throw new Error('Unexpected outbound request');
  });
  try {
    const dividend = await mf.dispatchFetch('https://local/api/income/dividend?symbol=AAPL', { headers: { authorization: 'not-for-upstream' } });
    const body = await dividend.json(); assert.equal(dividend.status, 200, JSON.stringify(body)); assert.equal(body.annualPerShare, 1.08);
    const fx = await mf.dispatchFetch('https://local/api/income/fx'); assert.equal(fx.status, 200); assert.equal((await fx.json()).rates.USD, 1.25);
    assert.equal(calls.length, 2);
  } finally { await mf.dispose(); }
});
test('workerd refuses upstream redirects without visiting their destination', async () => {
  const calls = [];
  const mf = await runtime(request => { calls.push(request.url); return new Response(null, { status: 302, headers: { location: 'https://unexpected.example/other' } }); });
  try {
    const response = await mf.dispatchFetch('https://local/api/income/dividend?symbol=AAPL');
    assert.equal(response.status, 502); assert.match((await response.json()).error, /reindirizzamento/);
    assert.deepEqual(calls, ['https://stockanalysis.com/stocks/aapl/dividend/']);
  } finally { await mf.dispose(); }
});
test('workerd fetches issuer policies and falls back to confirmed stock statistics', async () => {
  const calls = [];
  const mf = await runtime(request => {
    calls.push(request.url);
    if (request.url === fundReference('CNDX.L').url) return new Response(fundFixture());
    if (request.url === fundReference('8PSG.DE').url) return new Response(goldFixture());
    if (request.url === 'https://stockanalysis.com/stocks/clsk/dividend/') return new Response(null, { status: 404 });
    if (request.url === 'https://stockanalysis.com/stocks/clsk/statistics/') return new Response(statisticsFixture());
    throw new Error('Unexpected upstream');
  });
  try {
    for (const [symbol, method] of [['CNDX.L', 'accumulating'], ['8PSG.DE', 'non_distributing'], ['CLSK', 'no_current_distribution']]) {
      const response = await mf.dispatchFetch(`https://local/api/income/dividend?symbol=${symbol}`);
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.method, method); assert.equal(body.annualPerShare, 0);
    }
    assert.equal(calls.length, 4);
  } finally { await mf.dispose(); }
});
