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
  liveActivation: {
    serverNow: 10_000,
    ttlMs: 7_200_000,
    dryRun: {
      runId: 'run-1',
      status: 'ok',
      finishedAt: 2,
      artifactCreatedAt: 2,
      expiresAt: 7_200_002,
      reusable: true,
      reason: 'fresh',
      model: 'workers-ai/test',
      confidence: 0.84,
      orderCount: 2,
      turnoverPct: 0.12,
    },
  },
};

const liveActivationId = '018f4f92-9fb4-7e66-8c74-c6ea23b88e7f';
const validLiveActivationResponse = {
  activationId: liveActivationId,
  runId: 'live-run-1',
  status: 'ok',
  mode: 'live',
  action: null,
  reason: null,
  error: null,
  decisionSource: 'fresh-analysis',
  reusedDryRunId: null,
  reuseFallbackReason: null,
  plan: {
    orderCount: 1,
    turnoverPct: 0.08,
    confidence: 0.82,
  },
  execution: {
    counts: { planned: 1, sent: 0, filled: 1, partial: 0, failed: 0, skipped: 0, simulated: 0 },
    orders: [{
      symbol: 'SPY',
      side: 'buy',
      amountUsd: 100,
      state: 'filled',
      message: null,
    }],
  },
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

  const currentState = await autopilot.state();
  assert.equal(currentState.config.executionMode, 'dry-run');
  assert.equal(currentState.liveActivation.dryRun.runId, 'run-1');
  assert.equal(currentState.liveActivation.dryRun.reusable, true);
  assert.equal((await autopilot.runs()).runs[0].id, 'run-1');
  assert.deepEqual(requested, [
    'https://worker.example/agent/state',
    'https://worker.example/agent/runs?limit=30',
  ]);
});

test('activateLive usa l\'endpoint atomico e invia conferma esplicita e activationId', async () => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return jsonResponse(validLiveActivationResponse);
  };
  const payload = {
    activationId: liveActivationId,
    confirmation: 'ESEGUI LIVE',
    acknowledgePersistentLive: true,
  };

  const result = await autopilot.activateLive(payload);

  assert.equal(result.runId, 'live-run-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://worker.example/agent/live/activate-and-run');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
  assert.equal(requests[0].init.headers.authorization, 'Bearer control-test');
  assert.equal(requests[0].init.cache, 'no-store');
});

test('unfreeze invia revision esatta e conferma esplicita dopo la verifica eToro', async () => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return jsonResponse({ config: { executionMode: 'shadow', frozen: false, safetyRevision: 18 } });
  };
  const payload = {
    safetyRevision: 17,
    confirmation: 'HO VERIFICATO GLI ORDINI SU ETORO',
  };

  const result = await autopilot.unfreeze(payload);

  assert.equal(result.config.executionMode, 'shadow');
  assert.equal(requests[0].url, 'https://worker.example/agent/unfreeze');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
});

test('prepareRecovery verifica gli acquisti senza inviare un comando Live', async () => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      status: 'ready',
      mode: 'shadow',
      config: { executionMode: 'shadow', frozen: true, recoveryRequired: true, safetyRevision: 18 },
      alreadyAcquired: 4,
      selectedSourceRunId: 'live-run-1',
      candidates: [],
    });
  };
  const payload = {
    safetyRevision: 18,
    confirmation: 'VERIFICA ACQUISTI E PREPARA RIPRESA',
  };

  const result = await autopilot.prepareRecovery(payload);

  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'shadow');
  assert.equal(result.alreadyAcquired, 4);
  assert.equal(requests[0].url, 'https://worker.example/agent/recovery/prepare');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
  assert.ok(!requests[0].url.includes('activate-and-run'));
});

test('executeRecovery invia piano scelto, revision e conferma one-shot', async () => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      activationId: liveActivationId,
      runId: 'recovery-run-1',
      status: 'ok',
      mode: 'shadow',
      recovery: true,
      recoveryCompleted: true,
      recoverySourceRunId: 'dry-run-22',
    });
  };
  const payload = {
    activationId: liveActivationId,
    sourceRunId: 'dry-run-22',
    safetyRevision: 18,
    confirmation: 'COMPLETA PIANO',
    acknowledgeOneShotShadow: true,
  };

  const result = await autopilot.executeRecovery(payload);

  assert.equal(result.recoveryCompleted, true);
  assert.equal(result.mode, 'shadow');
  assert.equal(requests[0].url, 'https://worker.example/agent/recovery/execute');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
});

test('executeRecovery rifiuta un falso successo che non termina in Shadow', async () => {
  globalThis.fetch = async () => jsonResponse({
    activationId: liveActivationId,
    runId: 'recovery-run-1',
    status: 'ok',
    mode: 'live',
    recovery: true,
    recoveryCompleted: true,
    recoverySourceRunId: 'dry-run-22',
  });
  await assert.rejects(() => autopilot.executeRecovery({
    activationId: liveActivationId,
    sourceRunId: 'dry-run-22',
    safetyRevision: 18,
    confirmation: 'COMPLETA PIANO',
    acknowledgeOneShotShadow: true,
  }), /deve terminare in Shadow/);
});

test('activateLive rifiuta fail-closed payload 2xx incoerenti o malformati', async (t) => {
  const payload = {
    activationId: liveActivationId,
    confirmation: 'ESEGUI LIVE',
    acknowledgePersistentLive: true,
  };
  const malformed = [
    {
      name: 'activationId diverso',
      body: { ...validLiveActivationResponse, activationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      message: /activationId assente o diverso/,
    },
    {
      name: 'status sconosciuto',
      body: { ...validLiveActivationResponse, status: 'completed' },
      message: /stato della run Live .* sconosciuto/,
    },
    {
      name: 'successo senza modalità Live',
      body: { ...validLiveActivationResponse, mode: 'dry-run' },
      message: /run riuscita non conferma la modalità Live/,
    },
    {
      name: 'modalità finale assente',
      body: { ...validLiveActivationResponse, mode: undefined },
      message: /modalità finale è assente o sconosciuta/,
    },
    {
      name: 'successo senza runId',
      body: { ...validLiveActivationResponse, runId: null },
      message: /runId manca per lo stato ok/,
    },
    {
      name: 'fail-safe senza conferma booleana',
      body: {
        ...validLiveActivationResponse,
        status: 'frozen',
        mode: 'shadow',
        safetyPersisted: 'no',
      },
      message: /safetyPersisted deve essere booleano/,
    },
    {
      name: 'fail-safe frozen senza esito di persistenza',
      body: {
        ...validLiveActivationResponse,
        status: 'frozen',
        mode: 'shadow',
        safetyPersisted: undefined,
      },
      message: /fail-safe frozen deve dichiarare safetyPersisted/,
    },
    {
      name: 'piano con percentuale impossibile',
      body: {
        ...validLiveActivationResponse,
        plan: { ...validLiveActivationResponse.plan, turnoverPct: 1.5 },
      },
      message: /plan.turnoverPct non è una percentuale valida/,
    },
    {
      name: 'riepilogo ordini non valido',
      body: {
        ...validLiveActivationResponse,
        execution: {
          ...validLiveActivationResponse.execution,
          orders: [{ symbol: '', side: 'buy', amountUsd: 100, state: 'filled', message: null }],
        },
      },
      message: /execution.orders contiene un ordine non valido/,
    },
    {
      name: 'successo senza riepilogo di esecuzione',
      body: { ...validLiveActivationResponse, execution: undefined },
      message: /run riuscita non contiene il riepilogo/,
    },
  ];

  for (const item of malformed) {
    await t.test(item.name, async () => {
      globalThis.fetch = async () => jsonResponse(item.body);
      await assert.rejects(
        autopilot.activateLive(payload),
        (error) => error instanceof AutopilotError
          && error.status === 502
          && item.message.test(error.message),
      );
    });
  }
});

test('activateLive conserva gli indicatori di replay, persistenza e fail-safe', async () => {
  globalThis.fetch = async () => jsonResponse({
    ...validLiveActivationResponse,
    runId: null,
    status: 'frozen',
    mode: null,
    safetyPersisted: false,
    replayed: true,
    busy: false,
    persistenceWarning: 'Esito non persistito.',
  });

  const result = await autopilot.activateLive({
    activationId: liveActivationId,
    confirmation: 'ESEGUI LIVE',
    acknowledgePersistentLive: true,
  });

  assert.equal(result.status, 'frozen');
  assert.equal(result.safetyPersisted, false);
  assert.equal(result.replayed, true);
  assert.equal(result.persistenceWarning, 'Esito non persistito.');
});
