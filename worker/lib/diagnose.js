/**
 * Diagnostica delle credenziali e delle dipendenze esterne.
 *
 * Ogni controllo è isolato e restituisce un esito leggibile: serve a capire
 * *quale* credenziale è sbagliata invece di vedere un generico HTTP 401.
 */
import { EtoroClient } from './etoro.js';
import { probeModels } from './brain.js';
import { checkTelegram } from './notify.js';
import { collectExternalContext } from './sources.js';

function ok(id, label, detail, extra = {}) {
  return { id, label, ok: true, detail, ...extra };
}
function ko(id, label, error, hint) {
  return { id, label, ok: false, error: String(error).slice(0, 400), hint };
}
function skip(id, label, reason) {
  return { id, label, ok: null, detail: reason };
}

function etoroHint(status) {
  if (status === 401) return 'API key o user key non valide: ricontrolla di non aver invertito i due campi.';
  if (status === 403) return 'Chiavi valide ma senza i permessi richiesti: verifica gli scope dell’applicazione su eToro.';
  if (status === 429) return 'Troppe richieste: attendi qualche minuto e riprova.';
  return undefined;
}

/**
 * @param {{values: object}} resolved
 * @param {object} config
 */
export async function runDiagnostics(resolved, config) {
  const credentials = resolved.values ?? resolved;
  const checks = [];

  // --- eToro in lettura ---------------------------------------------------
  let readClient = null;
  if (!credentials.etoroApiKey || !credentials.etoroUserKey) {
    checks.push(ko('etoro.read', 'eToro — lettura account', 'API key o user key mancanti', 'Compilale nella sezione Credenziali.'));
  } else {
    try {
      readClient = new EtoroClient({ apiKey: credentials.etoroApiKey, userKey: credentials.etoroUserKey });
      const portfolio = await readClient.portfolio(credentials.etoroUserKey);
      checks.push(ok('etoro.read', 'eToro — lettura account',
        `equity ${portfolio.equityUsd} USD · cash ${portfolio.cashUsd} USD · ${portfolio.positions.length} posizioni aperte`,
        { data: { equityUsd: portfolio.equityUsd, positions: portfolio.positions.length } }));
    } catch (error) {
      checks.push(ko('etoro.read', 'eToro — lettura account', error.message, etoroHint(error.status)));
      readClient = null;
    }
  }

  // --- Token dell'Agent Portfolio ----------------------------------------
  if (!credentials.etoroAgentToken) {
    checks.push(skip('etoro.agent', 'eToro — token Agent Portfolio',
      'Non configurato. Shadow e dry-run funzionano lo stesso; serve solo per inviare ordini reali.'));
  } else {
    try {
      const agentClient = new EtoroClient({
        apiKey: credentials.etoroApiKey,
        userKey: credentials.etoroAgentToken,
        agentToken: credentials.etoroAgentToken,
      });
      const portfolio = await agentClient.portfolio(credentials.etoroAgentToken);
      checks.push(ok('etoro.agent', 'eToro — token Agent Portfolio',
        `valido · equity ${portfolio.equityUsd} USD · ${portfolio.positions.length} posizioni`,
        { data: { equityUsd: portfolio.equityUsd, positions: portfolio.positions.length } }));
    } catch (error) {
      checks.push(ko('etoro.agent', 'eToro — token Agent Portfolio', error.message,
        error.status === 401
          ? 'Token non valido o revocato. Rigeneralo dalla sezione Agent (Genera token) e reincollalo qui.'
          : etoroHint(error.status)));
    }
  }

  // --- Elenco degli Agent Portfolio disponibili ---------------------------
  if (readClient) {
    try {
      const portfolios = await readClient.agentPortfolios();
      checks.push(portfolios.length
        ? ok('etoro.portfolios', 'eToro — Agent Portfolio esistenti',
            portfolios.map((item) => `${item.name} (${item.id})`).join(' · '),
            { data: portfolios })
        : skip('etoro.portfolios', 'eToro — Agent Portfolio esistenti',
            'Nessuno creato. Vai in Agent per crearne uno prima di passare in live.'));
    } catch (error) {
      checks.push(ko('etoro.portfolios', 'eToro — Agent Portfolio esistenti', error.message));
    }
  }

  // --- Risoluzione dell'universo -----------------------------------------
  if (readClient) {
    const resolvedSymbols = [];
    const approximate = [];
    const missing = [];
    for (const entry of config.whitelist) {
      try {
        const found = await readClient.searchInstrument(entry.symbol);
        if (!found?.instrumentId) missing.push(entry.symbol);
        else if (found.exact) resolvedSymbols.push(`${entry.symbol}→#${found.instrumentId}`);
        else approximate.push(`${entry.symbol} risolto come ${found.matchedAs} (#${found.instrumentId})`);
      } catch (error) {
        missing.push(`${entry.symbol} (${error.message})`);
      }
    }
    const detail = [
      resolvedSymbols.length ? `${resolvedSymbols.length} esatti` : null,
      approximate.length ? `${approximate.length} approssimati: ${approximate.join('; ')}` : null,
    ].filter(Boolean).join(' · ');
    checks.push(missing.length === 0
      ? ok('etoro.universe', 'Universo strumenti', detail || 'nessuno strumento in whitelist')
      : ko('etoro.universe', 'Universo strumenti',
          `non risolti: ${missing.join(', ')}${detail ? ` — ${detail}` : ''}`,
          'Usa la ricerca nel tab Strategia: cerca il nome dello strumento e scegli la voce giusta dal catalogo eToro, invece di scrivere il ticker a mano.'));
  }

  // --- OpenRouter ---------------------------------------------------------
  if (!credentials.openrouterApiKey) {
    checks.push(ko('openrouter', 'OpenRouter — chiave AI', 'chiave non configurata', 'Creala su openrouter.ai → Keys.'));
  } else {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { authorization: `Bearer ${credentials.openrouterApiKey}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        checks.push(ko('openrouter', 'OpenRouter — chiave AI',
          payload?.error?.message ?? `HTTP ${response.status}`,
          response.status === 401 ? 'Chiave revocata o errata: creane una nuova su openrouter.ai → Keys.' : undefined));
      } else {
        const data = payload?.data ?? {};
        const remaining = data.limit_remaining;
        checks.push(ok('openrouter', 'OpenRouter — chiave AI',
          `valida${data.label ? ` · ${data.label}` : ''}${remaining != null ? ` · credito residuo ${remaining}` : ' · piano free'}`));
      }
    } catch (error) {
      checks.push(ko('openrouter', 'OpenRouter — chiave AI', error instanceof Error ? error.message : String(error)));
    }
  }

  // --- Modelli configurati -------------------------------------------------
  if (credentials.openrouterApiKey && config.models?.length) {
    const probes = await probeModels({ apiKey: credentials.openrouterApiKey, models: config.models });
    const working = probes.filter((item) => item.ok);
    const broken = probes.filter((item) => !item.ok);
    checks.push(working.length
      ? ok('models', 'Modelli AI configurati',
          `${working.length}/${probes.length} funzionanti: ${working.map((item) => item.model).join(', ')}${broken.length ? ` · non disponibili: ${broken.map((item) => `${item.model} (${item.error})`).join('; ')}` : ''}`,
          { data: probes })
      : ko('models', 'Modelli AI configurati',
          broken.map((item) => `${item.model}: ${item.error}`).join(' · '),
          'Il catalogo gratuito di OpenRouter cambia spesso: apri Strategia → Modelli AI e scegli fra quelli disponibili adesso.'));
  }

  // --- Notifiche ----------------------------------------------------------
  if (!credentials.telegramBotToken && !credentials.telegramChatId && !credentials.notifyWebhookUrl) {
    checks.push(skip('telegram', 'Telegram — notifiche', 'Non configurato: l’agente lavorerà in silenzio.'));
  } else {
    const result = await checkTelegram(credentials);
    checks.push(result.ok
      ? ok('telegram', 'Telegram — notifiche', `@${result.bot} · ${result.detail}`)
      : ko('telegram', 'Telegram — notifiche', result.error));
  }

  // --- Fonti dati esterne -------------------------------------------------
  try {
    const external = await collectExternalContext({
      finnhubKey: credentials.finnhubKey,
      marketauxKey: credentials.marketauxKey,
      fmpKey: credentials.fmpKey,
      symbols: config.whitelist.map((item) => item.symbol),
    });
    const failed = external.diagnostics.filter((item) => !item.ok);
    const total = external.diagnostics.length;
    checks.push(ok('sources', 'Fonti dati esterne',
      `${total - failed.length}/${total} raggiungibili · ${external.news.items.length} notizie raccolte`,
      { data: external.diagnostics }));
  } catch (error) {
    checks.push(ko('sources', 'Fonti dati esterne', error instanceof Error ? error.message : String(error)));
  }

  const failures = checks.filter((item) => item.ok === false);
  return {
    checkedAt: Date.now(),
    ok: failures.length === 0,
    readyForShadow: checks.find((item) => item.id === 'etoro.read')?.ok === true
      && checks.find((item) => item.id === 'openrouter')?.ok === true
      && checks.find((item) => item.id === 'models')?.ok !== false,
    readyForLive: checks.find((item) => item.id === 'etoro.agent')?.ok === true,
    checks,
  };
}
