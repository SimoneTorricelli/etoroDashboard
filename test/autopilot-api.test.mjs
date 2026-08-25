import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

class MemoryStorage {
  #values = new Map();

  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key) { this.#values.delete(String(key)); }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
globalThis.window = {
  location: { origin: 'https://dashboard.example' },
  localStorage,
  sessionStorage,
};

// Il progetto non dipende da un test runner TypeScript: transpiliamo il singolo
// modulo in memoria, così lo stesso test gira anche con il Node minimo del repo.
const sourceUrl = new URL('../src/lib/agent/autopilot-api.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourceUrl.pathname,
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  AutopilotError,
  autopilot,
  getBaseUrl,
  normalizeBaseUrl,
  setBaseUrl,
  setControlToken,
} = await import(moduleUrl);

const run = {
  id: 'run-1',
  kind: 'rebalance',
  started_at: 1,
  finished_at: 2,
  status: 'ok',
  execution_mode: 'dry-run',
  equity_usd: 100,
  error: null,
};

const state = {
  config: { executionMode: 'dry-run' },
  lastRun: run,
  recentRuns: [run],
  equityCurve: [],
  equityUsd: 100,
  highWaterMarkUsd: 105,
  drawdownPct: 5 / 105,
  credentials: [],
  agentBindingVerified: true,
  notificationsActive: false,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

test('normalizeBaseUrl usa la stessa origin per un valore vuoto', () => {
  assert.equal(normalizeBaseUrl('', 'https://dashboard.example/autopilot?tab=x'), 'https://dashboard.example');
});

test('normalizeBaseUrl conserva solo origin e porta', () => {
  assert.equal(
    normalizeBaseUrl('  https://worker.example:8443/autopilot/agent/state?x=1#y  '),
    'https://worker.example:8443',
  );
});

test('normalizeBaseUrl rifiuta protocolli non HTTP(S) e credenziali nell’URL', () => {
  assert.throws(() => normalizeBaseUrl('ftp://worker.example'), /http:\/\/ o https:\/\//);
  assert.throws(() => normalizeBaseUrl('https://user:secret@worker.example'), /credenziali/);
  assert.throws(() => normalizeBaseUrl('http://worker.example'), /obbligatorio usare https/);
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787/autopilot'), 'http://127.0.0.1:8787');
});

test('setBaseUrl restituisce e persiste la origin normalizzata', () => {
  assert.equal(setBaseUrl(''), 'https://dashboard.example');
  assert.equal(localStorage.getItem('torino.autopilot.base-url'), 'https://dashboard.example');
  assert.equal(setBaseUrl('https://worker.example/autopilot'), 'https://worker.example');
  assert.equal(getBaseUrl(), 'https://worker.example');
  assert.equal(localStorage.getItem('torino.autopilot.base-url'), 'https://worker.example');
});

test('setControlToken segnala quando lo storage persistente non è disponibile', () => {
  const availableStorage = window.localStorage;
  window.localStorage = null;
  try {
    assert.equal(setControlToken('solo-in-memoria', true), false);
  } finally {
    window.localStorage = availableStorage;
  }
});

test('una risposta HTML 200 non può produrre una falsa connessione', async () => {
  setControlToken('control-test');
  setBaseUrl('https://worker.example/autopilot');
  globalThis.fetch = async () => new Response('<!doctype html><title>SPA</title>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await assert.rejects(
    autopilot.state(),
    (error) => error instanceof AutopilotError
      && error.status === 502
      && /non punta all.API Autopilot/.test(error.message)
      && /senza \/autopilot o \/agent/.test(error.message),
  );
});

test('JSON dichiarato ma malformato viene rifiutato', async () => {
  globalThis.fetch = async () => new Response('{"config":', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(autopilot.state(), /JSON non leggibile/);
});

test('/agent/state richiede la configurazione e i campi runtime essenziali', async () => {
  globalThis.fetch = async () => jsonResponse({ recentRuns: [] });
  await assert.rejects(
    autopilot.state(),
    (error) => error instanceof AutopilotError
      && error.status === 502
      && /manca la configurazione Autopilot/.test(error.message),
  );
});

test('/agent/runs richiede un array di run compatibili', async () => {
  globalThis.fetch = async () => jsonResponse({ runs: 'non-array' });
  await assert.rejects(autopilot.runs(), /manca l.elenco delle esecuzioni/);

  globalThis.fetch = async () => jsonResponse({ runs: [{ id: 'incompleta' }] });
  await assert.rejects(autopilot.runs(), /formato incompatibile/);
});

test('state e runs validi vengono accettati e usano la origin normalizzata', async () => {
  const requested = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return String(input).includes('/agent/runs') ? jsonResponse({ runs: [run] }) : jsonResponse(state);
  };

  assert.equal((await autopilot.state()).config.executionMode, 'dry-run');
  assert.equal((await autopilot.runs()).runs[0].id, 'run-1');
  assert.deepEqual(requested, [
    'https://worker.example/agent/state',
    'https://worker.example/agent/runs?limit=30',
  ]);
});
