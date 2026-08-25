/**
 * Remote MCP server: espone lo stato dell'Autopilot a client come Claude,
 * Cursor o ChatGPT per la supervisione conversazionale.
 *
 * Il loop automatico resta indipendente: qui si legge, si configura e si
 * lancia una run in shadow/dry-run. L'attivazione della modalità live NON è
 * esposta come tool, per scelta.
 */
import { runPipeline } from './pipeline.js';
import {
  equityHistory, getRunBundle, listRuns, loadConfig, mutateSafetyConfig, saveConfig, unfreezeSafetyConfig, audit,
} from './db.js';
import { sanitizeConfigPatch } from './api.js';
import { isDecisionConfigPatch, LIVE_RECOVERY_CONFIRMATION } from './live-plan.js';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * `search` e `fetch` sono il contratto minimo richiesto dai connector ChatGPT:
 * senza di essi il connector viene rifiutato in fase di aggiunta.
 */
const DISCOVERY_TOOLS = [
  {
    name: 'search',
    description: 'Cerca fra run, configurazione e stato dell\'Autopilot eToro. Restituisce documenti con un id da passare a fetch.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Termini di ricerca, oppure un id di run' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'fetch',
    description: 'Recupera il contenuto completo di un documento dell\'Autopilot a partire dall\'id restituito da search.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
];

const TOOLS = [
  {
    name: 'autopilot_get_state',
    description: 'Stato corrente dell\'agente: configurazione, modalità di esecuzione, equity, drawdown e ultime run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'autopilot_list_runs',
    description: 'Elenca le run recenti con esito, modalità ed equity.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Numero massimo di run (default 20)' } }, additionalProperties: false },
  },
  {
    name: 'autopilot_get_run',
    description: 'Dettaglio completo di una run: snapshot, feature, proposta del modello, violazioni dei guardrail, ordini e log.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
  },
  {
    name: 'autopilot_get_config',
    description: 'Configurazione completa: whitelist, guardrail, cadenza, modelli.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'autopilot_update_config',
    description: 'Aggiorna parametri di configurazione. Non può cambiare la modalità di esecuzione né lo stato di freeze.',
    inputSchema: { type: 'object', properties: { patch: { type: 'object', description: 'Oggetto parziale di configurazione' } }, required: ['patch'], additionalProperties: false },
  },
  {
    name: 'autopilot_trigger_run',
    description: 'Lancia una run immediata in modalità shadow o dry-run. Non invia mai ordini reali.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['snapshot', 'rebalance'], description: 'Tipo di run' },
        mode: { type: 'string', enum: ['shadow', 'dry-run'], description: 'Modalità forzata' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'autopilot_freeze',
    description: 'Congela immediatamente l\'agente: nessuna run potrà eseguire ordini finché non viene riattivato.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'autopilot_unfreeze',
    description: 'Rimuove il freeze sull’epoch corrente. Se recoveryRequired è true serve la conferma esatta dopo aver verificato eToro.',
    inputSchema: {
      type: 'object',
      properties: {
        safetyRevision: { type: 'integer', minimum: 0 },
        confirmation: { type: 'string', description: `Se richiesto: ${LIVE_RECOVERY_CONFIRMATION}` },
      },
      required: ['safetyRevision'],
      additionalProperties: false,
    },
  },
];

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolText = (payload) => ({ content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] });

function publicUrl(env, path) {
  const base = String(env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

/** Indice dei documenti interrogabili: stato, configurazione e run. */
async function searchDocuments(env, query) {
  const db = env.DB;
  const term = String(query ?? '').trim().toLowerCase();
  const results = [
    { id: 'state', title: 'Stato corrente dell\'Autopilot', url: publicUrl(env, '/agent/state') },
    { id: 'config', title: 'Configurazione e guardrail', url: publicUrl(env, '/agent/config') },
  ];

  const runs = await listRuns(db, 60);
  const matched = runs.filter((run) => {
    if (!term) return true;
    const when = new Date(run.started_at).toLocaleString('it-IT');
    return `${run.id} ${run.kind} ${run.status} ${run.execution_mode} ${when} ${run.error ?? ''}`.toLowerCase().includes(term);
  });
  // Un termine molto selettivo può non trovare nulla: le run recenti sono
  // comunque una risposta più utile di un risultato vuoto.
  for (const run of (matched.length ? matched : runs).slice(0, 30)) {
    results.push({
      id: `run:${run.id}`,
      title: `Run ${run.kind} del ${new Date(run.started_at).toLocaleString('it-IT')} — ${run.status} (${run.execution_mode})`,
      url: publicUrl(env, `/agent/runs/${run.id}`),
    });
  }
  return { results };
}

async function fetchDocument(env, id) {
  const db = env.DB;
  const key = String(id ?? '');

  if (key === 'state') {
    const [config, runs, curve] = await Promise.all([loadConfig(db), listRuns(db, 10), equityHistory(db, 60)]);
    const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : null;
    const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : null;
    return {
      id: key,
      title: 'Stato corrente dell\'Autopilot',
      url: publicUrl(env, '/agent/state'),
      text: [
        `Modalità di esecuzione: ${config.executionMode}`,
        `Congelato: ${config.frozen ? `sì — ${config.frozenReason}` : 'no'}`,
        `Cadenza: ${config.cadence}, budget ${config.budgetEur} EUR`,
        `Equity: ${equity ?? 'n/d'} USD · massimo storico ${hwm ?? 'n/d'} USD`,
        `Drawdown: ${hwm && equity ? `${(((hwm - equity) / hwm) * 100).toFixed(2)}%` : 'n/d'}`,
        `Universo: ${config.whitelist.map((item) => item.symbol).join(', ')}`,
        '',
        'Run recenti:',
        ...runs.map((run) => `- ${new Date(run.started_at).toLocaleString('it-IT')} ${run.kind} ${run.status} (${run.execution_mode}) equity=${run.equity_usd ?? 'n/d'}${run.error ? ` errore: ${run.error}` : ''}`),
      ].join('\n'),
      metadata: { type: 'state' },
    };
  }

  if (key === 'config') {
    const config = await loadConfig(db);
    return { id: key, title: 'Configurazione e guardrail', url: publicUrl(env, '/agent/config'), text: JSON.stringify(config, null, 2), metadata: { type: 'config' } };
  }

  if (key.startsWith('run:')) {
    const bundle = await getRunBundle(db, key.slice(4));
    if (!bundle.run) throw new Error('run non trovata');
    const proposal = bundle.proposal?.parsed;
    const lines = [
      `Run ${bundle.run.id} — ${bundle.run.kind}, esito ${bundle.run.status}, modalità ${bundle.run.execution_mode}`,
      `Avvio: ${new Date(bundle.run.started_at).toLocaleString('it-IT')}`,
      bundle.run.error ? `Errore: ${bundle.run.error}` : '',
      '',
      bundle.snapshot ? `PORTAFOGLIO equity=${bundle.snapshot.equity_usd} USD cash=${bundle.snapshot.cash_usd} USD investito=${bundle.snapshot.invested_usd} USD` : '',
      bundle.features ? `REGIME ${bundle.features.regime.label} (score ${bundle.features.regime.score}) VIX=${bundle.features.regime.vix} curva=${bundle.features.regime.yieldCurveBp}bp news=${bundle.features.regime.newsNet}` : '',
      bundle.features ? `ALLOCAZIONE ${Object.entries(bundle.features.allocationByClass).map(([klass, weight]) => `${klass}=${(weight * 100).toFixed(1)}%`).join(' ')}` : '',
      '',
      proposal ? `PROPOSTA (modello ${bundle.proposal.model}, confidence ${proposal.confidence})` : `PROPOSTA assente: ${bundle.proposal?.error ?? 'non generata'}`,
      proposal ? `Target: ${Object.entries(proposal.targetWeights).map(([symbol, weight]) => `${symbol} ${(weight * 100).toFixed(1)}%`).join(', ')}` : '',
      proposal ? `Motivazione: ${proposal.rationale}` : '',
      proposal?.risks?.length ? `Rischi: ${proposal.risks.join(' · ')}` : '',
      '',
      bundle.validation ? `GUARDRAIL: ${bundle.validation.ok ? 'piano ammesso' : 'piano bloccato'}` : 'GUARDRAIL non valutati',
      ...(bundle.validation?.violations ?? []).map((item) => `- [${item.severity}] ${item.message}`),
      '',
      'ORDINI:',
      ...(bundle.orders.length ? bundle.orders.map((order) => `- ${order.side} ${order.amount_usd} USD ${order.symbol} → ${order.state}${order.message ? ` (${order.message})` : ''}`) : ['- nessuno']),
      '',
      'LOG:',
      ...bundle.logs.map((log) => `${new Date(log.at).toLocaleTimeString('it-IT')} [${log.level}/${log.stage}] ${log.message}`),
    ];
    return {
      id: key,
      title: `Run ${bundle.run.kind} — ${bundle.run.status}`,
      url: publicUrl(env, `/agent/runs/${bundle.run.id}`),
      text: lines.filter(Boolean).join('\n'),
      metadata: { type: 'run', status: bundle.run.status },
    };
  }

  throw new Error(`id non riconosciuto: ${key}`);
}

async function callTool(env, name, args) {
  const db = env.DB;
  switch (name) {
    // I connector ChatGPT si aspettano il risultato sia come JSON strutturato
    // sia come testo: vengono restituiti entrambi.
    case 'search': {
      const payload = await searchDocuments(env, args?.query);
      return { ...toolText(payload), structuredContent: payload };
    }
    case 'fetch': {
      const payload = await fetchDocument(env, args?.id);
      return { ...toolText(payload), structuredContent: payload };
    }
    case 'autopilot_get_state': {
      const [config, runs, curve] = await Promise.all([loadConfig(db), listRuns(db, 8), equityHistory(db, 60)]);
      const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : null;
      const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : null;
      return toolText({
        executionMode: config.executionMode,
        frozen: config.frozen,
        frozenReason: config.frozenReason,
        cadence: config.cadence,
        budgetEur: config.budgetEur,
        equityUsd: equity,
        highWaterMarkUsd: hwm,
        drawdownPct: hwm ? Number(((hwm - equity) / hwm).toFixed(4)) : null,
        whitelist: config.whitelist.map((item) => item.symbol),
        recentRuns: runs.map((run) => ({ id: run.id, kind: run.kind, status: run.status, mode: run.execution_mode, at: run.started_at, equityUsd: run.equity_usd, error: run.error })),
      });
    }
    case 'autopilot_list_runs':
      return toolText(await listRuns(db, Math.min(Math.max(Number(args?.limit ?? 20), 1), 100)));
    case 'autopilot_get_run': {
      const bundle = await getRunBundle(db, String(args?.runId ?? ''));
      if (!bundle.run) throw new Error('run non trovata');
      return toolText({
        run: bundle.run,
        equityUsd: bundle.snapshot?.equity_usd ?? null,
        regime: bundle.features?.regime ?? null,
        allocation: bundle.features?.allocationByClass ?? null,
        proposal: bundle.proposal?.parsed ?? null,
        modelUsed: bundle.proposal?.model ?? null,
        validation: bundle.validation ? { ok: bundle.validation.ok, violations: bundle.validation.violations, orders: bundle.validation.plan?.orders ?? [] } : null,
        orders: bundle.orders.map((order) => ({ symbol: order.symbol, side: order.side, amountUsd: order.amount_usd, state: order.state, message: order.message })),
        logs: bundle.logs.map((log) => ({ at: log.at, level: log.level, stage: log.stage, message: log.message })),
      });
    }
    case 'autopilot_get_config':
      return toolText(await loadConfig(db));
    case 'autopilot_update_config': {
      const { patch, rejected } = sanitizeConfigPatch(args?.patch);
      if (!Object.keys(patch).length) throw new Error(`nessuna modifica valida. Scartate: ${rejected.join('; ')}`);
      const config = await saveConfig(db, patch, { decisionChange: isDecisionConfigPatch(patch) });
      await audit(db, null, 'info', 'mcp', 'Configurazione aggiornata via MCP', { patch, rejected });
      return toolText({ applied: Object.keys(patch), rejected, config });
    }
    case 'autopilot_trigger_run': {
      const kind = ['snapshot', 'rebalance'].includes(args?.kind) ? args.kind : 'rebalance';
      const mode = args?.mode === 'dry-run' ? 'dry-run' : 'shadow';
      return toolText(await runPipeline({ env, kind, modeOverride: mode }));
    }
    case 'autopilot_freeze': {
      const reason = String(args?.reason ?? 'freeze richiesto via MCP').slice(0, 300);
      const current = await loadConfig(db);
      await audit(db, null, 'warn', 'mcp', `Freeze via MCP: ${reason}`);
      return toolText(await mutateSafetyConfig(db, {
        executionMode: 'shadow',
        frozen: true,
        frozenReason: reason,
        recoveryRequired: true,
        recoveryReason: current.recoveryReason || reason,
        recoveryRunIds: current.recoveryRunIds ?? [],
        recoveryUpdatedAt: Date.now(),
      }));
    }
    case 'autopilot_unfreeze': {
      const current = await loadConfig(db);
      const expectedSafetyRevision = Number(args?.safetyRevision);
      const recoveryConfirmed = args?.confirmation === LIVE_RECOVERY_CONFIRMATION;
      if (!Number.isInteger(expectedSafetyRevision) || expectedSafetyRevision < 0) {
        throw new Error('safetyRevision corrente obbligatoria');
      }
      if (current.recoveryRequired && !recoveryConfirmed) {
        throw new Error(`verifica eToro e conferma con "${LIVE_RECOVERY_CONFIRMATION}"`);
      }
      const config = await unfreezeSafetyConfig(db, { expectedSafetyRevision, recoveryConfirmed });
      if (!config) throw new Error('stato di sicurezza cambiato: rileggi la configurazione e riprova');
      await audit(db, null, 'warn', 'mcp', current.recoveryRequired
        ? 'Unfreeze via MCP dopo conferma verifica eToro'
        : 'Unfreeze via MCP');
      return toolText(config);
    }
    default:
      throw new Error(`tool sconosciuto: ${name}`);
  }
}

export async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'usare POST con payload JSON-RPC 2.0' }), { status: 405, headers: { 'content-type': 'application/json' } });
  }
  const message = await request.json().catch(() => null);
  if (!message || typeof message !== 'object') {
    return new Response(JSON.stringify(rpcError(null, -32700, 'JSON non valido')), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const { id = null, method, params } = message;
  const respond = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

  try {
    switch (method) {
      case 'initialize':
        return respond(rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'torino-autopilot', version: '1.0.0' },
        }));
      case 'notifications/initialized':
        return new Response(null, { status: 204 });
      case 'ping':
        return respond(rpcResult(id, {}));
      case 'tools/list':
        return respond(rpcResult(id, { tools: [...DISCOVERY_TOOLS, ...TOOLS] }));
      case 'tools/call': {
        const name = params?.name;
        try {
          return respond(rpcResult(id, await callTool(env, name, params?.arguments ?? {})));
        } catch (error) {
          return respond(rpcResult(id, { ...toolText(`Errore: ${error instanceof Error ? error.message : String(error)}`), isError: true }));
        }
      }
      default:
        return respond(rpcError(id, -32601, `metodo non supportato: ${method}`));
    }
  } catch (error) {
    return respond(rpcError(id, -32603, error instanceof Error ? error.message : String(error)), 500);
  }
}
