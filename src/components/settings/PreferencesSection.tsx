/**
 * PreferencesSection — Impostazioni §4 "Preferenze" (design/settings.md):
 * righe label+controllo con divisori hairline: valuta di display (EUR/USD),
 * densità, notifiche browser, suoni tick, riduci animazioni, intervallo
 * aggiornamento demo, reimposta dati demo, cancella dati locali.
 * Ogni modifica mostra un "Salvato ✓" transiente.
 */
import { useState } from 'react';
import { RefreshCcw, Trash2 } from 'lucide-react';
import { useAppData } from '@/lib/data/store';
import { Switch } from '@/components/ui/switch';
import { SavedCaption, Section, Segmented } from './common';
import { useSavedFeedback } from './useSavedFeedback';

/* Preferenze locali (non nello store globale): localStorage diretto */
const PREFS = {
  sounds: 'torino.prefs.sounds',
  reducedMotion: 'torino.prefs.reducedMotion',
  demoInterval: 'torino.prefs.demoIntervalMs',
} as const;

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function saveBool(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignora */ }
}

function loadInterval(): string {
  try { return localStorage.getItem(PREFS.demoInterval) ?? '1500'; } catch { return '1500'; }
}

export function PreferencesSection() {
  const { displayCurrency, setDisplayCurrency, density, setDensity, refresh } = useAppData();
  const [savedVisible, triggerSaved] = useSavedFeedback();

  const [notificationsOn, setNotificationsOn] = useState(
    () => typeof Notification !== 'undefined' && Notification.permission === 'granted',
  );
  const [sounds, setSounds] = useState(() => loadBool(PREFS.sounds, false));
  const [reducedMotion, setReducedMotion] = useState(
    () => loadBool(PREFS.reducedMotion, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false),
  );
  const [demoInterval, setDemoInterval] = useState(loadInterval);
  const [confirmClear, setConfirmClear] = useState(false);
  const [demoResetDone, setDemoResetDone] = useState(false);

  const notifPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  const toggleNotifications = async (on: boolean) => {
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      setNotificationsOn(perm === 'granted');
    } else {
      setNotificationsOn(on);
    }
    triggerSaved();
  };

  return (
    <Section id="preferenze" title="Preferenze" description="Valuta, densità e comportamento dell'app.">
      <div className="card-surface density-pad divide-y divide-hairline p-5">
        <PrefRow label="Valuta di visualizzazione" hint="Applicata a tutti i valori dell'app.">
          <Segmented
            ariaLabel="Valuta di visualizzazione"
            options={[{ value: 'EUR', label: 'EUR (€)' }, { value: 'USD', label: 'USD ($)' }]}
            value={displayCurrency}
            onChange={(v) => { setDisplayCurrency(v); triggerSaved(); }}
          />
        </PrefRow>

        <PrefRow label="Densità" hint="Comoda: righe 44px · Compatta: righe 34px.">
          <Segmented
            ariaLabel="Densità interfaccia"
            options={[{ value: 'comfy', label: 'Comoda' }, { value: 'compact', label: 'Compatta' }]}
            value={density}
            onChange={(v) => { setDensity(v); triggerSaved(); }}
          />
        </PrefRow>

        <PrefRow
          label="Notifiche browser"
          hint={
            notifPermission === 'denied'
              ? 'Bloccate dal browser: riattivale dalle impostazioni del sito.'
              : notifPermission === 'unsupported'
                ? 'Non supportate da questo browser.'
                : 'Per gli avvisi di cambio e gli eventi dell\u2019Agent.'
          }
        >
          <Switch
            checked={notificationsOn}
            onCheckedChange={(v) => void toggleNotifications(v)}
            disabled={notifPermission === 'denied' || notifPermission === 'unsupported'}
            aria-label="Notifiche browser"
          />
        </PrefRow>

        <PrefRow label="Suoni tick" hint="Feedback sonoro sui tick di prezzo (spento di default).">
          <Switch
            checked={sounds}
            onCheckedChange={(v) => { setSounds(v); saveBool(PREFS.sounds, v); triggerSaved(); }}
            aria-label="Suoni tick"
          />
        </PrefRow>

        <PrefRow label="Riduci animazioni" hint="Ricalca prefers-reduced-motion: disattiva flash e ticker.">
          <Switch
            checked={reducedMotion}
            onCheckedChange={(v) => { setReducedMotion(v); saveBool(PREFS.reducedMotion, v); triggerSaved(); }}
            aria-label="Riduci animazioni"
          />
        </PrefRow>

        <PrefRow label="Intervallo aggiornamento demo" hint="Frequenza dei tick simulati in modalità Demo.">
          <Segmented
            ariaLabel="Intervallo aggiornamento demo"
            options={[{ value: '1000', label: '1s' }, { value: '2000', label: '2s' }, { value: '5000', label: '5s' }]}
            value={demoInterval}
            onChange={(v) => {
              setDemoInterval(v);
              try { localStorage.setItem(PREFS.demoInterval, v); } catch { /* ignora */ }
              triggerSaved();
            }}
          />
        </PrefRow>

        <PrefRow label="Reimposta dati demo" hint="Ricarica portfolio e quotazioni simulate dal provider.">
          <button
            onClick={() => {
              void refresh();
              setDemoResetDone(true);
              setTimeout(() => setDemoResetDone(false), 1500);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-caption text-text-1 transition-colors hover:bg-bg-2 hover:text-text-0"
          >
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
            {demoResetDone ? 'Dati ricaricati' : 'Reimposta'}
          </button>
        </PrefRow>

        <PrefRow label="Cancella dati locali" hint="Svuota il localStorage (chiavi, regole, avvisi) e ricarica l'app.">
          {confirmClear ? (
            <span className="flex items-center gap-2">
              <button
                onClick={() => { localStorage.clear(); window.location.reload(); }}
                className="rounded-lg bg-loss px-3 py-1.5 text-caption font-medium text-white transition-colors hover:bg-loss/90"
              >
                Conferma cancellazione
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="rounded-lg border border-hairline px-3 py-1.5 text-caption text-text-1 transition-colors hover:bg-bg-2"
              >
                Annulla
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 rounded-lg border border-loss/40 px-3 py-1.5 text-caption text-loss transition-colors hover:bg-loss-dim"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Cancella tutto
            </button>
          )}
        </PrefRow>
      </div>

      <div className="flex justify-end">
        <SavedCaption visible={savedVisible} />
      </div>
    </Section>
  );
}

function PrefRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-body-strong text-text-0">{label}</div>
        {hint && <div className="mt-0.5 text-micro text-text-2">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
