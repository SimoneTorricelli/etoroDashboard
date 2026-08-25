/**
 * Entry point del Worker "Torino".
 *
 * Tre responsabilità:
 *  1. proxy CORS verso la eToro Public API per la dashboard (contratto legacy
 *     invariato, ma con origini ora ristrette);
 *  2. Autopilot: API di controllo `/agent/*` e pipeline schedulata via cron;
 *  3. remote MCP server su `/mcp` per la supervisione conversazionale.
 *
 * Le credenziali dell'Autopilot vivono esclusivamente nei Worker Secrets.
 */
import { handleAgentApi, isAuthorized, safeEqual } from './lib/api.js';
import { handleMcp } from './lib/mcp.js';
import { decideKind, romeParts, runPipeline } from './lib/pipeline.js';
import { migrate, loadConfig } from './lib/db.js';

const ETORO_BASES = {
  v1: 'https://public-api.etoro.com/api/v1',
  v2: 'https://public-api.etoro.com/api/v2',
};
const PASS_HEADERS = ['x-api-key', 'x-user-key', 'x-request-id', 'content-type'];

let migrated = false;
async function ensureSchema(env) {
  if (migrated || !env.DB) return;
  await migrate(env.DB);
  migrated = true;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Header CORS se l'origine è ammessa, `null` se va bloccata, oggetto vuoto per
 * richieste same-origin o server-to-server.
 */
function corsHeaders(request, env, extraAllowedHeaders = []) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const allowList = allowedOrigins(env);
  const selfOrigin = new URL(request.url).origin;
  if (origin !== selfOrigin && !allowList.includes(origin) && !allowList.includes('*')) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': [...PASS_HEADERS, 'authorization', ...extraAllowedHeaders].join(', '),
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set('X-Content-Type-Options', 'nosniff');
  merged.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

const forbidden = () => new Response(JSON.stringify({ error: 'origine non consentita' }), {
  status: 403,
  headers: { 'content-type': 'application/json' },
});

/**
 * Impedisce che il fallback SPA venga spacciato per un asset JS o CSS non più
 * presente durante il passaggio fra due deploy.
 */
export async function serveStaticAsset(request, env) {
  const url = new URL(request.url);
  const response = await env.ASSETS.fetch(request);
  const contentType = response.headers.get('content-type') ?? '';
  if (url.pathname.startsWith('/assets/') && contentType.includes('text/html')) {
    return new Response('Asset non disponibile: ricarica la pagina.', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const headers = new Headers(response.headers);
  if (contentType.includes('text/html')) headers.set('cache-control', 'no-store');
  if (url.pathname.startsWith('/assets/')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('x-content-type-options', 'nosniff');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyEtoro(request, env, url) {
  const cors = corsHeaders(request, env);
  if (cors === null) return forbidden();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const version = url.pathname.startsWith('/api/v2/') ? 'v2' : 'v1';
  const path = url.pathname.replace(/^\/api\/v[12]\//, '');
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Il proxy non aggiunge mai credenziali proprie: chi non le porta non passa.
  if (!headers.has('x-api-key') || !headers.has('x-user-key')) {
    return withHeaders(new Response(JSON.stringify({ error: 'credenziali eToro assenti' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }), cors);
  }

  try {
    const upstream = await fetch(`${ETORO_BASES[version]}/${path}${url.search}`, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
    return withHeaders(upstream, cors);
  } catch (error) {
    return withHeaders(new Response(JSON.stringify({
      error: 'eToro upstream request failed',
      message: error instanceof Error ? error.message : String(error),
    }), { status: 502, headers: { 'content-type': 'application/json' } }), cors);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/api/v2/')) {
      return proxyEtoro(request, env, url);
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      const cors = corsHeaders(request, env, ['mcp-session-id', 'mcp-protocol-version']);
      if (cors === null) return forbidden();
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      // I connector ChatGPT non permettono header personalizzati: si accetta il
      // token anche come segmento di path (/mcp/<CONTROL_TOKEN>).
      const pathToken = url.pathname.slice('/mcp/'.length);
      const authorized = isAuthorized(request, env)
        || (pathToken && env.CONTROL_TOKEN && safeEqual(pathToken, env.CONTROL_TOKEN));
      if (!authorized) {
        return withHeaders(new Response(JSON.stringify({ error: 'non autorizzato' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'WWW-Authenticate': 'Bearer' },
        }), cors);
      }
      await ensureSchema(env);
      return withHeaders(await handleMcp(request, env), cors);
    }

    if (url.pathname.startsWith('/agent')) {
      const cors = corsHeaders(request, env);
      if (cors === null) return forbidden();
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      await ensureSchema(env);
      return withHeaders(await handleAgentApi(request, env, ctx, url.pathname), cors);
    }

    return serveStaticAsset(request, env);
  },

  /**
   * Cron ogni 15 minuti. Il tipo di run è deciso sull'ora locale Europe/Rome,
   * così il passaggio ora legale/solare non sposta il ribilanciamento.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.DB) return;
      await ensureSchema(env);
      const config = await loadConfig(env.DB);
      const parts = romeParts(new Date(event.scheduledTime));
      const kind = decideKind(config, parts);
      if (kind === null) return;
      if (kind === 'heartbeat' && config.frozen) return;
      await runPipeline({ env, kind });
    })());
  },
};
