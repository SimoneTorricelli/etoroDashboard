import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'plugin-inspect-react-code'
// Same public-data handler as production; no account or trading endpoints in dev.
// @ts-expect-error The Worker is maintained as native JavaScript.
import { incomeReference } from './worker/lib/income-reference.js'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), {
    name: 'income-public-references',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        // Read-only history relay for local development; no trading actions or arbitrary targets.
        if (['/api/v1/trading/info/trade/history', '/api/v1/trading/info/real/pnl'].some(path => url.pathname === `/__etoro-readonly${path}`)) {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) { res.statusCode = 403; res.end(); return; }
          try {
            const headers = new Headers();
            for (const name of ['x-api-key', 'x-user-key', 'x-request-id']) {
              const value = req.headers[name];
              if (typeof value === 'string') headers.set(name, value);
            }
            const response = await fetch(`https://public-api.etoro.com${url.pathname.replace('/__etoro-readonly', '')}${url.search}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
            res.statusCode = response.status;
            res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
            const retryAfter = response.headers.get('retry-after'); if (retryAfter) res.setHeader('retry-after', retryAfter);
            res.end(await response.text());
          } catch { res.statusCode = 502; res.end(JSON.stringify({ error: 'Connessione eToro non disponibile' })); }
          return;
        }
        if (!['/api/income/dividend', '/api/income/fx'].includes(url.pathname)) return next();
        try {
          const response = await incomeReference(new Request(url, { method: req.method }), {});
          res.statusCode = response.status;
          response.headers.forEach((value: string, name: string) => res.setHeader(name, value));
          res.end(await response.text());
        } catch { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'Fonte temporaneamente non disponibile' })); }
      });
    },
  }],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
