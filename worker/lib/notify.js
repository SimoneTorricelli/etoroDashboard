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
