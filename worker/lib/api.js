/**
 * API di controllo dell'Autopilot. Tutte le rotte richiedono il bearer token
 * `CONTROL_TOKEN`; il passaggio a modalità `live` richiede una conferma
 * esplicita aggiuntiva.
 */
import { runPipeline } from './pipeline.js';
import { listFreeModels } from './brain.js';
import { notify, notifyTest } from './notify.js';
import { clearCredentials, describeCredentials, resolveCredentials, saveCredentials } from './vault.js';
import { runDiagnostics } from './diagnose.js';
import { EtoroClient } from './etoro.js';
import {
  audit, equityHistory, getRunBundle, listRuns, loadConfig, saveConfig, DEFAULT_CONFIG,
} from './db.js';

/** Confronto a tempo costante: evita di rivelare il token per timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

export function isAuthorized(request, env) {
  const token = env.CONTROL_TOKEN;
  if (!token) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match) && safeEqual(match[1].trim(), token);
}

const NUMERIC_BOUNDS = {
  budgetEur: [10, 100000],
  maxOrdersPerRun: [1, 20],
  maxOrdersPerDay: [1, 40],
  minOrderUsd: [1, 10000],
  maxOrderUsd: [5, 100000],
  maxTurnoverPct: [0.01, 1],
  minRebalanceBandAbs: [0.001, 0.5],
  minRebalanceBandRel: [0.01, 2],
  minCashPct: [0, 0.9],
  maxCashPct: [0.05, 1],
  drawdownStopPct: [0.02, 0.6],
  reconcileTolerancePct: [0.005, 0.3],
  minConfidence: [0, 1],
  rebalanceWeekday: [1, 7],
  rebalanceDayOfMonth: [1, 28],
  rebalanceHour: [0, 23],
  rebalanceMinute: [0, 59],
  llmTemperature: [0, 1.5],
  llmMaxTokens: [256, 8000],
  fallbackEurUsd: [0.5, 2],
};

/** Ripulisce la patch di configurazione: chiavi ignote e valori fuori range vengono scartati. */
export function sanitizeConfigPatch(patch) {
  const out = {};
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_CONFIG)) { rejected.push(`${key}: chiave sconosciuta`); continue; }
    if (key === 'executionMode') { rejected.push('executionMode: usa POST /agent/mode'); continue; }
    if (key === 'frozen' || key === 'frozenReason') { rejected.push(`${key}: usa /agent/freeze o /agent/unfreeze`); continue; }

    if (key in NUMERIC_BOUNDS) {
      const numeric = Number(value);
      const [min, max] = NUMERIC_BOUNDS[key];
      if (!Number.isFinite(numeric) || numeric < min || numeric > max) { rejected.push(`${key}: fuori intervallo [${min}, ${max}]`); continue; }
      out[key] = numeric;
      continue;
    }
    if (key === 'cadence') {
      if (!['daily', 'weekly', 'monthly'].includes(value)) { rejected.push('cadence: valore non ammesso'); continue; }
      out[key] = value;
      continue;
    }
    if (key === 'whitelist') {
      if (!Array.isArray(value) || !value.length) { rejected.push('whitelist: deve essere un array non vuoto'); continue; }
      const cleaned = value
        .filter((item) => item && typeof item.symbol === 'string')
        .map((item) => ({
          symbol: String(item.symbol).trim().toUpperCase().slice(0, 16),
          name: String(item.name ?? item.symbol).slice(0, 80),
          class: ['etf', 'stock', 'bond', 'commodity', 'crypto'].includes(item.class) ? item.class : 'etf',
          maxWeight: Math.max(0.01, Math.min(1, Number(item.maxWeight) || 0.2)),
        }));
      if (!cleaned.length) { rejected.push('whitelist: nessuna voce valida'); continue; }
      out[key] = cleaned;
      continue;
    }
    if (key === 'models') {
      if (!Array.isArray(value) || !value.length) { rejected.push('models: array non vuoto richiesto'); continue; }
      out[key] = value.map(String).slice(0, 8);
      continue;
    }
    if (key === 'snapshotHours') {
      if (!Array.isArray(value)) { rejected.push('snapshotHours: array richiesto'); continue; }
      out[key] = [...new Set(value.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))];
      continue;
    }
    if (key === 'maxWeightPerClass') {
      if (!value || typeof value !== 'object') { rejected.push('maxWeightPerClass: oggetto richiesto'); continue; }
      out[key] = Object.fromEntries(Object.entries(value)
        .map(([klass, weight]) => [klass, Math.max(0, Math.min(1, Number(weight) || 0))]));
      continue;
    }
    if (key === 'riskProfile') { out[key] = String(value).slice(0, 800); continue; }
    rejected.push(`${key}: tipo non gestito`);
  }
  return { patch: out, rejected };
}

export async function handleAgentApi(request, env, ctx, pathname) {
  if (!env.DB) return json({ error: 'binding D1 "DB" non configurato' }, 500);
  if (!isAuthorized(request, env)) return json({ error: 'non autorizzato' }, 401);

  const db = env.DB;
  const route = pathname.replace(/^\/agent\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const body = ['POST', 'PUT', 'PATCH'].includes(method)
    ? await request.json().catch(() => ({}))
    : {};

  // GET /agent/state
  if (route === 'state' && method === 'GET') {
    const [config, runs, curve, resolved] = await Promise.all([loadConfig(db), listRuns(db, 12), equityHistory(db, 200), resolveCredentials(db, env)]);
    const last = runs[0] ?? null;
    const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : 0;
    const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : 0;
    return json({
      config,
      lastRun: last,
      recentRuns: runs,
      equityCurve: curve,
      equityUsd: equity,
      highWaterMarkUsd: hwm,
      drawdownPct: hwm > 0 ? (hwm - equity) / hwm : 0,
      credentials: describeCredentials(resolved),
      notificationsActive: Boolean((resolved.values.telegramBotToken && resolved.values.telegramChatId) || resolved.values.notifyWebhookUrl),
    });
  }

  // GET /agent/runs
  if (route === 'runs' && method === 'GET') {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 30);
    return json({ runs: await listRuns(db, Math.min(Math.max(limit, 1), 200)) });
  }

  // GET /agent/runs/:id
  if (route.startsWith('runs/') && method === 'GET') {
    const bundle = await getRunBundle(db, route.slice('runs/'.length));
    if (!bundle.run) return json({ error: 'run non trovata' }, 404);
    return json(bundle);
  }

  // GET|PUT /agent/config
  if (route === 'config') {
    if (method === 'GET') return json({ config: await loadConfig(db), defaults: DEFAULT_CONFIG });
    if (method === 'PUT') {
      const { patch, rejected } = sanitizeConfigPatch(body);
      if (!Object.keys(patch).length) return json({ error: 'nessuna modifica valida', rejected }, 400);
      const config = await saveConfig(db, patch);
      await audit(db, null, 'info', 'config', 'Configurazione aggiornata', { patch, rejected });
      return json({ config, applied: Object.keys(patch), rejected });
    }
  }

  // POST /agent/mode  { mode, confirm }
  if (route === 'mode' && method === 'POST') {
    const mode = String(body.mode ?? '');
    if (!['shadow', 'dry-run', 'live'].includes(mode)) return json({ error: 'modalità non ammessa' }, 400);
    if (mode === 'live' && body.confirm !== 'ATTIVA ORDINI REALI') {
      return json({ error: 'per la modalità live serve confirm = "ATTIVA ORDINI REALI"' }, 400);
    }
    const { values: credentials } = await resolveCredentials(db, env);
    if (mode === 'live' && !credentials.etoroAgentToken) {
      return json({ error: 'token Agent Portfolio non configurato: impossibile operare in live' }, 400);
    }
    const config = await saveConfig(db, { executionMode: mode });
    await audit(db, null, 'warn', 'config', `Modalità di esecuzione impostata su ${mode}`);
    await notify(credentials, mode === 'live' ? 'critical' : 'info', `Autopilot: modalità ${mode}`, [
      mode === 'live' ? 'Da ora gli ordini vengono inviati davvero su eToro.' : 'Nessun ordine reale verrà inviato.',
    ]);
    return json({ config });
  }

  // POST /agent/freeze | /agent/unfreeze
  if (route === 'freeze' && method === 'POST') {
    const reason = String(body.reason ?? 'freeze manuale').slice(0, 300);
    const config = await saveConfig(db, { frozen: true, frozenReason: reason });
    await audit(db, null, 'warn', 'config', `Agente congelato: ${reason}`);
    return json({ config });
  }
  if (route === 'unfreeze' && method === 'POST') {
    const config = await saveConfig(db, { frozen: false, frozenReason: '' });
    await audit(db, null, 'warn', 'config', 'Agente riattivato');
    return json({ config });
  }

  // POST /agent/trigger { kind, mode }
  if (route === 'trigger' && method === 'POST') {
    const kind = ['snapshot', 'rebalance', 'heartbeat'].includes(body.kind) ? body.kind : 'rebalance';
    const modeOverride = ['shadow', 'dry-run', 'live'].includes(body.mode) ? body.mode : undefined;
    if (modeOverride === 'live' && body.confirm !== 'ATTIVA ORDINI REALI') {
      return json({ error: 'override live richiede confirm = "ATTIVA ORDINI REALI"' }, 400);
    }
    const result = await runPipeline({ env, kind, modeOverride });
    return json(result);
  }

  // GET|PUT|DELETE /agent/credentials
  if (route === 'credentials') {
    if (method === 'GET') {
      return json({ credentials: describeCredentials(await resolveCredentials(db, env)) });
    }
    if (method === 'PUT') {
      const { applied, rejected } = await saveCredentials(db, env, body);
      await audit(db, null, 'warn', 'credentials', `Credenziali aggiornate: ${applied.join(', ') || 'nessuna'}`, { rejected });
      return json({ credentials: describeCredentials(await resolveCredentials(db, env)), applied, rejected });
    }
    if (method === 'DELETE') {
      await clearCredentials(db);
      await audit(db, null, 'warn', 'credentials', 'Vault credenziali svuotato');
      return json({ credentials: describeCredentials(await resolveCredentials(db, env)) });
    }
  }

  // GET /agent/instruments?q=...  — ricerca nel catalogo eToro
  if (route === 'instruments' && method === 'GET') {
    const term = new URL(request.url).searchParams.get('q') ?? '';
    const { values: credentials } = await resolveCredentials(db, env);
    if (!credentials.etoroApiKey || !credentials.etoroUserKey) return json({ error: 'credenziali eToro non configurate' }, 400);
    try {
      const client = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      return json({ results: (await client.searchInstruments(term)).slice(0, 25) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  // GET /agent/agent-portfolios
  if (route === 'agent-portfolios' && method === 'GET') {
    const { values: credentials } = await resolveCredentials(db, env);
    if (!credentials.etoroApiKey || !credentials.etoroUserKey) return json({ error: 'credenziali eToro non configurate' }, 400);
    try {
      const client = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      const portfolios = await client.agentPortfolios();
      return json({ portfolios: portfolios.map(({ raw, ...rest }) => { void raw; return rest; }) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  // POST /agent/agent-token { agentPortfolioId }
  // Genera un nuovo token operativo e lo salva nel vault senza mai restituirlo.
  if (route === 'agent-token' && method === 'POST') {
    const agentPortfolioId = String(body.agentPortfolioId ?? '').trim();
    if (!agentPortfolioId) return json({ error: 'agentPortfolioId obbligatorio' }, 400);
    const { values: credentials } = await resolveCredentials(db, env);
    if (!credentials.etoroApiKey || !credentials.etoroUserKey) return json({ error: 'credenziali eToro non configurate' }, 400);
    try {
      const client = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      const { token, name } = await client.createAgentUserToken(agentPortfolioId);
      await saveCredentials(db, env, { etoroAgentToken: token });
      await audit(db, null, 'warn', 'credentials', `Nuovo token Agent Portfolio generato e salvato (${name})`, { agentPortfolioId });
      return json({
        ok: true,
        tokenName: name,
        hint: `••••${token.slice(-4)}`,
        credentials: describeCredentials(await resolveCredentials(db, env)),
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  // POST /agent/diagnose
  if (route === 'diagnose' && method === 'POST') {
    const [config, resolved] = await Promise.all([loadConfig(db), resolveCredentials(db, env)]);
    const report = await runDiagnostics(resolved, config);
    await audit(db, null, report.ok ? 'info' : 'warn', 'diagnose',
      `Diagnostica: ${report.checks.filter((item) => item.ok === false).length} problemi`,
      report.checks.map(({ id, ok: state, error }) => ({ id, ok: state, error })));
    return json(report);
  }

  // POST /agent/notify-test
  if (route === 'notify-test' && method === 'POST') {
    const { values: credentials } = await resolveCredentials(db, env);
    try {
      return json(await notifyTest(credentials));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // GET /agent/models
  if (route === 'models' && method === 'GET') {
    try {
      const { values: credentials } = await resolveCredentials(db, env);
      return json({ models: await listFreeModels(credentials.openrouterApiKey) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  if (route === 'health' && method === 'GET') {
    return json({ ok: true, at: Date.now() });
  }

  return json({ error: 'rotta non trovata' }, 404);
}
