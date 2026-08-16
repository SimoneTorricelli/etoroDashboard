const ETORO_BASES = {
  v1: 'https://public-api.etoro.com/api/v1',
  v2: 'https://public-api.etoro.com/api/v2',
};
const PASS_HEADERS = ['x-api-key', 'x-user-key', 'x-request-id', 'content-type'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': PASS_HEADERS.join(', '),
  'Access-Control-Max-Age': '86400',
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Wrangler routes /api/* to this handler first. All other requests are
    // served by the dashboard static assets.
    if (!url.pathname.startsWith('/api/v1/') && !url.pathname.startsWith('/api/v2/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const version = url.pathname.startsWith('/api/v2/') ? 'v2' : 'v1';
    const path = url.pathname.replace(/^\/api\/v[12]\//, '');
    const headers = new Headers();
    for (const name of PASS_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    try {
      const response = await fetch(`${ETORO_BASES[version]}/${path}${url.search}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });
      return withCors(response);
    } catch (error) {
      return withCors(new Response(JSON.stringify({
        error: 'eToro upstream request failed',
        message: error instanceof Error ? error.message : String(error),
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }));
    }
  },
};
