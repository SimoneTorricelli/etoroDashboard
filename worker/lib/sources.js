/**
 * Fonti dati esterne gratuite. Ogni fonte è opzionale e isolata: un errore o un
 * timeout degrada il contesto ma non blocca mai la run.
 *
 * Senza chiave: Frankfurter (FX), Stooq (indici/tassi/commodity), CoinGecko
 * (crypto), Alternative.me (Fear & Greed), feed RSS finanziari.
 * Con chiave opzionale: Finnhub, Marketaux, Financial Modeling Prep.
 */

const UA = 'TorinoAutopilot/1.0 (+cloudflare-worker)';

async function fetchWithTimeout(url, { timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function json(url, options) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} su ${new URL(url).host}`);
  return response.json();
}

async function text(url, options) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} su ${new URL(url).host}`);
  return response.text();
}

/** Esegue un task e ne cattura l'esito senza mai propagare l'errore. */
async function settle(name, task) {
  const startedAt = Date.now();
  try {
    const value = await task();
    return { name, ok: true, value, ms: Date.now() - startedAt };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt };
  }
}

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// ---------------------------------------------------------------- FX

async function eurUsd() {
  const data = await json('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD');
  const rate = Number(data?.rates?.USD);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('cambio EUR/USD non valido');
  return { rate: round(rate, 4), date: String(data?.date ?? '') };
}

// ---------------------------------------------------------------- Stooq

const STOOQ_SERIES = {
  spx: '^spx',
  ndx: '^ndx',
  vix: '^vix',
  us10y: '10usy.b',
  us2y: '2usy.b',
  gold: 'xauusd',
};

function parseStooqCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 3) throw new Error('serie Stooq vuota');
  const header = lines[0].split(',').map((item) => item.trim().toLowerCase());
  const closeIndex = header.indexOf('close');
  const dateIndex = header.indexOf('date');
  if (closeIndex < 0) throw new Error('colonna close assente');
  return lines.slice(1)
    .map((line) => line.split(','))
    .filter((cells) => cells.length > closeIndex)
    .map((cells) => ({ at: cells[dateIndex] ?? '', close: Number(cells[closeIndex]) }))
    .filter((row) => Number.isFinite(row.close) && row.close !== 0);
}

async function stooqSeries(key) {
  const csv = await text(`https://stooq.com/q/d/l/?s=${encodeURIComponent(STOOQ_SERIES[key])}&i=d`);
  const rows = parseStooqCsv(csv).slice(-260);
  if (rows.length < 20) throw new Error('storico troppo corto');
  return rows;
}

// ---------------------------------------------------------------- Crypto

async function cryptoGlobal() {
  const data = await json('https://api.coingecko.com/api/v3/global');
  const payload = data?.data ?? {};
  return {
    marketCapUsd: round(Number(payload.total_market_cap?.usd ?? 0), 0),
    marketCapChange24hPct: round(Number(payload.market_cap_change_percentage_24h_usd ?? 0), 2),
    btcDominancePct: round(Number(payload.market_cap_percentage?.btc ?? 0), 2),
    ethDominancePct: round(Number(payload.market_cap_percentage?.eth ?? 0), 2),
  };
}

async function cryptoFearGreed() {
  const data = await json('https://api.alternative.me/fng/?limit=8');
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (!rows.length) throw new Error('indice non disponibile');
  return {
    value: Number(rows[0].value),
    label: String(rows[0].value_classification ?? ''),
    weekAgo: rows.length > 6 ? Number(rows[6].value) : null,
  };
}

// ---------------------------------------------------------------- News

// Il Worker ha un budget di subrequest per invocazione: la lista resta corta
// e senza duplicati.
const RSS_FEEDS = [
  { id: 'cnbc-markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', topic: 'markets' },
  { id: 'marketwatch-top', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', topic: 'markets' },
  { id: 'yahoo-finance', url: 'https://finance.yahoo.com/news/rssindex', topic: 'markets' },
  { id: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', topic: 'crypto' },
  { id: 'fed-press', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', topic: 'macro' },
];

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRss(xml, topic, limit = 12) {
  const items = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return items.slice(0, limit).map((item) => {
    const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    const date = item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)?.[1] ?? '';
    const parsedDate = Date.parse(decodeXml(date));
    return {
      title: decodeXml(title).slice(0, 220),
      at: Number.isFinite(parsedDate) ? parsedDate : null,
      topic,
    };
  }).filter((entry) => entry.title.length > 12);
}

async function rssHeadlines(feed) {
  const xml = await text(feed.url, { timeoutMs: 7000 });
  return parseRss(xml, feed.topic);
}

const POSITIVE = ['beat', 'beats', 'surge', 'surges', 'rally', 'rallies', 'gain', 'gains', 'record high', 'upgrade', 'upgrades', 'strong', 'growth', 'optimism', 'rebound', 'boost', 'jump', 'jumps', 'soar', 'soars', 'profit', 'bullish', 'outperform', 'expands', 'recovery', 'cut rates', 'rate cut', 'dovish', 'easing'];
const NEGATIVE = ['miss', 'misses', 'plunge', 'plunges', 'slump', 'slumps', 'fall', 'falls', 'drop', 'drops', 'downgrade', 'downgrades', 'weak', 'recession', 'fear', 'fears', 'selloff', 'sell-off', 'crash', 'loss', 'losses', 'bearish', 'underperform', 'warning', 'warns', 'default', 'layoff', 'layoffs', 'inflation surge', 'hike', 'hawkish', 'tariff', 'sanction', 'conflict', 'war', 'crisis', 'bankruptcy', 'probe', 'lawsuit'];

/** Punteggio lessicale deterministico: evita di spendere token dell'LLM per il sentiment. */
export function scoreHeadlines(headlines) {
  let positive = 0;
  let negative = 0;
  const scored = headlines.map((entry) => {
    const lower = entry.title.toLowerCase();
    const up = POSITIVE.filter((word) => lower.includes(word)).length;
    const down = NEGATIVE.filter((word) => lower.includes(word)).length;
    positive += up;
    negative += down;
    return { ...entry, score: up - down };
  });
  const total = positive + negative;
  return {
    items: scored,
    positiveHits: positive,
    negativeHits: negative,
    /** -1 (molto negativo) … +1 (molto positivo). */
    net: total > 0 ? round((positive - negative) / total, 2) : 0,
  };
}

// ---------------------------------------------------------------- Fonti con chiave opzionale

async function finnhubNews(key) {
  const rows = await json(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}`);
  return (Array.isArray(rows) ? rows : []).slice(0, 15).map((row) => ({
    title: String(row.headline ?? '').slice(0, 220),
    at: Number(row.datetime) * 1000 || null,
    topic: 'markets',
  })).filter((entry) => entry.title);
}

async function marketauxNews(key) {
  const data = await json(`https://api.marketaux.com/v1/news/all?filter_entities=true&language=en&limit=20&api_token=${encodeURIComponent(key)}`);
  return (Array.isArray(data?.data) ? data.data : []).map((row) => ({
    title: String(row.title ?? '').slice(0, 220),
    at: Date.parse(row.published_at ?? '') || null,
    topic: 'markets',
  })).filter((entry) => entry.title);
}

async function fmpRatios(key, symbols) {
  const list = symbols.slice(0, 12).join(',');
  const rows = await json(`https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(list)}?apikey=${encodeURIComponent(key)}`);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: String(row.symbol ?? ''),
    pe: Number.isFinite(Number(row.pe)) ? round(Number(row.pe), 1) : null,
    yearHigh: Number(row.yearHigh) || null,
    yearLow: Number(row.yearLow) || null,
    avgVolume: Number(row.avgVolume) || null,
  })).filter((row) => row.symbol);
}

// ---------------------------------------------------------------- Aggregatore

/**
 * Raccoglie tutto il contesto esterno in parallelo.
 * @param {{finnhubKey?: string, marketauxKey?: string, fmpKey?: string, symbols?: string[]}} options
 */
export async function collectExternalContext(options = {}) {
  const { finnhubKey, marketauxKey, fmpKey, symbols = [], kv = null, ttlSeconds = 3 * 60 * 60 } = options;

  // Il contesto di mercato cambia lentamente: una cache di poche ore evita di
  // rifare quindici chiamate a ogni heartbeat orario.
  const cacheKey = 'external-context:v1';
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, 'json');
      if (cached?.collectedAt) return { ...cached, fromCache: true };
    } catch { /* cache non disponibile */ }
  }

  const tasks = [
    settle('fx.eurusd', eurUsd),
    settle('crypto.global', cryptoGlobal),
    settle('crypto.feargreed', cryptoFearGreed),
    ...Object.keys(STOOQ_SERIES).map((key) => settle(`stooq.${key}`, () => stooqSeries(key))),
    ...RSS_FEEDS.map((feed) => settle(`rss.${feed.id}`, () => rssHeadlines(feed))),
  ];
  if (finnhubKey) tasks.push(settle('finnhub.news', () => finnhubNews(finnhubKey)));
  if (marketauxKey) tasks.push(settle('marketaux.news', () => marketauxNews(marketauxKey)));
  if (fmpKey && symbols.length) tasks.push(settle('fmp.quotes', () => fmpRatios(fmpKey, symbols)));

  const settled = await Promise.all(tasks);
  const byName = new Map(settled.map((entry) => [entry.name, entry]));
  const valueOf = (name, fallback = null) => (byName.get(name)?.ok ? byName.get(name).value : fallback);

  const headlines = settled
    .filter((entry) => entry.ok && (entry.name.startsWith('rss.') || entry.name.endsWith('.news')))
    .flatMap((entry) => entry.value ?? []);
  const deduped = [];
  const seen = new Set();
  for (const entry of headlines.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    const fingerprint = entry.title.toLowerCase().slice(0, 60);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push(entry);
  }

  const series = {};
  for (const key of Object.keys(STOOQ_SERIES)) {
    const rows = valueOf(`stooq.${key}`, null);
    if (rows) series[key] = rows;
  }

  const context = {
    collectedAt: Date.now(),
    eurUsd: valueOf('fx.eurusd'),
    crypto: { global: valueOf('crypto.global'), fearGreed: valueOf('crypto.feargreed') },
    series,
    news: scoreHeadlines(deduped.slice(0, 60)),
    fundamentals: valueOf('fmp.quotes', []),
    diagnostics: settled.map(({ name, ok, error, ms }) => ({ name, ok, error, ms })),
  };

  if (kv) {
    try { await kv.put(cacheKey, JSON.stringify(context), { expirationTtl: ttlSeconds }); } catch { /* cache non disponibile */ }
  }
  return context;
}
