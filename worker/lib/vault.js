/**
 * Vault delle credenziali.
 *
 * Il cron gira senza browser: le credenziali devono quindi vivere lato server.
 * Sono ammesse due sorgenti, nell'ordine:
 *   1. vault cifrato su D1 (configurabile dalla dashboard);
 *   2. Worker Secrets (fallback, immutabile a runtime).
 *
 * Il vault è cifrato con AES-GCM; la chiave deriva da `VAULT_KEY` (o, in sua
 * assenza, da `CONTROL_TOKEN`). Chi legge il database senza quel secret non
 * ottiene nulla di utile.
 */

const VAULT_ROW = 'vault';

/** Campi ammessi nel vault. L'ordine è quello mostrato in dashboard. */
export const CREDENTIAL_FIELDS = [
  { key: 'etoroApiKey', env: 'ETORO_API_KEY', label: 'eToro API key', required: true },
  { key: 'etoroUserKey', env: 'ETORO_USER_KEY', label: 'eToro user key', required: true },
  { key: 'etoroAgentToken', env: 'ETORO_AGENT_TOKEN', label: 'Token Agent Portfolio', required: false },
  { key: 'openrouterApiKey', env: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', required: false },
  { key: 'geminiApiKey', env: 'GEMINI_API_KEY', label: 'Google Gemini API key', required: false },
  { key: 'groqApiKey', env: 'GROQ_API_KEY', label: 'Groq API key', required: false },
  { key: 'telegramBotToken', env: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', required: false },
  { key: 'telegramChatId', env: 'TELEGRAM_CHAT_ID', label: 'Telegram chat id', required: false },
  { key: 'notifyWebhookUrl', env: 'NOTIFY_WEBHOOK_URL', label: 'Webhook notifiche', required: false },
  { key: 'finnhubKey', env: 'FINNHUB_API_KEY', label: 'Finnhub API key', required: false },
  { key: 'marketauxKey', env: 'MARKETAUX_API_KEY', label: 'Marketaux API key', required: false },
  { key: 'fmpKey', env: 'FMP_API_KEY', label: 'Financial Modeling Prep API key', required: false },
];

const FIELD_KEYS = new Set(CREDENTIAL_FIELDS.map((field) => field.key));

async function aesKey(env) {
  const material = env.VAULT_KEY || env.CONTROL_TOKEN;
  if (!material) throw new Error('serve VAULT_KEY (o almeno CONTROL_TOKEN) per cifrare il vault');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`torino-vault:v1:${material}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function seal(env, payload) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
  const blob = new Uint8Array(iv.length + cipher.length);
  blob.set(iv, 0);
  blob.set(cipher, iv.length);
  return toBase64(blob);
}

async function open(env, blob) {
  const key = await aesKey(env);
  const bytes = fromBase64(blob);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function readVault(db, env) {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(VAULT_ROW).first();
  if (!row?.value) return {};
  try {
    return await open(env, row.value);
  } catch {
    // Chiave cambiata o dato corrotto: si ricade sui Worker Secrets.
    return {};
  }
}

/**
 * Sovrascrive i soli campi presenti nella patch. Una stringa vuota cancella
 * il campo dal vault e riabilita l'eventuale Worker Secret.
 */
export async function saveCredentials(db, env, patch) {
  const current = await readVault(db, env);
  const applied = [];
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!FIELD_KEYS.has(key)) { rejected.push(`${key}: campo sconosciuto`); continue; }
    const text = String(value ?? '').trim();
    if (text) current[key] = text.slice(0, 4000); else delete current[key];
    applied.push(key);
  }
  await db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(VAULT_ROW, await seal(env, current), Date.now())
    .run();
  return { applied, rejected };
}

export async function clearCredentials(db) {
  await db.prepare('DELETE FROM config WHERE key = ?').bind(VAULT_ROW).run();
}

/**
 * Credenziali effettive più la provenienza di ciascun campo.
 * @returns {Promise<{values: object, origin: Record<string,'vault'|'env'|null>}>}
 */
export async function resolveCredentials(db, env) {
  const vault = db ? await readVault(db, env) : {};
  const values = {};
  const origin = {};
  for (const field of CREDENTIAL_FIELDS) {
    const fromVault = vault[field.key];
    const fromEnv = env[field.env];
    if (fromVault) { values[field.key] = fromVault; origin[field.key] = 'vault'; }
    else if (fromEnv) { values[field.key] = fromEnv; origin[field.key] = 'env'; }
    else { values[field.key] = ''; origin[field.key] = null; }
  }
  return { values, origin };
}

const mask = (value) => (value ? `••••${value.slice(-4)}` : '');

/** Vista sicura per la dashboard: presenza, provenienza e ultime 4 cifre. */
export function describeCredentials({ values, origin }) {
  return CREDENTIAL_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    required: field.required,
    configured: Boolean(values[field.key]),
    origin: origin[field.key],
    hint: mask(values[field.key]),
  }));
}

/** Elenco dei campi obbligatori mancanti, per bloccare le run in anticipo. */
export function missingRequired(values) {
  return CREDENTIAL_FIELDS.filter((field) => field.required && !values[field.key]).map((field) => field.label);
}
