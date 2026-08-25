/**
 * Notifiche: Telegram (gratuito) e webhook generico. Entrambi opzionali e
 * non bloccanti — un errore di notifica non deve mai fermare la pipeline.
 *
 * Le credenziali arrivano dal vault (configurabili in dashboard) o dai Worker
 * Secrets: qui si riceve già il valore risolto.
 */

/** Ritorna sempre un esito, mai un throw: gli errori si leggono nel risultato. */
async function post(channel, url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }
    // Telegram risponde 200 con ok:false: va trattato comunque come errore.
    if (!response.ok || payload.ok === false) {
      const detail = payload.description ?? payload.error ?? payload.raw ?? `HTTP ${response.status}`;
      return { channel, ok: false, error: String(detail).slice(0, 300) };
    }
    return { channel, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { channel, ok: false, error: /abort/i.test(message) ? 'timeout dopo 8s' : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{telegramBotToken?: string, telegramChatId?: string, notifyWebhookUrl?: string}} credentials
 * @param {'info'|'warn'|'critical'} level
 */
export async function notify(credentials, level, title, lines = []) {
  const icon = level === 'critical' ? '🔴' : level === 'warn' ? '🟡' : '🟢';
  const text = [`${icon} ${title}`, ...lines.filter(Boolean)].join('\n').slice(0, 3500);
  const tasks = [];

  if (credentials?.telegramBotToken && credentials?.telegramChatId) {
    tasks.push(post('telegram', `https://api.telegram.org/bot${credentials.telegramBotToken}/sendMessage`, {
      chat_id: credentials.telegramChatId,
      text,
      disable_web_page_preview: true,
    }));
  }
  if (credentials?.notifyWebhookUrl) {
    tasks.push(post('webhook', credentials.notifyWebhookUrl, { level, title, lines, text, at: Date.now() }));
  }

  const results = await Promise.all(tasks);
  return { results, sent: results.filter((item) => item.ok).length, attempted: results.length };
}

const PREFERENCE_LABELS = {
  'global-equities': 'Azioni globali',
  technology: 'Tecnologia',
  healthcare: 'Salute',
  'crypto-large-cap': 'Crypto large cap',
  bonds: 'Obbligazionario',
  commodities: 'Materie prime',
};

function clean(value, max = 180) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function signedPct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(1)}%`;
}

/**
 * Crea un riepilogo Telegram leggibile della strategia appena attivata.
 * Usa soltanto dati già normalizzati dal Worker e non include prompt, token,
 * chain-of-thought o altre informazioni sensibili.
 */
export function buildStrategyActivationNotification({
  spec,
  guided,
  draft,
  portfolioId,
  portfolioName,
  collaboration,
}) {
  const allocations = (Array.isArray(draft?.allocations) ? draft.allocations : [])
    .slice(0, 12)
    .map((item) => `  • ${clean(item.label, 60)}: ${Number(item.weightPct).toFixed(0)}%`);
  const preferences = (Array.isArray(guided?.macroPreferences) ? guided.macroPreferences : [])
    .map((item) => PREFERENCE_LABELS[item] ?? clean(item, 50))
    .filter(Boolean);
  const crypto = guided?.cryptoPreference === 'none'
    ? 'escluse'
    : guided?.cryptoPreference === 'majors'
      ? 'solo large cap'
      : guided?.cryptoPreference === 'broad'
        ? 'large cap e altcoin'
        : guided?.cryptoPreference === 'meme-opt-in' ? 'meme coin abilitate' : 'come da policy';
  const collaborationLabel = collaboration?.status === 'validated'
    ? `validata da ${Math.max(1, 1 + (collaboration.reviewerModels?.length ?? 0))} modelli`
    : collaboration?.status === 'deterministic-fallback'
      ? 'baseline deterministica protetta dai guardrail'
      : 'validata con attenzioni e guardrail deterministici';
  const portfolioLabel = clean(portfolioName, 80) || `Portfolio ${clean(portfolioId, 8)}`;
  const budget = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 })
    .format(Number(spec?.capital?.budgetEur) || 0);

  return {
    level: 'info',
    title: `Strategia attivata · ${clean(spec?.name || draft?.strategyName, 80)}`,
    lines: [
      `📁 Agent Portfolio: ${portfolioLabel} (${clean(portfolioId, 36)})`,
      `🛡 Modalità: shadow per ${Math.max(1, Number(draft?.shadowDays) || 14)} giorni · nessun ordine reale`,
      `💶 Capitale reale gestito: ${budget}`,
      `🎯 Obiettivo: ${clean(spec?.objective?.description || draft?.summary, 240)}`,
      preferences.length ? `🌍 Preferenze: ${preferences.join(', ')} · crypto ${crypto}` : `🌍 Universo dinamico · crypto ${crypto}`,
      '',
      '📊 Allocazione obiettivo:',
      ...allocations,
      '',
      `📈 Scenari modellati a ${Number(draft?.scenario?.horizonMonths) || 12} mesi — non sono previsioni:`,
      `  • Favorevole: ${signedPct(draft?.scenario?.favorablePct)}`,
      `  • Mediano: ${signedPct(draft?.scenario?.medianPct)}`,
      `  • Avverso: ${signedPct(draft?.scenario?.adversePct)}`,
      '',
      '🧱 Guardrail principali:',
      `  • Drawdown massimo: −${Number(spec?.risk?.maxDrawdownPct) || 0}%`,
      `  • Tetto per asset: ${Number(spec?.diversification?.maxInstrumentWeightPct) || 0}%`,
      `  • Tetto per settore: ${Number(spec?.diversification?.maxSectorWeightPct) || 0}%`,
      `  • Posizioni: ${Number(spec?.diversification?.minPositions) || 1}–${Number(spec?.diversification?.maxPositions) || 1}`,
      `  • Turnover massimo per ciclo: ${Number(spec?.execution?.maxTurnoverPct) || 0}%`,
      `  • Liquidità target: ${Math.max(0, 100 - (Number(spec?.capital?.targetDeploymentPct) || 100))}%`,
      '',
      `🤝 Validazione: ${collaborationLabel}`,
      '🧭 A ogni ciclo la shortlist viene aggiornata entro queste preferenze; pesi e ordini sono ricalcolati sul budget effettivo.',
    ],
  };
}

/**
 * Diagnostica del canale Telegram: verifica prima il bot, poi la chat, così
 * distingue i due errori più comuni — token sbagliato e chat mai avviata.
 */
export async function checkTelegram(credentials) {
  const token = credentials?.telegramBotToken;
  const chatId = credentials?.telegramChatId;
  if (!token) return { ok: false, error: 'bot token non configurato' };
  if (!chatId) return { ok: false, error: 'chat id non configurato' };

  try {
    const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const me = await meResponse.json();
    if (!me?.ok) return { ok: false, error: `bot token non valido (${me?.description ?? `HTTP ${meResponse.status}`})` };

    const username = me.result?.username ?? 'il tuo bot';
    const send = await post('telegram', `https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: '🟢 Test notifiche Autopilot\nSe leggi questo messaggio il canale funziona: riceverai qui ogni run, ordine, blocco dei guardrail e freeze automatico.',
      disable_web_page_preview: true,
    });
    if (!send.ok) {
      const hint = /chat not found/i.test(send.error)
        ? `chat id inesistente, oppure non hai ancora avviato la conversazione: apri Telegram, cerca @${username} e premi Avvia`
        : /bot was blocked/i.test(send.error)
          ? 'hai bloccato il bot su Telegram: sbloccalo e riprova'
          : send.error;
      return { ok: false, error: hint, bot: username };
    }
    return { ok: true, bot: username, detail: `messaggio inviato alla chat ${chatId}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Invio di prova su tutti i canali configurati, con errori dettagliati. */
export async function notifyTest(credentials) {
  const checks = [];
  if (credentials?.telegramBotToken || credentials?.telegramChatId) {
    checks.push({ channel: 'telegram', ...(await checkTelegram(credentials)) });
  }
  if (credentials?.notifyWebhookUrl) {
    checks.push(await post('webhook', credentials.notifyWebhookUrl, {
      level: 'info', title: 'Test notifiche Autopilot', lines: [], at: Date.now(),
    }));
  }
  if (!checks.length) throw new Error('nessun canale di notifica configurato');
  const failed = checks.filter((item) => !item.ok);
  if (failed.length === checks.length) {
    throw new Error(failed.map((item) => `${item.channel}: ${item.error}`).join(' · '));
  }
  return { checks, sent: checks.filter((item) => item.ok).length, attempted: checks.length };
}
