/**
 * ConnectionSection — Impostazioni §1 "Connessione API" (design/settings.md):
 * - Mode card Demo/Live (setMode) con avviso ambra se Live senza chiavi
 * - Form chiavi x-api-key / x-user-key (mono, masked, eye-toggle), salvate
 *   SOLO in localStorage via updateLiveSettings; dopo il salvataggio mostra
 *   la chiave mascherata (maskKey) con Sostituisci / Rimuovi
 * - Radio card Ambiente (Demo/Real) e Permesso (lettura/scrittura)
 * - Pulsante "Testa connessione": fetch portfolio reale via proxy con timing
 *   e hint parsati (401/403/429/rete)
 * - Mini step-list "Dove trovare le chiavi"
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircle2, Eye, EyeOff, FlaskConical, KeyRound, Loader2, Lock, Pencil, ShieldAlert, Trash2, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { hasLiveCredentials, maskKey } from '@/lib/settings';
import type { ApiPermissions, EtoroEnvironment } from '@/lib/settings';
import { Section } from './common';

type TestResult =
  | { ok: true; positions: number; ms: number }
  | { ok: false; message: string };

function hintForStatus(status: number): string {
  if (status === 401 || status === 403) return `${status} — chiavi non valide o permesso insufficiente`;
  if (status === 404) return '404 — endpoint non trovato: verifica l\u2019URL del proxy';
  if (status === 429) return '429 — rate limit eToro: riprova tra poco';
  if (status >= 500) return `${status} — errore del server eToro o del proxy`;
  return `Errore HTTP ${status}`;
}

export function ConnectionSection() {
  const { settings, mode, setMode, updateLiveSettings } = useAppData();
  const live = settings.live;

  /* Form chiavi: editing=true mostra i campi; altrimenti vista mascherata */
  const [editing, setEditing] = useState(!live.apiKey && !live.userKey);
  const [apiKey, setApiKey] = useState(live.apiKey);
  const [userKey, setUserKey] = useState(live.userKey);
  const [showKeys, setShowKeys] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const saveKeys = () => {
    updateLiveSettings({ apiKey: apiKey.trim(), userKey: userKey.trim() });
    setEditing(false);
    setTestResult(null);
  };
  const removeKeys = () => {
    updateLiveSettings({ apiKey: '', userKey: '' });
    setApiKey('');
    setUserKey('');
    setEditing(true);
    setTestResult(null);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const base = live.proxyUrl.replace(/\/+$/, '');
    const envPrefix = live.environment === 'demo' ? 'demo/' : 'real/';
    const url = `${base}/api/v1/trading/info/${envPrefix}pnl`;
    const started = performance.now();
    try {
      const res = await fetch(url, {
        headers: {
          'x-api-key': live.apiKey,
          'x-user-key': live.userKey,
          'x-request-id': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
      });
      const ms = Math.round(performance.now() - started);
      if (!res.ok) {
        setTestResult({ ok: false, message: hintForStatus(res.status) });
      } else {
        const data = (await res.json()) as Record<string, unknown>;
        const nested = data['clientPortfolio'] ?? data['ClientPortfolio'] ?? data['portfolio'] ?? data['Portfolio'];
        const account = nested && typeof nested === 'object' && !Array.isArray(nested)
          ? nested as Record<string, unknown>
          : data;
        const positions = (account['Positions'] ?? account['positions'] ?? []) as unknown[];
        setTestResult({ ok: true, positions: positions.length, ms });
      }
    } catch {
      setTestResult({
        ok: false,
        message: 'Proxy non raggiungibile o bloccato (CORS) — verifica l\u2019URL e che il Worker sia attivo',
      });
    } finally {
      setTesting(false);
    }
  };

  const keysSaved = Boolean(live.apiKey || live.userKey);

  return (
    <Section
      id="connessione"
      title="Connessione API"
      description="Collega il tuo account eToro tramite la Public API ufficiale, oppure resta in modalità Demo."
    >
      {/* Mode card */}
      <div className="card-surface density-pad p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <ModeCard
            active={mode === 'demo'}
            onClick={() => setMode('demo')}
            icon={<FlaskConical className="h-4 w-4 text-info" aria-hidden />}
            title="Demo"
            description="Dati simulati realistici. Tutto funziona senza chiavi."
          />
          <ModeCard
            active={mode === 'live'}
            onClick={() => setMode('live')}
            icon={<Lock className="h-4 w-4 text-gain" aria-hidden />}
            title="Live"
            description="Si collega al tuo account eToro tramite la Public API ufficiale."
          />
        </div>
        <AnimatePresence>
          {mode === 'live' && !hasLiveCredentials(settings) && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.24 }}
              className="mt-3 flex items-center gap-2 overflow-hidden rounded-lg border border-warn/30 bg-[#F5A62314] px-3 py-2 text-caption text-warn"
            >
              <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
              Modalità Live attiva ma mancano chiavi o proxy: l'app userà dati demo finché non completi la configurazione.
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Chiavi */}
      <div className="card-surface density-pad p-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-text-2" aria-hidden />
          <h3 className="text-body-strong text-text-0">Chiavi API</h3>
        </div>

        {keysSaved && !editing ? (
          <div className="mt-3 space-y-2">
            <KeyRow label="x-api-key" masked={maskKey(live.apiKey)} />
            <KeyRow label="x-user-key" masked={maskKey(live.userKey)} />
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { setApiKey(live.apiKey); setUserKey(live.userKey); setEditing(true); }}
                className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-caption text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Sostituisci
              </button>
              <button
                onClick={removeKeys}
                className="flex items-center gap-1.5 rounded-lg border border-loss/30 px-3 py-1.5 text-caption text-loss transition-colors hover:bg-loss-dim"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Rimuovi
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <KeyField
              id="api-key"
              label="x-api-key"
              value={apiKey}
              onChange={setApiKey}
              visible={showKeys}
            />
            <KeyField
              id="user-key"
              label="x-user-key"
              value={userKey}
              onChange={setUserKey}
              visible={showKeys}
            />
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowKeys((v) => !v)}
                className="flex items-center gap-1.5 text-caption text-text-2 transition-colors hover:text-text-1"
              >
                {showKeys ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
                {showKeys ? 'Nascondi' : 'Mostra'} mentre digiti
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveKeys}
                disabled={!apiKey.trim() || !userKey.trim()}
                className="rounded-lg bg-gain px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-gain/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Salva chiavi
              </button>
              {keysSaved && (
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-lg border border-hairline px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2"
                >
                  Annulla
                </button>
              )}
            </div>
          </div>
        )}

        <p className="mt-3 text-micro text-text-2">
          Le chiavi restano solo nel tuo browser (localStorage). Non vengono mai inviate a server nostri — solo a eToro tramite il tuo proxy.
        </p>
      </div>

      {/* Ambiente & permessi */}
      <div className="card-surface density-pad p-5">
        <h3 className="text-body-strong text-text-0">Ambiente e permessi</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className="text-label text-text-1">Ambiente</span>
            <div className="mt-1.5 space-y-2">
              <RadioCard
                active={live.environment === 'demo'}
                onClick={() => updateLiveSettings({ environment: 'demo' satisfies EtoroEnvironment })}
                title="Demo"
                description="Conto virtuale eToro (paper trading)."
              />
              <RadioCard
                active={live.environment === 'real'}
                onClick={() => updateLiveSettings({ environment: 'real' satisfies EtoroEnvironment })}
                title="Real"
                description="Conto reale: operazioni con denaro vero."
                tone="danger"
              />
            </div>
          </div>
          <div>
            <span className="text-label text-text-1">Permesso</span>
            <div className="mt-1.5 space-y-2">
              <RadioCard
                active={live.permissions === 'read'}
                onClick={() => updateLiveSettings({ permissions: 'read' satisfies ApiPermissions })}
                title="Sola lettura"
                description="Solo consultazione di portfolio e mercati."
              />
              <RadioCard
                active={live.permissions === 'write'}
                onClick={() => updateLiveSettings({ permissions: 'write' satisfies ApiPermissions })}
                title="Lettura e scrittura"
                description="Necessario per l'esecuzione ordini dell'Agent."
                tone="warn"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Test connessione */}
      <div className="card-surface density-pad p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={testConnection}
            disabled={testing || !hasLiveCredentials(settings)}
            className="flex items-center gap-2 rounded-lg bg-info px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-info/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {testing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Testa connessione
          </button>
          {!hasLiveCredentials(settings) && (
            <span className="text-caption text-text-2">Servono chiavi e URL proxy salvati.</span>
          )}
        </div>
        <AnimatePresence>
          {testResult && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.24 }}
              className="overflow-hidden"
            >
              <div
                className={cn(
                  'mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-caption',
                  testResult.ok ? 'border-gain/30 bg-gain-dim text-gain' : 'border-loss/30 bg-loss-dim text-loss',
                )}
              >
                {testResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> : <XCircle className="h-4 w-4 shrink-0" aria-hidden />}
                {testResult.ok
                  ? `Connesso — ${testResult.positions} posizioni lette in ${testResult.ms}ms`
                  : testResult.message}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-4 border-t border-hairline pt-3">
          <span className="text-label text-text-1">Dove trovare le chiavi</span>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-caption text-text-1">
            <li>Apri eToro → Impostazioni → Trading → API Keys.</li>
            <li>Genera una coppia di chiavi (public key + user key) con il permesso desiderato.</li>
            <li>
              Documentazione ufficiale:{' '}
              <a
                href="https://api-portal.etoro.com"
                target="_blank"
                rel="noreferrer"
                className="text-info underline-offset-2 hover:underline"
              >
                api-portal.etoro.com
              </a>
            </li>
          </ol>
        </div>
      </div>
    </Section>
  );
}

function ModeCard({ active, onClick, icon, title, description }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-xl border p-4 text-left transition-colors duration-300',
        active ? 'border-gain/50 bg-gain/5' : 'border-hairline hover:border-hairline-strong hover:bg-bg-2',
      )}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-body-strong text-text-0">{title}</span>
        {active && <CheckCircle2 className="ml-auto h-4 w-4 text-gain" aria-hidden />}
      </div>
      <p className="mt-1.5 text-caption text-text-1">{description}</p>
    </button>
  );
}

function RadioCard({ active, onClick, title, description, tone }: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
  tone?: 'danger' | 'warn';
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors duration-300',
        active
          ? tone === 'danger'
            ? 'border-loss/60 bg-loss-dim'
            : tone === 'warn'
              ? 'border-warn/60 bg-[#F5A62314]'
              : 'border-gain/50 bg-gain/5'
          : 'border-hairline hover:border-hairline-strong hover:bg-bg-2',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-body-strong text-text-0">{title}</span>
        {tone === 'danger' && <ShieldAlert className="h-3.5 w-3.5 text-loss" aria-hidden />}
        {active && <CheckCircle2 className={cn('ml-auto h-4 w-4', tone === 'danger' ? 'text-loss' : tone === 'warn' ? 'text-warn' : 'text-gain')} aria-hidden />}
      </div>
      <p className="mt-1 text-micro text-text-1">{description}</p>
    </button>
  );
}

function KeyRow({ label, masked }: { label: string; masked: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline bg-bg-2/50 px-3 py-2">
      <span className="font-mono text-ticker text-text-2">{label}</span>
      <span className="font-mono text-ticker text-text-0">{masked}</span>
    </div>
  );
}

function KeyField({ id, label, value, onChange, visible }: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  visible: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-label text-text-1">{label}</label>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="••••••••••••"
        className="mt-1.5 w-full rounded-lg border border-hairline bg-bg-3 px-3 py-2 font-mono text-ticker text-text-0 outline-none transition-colors duration-150 focus:border-hairline-strong focus:ring-1 focus:ring-info/40"
      />
    </div>
  );
}
