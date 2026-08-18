/**
 * ProxySection — Impostazioni §2 "Proxy CORS" (design/settings.md):
 * explainer, guida in 3 step con blocco codice copiabile (Cloudflare Worker
 * ~45 righe: inoltra /api/v1/* e /api/v2/* alla versione eToro corretta
 * passando x-api-key, x-user-key, x-request-id + CORS * e preflight OPTIONS),
 * input URL proxy + "Verifica proxy", nota di sicurezza ambra.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, CheckCircle2, Copy, Info, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { Section } from './common';

const WORKER_CODE = `// Cloudflare Worker — proxy CORS per la eToro Public API.
// Accetta /api/v1/* e /api/v2/* e conserva la versione dell'endpoint
// passando gli header x-api-key, x-user-key, x-request-id.
// Risponde con Access-Control-Allow-Origin: * e gestisce il preflight OPTIONS.

const ETORO_BASES = {
  v1: 'https://public-api.etoro.com/api/v1',
  v2: 'https://public-api.etoro.com/api/v2',
};
const PASS_HEADERS = ['x-api-key', 'x-user-key', 'x-request-id', 'content-type'];

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': PASS_HEADERS.join(', '),
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/v1/') && !url.pathname.startsWith('/api/v2/')) {
      return new Response(JSON.stringify({ error: 'Endpoint non supportato' }), {
        status: 404,
        headers: { ...cors, 'content-type': 'application/json' },
      });
    }
    const version = url.pathname.startsWith('/api/v2/') ? 'v2' : 'v1';
    const path = url.pathname.replace(/^\\/api\\/v[12]\\//, '');
    const headers = new Headers();
    for (const h of PASS_HEADERS) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const res = await fetch(\`\${ETORO_BASES[version]}/\${path}\${url.search}\`, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
    return new Response(res.body, { status: res.status, headers: { ...cors, 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  },
};`;

type VerifyResult = { ok: boolean; message: string };

export function ProxySection() {
  const { settings, updateLiveSettings } = useAppData();
  const live = settings.live;
  const [urlRaw, setUrlRaw] = useState(settings.live.proxyUrl);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(WORKER_CODE);
    } catch {
      /* fallback: selezione manuale */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveUrl = () => {
    updateLiveSettings({ proxyUrl: urlRaw.trim() });
  };

  const verifyProxy = async () => {
    const base = urlRaw.trim().replace(/\/+$/, '');
    setVerifying(true);
    setVerifyResult(null);
    if (!/^https:\/\//.test(base)) {
      setVerifyResult({ ok: false, message: 'L\u2019URL deve iniziare con https://' });
      setVerifying(false);
      return;
    }
    try {
      const headers = live.apiKey && live.userKey ? {
        'x-api-key': live.apiKey,
        'x-user-key': live.userKey,
        'x-request-id': crypto.randomUUID(),
      } : undefined;
      const [v1, v2] = await Promise.all([
        fetch(`${base}/api/v1/trading/info/real/pnl`, { method: 'GET', headers }),
        fetch(`${base}/api/v2/agent-portfolios/user-tokens/scopes`, { method: 'GET', headers }),
      ]);
      const v1Usable = v1.ok || (!headers && v1.status === 401);
      const v2Usable = v2.ok || (!headers && v2.status === 401);
      if (!v1Usable || !v2Usable) {
        setVerifyResult({
          ok: false,
          message: `Proxy raggiungibile, ma API v1/v2 non utilizzabili (HTTP ${v1.status}/${v2.status}). Aggiorna il Worker o verifica i permessi delle chiavi.`,
        });
        return;
      }
      setVerifyResult({
        ok: true,
        message: `Proxy compatibile v1/v2 (HTTP ${v1.status}/${v2.status}) — CORS gestito correttamente.`,
      });
      saveUrl();
    } catch {
      setVerifyResult({
        ok: false,
        message: 'Proxy non raggiungibile o CORS non gestito — ricontrolla il codice del Worker.',
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Section
      id="proxy"
      title="Proxy CORS"
      description="L'API eToro non accetta chiamate dirette dal browser: serve un piccolo proxy sul tuo account."
    >
      {/* Explainer */}
      <div className="flex items-start gap-3 rounded-xl border border-info/30 bg-info/10 p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
        <p className="text-body text-text-0">
          L'API eToro non accetta chiamate dirette dal browser (CORS). Serve un piccolo proxy: un{' '}
          <span className="font-semibold">Cloudflare Worker gratuito</span> che gira sul TUO account e inoltra le
          richieste a eToro aggiungendo gli header CORS.
        </p>
      </div>

      {/* Step guidati */}
      <div className="card-surface density-pad p-5">
        <ol className="space-y-5">
          <Step n={1} title="Crea il Worker">
            Crea un account Cloudflare gratuito e apri{' '}
            <span className="font-medium text-text-0">Workers → Create Worker</span>. Incolla il codice qui sotto e
            premi <span className="font-medium text-text-0">Deploy</span>.
          </Step>
          <Step n={2} title="Copia questo codice nel Worker">
            <div className="relative mt-2 overflow-hidden rounded-lg border border-hairline bg-bg-2">
              <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5">
                <span className="font-mono text-micro text-text-2">worker.js</span>
                <button
                  onClick={copyCode}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-micro transition-colors',
                    copied ? 'bg-gain/15 text-gain' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
                  )}
                >
                  {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  {copied ? 'Copiato ✓' : 'Copia'}
                </button>
              </div>
              <pre className="max-h-80 overflow-auto p-3 font-mono text-[12px] leading-5 text-text-1">
                <code>{WORKER_CODE}</code>
              </pre>
            </div>
          </Step>
          <Step n={3} title="Incolla l'URL del tuo Worker qui">
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={urlRaw}
                onChange={(e) => setUrlRaw(e.target.value)}
                onBlur={saveUrl}
                placeholder="https://etoro-proxy.tuo-utente.workers.dev"
                aria-label="URL del proxy Cloudflare Worker"
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-bg-3 px-3 py-2 font-mono text-ticker text-text-0 outline-none transition-colors duration-150 focus:border-hairline-strong focus:ring-1 focus:ring-info/40"
              />
              <button
                onClick={verifyProxy}
                disabled={verifying || !urlRaw.trim()}
                className="flex items-center gap-2 rounded-lg bg-info px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-info/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {verifying && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Verifica proxy
              </button>
            </div>
            <AnimatePresence>
              {verifyResult && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.24 }}
                  className="overflow-hidden"
                >
                  <div
                    className={cn(
                      'mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-caption',
                      verifyResult.ok ? 'border-gain/30 bg-gain-dim text-gain' : 'border-loss/30 bg-loss-dim text-loss',
                    )}
                  >
                    {verifyResult.ok
                      ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                      : <XCircle className="h-4 w-4 shrink-0" aria-hidden />}
                    {verifyResult.message}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Step>
        </ol>
      </div>

      {/* Nota sicurezza */}
      <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-[#F5A62314] p-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
        <p className="text-caption text-text-0">
          Il proxy vede le tue chiavi in transito. Usa solo un Worker che controlli tu. Il codice qui sopra è completo
          e verificabile riga per riga.
        </p>
      </div>
    </Section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-info/40 bg-info/10 font-display text-body-strong text-info">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-body-strong text-text-0">{title}</h3>
        <div className="mt-1 text-caption text-text-1">{children}</div>
      </div>
    </li>
  );
}
