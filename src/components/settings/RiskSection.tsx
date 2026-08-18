/**
 * RiskSection — Impostazioni §5 "Rischio e privacy" (design/settings.md):
 * privacy card (tutto nel browser) + Esporta/Importa configurazione JSON,
 * blocco disclaimer persistente, danger zone con azioni a doppia conferma
 * (Rimuovi chiavi, Ripristina l'app).
 */
import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { useAppData } from '@/lib/data/store';
import { Section } from './common';

const CONFIG_PREFIX = 'torino.';
const SETTINGS_KEY = 'torino.settings.v1';

function withoutSecrets(key: string, value: string): string {
  if (key !== SETTINGS_KEY) return value;
  try {
    const settings = JSON.parse(value) as Record<string, unknown> & { live?: Record<string, unknown> };
    return JSON.stringify({
      ...settings,
      fmpApiKey: '',
      live: { ...(settings.live ?? {}), apiKey: '', userKey: '' },
    });
  } catch {
    return value;
  }
}

function exportConfig() {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(CONFIG_PREFIX)) {
      data[key] = withoutSecrets(key, localStorage.getItem(key) ?? '');
    }
  }
  const blob = new Blob([JSON.stringify({ app: 'torino', exportedAt: new Date().toISOString(), data }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `torino-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function RiskSection() {
  const { updateLiveSettings } = useAppData();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'keys' | 'reset' | null>(null);

  const importConfig = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { data?: Record<string, string> };
      if (!parsed.data || typeof parsed.data !== 'object') throw new Error('formato');
      for (const [key, value] of Object.entries(parsed.data)) {
        if (key.startsWith(CONFIG_PREFIX) && typeof value === 'string') {
          localStorage.setItem(key, withoutSecrets(key, value));
        }
      }
      setImportMsg('Configurazione importata — ricarico l\u2019app…');
      setTimeout(() => window.location.reload(), 900);
    } catch {
      setImportMsg('File non valido: usa un export JSON di questa app.');
    }
  };

  const dangerActions = [
    {
      id: 'keys' as const,
      label: 'Rimuovi chiavi API',
      description: 'Cancella x-api-key e x-user-key dal localStorage.',
      confirmLabel: 'Rimuovi le chiavi',
      run: () => updateLiveSettings({ apiKey: '', userKey: '' }),
    },
    {
      id: 'reset' as const,
      label: 'Ripristina l\u2019app (cancella tutto)',
      description: 'Svuota tutto il localStorage — chiavi, regole, avvisi, preferenze — e ricarica.',
      confirmLabel: 'Cancella tutto e ripristina',
      run: () => { localStorage.clear(); window.location.reload(); },
    },
  ];

  return (
    <Section id="rischio" title="Rischio e privacy" description="Dove vivono i tuoi dati e cosa comporta il trading automatico.">
      {/* Privacy */}
      <div className="card-surface density-pad p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-gain" aria-hidden />
          <div>
            <h3 className="text-body-strong text-text-0">Tutto gira nel tuo browser</h3>
            <p className="mt-1 text-caption text-text-1">
              Chiavi, regole e dati restano in localStorage sul tuo dispositivo. Nessun account, nessun server nostro,
              nessun tracciamento. L’export trasferisce strategie e regole ma rimuove sempre le chiavi API.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={exportConfig}
                className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-caption text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden /> Esporta configurazione senza chiavi
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-caption text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden /> Importa configurazione
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => { void importConfig(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
            {importMsg && <p className="mt-2 text-caption text-info">{importMsg}</p>}
          </div>
        </div>
      </div>

      {/* Disclaimer rischio */}
      <div className="rounded-xl border border-hairline-strong bg-bg-1 p-4">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
          <p className="text-caption text-text-1">
            Questo strumento non è affiliato né approvato da eToro. Non costituisce consulenza finanziaria. Il trading
            e l'esecuzione automatica comportano il rischio di perdere l'intero capitale. Le simulazioni storiche non
            garantiscono risultati futuri.
          </p>
        </div>
      </div>

      {/* Danger zone */}
      <div className="rounded-xl border border-loss/40 p-5">
        <h3 className="text-body-strong text-loss">Danger zone</h3>
        <div className="mt-3 divide-y divide-hairline">
          {dangerActions.map((a) => (
            <div key={a.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-body-strong text-text-0">{a.label}</div>
                  <div className="mt-0.5 text-micro text-text-2">{a.description}</div>
                </div>
                {confirming !== a.id && (
                  <button
                    onClick={() => setConfirming(a.id)}
                    className="shrink-0 rounded-lg border border-loss/40 px-3 py-1.5 text-caption text-loss transition-colors hover:bg-loss-dim"
                  >
                    Esegui
                  </button>
                )}
              </div>
              <AnimatePresence>
                {confirming === a.id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.24 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-loss/30 bg-loss-dim p-3">
                      <span className="w-full text-caption text-loss">Sei sicuro? L'azione è immediata e irreversibile.</span>
                      <button
                        onClick={() => { setConfirming(null); a.run(); }}
                        className="rounded-lg bg-loss px-3 py-1.5 text-caption font-medium text-white transition-colors hover:bg-loss/90"
                      >
                        {a.confirmLabel}
                      </button>
                      <button
                        onClick={() => setConfirming(null)}
                        className="rounded-lg border border-hairline px-3 py-1.5 text-caption text-text-1 transition-colors hover:bg-bg-2"
                      >
                        Annulla
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
