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
