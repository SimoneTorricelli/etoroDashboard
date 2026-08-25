/**
 * Notifiche: Telegram (gratuito) e webhook generico. Entrambi opzionali e
 * non bloccanti — un errore di notifica non deve mai fermare la pipeline.
 *
 * Le credenziali arrivano dal vault (configurabili in dashboard) o dai Worker
 * Secrets: qui si riceve già il valore risolto.
 */

async function post(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
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
    tasks.push(post(`https://api.telegram.org/bot${credentials.telegramBotToken}/sendMessage`, {
      chat_id: credentials.telegramChatId,
      text,
      disable_web_page_preview: true,
    }));
  }
  if (credentials?.notifyWebhookUrl) {
    tasks.push(post(credentials.notifyWebhookUrl, { level, title, lines, text, at: Date.now() }));
  }

  const results = await Promise.allSettled(tasks);
  return { sent: results.filter((item) => item.status === 'fulfilled').length, attempted: tasks.length };
}

/** Invio di prova richiesto dalla dashboard per validare bot token e chat id. */
export async function notifyTest(credentials) {
  if (!credentials?.telegramBotToken || !credentials?.telegramChatId) {
    if (!credentials?.notifyWebhookUrl) throw new Error('nessun canale di notifica configurato');
  }
  const result = await notify(credentials, 'info', 'Test notifiche Autopilot', [
    'Se leggi questo messaggio il canale è configurato correttamente.',
    'Riceverai qui ogni run, ordine, blocco dei guardrail e freeze automatico.',
  ]);
  if (result.attempted === 0) throw new Error('nessun canale di notifica configurato');
  if (result.sent === 0) throw new Error('invio fallito: verifica bot token e chat id');
  return result;
}
