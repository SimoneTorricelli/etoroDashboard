/**
 * Impostazioni applicazione — persistenza SOLO su localStorage.
 * Le chiavi API non lasciano mai il browser se non verso il proxy configurato.
 */
import type { DataMode } from './data/types';

export type EtoroEnvironment = 'real';
export type ApiPermissions = 'read' | 'write';
export type DisplayCurrency = 'EUR' | 'USD';
export type Density = 'comfy' | 'compact';

export interface LiveSettings {
  apiKey: string;
  userKey: string;
  /** URL del proxy CORS dell'utente (es. Cloudflare Worker). */
  proxyUrl: string;
  environment: EtoroEnvironment;
  permissions: ApiPermissions;
}

export interface AppSettings {
  mode: DataMode;
  live: LiveSettings;
  displayCurrency: DisplayCurrency;
  density: Density;
  /** Soglia target EUR/USD per l'advisor prelievo (modulo FX). */
  fxTargetRate: number;
  /** Chiave opzionale Financial Modeling Prep per il calendario dividendi dichiarati. */
  fmpApiKey: string;
}

const STORAGE_KEY = 'torino.settings.v1';

export const DEFAULT_SETTINGS: AppSettings = {
  mode: 'live',
  live: {
    apiKey: '',
    userKey: '',
    proxyUrl: '',
    environment: 'real',
    permissions: 'read',
  },
  displayCurrency: 'EUR',
  density: 'comfy',
  fxTargetRate: 1.08,
  fmpApiKey: '',
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode: 'live',
      live: { ...DEFAULT_SETTINGS.live, ...(parsed.live ?? {}), environment: 'real' },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* storage pieno/bloccato: ignora */ }
}

/** true se le chiavi Live sono compilate e il proxy è configurato. */
export function hasLiveCredentials(s: AppSettings): boolean {
  return Boolean(s.live.apiKey && s.live.userKey && s.live.proxyUrl);
}

/** true se l'app può inviare ordini REALI (Live + REAL + write). */
export function isRealExecutionActive(s: AppSettings): boolean {
  return s.live.permissions === 'write';
}

/** Chiave mascherata per l'header: mostra solo gli ultimi 4 caratteri. */
export function maskKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}
