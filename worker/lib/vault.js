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

import { CONFIG_KEY, loadConfig } from './db.js';

const VAULT_ROW = 'vault';
const AGENT_BINDING_ROW = '__etoroAgentBinding';

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
const ETORO_CREDENTIAL_KEYS = new Set(['etoroApiKey', 'etoroUserKey', 'etoroAgentToken']);

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

/** Impronta non reversibile usata per legare il segreto al portfolio verificato. */
export async function credentialFingerprint(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`torino-agent-token:v1:${text}`)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Lega il token Agent anche alla coppia owner/API usata per crearlo e
 * verificarlo. L'impronta resta nel vault cifrato e non espone i segreti.
 */
export async function etoroCredentialSetFingerprint({ etoroApiKey, etoroUserKey, etoroAgentToken }) {
  const parts = [etoroApiKey, etoroUserKey, etoroAgentToken].map((value) => String(value ?? ''));
  if (parts.some((value) => !value)) return '';
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`torino-etoro-credentials:v1:${JSON.stringify(parts)}`),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readVaultRecord(db, env) {
  if (!db) {
    return { payload: {}, revision: { exists: false, value: '', updatedAt: 0 } };
  }
  const row = await db.prepare('SELECT value, updated_at FROM config WHERE key = ?').bind(VAULT_ROW).first();
  const revision = row?.value
    ? { exists: true, value: String(row.value), updatedAt: Number(row.updated_at) || 0 }
    : { exists: false, value: '', updatedAt: 0 };
  if (!row?.value) return { payload: {}, revision };
  try {
    return { payload: await open(env, row.value), revision };
  } catch {
    // Chiave cambiata o dato corrotto: si ricade sui Worker Secrets.
    return { payload: {}, revision };
  }
}

function sameVaultRevision(left, right) {
  return Boolean(left?.exists) === Boolean(right?.exists)
    && String(left?.value ?? '') === String(right?.value ?? '')
    && Number(left?.updatedAt ?? 0) === Number(right?.updatedAt ?? 0);
}

async function writeVaultIfUnchanged(db, expected, value, updatedAt) {
  const expectedExists = expected?.exists ? 1 : 0;
  const expectedValue = expected?.exists ? String(expected.value) : '';
  const expectedUpdatedAt = expected?.exists ? Number(expected.updatedAt) : 0;
  const row = await db.prepare(`INSERT INTO config (key, value, updated_at)
    SELECT ?, ?, ?
    WHERE (
      ? = 0 AND NOT EXISTS (SELECT 1 FROM config vault WHERE vault.key = ?)
    ) OR (
      ? = 1 AND EXISTS (
        SELECT 1 FROM config vault
        WHERE vault.key = ? AND vault.value = ? AND vault.updated_at = ?
      )
    )
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    WHERE ? = 1 AND config.value = ? AND config.updated_at = ?
    RETURNING value, updated_at`)
    .bind(
      VAULT_ROW,
      value,
      updatedAt,
      expectedExists,
      VAULT_ROW,
      expectedExists,
      VAULT_ROW,
      expectedValue,
      expectedUpdatedAt,
      expectedExists,
      expectedValue,
      expectedUpdatedAt,
    )
    .first();
  return row?.value === value && Number(row.updated_at) === Number(updatedAt);
}

/**
 * Sovrascrive i soli campi presenti nella patch. Una stringa vuota cancella
 * il campo dal vault e riabilita l'eventuale Worker Secret.
 */
export async function saveCredentials(db, env, patch) {
  const applied = [];
  const rejected = [];
  const operations = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!FIELD_KEYS.has(key)) { rejected.push(`${key}: campo sconosciuto`); continue; }
    const text = String(value ?? '').trim();
    operations.push({ key, value: text ? text.slice(0, 4000) : '' });
    applied.push(key);
  }
  if (!operations.length) return { applied, rejected };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { payload, revision } = await readVaultRecord(db, env);
    const next = { ...payload };
    for (const operation of operations) {
      if (operation.value) next[operation.key] = operation.value;
      else delete next[operation.key];
    }
    // Qualunque modifica eToro non eredita mai la verifica precedente. La
    // relazione portfolio↔credenziali viene ricreata solo dal flusso ufficiale.
    if (operations.some(({ key }) => ETORO_CREDENTIAL_KEYS.has(key))) {
      delete next[AGENT_BINDING_ROW];
    }
    const now = Date.now();
    const sealed = await seal(env, next);
    if (await writeVaultIfUnchanged(db, revision, sealed, now)) {
      return { applied, rejected };
    }
  }
  throw new Error('vault credenziali modificato contemporaneamente: aggiorna lo stato e riprova');
}

/**
 * Salva segreto, binding verificato e vista Autopilot in una singola transazione
 * D1, soltanto se il vault osservato prima delle chiamate eToro è ancora lo
 * stesso. Una rotazione concorrente vince e obbliga a ripetere la verifica.
 */
export async function saveVerifiedAgentToken(db, env, {
  token, etoroApiKey, etoroUserKey, portfolioId, portfolioName = '', mirrorId = '', virtualBalanceUsd = 0,
  verifiedAt = Date.now(), currentConfig, expectedVaultRevision,
}) {
  const cleanToken = String(token ?? '').trim();
  const cleanPortfolioId = String(portfolioId ?? '').trim();
  if (!cleanToken || !cleanPortfolioId) throw new Error('token e portfolioId sono obbligatori');
  if (!db?.batch) throw new Error('D1 batch non disponibile: binding Agent non salvato');
  if (!expectedVaultRevision || typeof expectedVaultRevision !== 'object') {
    throw new Error('revisione vault obbligatoria per salvare il binding Agent');
  }

  const fingerprint = await credentialFingerprint(cleanToken);
  const credentialsFingerprint = await etoroCredentialSetFingerprint({
    etoroApiKey,
    etoroUserKey,
    etoroAgentToken: cleanToken,
  });
  if (!credentialsFingerprint) throw new Error('credenziali eToro complete obbligatorie per il binding Agent');
  const binding = {
    version: 2,
    portfolioId: cleanPortfolioId,
    portfolioName: String(portfolioName ?? '').slice(0, 120),
    fingerprint,
    credentialsFingerprint,
    verifiedAt: Number(verifiedAt) || Date.now(),
  };
  const currentVault = await readVaultRecord(db, env);
  if (!sameVaultRevision(currentVault.revision, expectedVaultRevision)) {
    throw new Error('credenziali eToro cambiate durante la generazione: il nuovo token non è stato attivato');
  }
  const vault = { ...currentVault.payload };
  vault.etoroAgentToken = cleanToken.slice(0, 4000);
  vault[AGENT_BINDING_ROW] = binding;

  const configPatch = {
    activeAgentPortfolioId: binding.portfolioId,
    activeAgentPortfolioName: binding.portfolioName,
    activeAgentPortfolioMirrorId: String(mirrorId ?? ''),
    activeAgentPortfolioVirtualBalanceUsd: Number(virtualBalanceUsd) || 0,
    agentTokenVerifiedAt: binding.verifiedAt,
    agentTokenHint: `••••${cleanToken.slice(-4)}`,
    agentTokenFingerprint: fingerprint,
    agentTokenOrigin: 'vault',
  };
  // Il chiamante verifica il mirror reale prima di arrivare qui. Questi campi
  // fanno parte della stessa transazione del nuovo binding: se restassero
  // quelli precedenti, il primo snapshot del nuovo Agent verrebbe confrontato
  // con il vecchio massimo storico e potrebbe generare un falso drawdown.
  for (const key of [
    'lastManagedCapitalUsd',
    'lastManagedCapitalEur',
    'lastManagedCapitalAt',
    'lastManagedEurUsd',
    'realCapitalTrackingStartedAt',
  ]) {
    if (Object.prototype.hasOwnProperty.call(currentConfig ?? {}, key)) {
      configPatch[key] = Number(currentConfig[key]) || 0;
    }
  }
  const now = Date.now();
  const baseConfigJson = JSON.stringify(currentConfig ?? {});
  const configPatchJson = JSON.stringify(configPatch);
  const insertedRevision = Math.max(0, Math.trunc(Number(currentConfig?.decisionRevision) || 0)) + 1;
  const sealedVault = await seal(env, vault);
  const expectedExists = expectedVaultRevision.exists ? 1 : 0;
  const expectedValue = expectedVaultRevision.exists ? String(expectedVaultRevision.value) : '';
  const expectedUpdatedAt = expectedVaultRevision.exists ? Number(expectedVaultRevision.updatedAt) : 0;
  await db.batch([
    db.prepare(`INSERT INTO config (key, value, updated_at)
      SELECT ?, ?, ?
      WHERE (
        ? = 0 AND NOT EXISTS (SELECT 1 FROM config vault WHERE vault.key = ?)
      ) OR (
        ? = 1 AND EXISTS (
          SELECT 1 FROM config vault
          WHERE vault.key = ? AND vault.value = ? AND vault.updated_at = ?
        )
      )
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      WHERE ? = 1 AND config.value = ? AND config.updated_at = ?`)
      .bind(
        VAULT_ROW,
        sealedVault,
        now,
        expectedExists,
        VAULT_ROW,
        expectedExists,
        VAULT_ROW,
        expectedValue,
        expectedUpdatedAt,
        expectedExists,
        expectedValue,
        expectedUpdatedAt,
      ),
    db.prepare(`INSERT INTO config (key, value, updated_at)
      SELECT ?, json_set(json_patch(json(?), json(?)), '$.decisionRevision', ?), ?
      WHERE EXISTS (
        SELECT 1 FROM config vault
        WHERE vault.key = ? AND vault.value = ? AND vault.updated_at = ?
      )
      ON CONFLICT(key) DO UPDATE SET
        value = json_set(
          json_patch(
            CASE WHEN json_valid(config.value) THEN config.value ELSE json(?) END,
            json(?)
          ),
          '$.decisionRevision',
          CAST(COALESCE(json_extract(
            CASE WHEN json_valid(config.value) THEN config.value ELSE json(?) END,
            '$.decisionRevision'
          ), 0) AS INTEGER) + 1
        ),
        updated_at = excluded.updated_at
      WHERE EXISTS (
        SELECT 1 FROM config vault
        WHERE vault.key = ? AND vault.value = ? AND vault.updated_at = ?
      )`)
      .bind(
        CONFIG_KEY,
        baseConfigJson,
        configPatchJson,
        insertedRevision,
        now,
        VAULT_ROW,
        sealedVault,
        now,
        baseConfigJson,
        configPatchJson,
        baseConfigJson,
        VAULT_ROW,
        sealedVault,
        now,
      ),
  ]);
  const [config, resolved] = await Promise.all([loadConfig(db), resolveCredentials(db, env)]);
  const ownBindingPersisted = hasVerifiedAgentBinding(resolved, config)
    && resolved.agentBinding?.portfolioId === binding.portfolioId
    && resolved.agentBinding?.fingerprint === binding.fingerprint
    && resolved.agentBinding?.credentialsFingerprint === binding.credentialsFingerprint
    && resolved.agentBinding?.verifiedAt === binding.verifiedAt;
  if (!ownBindingPersisted) {
    throw new Error('salvataggio Agent non confermato: il vault è cambiato contemporaneamente');
  }
  return { config, binding };
}

export async function clearCredentials(db, env) {
  // Scrive un tombstone cifrato anche quando la riga non esisteva: un token
  // generato in parallelo deve osservare una revisione diversa e fallire la CAS.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { revision } = await readVaultRecord(db, env);
    const now = Date.now();
    const sealed = await seal(env, {});
    if (await writeVaultIfUnchanged(db, revision, sealed, now)) return true;
  }
  throw new Error('vault credenziali modificato contemporaneamente: aggiorna lo stato e riprova');
}

/**
 * Credenziali effettive più la provenienza di ciascun campo.
 * @returns {Promise<{values: object, origin: Record<string,'vault'|'env'|null>}>}
 */
export async function resolveCredentials(db, env) {
  const { payload: vault, revision: vaultRevision } = await readVaultRecord(db, env);
  const values = {};
  const origin = {};
  for (const field of CREDENTIAL_FIELDS) {
    const fromVault = vault[field.key];
    const fromEnv = env[field.env];
    if (fromVault) { values[field.key] = fromVault; origin[field.key] = 'vault'; }
    else if (fromEnv) { values[field.key] = fromEnv; origin[field.key] = 'env'; }
    else { values[field.key] = ''; origin[field.key] = null; }
  }
  const rawBinding = vault[AGENT_BINDING_ROW];
  let agentBinding = null;
  if (origin.etoroAgentToken === 'vault' && values.etoroAgentToken && rawBinding?.version === 2) {
    const fingerprint = await credentialFingerprint(values.etoroAgentToken);
    const credentialsFingerprint = await etoroCredentialSetFingerprint(values);
    if (
      fingerprint
      && fingerprint === rawBinding.fingerprint
      && credentialsFingerprint
      && credentialsFingerprint === rawBinding.credentialsFingerprint
    ) {
      agentBinding = {
        version: 2,
        portfolioId: String(rawBinding.portfolioId ?? ''),
        portfolioName: String(rawBinding.portfolioName ?? ''),
        fingerprint,
        credentialsFingerprint,
        verifiedAt: Number(rawBinding.verifiedAt) || 0,
      };
    }
  }
  return { values, origin, agentBinding, vaultRevision };
}

/** Unico gate condiviso da API e pipeline per autorizzare l'uso del token. */
export function hasVerifiedAgentBinding(resolved, config) {
  const binding = resolved?.agentBinding;
  return Boolean(
    resolved?.values?.etoroAgentToken
    && resolved?.origin?.etoroAgentToken === 'vault'
    && binding?.portfolioId
    && binding.portfolioId === config?.activeAgentPortfolioId
    && binding.fingerprint === config?.agentTokenFingerprint
    && binding.verifiedAt > 0
    && binding.verifiedAt === Number(config?.agentTokenVerifiedAt),
  );
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
