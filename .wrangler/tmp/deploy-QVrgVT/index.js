var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/lib/etoro.js
var BASE = {
  v1: "https://public-api.etoro.com/api/v1",
  v2: "https://public-api.etoro.com/api/v2"
};
var EtoroError = class extends Error {
  static {
    __name(this, "EtoroError");
  }
  constructor(message, status, body) {
    super(message);
    this.name = "EtoroError";
    this.status = status;
    this.body = body;
  }
};
var num = /* @__PURE__ */ __name((value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}, "num");
var pick = /* @__PURE__ */ __name((record, ...keys) => {
  for (const key of keys) {
    if (record && record[key] !== void 0 && record[key] !== null) return record[key];
  }
  return void 0;
}, "pick");
var asRecord = /* @__PURE__ */ __name((value) => value && typeof value === "object" && !Array.isArray(value) ? value : {}, "asRecord");
var recordList = /* @__PURE__ */ __name((value) => Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [], "recordList");
var EtoroClient = class {
  static {
    __name(this, "EtoroClient");
  }
  /**
   * @param {{apiKey: string, userKey: string, agentToken?: string}} credentials
   */
  constructor(credentials, { timeoutMs = 15e3 } = {}) {
    this.apiKey = credentials.apiKey;
    this.userKey = credentials.userKey;
    this.agentToken = credentials.agentToken || "";
    this.timeoutMs = timeoutMs;
    this.calls = 0;
  }
  headers(userKey = this.userKey, requestId = crypto.randomUUID()) {
    return {
      "x-api-key": this.apiKey,
      "x-user-key": userKey,
      "x-request-id": requestId,
      "content-type": "application/json",
      accept: "application/json"
    };
  }
  async request(version, path, { method = "GET", body, userKey, requestId } = {}) {
    const url = `${BASE[version]}/${path.replace(/^\/+/, "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.calls += 1;
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers(userKey, requestId),
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: controller.signal
      });
      const text2 = await response.text();
      let parsed = {};
      try {
        parsed = text2 ? JSON.parse(text2) : {};
      } catch {
        parsed = { message: text2 };
      }
      if (!response.ok) {
        const record = asRecord(parsed);
        const message = pick(record, "message", "Message", "error", "Error") ?? `HTTP ${response.status}`;
        throw new EtoroError(typeof message === "string" ? message : JSON.stringify(message), response.status, parsed);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Portafoglio + posizioni aperte dell'account indicato dallo user key attivo. */
  async portfolio(userKey = this.userKey) {
    const data = await this.request("v1", "trading/info/real/pnl", { userKey });
    const account = asRecord(pick(data, "clientPortfolio", "ClientPortfolio", "portfolio", "Portfolio"));
    const root = Object.keys(account).length ? account : asRecord(data);
    const rawPositions = recordList(pick(root, "Positions", "positions"));
    const positions = rawPositions.map((raw) => {
      const invested = num(pick(raw, "Amount", "amount"));
      const units = num(pick(raw, "Units", "units"));
      const openRate = num(pick(raw, "OpenRate", "openRate"));
      const leverage = num(pick(raw, "Leverage", "leverage"), 1) || 1;
      const currentRate = num(pick(raw, "CurrentRate", "currentRate", "Rate", "rate"), openRate);
      const isBuy = pick(raw, "IsBuy", "isBuy") !== false;
      const grossValue = units > 0 && currentRate > 0 ? units * currentRate : invested;
      const pnl = openRate > 0 && units > 0 ? (isBuy ? currentRate - openRate : openRate - currentRate) * units : num(pick(raw, "NetProfit", "netProfit", "Profit", "profit"));
      return {
        positionId: num(pick(raw, "PositionID", "positionId", "PositionId")),
        instrumentId: num(pick(raw, "InstrumentID", "instrumentId", "InstrumentId")),
        invested,
        units,
        openRate,
        currentRate,
        leverage,
        isBuy,
        valueUsd: Math.round((invested + pnl) * 100) / 100,
        grossValueUsd: Math.round(grossValue * 100) / 100,
        pnlUsd: Math.round(pnl * 100) / 100,
        openedAt: String(pick(raw, "OpenDateTime", "openDateTime", "OpenTime") ?? "")
      };
    });
    const cashUsd = num(pick(root, "Credit", "credit"));
    const investedUsd = positions.reduce((sum, item) => sum + item.invested, 0);
    const positionsValue = positions.reduce((sum, item) => sum + item.valueUsd, 0);
    const reportedEquity = num(pick(root, "Equity", "equity"), 0);
    const equityUsd = reportedEquity > 0 ? reportedEquity : cashUsd + positionsValue;
    return {
      takenAt: Date.now(),
      cashUsd: Math.round(cashUsd * 100) / 100,
      investedUsd: Math.round(investedUsd * 100) / 100,
      positionsValueUsd: Math.round(positionsValue * 100) / 100,
      equityUsd: Math.round(equityUsd * 100) / 100,
      positions
    };
  }
  async searchInstrument(symbol) {
    const data = await this.request("v1", `market-data/search?internalSymbolFull=${encodeURIComponent(symbol)}`);
    const rows = recordList(pick(asRecord(data), "instruments", "Instruments", "data", "Data")).concat(Array.isArray(data) ? data : []);
    const first = rows[0];
    if (!first) return null;
    return {
      symbol,
      instrumentId: num(pick(first, "instrumentId", "InstrumentID", "InstrumentId", "id")),
      name: String(pick(first, "instrumentDisplayName", "InstrumentDisplayName", "name", "Name") ?? symbol),
      assetClass: String(pick(first, "instrumentTypeDescription", "InstrumentTypeDescription", "assetClass") ?? "")
    };
  }
  async instruments(ids) {
    if (!ids.length) return [];
    const data = await this.request("v1", `market-data/instruments?instrumentIds=${ids.join(",")}`);
    return recordList(pick(asRecord(data), "instrumentDisplayDatas", "InstrumentDisplayDatas", "instruments", "data") ?? data).map((raw) => ({
      instrumentId: num(pick(raw, "instrumentID", "instrumentId", "InstrumentID")),
      symbol: String(pick(raw, "symbolFull", "SymbolFull", "internalSymbolFull", "symbol") ?? ""),
      name: String(pick(raw, "instrumentDisplayName", "InstrumentDisplayName", "name") ?? ""),
      assetClass: String(pick(raw, "instrumentTypeDescription", "InstrumentTypeDescription") ?? "")
    }));
  }
  async rates(ids) {
    if (!ids.length) return /* @__PURE__ */ new Map();
    const data = await this.request("v1", `market-data/instruments/rates?instrumentIds=${ids.join(",")}`);
    const rows = recordList(pick(asRecord(data), "rates", "Rates", "data") ?? data);
    return new Map(rows.map((raw) => [
      num(pick(raw, "instrumentId", "InstrumentID", "instrumentID")),
      {
        last: num(pick(raw, "lastExecution", "LastExecution", "last", "Last", "ask", "Ask")),
        ask: num(pick(raw, "ask", "Ask")),
        bid: num(pick(raw, "bid", "Bid")),
        previousClose: num(pick(raw, "previousClose", "PreviousClose", "closeLast", "CloseLast"))
      }
    ]));
  }
  /** Serie storica di chiusure. `interval` tipico: OneDay. */
  async candles(instrumentId, interval = "OneDay", count = 260) {
    const data = await this.request("v1", `market-data/instruments/${instrumentId}/history/candles/asc/${interval}/${count}`);
    const buckets = recordList(pick(asRecord(data), "candles", "Candles") ?? data);
    const rows = buckets.flatMap((bucket) => recordList(pick(bucket, "candles", "Candles")).length ? recordList(pick(bucket, "candles", "Candles")) : [bucket]);
    return rows.map((raw) => ({
      at: String(pick(raw, "fromDate", "FromDate", "date", "Date") ?? ""),
      close: num(pick(raw, "close", "Close")),
      high: num(pick(raw, "high", "High")),
      low: num(pick(raw, "low", "Low")),
      volume: num(pick(raw, "volume", "Volume"))
    })).filter((row) => row.close > 0);
  }
  async eligibility(instrumentIds, userKey = this.agentToken || this.userKey) {
    const data = await this.request("v2", "trading/info/eligibility", {
      method: "POST",
      userKey,
      body: { instrumentIds, currency: "USD" }
    });
    const rows = recordList(pick(asRecord(data), "eligibilities", "Eligibilities"));
    return new Map(rows.map((raw) => {
      const leverageConfigs = recordList(pick(raw, "leverageConfigs", "LeverageConfigs"));
      const longMins = leverageConfigs.filter((config) => {
        const direction = String(pick(config, "direction", "Direction") ?? "").toUpperCase();
        const values = pick(config, "leverageValues", "LeverageValues");
        return (!direction || direction === "LONG") && Array.isArray(values) && values.map(Number).includes(1);
      }).map((config) => num(pick(config, "minPositionAmount", "MinPositionAmount"))).filter((value) => value > 0);
      return [
        num(pick(raw, "instrumentId", "InstrumentId")),
        {
          allowOpenPosition: Boolean(pick(raw, "allowOpenPosition", "AllowOpenPosition")),
          minPositionUsd: Math.max(num(pick(raw, "minPositionExposure", "MinPositionExposure")), longMins.length ? Math.min(...longMins) : 0)
        }
      ];
    }));
  }
  /** Apertura posizione a mercato sull'Agent Portfolio. */
  async openOrder({ instrumentId, amountUsd, requestId }) {
    return this.request("v2", "trading/execution/orders", {
      method: "POST",
      userKey: this.agentToken,
      requestId,
      body: {
        action: "open",
        transaction: "buy",
        instrumentId,
        orderType: "mkt",
        leverage: 1,
        amount: Math.round(amountUsd * 100) / 100,
        orderCurrency: "usd"
      }
    });
  }
  /** Chiusura (totale o parziale) di una posizione dell'Agent Portfolio. */
  async closeOrder({ positionId, amountUsd, requestId }) {
    const body = { action: "close", positionId, orderType: "mkt", orderCurrency: "usd" };
    if (amountUsd != null) body.amount = Math.round(amountUsd * 100) / 100;
    try {
      return await this.request("v2", "trading/execution/orders", {
        method: "POST",
        userKey: this.agentToken,
        requestId,
        body
      });
    } catch (error) {
      if (amountUsd != null) throw error;
      return this.request("v1", `trading/execution/real/market-close-orders/positions/${positionId}`, {
        method: "POST",
        userKey: this.agentToken,
        requestId,
        body: { PositionID: positionId }
      });
    }
  }
  async lookupOrder({ orderId, referenceId }) {
    const query = orderId ? `orderId=${encodeURIComponent(orderId)}` : `referenceId=${encodeURIComponent(referenceId)}`;
    const data = await this.request("v2", `trading/info/orders:lookup?${query}`, { userKey: this.agentToken });
    const root = asRecord(pick(asRecord(data), "data", "Data") ?? data);
    const statusRecord = asRecord(pick(root, "status", "Status"));
    const label = String(pick(statusRecord, "name", "Name") ?? pick(root, "statusName", "StatusName") ?? "Pending");
    const statusId = num(pick(statusRecord, "id", "Id"));
    const executions = recordList(pick(root, "positionExecutions", "PositionExecutions"));
    const normalized = label.toLowerCase();
    const isPartial = statusId === 5 || statusId === 10 || /partial/.test(normalized);
    const isFilled = statusId === 3 || !isPartial && /filled|executed|completed/.test(normalized);
    const isRejected = statusId === 4 || !isPartial && /reject|cancel|fail|expired/.test(normalized);
    return {
      orderId: num(pick(root, "orderId", "OrderId", "OrderID"), orderId ?? 0),
      state: isFilled ? "filled" : isPartial ? "partial" : isRejected ? "rejected" : "pending",
      label,
      filledUsd: executions.reduce((sum, item) => sum + num(pick(item, "investedAmountCurrency", "InvestedAmountCurrency", "initialExposureAccountCurrency")), 0),
      positionIds: executions.map((item) => num(pick(item, "positionId", "PositionId", "PositionID"))).filter(Boolean),
      error: String(pick(statusRecord, "errorMessage", "ErrorMessage") ?? "").trim() || void 0
    };
  }
  async agentPortfolios() {
    const data = await this.request("v1", "agent-portfolios");
    return recordList(pick(asRecord(data), "agentPortfolios", "AgentPortfolios", "data") ?? data).map((raw) => ({
      id: String(pick(raw, "agentPortfolioId", "id", "Id") ?? ""),
      name: String(pick(raw, "name", "Name") ?? ""),
      virtualBalanceUsd: num(pick(raw, "virtualBalance", "VirtualBalance"))
    }));
  }
};

// worker/lib/sources.js
var UA = "TorinoAutopilot/1.0 (+cloudflare-worker)";
async function fetchWithTimeout(url, { timeoutMs = 8e3, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
async function json(url, options) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} su ${new URL(url).host}`);
  return response.json();
}
__name(json, "json");
async function text(url, options) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} su ${new URL(url).host}`);
  return response.text();
}
__name(text, "text");
async function settle(name, task) {
  const startedAt = Date.now();
  try {
    const value = await task();
    return { name, ok: true, value, ms: Date.now() - startedAt };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt };
  }
}
__name(settle, "settle");
var round = /* @__PURE__ */ __name((value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}, "round");
async function eurUsd() {
  const data = await json("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD");
  const rate = Number(data?.rates?.USD);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("cambio EUR/USD non valido");
  return { rate: round(rate, 4), date: String(data?.date ?? "") };
}
__name(eurUsd, "eurUsd");
var STOOQ_SERIES = {
  spx: "^spx",
  ndx: "^ndx",
  vix: "^vix",
  us10y: "10usy.b",
  us2y: "2usy.b",
  gold: "xauusd"
};
function parseStooqCsv(csv) {
  const lines = csv.trim().split("\n");
  if (lines.length < 3) throw new Error("serie Stooq vuota");
  const header = lines[0].split(",").map((item) => item.trim().toLowerCase());
  const closeIndex = header.indexOf("close");
  const dateIndex = header.indexOf("date");
  if (closeIndex < 0) throw new Error("colonna close assente");
  return lines.slice(1).map((line) => line.split(",")).filter((cells) => cells.length > closeIndex).map((cells) => ({ at: cells[dateIndex] ?? "", close: Number(cells[closeIndex]) })).filter((row) => Number.isFinite(row.close) && row.close !== 0);
}
__name(parseStooqCsv, "parseStooqCsv");
async function stooqSeries(key) {
  const csv = await text(`https://stooq.com/q/d/l/?s=${encodeURIComponent(STOOQ_SERIES[key])}&i=d`);
  const rows = parseStooqCsv(csv).slice(-260);
  if (rows.length < 20) throw new Error("storico troppo corto");
  return rows;
}
__name(stooqSeries, "stooqSeries");
async function cryptoGlobal() {
  const data = await json("https://api.coingecko.com/api/v3/global");
  const payload = data?.data ?? {};
  return {
    marketCapUsd: round(Number(payload.total_market_cap?.usd ?? 0), 0),
    marketCapChange24hPct: round(Number(payload.market_cap_change_percentage_24h_usd ?? 0), 2),
    btcDominancePct: round(Number(payload.market_cap_percentage?.btc ?? 0), 2),
    ethDominancePct: round(Number(payload.market_cap_percentage?.eth ?? 0), 2)
  };
}
__name(cryptoGlobal, "cryptoGlobal");
async function cryptoFearGreed() {
  const data = await json("https://api.alternative.me/fng/?limit=8");
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (!rows.length) throw new Error("indice non disponibile");
  return {
    value: Number(rows[0].value),
    label: String(rows[0].value_classification ?? ""),
    weekAgo: rows.length > 6 ? Number(rows[6].value) : null
  };
}
__name(cryptoFearGreed, "cryptoFearGreed");
var RSS_FEEDS = [
  { id: "cnbc-markets", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", topic: "markets" },
  { id: "cnbc-economy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", topic: "economy" },
  { id: "marketwatch-top", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", topic: "markets" },
  { id: "yahoo-finance", url: "https://finance.yahoo.com/news/rssindex", topic: "markets" },
  { id: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", topic: "crypto" },
  { id: "investing-econ", url: "https://www.investing.com/rss/news_14.rss", topic: "economy" },
  { id: "fed-press", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", topic: "macro" }
];
function decodeXml(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
__name(decodeXml, "decodeXml");
function parseRss(xml, topic, limit = 12) {
  const items = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return items.slice(0, limit).map((item) => {
    const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const date = item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)?.[1] ?? "";
    const parsedDate = Date.parse(decodeXml(date));
    return {
      title: decodeXml(title).slice(0, 220),
      at: Number.isFinite(parsedDate) ? parsedDate : null,
      topic
    };
  }).filter((entry) => entry.title.length > 12);
}
__name(parseRss, "parseRss");
async function rssHeadlines(feed) {
  const xml = await text(feed.url, { timeoutMs: 7e3 });
  return parseRss(xml, feed.topic);
}
__name(rssHeadlines, "rssHeadlines");
var POSITIVE = ["beat", "beats", "surge", "surges", "rally", "rallies", "gain", "gains", "record high", "upgrade", "upgrades", "strong", "growth", "optimism", "rebound", "boost", "jump", "jumps", "soar", "soars", "profit", "bullish", "outperform", "expands", "recovery", "cut rates", "rate cut", "dovish", "easing"];
var NEGATIVE = ["miss", "misses", "plunge", "plunges", "slump", "slumps", "fall", "falls", "drop", "drops", "downgrade", "downgrades", "weak", "recession", "fear", "fears", "selloff", "sell-off", "crash", "loss", "losses", "bearish", "underperform", "warning", "warns", "default", "layoff", "layoffs", "inflation surge", "hike", "hawkish", "tariff", "sanction", "conflict", "war", "crisis", "bankruptcy", "probe", "lawsuit"];
function scoreHeadlines(headlines) {
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
    net: total > 0 ? round((positive - negative) / total, 2) : 0
  };
}
__name(scoreHeadlines, "scoreHeadlines");
async function finnhubNews(key) {
  const rows = await json(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}`);
  return (Array.isArray(rows) ? rows : []).slice(0, 15).map((row) => ({
    title: String(row.headline ?? "").slice(0, 220),
    at: Number(row.datetime) * 1e3 || null,
    topic: "markets"
  })).filter((entry) => entry.title);
}
__name(finnhubNews, "finnhubNews");
async function marketauxNews(key) {
  const data = await json(`https://api.marketaux.com/v1/news/all?filter_entities=true&language=en&limit=20&api_token=${encodeURIComponent(key)}`);
  return (Array.isArray(data?.data) ? data.data : []).map((row) => ({
    title: String(row.title ?? "").slice(0, 220),
    at: Date.parse(row.published_at ?? "") || null,
    topic: "markets"
  })).filter((entry) => entry.title);
}
__name(marketauxNews, "marketauxNews");
async function fmpRatios(key, symbols) {
  const list = symbols.slice(0, 12).join(",");
  const rows = await json(`https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(list)}?apikey=${encodeURIComponent(key)}`);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: String(row.symbol ?? ""),
    pe: Number.isFinite(Number(row.pe)) ? round(Number(row.pe), 1) : null,
    yearHigh: Number(row.yearHigh) || null,
    yearLow: Number(row.yearLow) || null,
    avgVolume: Number(row.avgVolume) || null
  })).filter((row) => row.symbol);
}
__name(fmpRatios, "fmpRatios");
async function collectExternalContext(options = {}) {
  const { finnhubKey, marketauxKey, fmpKey, symbols = [] } = options;
  const tasks = [
    settle("fx.eurusd", eurUsd),
    settle("crypto.global", cryptoGlobal),
    settle("crypto.feargreed", cryptoFearGreed),
    ...Object.keys(STOOQ_SERIES).map((key) => settle(`stooq.${key}`, () => stooqSeries(key))),
    ...RSS_FEEDS.map((feed) => settle(`rss.${feed.id}`, () => rssHeadlines(feed)))
  ];
  if (finnhubKey) tasks.push(settle("finnhub.news", () => finnhubNews(finnhubKey)));
  if (marketauxKey) tasks.push(settle("marketaux.news", () => marketauxNews(marketauxKey)));
  if (fmpKey && symbols.length) tasks.push(settle("fmp.quotes", () => fmpRatios(fmpKey, symbols)));
  const settled = await Promise.all(tasks);
  const byName = new Map(settled.map((entry) => [entry.name, entry]));
  const valueOf = /* @__PURE__ */ __name((name, fallback = null) => byName.get(name)?.ok ? byName.get(name).value : fallback, "valueOf");
  const headlines = settled.filter((entry) => entry.ok && (entry.name.startsWith("rss.") || entry.name.endsWith(".news"))).flatMap((entry) => entry.value ?? []);
  const deduped = [];
  const seen = /* @__PURE__ */ new Set();
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
  return {
    collectedAt: Date.now(),
    eurUsd: valueOf("fx.eurusd"),
    crypto: { global: valueOf("crypto.global"), fearGreed: valueOf("crypto.feargreed") },
    series,
    news: scoreHeadlines(deduped.slice(0, 60)),
    fundamentals: valueOf("fmp.quotes", []),
    diagnostics: settled.map(({ name, ok, error, ms }) => ({ name, ok, error, ms }))
  };
}
__name(collectExternalContext, "collectExternalContext");

// worker/lib/features.js
var round2 = /* @__PURE__ */ __name((value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}, "round");
function pctChange(series, lookback) {
  if (!Array.isArray(series) || series.length <= lookback) return null;
  const last = series[series.length - 1];
  const past = series[series.length - 1 - lookback];
  if (!past) return null;
  return round2((last - past) / past * 100, 2);
}
__name(pctChange, "pctChange");
function dailyReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i - 1] > 0) out.push(series[i] / series[i - 1] - 1);
  }
  return out;
}
__name(dailyReturns, "dailyReturns");
function annualizedVol(series, window = 30) {
  const returns = dailyReturns(series).slice(-window);
  if (returns.length < 5) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return round2(Math.sqrt(variance) * Math.sqrt(252) * 100, 1);
}
__name(annualizedVol, "annualizedVol");
function maxDrawdown(series) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, (value - peak) / peak);
  }
  return round2(worst * 100, 2);
}
__name(maxDrawdown, "maxDrawdown");
function rsi(series, period = 14) {
  if (series.length < period + 1) return null;
  const slice = series.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return round2(100 - 100 / (1 + gains / losses), 1);
}
__name(rsi, "rsi");
function sma(series, period) {
  if (series.length < period) return null;
  const slice = series.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}
__name(sma, "sma");
function distanceFromSma(series, period) {
  const average = sma(series, period);
  if (!average) return null;
  return round2((series[series.length - 1] - average) / average * 100, 2);
}
__name(distanceFromSma, "distanceFromSma");
function correlation(a, b) {
  const size = Math.min(a.length, b.length);
  if (size < 20) return null;
  const left = a.slice(-size);
  const right = b.slice(-size);
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / size;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / size;
  let cov = 0;
  let varLeft = 0;
  let varRight = 0;
  for (let i = 0; i < size; i += 1) {
    const dl = left[i] - meanLeft;
    const dr = right[i] - meanRight;
    cov += dl * dr;
    varLeft += dl * dl;
    varRight += dr * dr;
  }
  if (varLeft === 0 || varRight === 0) return null;
  return round2(cov / Math.sqrt(varLeft * varRight), 2);
}
__name(correlation, "correlation");
function momentumScore(closes) {
  const parts = [pctChange(closes, 21), pctChange(closes, 63), pctChange(closes, 126)];
  const weights = [0.5, 0.3, 0.2];
  let total = 0;
  let usedWeight = 0;
  parts.forEach((value, index) => {
    if (value == null) return;
    total += value * weights[index];
    usedWeight += weights[index];
  });
  if (usedWeight === 0) return null;
  return round2(Math.max(-100, Math.min(100, total / usedWeight * 3)), 1);
}
__name(momentumScore, "momentumScore");
function marketRegime(external) {
  const spx = external?.series?.spx?.map((row) => row.close) ?? [];
  const vix = external?.series?.vix?.map((row) => row.close) ?? [];
  const us10y = external?.series?.us10y?.map((row) => row.close) ?? [];
  const us2y = external?.series?.us2y?.map((row) => row.close) ?? [];
  const vixLast = vix.length ? vix[vix.length - 1] : null;
  const spxVsSma200 = distanceFromSma(spx, 200);
  const spxVsSma50 = distanceFromSma(spx, 50);
  const curveBp = us10y.length && us2y.length ? round2((us10y[us10y.length - 1] - us2y[us2y.length - 1]) * 100, 0) : null;
  const newsNet = external?.news?.net ?? 0;
  const signals = [];
  if (vixLast != null) signals.push(vixLast < 16 ? 1 : vixLast < 22 ? 0.2 : vixLast < 30 ? -0.5 : -1);
  if (spxVsSma200 != null) signals.push(spxVsSma200 > 3 ? 1 : spxVsSma200 > 0 ? 0.4 : spxVsSma200 > -5 ? -0.4 : -1);
  if (spxVsSma50 != null) signals.push(spxVsSma50 > 0 ? 0.5 : -0.5);
  if (curveBp != null) signals.push(curveBp > 20 ? 0.5 : curveBp > 0 ? 0.1 : -0.6);
  signals.push(newsNet);
  const score = signals.length ? round2(signals.reduce((sum, value) => sum + value, 0) / signals.length, 2) : 0;
  const label = score > 0.45 ? "risk-on" : score > 0.1 ? "risk-on moderato" : score > -0.15 ? "neutro" : score > -0.5 ? "risk-off moderato" : "risk-off";
  return { label, score, vix: vixLast != null ? round2(vixLast, 1) : null, spxVsSma200, spxVsSma50, yieldCurveBp: curveBp, newsNet };
}
__name(marketRegime, "marketRegime");
function buildFeatures({ snapshot, universe, candles, external, config, equityHistory: equityHistory2 = [] }) {
  const bySymbol = /* @__PURE__ */ new Map();
  const positionByInstrument = /* @__PURE__ */ new Map();
  for (const position of snapshot.positions) {
    const current = positionByInstrument.get(position.instrumentId) ?? { valueUsd: 0, investedUsd: 0, pnlUsd: 0, positionIds: [] };
    current.valueUsd += position.valueUsd;
    current.investedUsd += position.invested;
    current.pnlUsd += position.pnlUsd;
    current.positionIds.push(position.positionId);
    positionByInstrument.set(position.instrumentId, current);
  }
  const equityUsd = snapshot.equityUsd || 1;
  const benchmarkReturns = dailyReturns((candles.get("SPY") ?? []).map((row) => row.close));
  for (const [symbol, meta] of universe.entries()) {
    const series = (candles.get(symbol) ?? []).map((row) => row.close);
    const held = positionByInstrument.get(meta.instrumentId);
    const valueUsd = held?.valueUsd ?? 0;
    bySymbol.set(symbol, {
      symbol,
      class: meta.class,
      instrumentId: meta.instrumentId,
      weight: round2(valueUsd / equityUsd, 4),
      valueUsd: round2(valueUsd, 2),
      investedUsd: round2(held?.investedUsd ?? 0, 2),
      pnlUsd: round2(held?.pnlUsd ?? 0, 2),
      pnlPct: held?.investedUsd ? round2(held.pnlUsd / held.investedUsd * 100, 2) : null,
      positionIds: held?.positionIds ?? [],
      price: series.length ? round2(series[series.length - 1], 4) : null,
      ret1w: pctChange(series, 5),
      ret1m: pctChange(series, 21),
      ret3m: pctChange(series, 63),
      ret6m: pctChange(series, 126),
      ret12m: pctChange(series, 252),
      vol30: annualizedVol(series, 30),
      maxDd12m: series.length > 60 ? maxDrawdown(series.slice(-252)) : null,
      rsi14: rsi(series, 14),
      vsSma50: distanceFromSma(series, 50),
      vsSma200: distanceFromSma(series, 200),
      momentum: momentumScore(series),
      corrSpy: symbol === "SPY" ? 1 : correlation(dailyReturns(series), benchmarkReturns),
      maxWeight: meta.maxWeight
    });
  }
  const instruments = [...bySymbol.values()];
  const investedWeight = instruments.reduce((sum, item) => sum + item.weight, 0);
  const cashWeight = round2(Math.max(0, 1 - investedWeight), 4);
  const byClass = {};
  for (const item of instruments) {
    byClass[item.class] = round2((byClass[item.class] ?? 0) + item.weight, 4);
  }
  byClass.cash = cashWeight;
  const weights = instruments.map((item) => item.weight).filter((value) => value > 0);
  const herfindahl = round2(weights.reduce((sum, value) => sum + value ** 2, 0), 4);
  const equitySeries = equityHistory2.map((row) => Number(row.equity_usd)).filter(Number.isFinite);
  const portfolio = {
    equityUsd: round2(snapshot.equityUsd, 2),
    cashUsd: round2(snapshot.cashUsd, 2),
    investedUsd: round2(snapshot.investedUsd, 2),
    unrealizedPnlUsd: round2(instruments.reduce((sum, item) => sum + (item.pnlUsd ?? 0), 0), 2),
    openPositions: snapshot.positions.length,
    cashWeight,
    concentrationHhi: herfindahl,
    effectivePositions: herfindahl > 0 ? round2(1 / herfindahl, 1) : null,
    equityRet1w: pctChange(equitySeries, 7),
    equityRet1m: pctChange(equitySeries, 30),
    equityMaxDd: equitySeries.length > 10 ? maxDrawdown(equitySeries) : null
  };
  return {
    computedAt: Date.now(),
    budgetEur: config.budgetEur,
    eurUsd: external?.eurUsd?.rate ?? config.fallbackEurUsd,
    portfolio,
    allocationByClass: byClass,
    instruments,
    regime: marketRegime(external),
    crypto: external?.crypto ?? null,
    news: {
      net: external?.news?.net ?? 0,
      positiveHits: external?.news?.positiveHits ?? 0,
      negativeHits: external?.news?.negativeHits ?? 0,
      top: (external?.news?.items ?? []).slice(0, 10).map((item) => ({ t: item.title, s: item.score, topic: item.topic }))
    },
    fundamentals: external?.fundamentals ?? [],
    sourceDiagnostics: external?.diagnostics ?? []
  };
}
__name(buildFeatures, "buildFeatures");
function renderFeaturesPrompt(features, config) {
  const lines = [];
  const p = features.portfolio;
  lines.push(`PORTAFOGLIO (USD) equity=${p.equityUsd} cash=${p.cashUsd} (${(features.allocationByClass.cash * 100).toFixed(1)}%) investito=${p.investedUsd} pnl_aperto=${p.unrealizedPnlUsd} posizioni=${p.openPositions}`);
  lines.push(`STORICO equity 1w=${p.equityRet1w ?? "n/d"}% 1m=${p.equityRet1m ?? "n/d"}% maxDD=${p.equityMaxDd ?? "n/d"}% concentrazione_HHI=${p.concentrationHhi} pos_efficaci=${p.effectivePositions ?? "n/d"}`);
  lines.push(`CLASSI ${Object.entries(features.allocationByClass).map(([key, value]) => `${key}=${(value * 100).toFixed(1)}%`).join(" ")}`);
  const r = features.regime;
  lines.push(`REGIME ${r.label} (score ${r.score}) VIX=${r.vix ?? "n/d"} SPX_vs_SMA200=${r.spxVsSma200 ?? "n/d"}% SPX_vs_SMA50=${r.spxVsSma50 ?? "n/d"}% curva_10y2y=${r.yieldCurveBp ?? "n/d"}bp news_net=${r.newsNet}`);
  if (features.crypto?.global) {
    const g = features.crypto.global;
    const fg = features.crypto.fearGreed;
    lines.push(`CRYPTO mcap24h=${g.marketCapChange24hPct}% btc_dom=${g.btcDominancePct}% fear_greed=${fg?.value ?? "n/d"} (${fg?.label ?? "n/d"})`);
  }
  lines.push("");
  lines.push("STRUMENTI  peso%  max%  1m%    3m%    12m%   vol30  RSI  vsSMA50  vsSMA200  mom   corrSPY  pnl%");
  for (const item of features.instruments) {
    const cell = /* @__PURE__ */ __name((value, width, suffix = "") => `${value == null ? "n/d" : value}${suffix}`.padEnd(width), "cell");
    lines.push([
      item.symbol.padEnd(10),
      cell((item.weight * 100).toFixed(1), 6),
      cell((item.maxWeight * 100).toFixed(0), 5),
      cell(item.ret1m, 6),
      cell(item.ret3m, 6),
      cell(item.ret12m, 6),
      cell(item.vol30, 6),
      cell(item.rsi14, 4),
      cell(item.vsSma50, 8),
      cell(item.vsSma200, 9),
      cell(item.momentum, 5),
      cell(item.corrSpy, 8),
      cell(item.pnlPct, 6)
    ].join(" "));
  }
  if (features.news.top.length) {
    lines.push("");
    lines.push(`NOTIZIE (sentiment lessicale net=${features.news.net}, +${features.news.positiveHits}/-${features.news.negativeHits})`);
    for (const item of features.news.top) {
      lines.push(`- [${item.topic}${item.s ? ` ${item.s > 0 ? "+" : ""}${item.s}` : ""}] ${item.t}`);
    }
  }
  lines.push("");
  lines.push(`VINCOLI budget=${config.budgetEur} EUR (EURUSD ${features.eurUsd}) cash_min=${(config.minCashPct * 100).toFixed(0)}% cash_max=${(config.maxCashPct * 100).toFixed(0)}% turnover_max=${(config.maxTurnoverPct * 100).toFixed(0)}% ordini_max=${config.maxOrdersPerRun} banda_minima=${(config.minRebalanceBandAbs * 100).toFixed(0)}%`);
  lines.push(`PROFILO ${config.riskProfile}`);
  return lines.join("\n");
}
__name(renderFeaturesPrompt, "renderFeaturesPrompt");

// worker/lib/brain.js
var OPENROUTER_BASE = "https://openrouter.ai/api/v1";
var SYSTEM_PROMPT = `Sei un risk manager quantitativo. Ricevi lo stato di un portafoglio reale di piccola taglia e un insieme di indicatori gi\xE0 calcolati.

Il tuo unico output \xE8 un'allocazione TARGET in percentuale, in JSON valido, senza testo attorno.

Regole non negoziabili:
- Usa esclusivamente i simboli elencati in STRUMENTI, pi\xF9 la voce CASH.
- I pesi sono numeri decimali fra 0 e 1 e la loro somma deve fare esattamente 1.
- Non superare mai il peso massimo indicato nella colonna max% di ciascuno strumento.
- Nessuna leva, nessuna posizione short, nessuno strumento fuori lista.
- Se il quadro non \xE8 chiaro o i segnali sono contraddittori, proponi un'allocazione vicina a quella corrente e abbassa la confidence: l'inazione \xE8 una scelta legittima e spesso corretta.
- La confidence \xE8 la tua probabilit\xE0 soggettiva che questa allocazione batta il mantenimento dello status quo nell'orizzonte indicato. Sii conservativo.
- rationale: massimo 600 caratteri, in italiano, concreto, cita i numeri che ti hanno guidato.

Schema di output:
{"targetWeights":{"SIMBOLO":0.00,"CASH":0.00},"confidence":0.00,"rationale":"...","risks":["..."],"watch":["..."]}`;
var RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetWeights", "confidence", "rationale"],
  properties: {
    targetWeights: { type: "object", additionalProperties: { type: "number" } },
    confidence: { type: "number" },
    rationale: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    watch: { type: "array", items: { type: "string" } }
  }
};
function extractJson(text2) {
  if (!text2) return null;
  const cleaned = text2.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
__name(extractJson, "extractJson");
function normalizeProposal(raw, allowedSymbols) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "risposta non \xE8 un oggetto" };
  const weightsRaw = raw.targetWeights ?? raw.target_weights ?? raw.weights;
  if (!weightsRaw || typeof weightsRaw !== "object") return { ok: false, error: "targetWeights assente" };
  const allowed = /* @__PURE__ */ new Set([...allowedSymbols, "CASH"]);
  const unknown = [];
  const weights = {};
  for (const [key, value] of Object.entries(weightsRaw)) {
    const symbol = String(key).trim().toUpperCase();
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    if (!allowed.has(symbol)) {
      unknown.push(symbol);
      continue;
    }
    weights[symbol] = numeric > 1.0001 ? numeric / 100 : numeric;
  }
  if (unknown.length) return { ok: false, error: `simboli non ammessi: ${unknown.join(", ")}` };
  if (!Object.keys(weights).length) return { ok: false, error: "nessun peso valido" };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ok: false, error: "somma pesi nulla" };
  if (Math.abs(total - 1) > 0.05) return { ok: false, error: `somma pesi ${total.toFixed(3)} fuori tolleranza` };
  for (const key of Object.keys(weights)) weights[key] = Math.round(weights[key] / total * 1e4) / 1e4;
  const confidence = Number(raw.confidence);
  return {
    ok: true,
    value: {
      targetWeights: weights,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : 0.5,
      rationale: String(raw.rationale ?? "").slice(0, 1500),
      risks: Array.isArray(raw.risks) ? raw.risks.map(String).slice(0, 6) : [],
      watch: Array.isArray(raw.watch) ? raw.watch.map(String).slice(0, 6) : []
    }
  };
}
__name(normalizeProposal, "normalizeProposal");
async function callOpenRouter(apiKey, model, messages, { temperature, maxTokens, responseFormat, referer }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6e4);
  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": referer || "https://etorodashboard.workers.dev",
        "X-Title": "Torino Autopilot"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...responseFormat ? { response_format: responseFormat } : {}
      })
    });
    const text2 = await response.text();
    let payload = {};
    try {
      payload = text2 ? JSON.parse(text2) : {};
    } catch {
      payload = { raw: text2 };
    }
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
      throw new Error(typeof message === "string" ? message : JSON.stringify(message));
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error("risposta senza contenuto");
    return { content: typeof content === "string" ? content : JSON.stringify(content), usage: payload?.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}
__name(callOpenRouter, "callOpenRouter");
async function listFreeModels(apiKey) {
  const response = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  });
  if (!response.ok) throw new Error(`OpenRouter models HTTP ${response.status}`);
  const payload = await response.json();
  return (payload?.data ?? []).filter((model) => Number(model?.pricing?.prompt ?? 1) === 0 && Number(model?.pricing?.completion ?? 1) === 0).map((model) => ({
    id: model.id,
    name: model.name,
    contextLength: model.context_length ?? null,
    supportsJsonSchema: Boolean(model?.supported_parameters?.includes?.("structured_outputs"))
  })).sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
}
__name(listFreeModels, "listFreeModels");
async function askBrain({ apiKey, models, featuresPrompt, allowedSymbols, config, referer }) {
  const userPrompt = `${featuresPrompt}

Orizzonte del ribilanciamento: ${config.cadence === "daily" ? "giornaliero" : config.cadence === "monthly" ? "mensile" : "settimanale"}.
Rispondi solo con il JSON dello schema richiesto.`;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt }
  ];
  const formats = [
    { type: "json_schema", json_schema: { name: "allocation", strict: true, schema: RESPONSE_SCHEMA } },
    { type: "json_object" },
    null
  ];
  const attempts = [];
  for (const model of models) {
    for (const responseFormat of formats) {
      const label = responseFormat?.type ?? "text";
      try {
        const { content, usage } = await callOpenRouter(apiKey, model, messages, {
          temperature: config.llmTemperature,
          maxTokens: config.llmMaxTokens,
          responseFormat,
          referer
        });
        const parsedRaw = extractJson(content);
        const normalized = normalizeProposal(parsedRaw, allowedSymbols);
        if (!normalized.ok) {
          attempts.push({ model, format: label, ok: false, error: normalized.error });
          continue;
        }
        attempts.push({ model, format: label, ok: true, usage });
        return { ok: true, model, attempts, rawText: content, promptChars: userPrompt.length + SYSTEM_PROMPT.length, parsed: normalized.value, usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ model, format: label, ok: false, error: message });
        if (/rate limit|429|quota|temporarily/i.test(message)) break;
      }
    }
  }
  return { ok: false, attempts, error: "nessun modello ha prodotto una proposta valida", promptChars: userPrompt.length };
}
__name(askBrain, "askBrain");

// worker/lib/validator.js
var round3 = /* @__PURE__ */ __name((value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits, "round");
function violation(code, message, severity = "blocking", data) {
  return { code, message, severity, data };
}
__name(violation, "violation");
function clampWeights(targetWeights, features, config, violations) {
  const bySymbol = new Map(features.instruments.map((item) => [item.symbol, item]));
  const weights = { ...targetWeights };
  for (const [symbol, weight] of Object.entries(weights)) {
    if (symbol === "CASH") continue;
    const meta = bySymbol.get(symbol);
    const cap = meta?.maxWeight ?? 0;
    if (weight > cap) {
      violations.push(violation("symbol_cap", `${symbol}: peso ${(weight * 100).toFixed(1)}% ridotto al massimo ${(cap * 100).toFixed(0)}%`, "clamped"));
      weights[symbol] = cap;
    }
  }
  const classCaps = config.maxWeightPerClass ?? {};
  const classTotals = {};
  for (const [symbol, weight] of Object.entries(weights)) {
    if (symbol === "CASH") continue;
    const klass = bySymbol.get(symbol)?.class ?? "other";
    classTotals[klass] = (classTotals[klass] ?? 0) + weight;
  }
  for (const [klass, total] of Object.entries(classTotals)) {
    const cap = classCaps[klass];
    if (cap == null || total <= cap || total === 0) continue;
    const factor = cap / total;
    violations.push(violation("class_cap", `classe ${klass}: ${(total * 100).toFixed(1)}% ridotta a ${(cap * 100).toFixed(0)}%`, "clamped"));
    for (const [symbol, weight] of Object.entries(weights)) {
      if (symbol !== "CASH" && (bySymbol.get(symbol)?.class ?? "other") === klass) weights[symbol] = weight * factor;
    }
  }
  const invested = Object.entries(weights).reduce((sum, [symbol, weight]) => sum + (symbol === "CASH" ? 0 : weight), 0);
  let cash = round3(1 - invested, 4);
  if (cash < config.minCashPct) {
    const deficit = config.minCashPct - cash;
    violations.push(violation("cash_floor", `cash ${(cash * 100).toFixed(1)}% sotto il minimo ${(config.minCashPct * 100).toFixed(0)}%: posizioni ridotte`, "clamped"));
    const factor = invested > 0 ? (invested - deficit) / invested : 0;
    for (const symbol of Object.keys(weights)) {
      if (symbol !== "CASH") weights[symbol] *= factor;
    }
    cash = config.minCashPct;
  }
  if (cash > config.maxCashPct) {
    violations.push(violation("cash_ceiling", `cash ${(cash * 100).toFixed(1)}% sopra il massimo ${(config.maxCashPct * 100).toFixed(0)}%: proposta accettata ma segnalata`, "info"));
  }
  weights.CASH = round3(cash, 4);
  for (const key of Object.keys(weights)) weights[key] = round3(weights[key], 4);
  return weights;
}
__name(clampWeights, "clampWeights");
function validateProposal({ proposal, features, config, ordersToday = 0 }) {
  const violations = [];
  const equityUsd = features.portfolio.equityUsd;
  const bySymbol = new Map(features.instruments.map((item) => [item.symbol, item]));
  if (config.frozen) violations.push(violation("frozen", `agente congelato: ${config.frozenReason || "freeze manuale"}`));
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) violations.push(violation("no_equity", "equity del portafoglio non disponibile"));
  if (proposal.confidence < config.minConfidence) {
    violations.push(violation("low_confidence", `confidence ${proposal.confidence.toFixed(2)} sotto la soglia ${config.minConfidence}`));
  }
  if (ordersToday >= config.maxOrdersPerDay) {
    violations.push(violation("daily_order_cap", `raggiunto il limite di ${config.maxOrdersPerDay} ordini nelle ultime 24h`));
  }
  const targets = clampWeights(proposal.targetWeights, features, config, violations);
  const deltas = [];
  for (const item of features.instruments) {
    const target = targets[item.symbol] ?? 0;
    const current = item.weight ?? 0;
    const deltaAbs = target - current;
    const deltaRel = current > 1e-4 ? Math.abs(deltaAbs) / current : Math.abs(deltaAbs) > 0 ? 1 : 0;
    const withinBand = Math.abs(deltaAbs) < config.minRebalanceBandAbs && deltaRel < config.minRebalanceBandRel;
    deltas.push({
      symbol: item.symbol,
      instrumentId: item.instrumentId,
      class: item.class,
      currentWeight: current,
      targetWeight: target,
      deltaWeight: round3(deltaAbs, 4),
      deltaUsd: round3(deltaAbs * equityUsd, 2),
      positionIds: item.positionIds,
      currentValueUsd: item.valueUsd,
      skipped: withinBand ? "dentro banda di tolleranza" : null
    });
  }
  let candidates = deltas.filter((item) => !item.skipped && Math.abs(item.deltaUsd) >= config.minOrderUsd);
  for (const item of deltas) {
    if (!item.skipped && Math.abs(item.deltaUsd) < config.minOrderUsd) {
      item.skipped = `sotto l'ordine minimo di ${config.minOrderUsd} USD`;
    }
  }
  const turnoverUsd = candidates.reduce((sum, item) => sum + Math.abs(item.deltaUsd), 0);
  const turnoverCapUsd = config.maxTurnoverPct * equityUsd;
  if (turnoverUsd > turnoverCapUsd && turnoverUsd > 0) {
    const factor = turnoverCapUsd / turnoverUsd;
    violations.push(violation("turnover_cap", `turnover ${round3(turnoverUsd, 0)} USD ridotto a ${round3(turnoverCapUsd, 0)} USD (${(config.maxTurnoverPct * 100).toFixed(0)}%)`, "clamped"));
    for (const item of candidates) item.deltaUsd = round3(item.deltaUsd * factor, 2);
    candidates = candidates.filter((item) => Math.abs(item.deltaUsd) >= config.minOrderUsd);
  }
  for (const item of candidates) {
    if (Math.abs(item.deltaUsd) > config.maxOrderUsd) {
      violations.push(violation("order_cap", `${item.symbol}: importo ridotto a ${config.maxOrderUsd} USD`, "clamped"));
      item.deltaUsd = round3(Math.sign(item.deltaUsd) * config.maxOrderUsd, 2);
    }
  }
  candidates.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  const remainingSlots = Math.max(0, Math.min(config.maxOrdersPerRun, config.maxOrdersPerDay - ordersToday));
  if (candidates.length > remainingSlots) {
    violations.push(violation("run_order_cap", `${candidates.length} ordini richiesti, ne vengono eseguiti ${remainingSlots}`, "clamped"));
    for (const dropped of candidates.slice(remainingSlots)) dropped.skipped = "oltre il numero massimo di ordini";
    candidates = candidates.slice(0, remainingSlots);
  }
  const sells = candidates.filter((item) => item.deltaUsd < 0).sort((a, b) => a.deltaUsd - b.deltaUsd);
  const buys = candidates.filter((item) => item.deltaUsd > 0).sort((a, b) => b.deltaUsd - a.deltaUsd);
  let availableCash = features.portfolio.cashUsd + sells.reduce((sum, item) => sum + Math.abs(item.deltaUsd), 0);
  const reserveUsd = config.minCashPct * equityUsd;
  const orders = [];
  let seq = 0;
  for (const item of sells) {
    const amount = Math.min(Math.abs(item.deltaUsd), item.currentValueUsd);
    if (amount < config.minOrderUsd) {
      item.skipped = "posizione troppo piccola per una vendita valida";
      continue;
    }
    const fullExit = item.targetWeight === 0 || amount >= item.currentValueUsd - 0.01;
    orders.push({
      seq: seq++,
      symbol: item.symbol,
      instrumentId: item.instrumentId,
      side: "sell",
      amountUsd: round3(amount, 2),
      positionId: item.positionIds[0] ?? null,
      positionIds: item.positionIds,
      fullExit,
      reason: `peso ${(item.currentWeight * 100).toFixed(1)}% \u2192 ${(item.targetWeight * 100).toFixed(1)}%`
    });
  }
  for (const item of buys) {
    const spendable = Math.max(0, availableCash - reserveUsd);
    const amount = Math.min(item.deltaUsd, spendable);
    if (amount < config.minOrderUsd) {
      item.skipped = amount <= 0 ? "liquidit\xE0 insufficiente dopo la riserva di cassa" : `residuo ${round3(amount, 2)} USD sotto il minimo`;
      continue;
    }
    availableCash -= amount;
    orders.push({
      seq: seq++,
      symbol: item.symbol,
      instrumentId: item.instrumentId,
      side: "buy",
      amountUsd: round3(amount, 2),
      positionId: null,
      positionIds: [],
      fullExit: false,
      reason: `peso ${(item.currentWeight * 100).toFixed(1)}% \u2192 ${(item.targetWeight * 100).toFixed(1)}%`
    });
  }
  const blocking = violations.filter((item) => item.severity === "blocking");
  const plan = {
    createdAt: Date.now(),
    equityUsd,
    targets,
    deltas,
    orders,
    turnoverUsd: round3(orders.reduce((sum, item) => sum + item.amountUsd, 0), 2),
    turnoverPct: equityUsd > 0 ? round3(orders.reduce((sum, item) => sum + item.amountUsd, 0) / equityUsd, 4) : 0,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
    risks: proposal.risks,
    watch: proposal.watch
  };
  return { ok: blocking.length === 0, violations, plan };
}
__name(validateProposal, "validateProposal");

// worker/lib/db.js
var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, execution_mode TEXT NOT NULL, equity_usd REAL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL, equity_usd REAL NOT NULL, cash_usd REAL NOT NULL, invested_usd REAL NOT NULL, positions_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS features (run_id TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, payload_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS proposals (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, model TEXT, attempts_json TEXT, prompt_chars INTEGER, raw_text TEXT, parsed_json TEXT, confidence REAL, rationale TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS validations (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, ok INTEGER NOT NULL, violations_json TEXT NOT NULL, plan_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, symbol TEXT NOT NULL, instrument_id INTEGER NOT NULL, side TEXT NOT NULL, amount_usd REAL NOT NULL, position_id INTEGER, mode TEXT NOT NULL, state TEXT NOT NULL, etoro_order_id TEXT, position_ids TEXT, filled_usd REAL NOT NULL DEFAULT 0, message TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_run ON orders (run_id)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, at INTEGER NOT NULL, level TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at DESC)`,
  `CREATE TABLE IF NOT EXISTS equity_curve (at INTEGER PRIMARY KEY, equity_usd REAL NOT NULL, invested_usd REAL, cash_usd REAL, hwm_usd REAL)`
];
var DEFAULT_CONFIG = {
  /** shadow: nessun ordine. dry-run: ordini costruiti e simulati. live: invio reale. */
  executionMode: "shadow",
  /** Blocco totale attivato da circuit breaker o dall'utente. */
  frozen: false,
  frozenReason: "",
  cadence: "weekly",
  // daily | weekly | monthly
  rebalanceWeekday: 1,
  // 1 = lunedì (solo per cadence weekly)
  rebalanceDayOfMonth: 1,
  // solo per cadence monthly
  rebalanceHour: 9,
  // ora locale Europe/Rome
  rebalanceMinute: 30,
  snapshotHours: [8, 14, 22],
  // ore locali per lo snapshot giornaliero
  /** Capitale nominale gestito dall'agente, in EUR. */
  budgetEur: 250,
  /** Cambio EUR→USD di fallback se le fonti FX non rispondono. */
  fallbackEurUsd: 1.08,
  /** Universo ammesso: nessun ordine fuori da questa lista. */
  whitelist: [
    { symbol: "SPY", name: "SPDR S&P 500 ETF", class: "etf", maxWeight: 0.4 },
    { symbol: "QQQ", name: "Invesco QQQ Trust", class: "etf", maxWeight: 0.3 },
    { symbol: "IWDA.L", name: "iShares Core MSCI World", class: "etf", maxWeight: 0.4 },
    { symbol: "GLD", name: "SPDR Gold Shares", class: "commodity", maxWeight: 0.25 },
    { symbol: "TLT", name: "iShares 20+ Treasury", class: "bond", maxWeight: 0.25 },
    { symbol: "BTC", name: "Bitcoin", class: "crypto", maxWeight: 0.15 },
    { symbol: "ETH", name: "Ethereum", class: "crypto", maxWeight: 0.1 }
  ],
  /** Guardrail non negoziabili. */
  maxOrdersPerRun: 6,
  maxOrdersPerDay: 8,
  minOrderUsd: 10,
  maxOrderUsd: 120,
  maxTurnoverPct: 0.2,
  // quota max di portafoglio movimentata per run
  minRebalanceBandAbs: 0.03,
  // scostamento assoluto minimo per agire
  minRebalanceBandRel: 0.15,
  // scostamento relativo minimo per agire
  maxWeightPerClass: { etf: 0.8, bond: 0.4, commodity: 0.25, crypto: 0.2, cash: 1 },
  minCashPct: 0.05,
  maxCashPct: 0.6,
  /** Drawdown dal massimo storico che congela l'agente. */
  drawdownStopPct: 0.15,
  /** Divergenza tollerata in riconciliazione prima del freeze. */
  reconcileTolerancePct: 0.05,
  /** Confidenza minima della proposta perché sia eseguibile. */
  minConfidence: 0.55,
  /** Cascata modelli OpenRouter: il primo che risponde valido vince. */
  models: [
    "deepseek/deepseek-chat-v3-0324:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-235b-a22b:free",
    "mistralai/mistral-small-3.2-24b-instruct:free",
    "google/gemma-3-27b-it:free"
  ],
  llmTemperature: 0.2,
  llmMaxTokens: 1600,
  /** Politica di rischio in linguaggio naturale, iniettata nel prompt. */
  riskProfile: "Bilanciato. Priorit\xE0 alla protezione del capitale, crescita moderata, nessuna leva, nessuno short."
};
var CONFIG_KEY = "autopilot";
async function migrate(db) {
  for (const statement of SCHEMA) {
    await db.prepare(statement).run();
  }
}
__name(migrate, "migrate");
function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = current && typeof current === "object" && !Array.isArray(current) ? deepMerge(current, value) : value;
  }
  return out;
}
__name(deepMerge, "deepMerge");
async function loadConfig(db) {
  const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(CONFIG_KEY).first();
  if (!row?.value) return { ...DEFAULT_CONFIG };
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
__name(loadConfig, "loadConfig");
async function saveConfig(db, patch) {
  const current = await loadConfig(db);
  const next = deepMerge(current, patch);
  await db.prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(CONFIG_KEY, JSON.stringify(next), Date.now()).run();
  return next;
}
__name(saveConfig, "saveConfig");
async function audit(db, runId, level, stage, message, data) {
  await db.prepare("INSERT INTO audit (run_id, at, level, stage, message, data_json) VALUES (?, ?, ?, ?, ?, ?)").bind(runId ?? null, Date.now(), level, stage, String(message).slice(0, 2e3), data === void 0 ? null : JSON.stringify(data).slice(0, 2e4)).run();
}
__name(audit, "audit");
async function startRun(db, id, kind, executionMode) {
  await db.prepare("INSERT INTO runs (id, kind, started_at, status, execution_mode) VALUES (?, ?, ?, ?, ?)").bind(id, kind, Date.now(), "running", executionMode).run();
}
__name(startRun, "startRun");
async function finishRun(db, id, status, equityUsd, error) {
  await db.prepare("UPDATE runs SET finished_at = ?, status = ?, equity_usd = ?, error = ? WHERE id = ?").bind(Date.now(), status, equityUsd ?? null, error ? String(error).slice(0, 1e3) : null, id).run();
}
__name(finishRun, "finishRun");
async function saveSnapshot(db, runId, snapshot) {
  await db.prepare("INSERT OR REPLACE INTO snapshots (run_id, taken_at, equity_usd, cash_usd, invested_usd, positions_json) VALUES (?, ?, ?, ?, ?, ?)").bind(runId, snapshot.takenAt, snapshot.equityUsd, snapshot.cashUsd, snapshot.investedUsd, JSON.stringify(snapshot.positions)).run();
}
__name(saveSnapshot, "saveSnapshot");
async function saveFeatures(db, runId, payload) {
  await db.prepare("INSERT OR REPLACE INTO features (run_id, computed_at, payload_json) VALUES (?, ?, ?)").bind(runId, Date.now(), JSON.stringify(payload)).run();
}
__name(saveFeatures, "saveFeatures");
async function saveProposal(db, runId, proposal) {
  await db.prepare("INSERT OR REPLACE INTO proposals (run_id, created_at, model, attempts_json, prompt_chars, raw_text, parsed_json, confidence, rationale, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
    runId,
    Date.now(),
    proposal.model ?? null,
    JSON.stringify(proposal.attempts ?? []),
    proposal.promptChars ?? null,
    (proposal.rawText ?? "").slice(0, 2e4),
    proposal.parsed ? JSON.stringify(proposal.parsed) : null,
    proposal.parsed?.confidence ?? null,
    (proposal.parsed?.rationale ?? "").slice(0, 4e3),
    proposal.error ? String(proposal.error).slice(0, 1e3) : null
  ).run();
}
__name(saveProposal, "saveProposal");
async function saveValidation(db, runId, validation) {
  await db.prepare("INSERT OR REPLACE INTO validations (run_id, created_at, ok, violations_json, plan_json) VALUES (?, ?, ?, ?, ?)").bind(runId, Date.now(), validation.ok ? 1 : 0, JSON.stringify(validation.violations), JSON.stringify(validation.plan)).run();
}
__name(saveValidation, "saveValidation");
async function recordEquity(db, equityUsd, investedUsd, cashUsd) {
  const previous = await db.prepare("SELECT hwm_usd FROM equity_curve ORDER BY at DESC LIMIT 1").first();
  const hwm = Math.max(Number(previous?.hwm_usd ?? 0), equityUsd);
  await db.prepare("INSERT OR REPLACE INTO equity_curve (at, equity_usd, invested_usd, cash_usd, hwm_usd) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), equityUsd, investedUsd ?? null, cashUsd ?? null, hwm).run();
  return { hwm, drawdown: hwm > 0 ? (hwm - equityUsd) / hwm : 0 };
}
__name(recordEquity, "recordEquity");
async function countOrdersToday(db) {
  const since = Date.now() - 24 * 60 * 60 * 1e3;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at > ? AND state NOT IN ('simulated','skipped')").bind(since).first();
  return Number(row?.n ?? 0);
}
__name(countOrdersToday, "countOrdersToday");
async function upsertOrder(db, order) {
  await db.prepare(`INSERT INTO orders (id, run_id, seq, created_at, updated_at, symbol, instrument_id, side, amount_usd, position_id, mode, state, etoro_order_id, position_ids, filled_usd, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, state = excluded.state, etoro_order_id = excluded.etoro_order_id, position_ids = excluded.position_ids, filled_usd = excluded.filled_usd, message = excluded.message`).bind(
    order.id,
    order.runId,
    order.seq,
    order.createdAt ?? Date.now(),
    Date.now(),
    order.symbol,
    order.instrumentId,
    order.side,
    order.amountUsd,
    order.positionId ?? null,
    order.mode,
    order.state,
    order.etoroOrderId ?? null,
    order.positionIds ? JSON.stringify(order.positionIds) : null,
    order.filledUsd ?? 0,
    order.message ? String(order.message).slice(0, 1e3) : null
  ).run();
}
__name(upsertOrder, "upsertOrder");
async function getOrder(db, id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
}
__name(getOrder, "getOrder");
async function listRuns(db, limit = 30) {
  const { results } = await db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").bind(limit).all();
  return results ?? [];
}
__name(listRuns, "listRuns");
async function getRunBundle(db, runId) {
  const [run, snapshot, features, proposal, validation, orders, logs] = await Promise.all([
    db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first(),
    db.prepare("SELECT * FROM snapshots WHERE run_id = ?").bind(runId).first(),
    db.prepare("SELECT * FROM features WHERE run_id = ?").bind(runId).first(),
    db.prepare("SELECT * FROM proposals WHERE run_id = ?").bind(runId).first(),
    db.prepare("SELECT * FROM validations WHERE run_id = ?").bind(runId).first(),
    db.prepare("SELECT * FROM orders WHERE run_id = ? ORDER BY seq").bind(runId).all(),
    db.prepare("SELECT * FROM audit WHERE run_id = ? ORDER BY at").bind(runId).all()
  ]);
  const parse = /* @__PURE__ */ __name((value, fallback = null) => {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }, "parse");
  return {
    run: run ?? null,
    snapshot: snapshot ? { ...snapshot, positions: parse(snapshot.positions_json, []) } : null,
    features: features ? parse(features.payload_json, null) : null,
    proposal: proposal ? { ...proposal, parsed: parse(proposal.parsed_json, null), attempts: parse(proposal.attempts_json, []) } : null,
    validation: validation ? { ok: !!validation.ok, violations: parse(validation.violations_json, []), plan: parse(validation.plan_json, null) } : null,
    orders: (orders?.results ?? []).map((row) => ({ ...row, positionIds: parse(row.position_ids, []) })),
    logs: (logs?.results ?? []).map((row) => ({ ...row, data: parse(row.data_json, null) }))
  };
}
__name(getRunBundle, "getRunBundle");
async function equityHistory(db, limit = 400) {
  const { results } = await db.prepare("SELECT * FROM equity_curve ORDER BY at DESC LIMIT ?").bind(limit).all();
  return (results ?? []).reverse();
}
__name(equityHistory, "equityHistory");

// worker/lib/executor.js
var round4 = /* @__PURE__ */ __name((value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits, "round");
async function deterministicId(...parts) {
  const data = new TextEncoder().encode(parts.join("|"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
__name(deterministicId, "deterministicId");
var sleep = /* @__PURE__ */ __name((ms) => new Promise((resolve) => setTimeout(resolve, ms)), "sleep");
async function checkEligibility(client, orders, config) {
  const buys = orders.filter((order) => order.side === "buy");
  if (!buys.length) return { ok: true, issues: [], checks: [] };
  const map = await client.eligibility([...new Set(buys.map((order) => order.instrumentId))]);
  const issues = [];
  const checks = buys.map((order) => {
    const info = map.get(order.instrumentId);
    let detail = "ammesso";
    if (!info) detail = "eToro non ha restituito l\u2019ammissibilit\xE0";
    else if (!info.allowOpenPosition) detail = "mercato chiuso o strumento non negoziabile";
    else if (order.amountUsd + 5e-3 < info.minPositionUsd) detail = `sotto il minimo eToro di ${info.minPositionUsd} USD`;
    const eligible = detail === "ammesso";
    if (!eligible) issues.push(`${order.symbol}: ${detail}`);
    return { symbol: order.symbol, instrumentId: order.instrumentId, eligible, detail, minPositionUsd: info?.minPositionUsd ?? null };
  });
  void config;
  return { ok: issues.length === 0, issues, checks };
}
__name(checkEligibility, "checkEligibility");
async function executePlan({ db, client, runId, plan, mode, config }) {
  const results = [];
  if (mode === "shadow") {
    for (const order of plan.orders) {
      const id = await deterministicId(runId, order.seq, order.symbol, order.side);
      const record = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode, state: "simulated", message: "shadow mode: nessun ordine costruito" };
      await upsertOrder(db, record);
      results.push(record);
    }
    return { mode, executed: false, results, eligibility: null };
  }
  const eligibility = await checkEligibility(client, plan.orders, config).catch((error) => ({
    ok: false,
    issues: [`pre-check ammissibilit\xE0 fallito: ${error.message}`],
    checks: []
  }));
  if (!eligibility.ok) {
    await audit(db, runId, "warn", "executor", "Piano bloccato dal pre-check di ammissibilit\xE0", eligibility.issues);
    for (const order of plan.orders) {
      const id = await deterministicId(runId, order.seq, order.symbol, order.side);
      const record = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode, state: "skipped", message: eligibility.issues.join(" \xB7 ").slice(0, 500) };
      await upsertOrder(db, record);
      results.push(record);
    }
    return { mode, executed: false, results, eligibility, blocked: true };
  }
  for (const order of plan.orders) {
    const id = await deterministicId(runId, order.seq, order.symbol, order.side);
    const existing = await getOrder(db, id);
    if (existing && existing.state !== "intent") {
      results.push({ ...existing, skippedDuplicate: true });
      continue;
    }
    const base = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode };
    if (mode === "dry-run") {
      const record = { ...base, state: "simulated", message: `dry-run: ${order.side} ${order.amountUsd} USD non inviato` };
      await upsertOrder(db, record);
      results.push(record);
      continue;
    }
    await upsertOrder(db, { ...base, state: "intent", message: "in invio" });
    try {
      const response = order.side === "buy" ? await client.openOrder({ instrumentId: order.instrumentId, amountUsd: order.amountUsd, requestId: id }) : await client.closeOrder({ positionId: order.positionId, amountUsd: order.fullExit ? null : order.amountUsd, requestId: id });
      const etoroOrderId = String(response?.orderId ?? response?.OrderId ?? response?.OrderID ?? "") || null;
      const record = { ...base, state: "sent", etoroOrderId, message: "accettato, in verifica" };
      await upsertOrder(db, record);
      results.push(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = { ...base, state: "failed", message };
      await upsertOrder(db, record);
      results.push(record);
      await audit(db, runId, "error", "executor", `Invio interrotto su ${order.symbol}`, { message });
      for (const remaining of plan.orders.filter((item) => item.seq > order.seq)) {
        const skippedId = await deterministicId(runId, remaining.seq, remaining.symbol, remaining.side);
        const skipped = { id: skippedId, runId, seq: remaining.seq, symbol: remaining.symbol, instrumentId: remaining.instrumentId, side: remaining.side, amountUsd: remaining.amountUsd, positionId: remaining.positionId, mode, state: "skipped", message: "non inviato: interruzione dopo errore precedente" };
        await upsertOrder(db, skipped);
        results.push(skipped);
      }
      break;
    }
  }
  if (mode === "live") await verifyOrders({ db, client, results });
  return { mode, executed: mode === "live", results, eligibility };
}
__name(executePlan, "executePlan");
async function verifyOrders({ db, client, results }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = results.filter((item) => item.state === "sent");
    if (!pending.length) return;
    if (attempt > 0) await sleep(1500);
    for (const record of pending) {
      try {
        const lookup = await client.lookupOrder({ orderId: record.etoroOrderId, referenceId: record.id });
        record.state = lookup.state === "pending" ? "sent" : lookup.state;
        record.filledUsd = lookup.filledUsd || (lookup.state === "filled" ? record.amountUsd : 0);
        record.positionIds = lookup.positionIds;
        record.message = lookup.error ? `${lookup.label} \u2014 ${lookup.error}` : lookup.label;
        await upsertOrder(db, record);
      } catch (error) {
        record.message = `verifica non riuscita: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
}
__name(verifyOrders, "verifyOrders");
async function reconcile({ client, plan, config }) {
  const snapshot = await client.portfolio();
  const equity = snapshot.equityUsd || 1;
  const byInstrument = /* @__PURE__ */ new Map();
  for (const position of snapshot.positions) {
    byInstrument.set(position.instrumentId, (byInstrument.get(position.instrumentId) ?? 0) + position.valueUsd);
  }
  const rows = plan.deltas.map((delta) => {
    const actualWeight = round4((byInstrument.get(delta.instrumentId) ?? 0) / equity, 4);
    return {
      symbol: delta.symbol,
      expectedWeight: delta.skipped ? delta.currentWeight : delta.targetWeight,
      actualWeight,
      divergence: round4(Math.abs(actualWeight - (delta.skipped ? delta.currentWeight : delta.targetWeight)), 4)
    };
  });
  const worst = rows.reduce((max, row) => Math.max(max, row.divergence), 0);
  return {
    checkedAt: Date.now(),
    equityUsd: snapshot.equityUsd,
    rows,
    worstDivergence: worst,
    ok: worst <= config.reconcileTolerancePct,
    snapshot
  };
}
__name(reconcile, "reconcile");

// worker/lib/notify.js
async function post(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(post, "post");
async function notify(credentials, level, title, lines = []) {
  const icon = level === "critical" ? "\u{1F534}" : level === "warn" ? "\u{1F7E1}" : "\u{1F7E2}";
  const text2 = [`${icon} ${title}`, ...lines.filter(Boolean)].join("\n").slice(0, 3500);
  const tasks = [];
  if (credentials?.telegramBotToken && credentials?.telegramChatId) {
    tasks.push(post(`https://api.telegram.org/bot${credentials.telegramBotToken}/sendMessage`, {
      chat_id: credentials.telegramChatId,
      text: text2,
      disable_web_page_preview: true
    }));
  }
  if (credentials?.notifyWebhookUrl) {
    tasks.push(post(credentials.notifyWebhookUrl, { level, title, lines, text: text2, at: Date.now() }));
  }
  const results = await Promise.allSettled(tasks);
  return { sent: results.filter((item) => item.status === "fulfilled").length, attempted: tasks.length };
}
__name(notify, "notify");
async function notifyTest(credentials) {
  if (!credentials?.telegramBotToken || !credentials?.telegramChatId) {
    if (!credentials?.notifyWebhookUrl) throw new Error("nessun canale di notifica configurato");
  }
  const result = await notify(credentials, "info", "Test notifiche Autopilot", [
    "Se leggi questo messaggio il canale \xE8 configurato correttamente.",
    "Riceverai qui ogni run, ordine, blocco dei guardrail e freeze automatico."
  ]);
  if (result.attempted === 0) throw new Error("nessun canale di notifica configurato");
  if (result.sent === 0) throw new Error("invio fallito: verifica bot token e chat id");
  return result;
}
__name(notifyTest, "notifyTest");

// worker/lib/vault.js
var VAULT_ROW = "vault";
var CREDENTIAL_FIELDS = [
  { key: "etoroApiKey", env: "ETORO_API_KEY", label: "eToro API key", required: true },
  { key: "etoroUserKey", env: "ETORO_USER_KEY", label: "eToro user key", required: true },
  { key: "etoroAgentToken", env: "ETORO_AGENT_TOKEN", label: "Token Agent Portfolio", required: false },
  { key: "openrouterApiKey", env: "OPENROUTER_API_KEY", label: "OpenRouter API key", required: true },
  { key: "telegramBotToken", env: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", required: false },
  { key: "telegramChatId", env: "TELEGRAM_CHAT_ID", label: "Telegram chat id", required: false },
  { key: "notifyWebhookUrl", env: "NOTIFY_WEBHOOK_URL", label: "Webhook notifiche", required: false },
  { key: "finnhubKey", env: "FINNHUB_API_KEY", label: "Finnhub API key", required: false },
  { key: "marketauxKey", env: "MARKETAUX_API_KEY", label: "Marketaux API key", required: false },
  { key: "fmpKey", env: "FMP_API_KEY", label: "Financial Modeling Prep API key", required: false }
];
var FIELD_KEYS = new Set(CREDENTIAL_FIELDS.map((field) => field.key));
async function aesKey(env) {
  const material = env.VAULT_KEY || env.CONTROL_TOKEN;
  if (!material) throw new Error("serve VAULT_KEY (o almeno CONTROL_TOKEN) per cifrare il vault");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`torino-vault:v1:${material}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
__name(aesKey, "aesKey");
var toBase64 = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)), "toBase64");
var fromBase64 = /* @__PURE__ */ __name((value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0)), "fromBase64");
async function seal(env, payload) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  const blob = new Uint8Array(iv.length + cipher.length);
  blob.set(iv, 0);
  blob.set(cipher, iv.length);
  return toBase64(blob);
}
__name(seal, "seal");
async function open(env, blob) {
  const key = await aesKey(env);
  const bytes = fromBase64(blob);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}
__name(open, "open");
async function readVault(db, env) {
  const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(VAULT_ROW).first();
  if (!row?.value) return {};
  try {
    return await open(env, row.value);
  } catch {
    return {};
  }
}
__name(readVault, "readVault");
async function saveCredentials(db, env, patch) {
  const current = await readVault(db, env);
  const applied = [];
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!FIELD_KEYS.has(key)) {
      rejected.push(`${key}: campo sconosciuto`);
      continue;
    }
    const text2 = String(value ?? "").trim();
    if (text2) current[key] = text2.slice(0, 4e3);
    else delete current[key];
    applied.push(key);
  }
  await db.prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(VAULT_ROW, await seal(env, current), Date.now()).run();
  return { applied, rejected };
}
__name(saveCredentials, "saveCredentials");
async function clearCredentials(db) {
  await db.prepare("DELETE FROM config WHERE key = ?").bind(VAULT_ROW).run();
}
__name(clearCredentials, "clearCredentials");
async function resolveCredentials(db, env) {
  const vault = db ? await readVault(db, env) : {};
  const values = {};
  const origin = {};
  for (const field of CREDENTIAL_FIELDS) {
    const fromVault = vault[field.key];
    const fromEnv = env[field.env];
    if (fromVault) {
      values[field.key] = fromVault;
      origin[field.key] = "vault";
    } else if (fromEnv) {
      values[field.key] = fromEnv;
      origin[field.key] = "env";
    } else {
      values[field.key] = "";
      origin[field.key] = null;
    }
  }
  return { values, origin };
}
__name(resolveCredentials, "resolveCredentials");
var mask = /* @__PURE__ */ __name((value) => value ? `\u2022\u2022\u2022\u2022${value.slice(-4)}` : "", "mask");
function describeCredentials({ values, origin }) {
  return CREDENTIAL_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    required: field.required,
    configured: Boolean(values[field.key]),
    origin: origin[field.key],
    hint: mask(values[field.key])
  }));
}
__name(describeCredentials, "describeCredentials");
function missingRequired(values) {
  return CREDENTIAL_FIELDS.filter((field) => field.required && !values[field.key]).map((field) => field.label);
}
__name(missingRequired, "missingRequired");

// worker/lib/pipeline.js
var KV_UNIVERSE = "universe:v1";
var KV_CANDLES = "candles:v1:";
function romeParts(date = /* @__PURE__ */ new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    weekday: weekdayMap[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    day: Number(parts.day),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`
  };
}
__name(romeParts, "romeParts");
function decideKind(config, parts) {
  const atRebalanceHour = parts.hour === config.rebalanceHour;
  if (atRebalanceHour) {
    if (config.cadence === "daily" && parts.weekday <= 5) return "rebalance";
    if (config.cadence === "weekly" && parts.weekday === config.rebalanceWeekday) return "rebalance";
    if (config.cadence === "monthly" && parts.day === config.rebalanceDayOfMonth) return "rebalance";
  }
  if ((config.snapshotHours ?? []).includes(parts.hour)) return "snapshot";
  return "heartbeat";
}
__name(decideKind, "decideKind");
function buildClient(credentials) {
  const missing = missingRequired(credentials).filter((label) => label.startsWith("eToro"));
  if (missing.length) throw new Error(`credenziali mancanti: ${missing.join(", ")}`);
  return new EtoroClient({
    apiKey: credentials.etoroApiKey,
    // Sull'Agent Portfolio si legge e si opera con il suo token dedicato.
    userKey: credentials.etoroAgentToken || credentials.etoroUserKey,
    agentToken: credentials.etoroAgentToken || ""
  });
}
__name(buildClient, "buildClient");
async function resolveUniverse(client, env, config) {
  let cached = null;
  if (env.STATE) {
    try {
      cached = await env.STATE.get(KV_UNIVERSE, "json");
    } catch {
      cached = null;
    }
  }
  const universe = /* @__PURE__ */ new Map();
  const resolved = { ...cached ?? {} };
  let dirty = false;
  for (const entry of config.whitelist) {
    const known = resolved[entry.symbol];
    if (known?.instrumentId) {
      universe.set(entry.symbol, { ...entry, instrumentId: known.instrumentId, name: known.name ?? entry.name });
      continue;
    }
    try {
      const found = await client.searchInstrument(entry.symbol);
      if (found?.instrumentId) {
        resolved[entry.symbol] = { instrumentId: found.instrumentId, name: found.name };
        universe.set(entry.symbol, { ...entry, instrumentId: found.instrumentId, name: found.name });
        dirty = true;
      }
    } catch {
    }
  }
  if (dirty && env.STATE) {
    try {
      await env.STATE.put(KV_UNIVERSE, JSON.stringify(resolved), { expirationTtl: 60 * 60 * 24 * 30 });
    } catch {
    }
  }
  return universe;
}
__name(resolveUniverse, "resolveUniverse");
async function loadCandles(client, env, universe) {
  const candles = /* @__PURE__ */ new Map();
  for (const [symbol, meta] of universe.entries()) {
    const key = `${KV_CANDLES}${meta.instrumentId}`;
    if (env.STATE) {
      try {
        const cached = await env.STATE.get(key, "json");
        if (cached?.rows?.length) {
          candles.set(symbol, cached.rows);
          continue;
        }
      } catch {
      }
    }
    try {
      const rows = await client.candles(meta.instrumentId, "OneDay", 260);
      if (rows.length) {
        candles.set(symbol, rows);
        if (env.STATE) {
          try {
            await env.STATE.put(key, JSON.stringify({ rows }), { expirationTtl: 60 * 60 * 12 });
          } catch {
          }
        }
      }
    } catch {
    }
  }
  return candles;
}
__name(loadCandles, "loadCandles");
async function runPipeline({ env, kind, modeOverride }) {
  const db = env.DB;
  const config = await loadConfig(db);
  const { values: credentials } = await resolveCredentials(db, env);
  const mode = modeOverride ?? config.executionMode;
  const runId = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${kind}-${crypto.randomUUID().slice(0, 8)}`;
  await startRun(db, runId, kind, mode);
  await audit(db, runId, "info", "start", `Run ${kind} avviata in modalit\xE0 ${mode}`);
  let equityUsd = null;
  try {
    const client = buildClient(credentials);
    const snapshot = await client.portfolio();
    equityUsd = snapshot.equityUsd;
    await saveSnapshot(db, runId, snapshot);
    const { hwm, drawdown } = await recordEquity(db, snapshot.equityUsd, snapshot.investedUsd, snapshot.cashUsd);
    await audit(db, runId, "info", "snapshot", `Equity ${snapshot.equityUsd} USD, cash ${snapshot.cashUsd} USD, ${snapshot.positions.length} posizioni`, { hwm, drawdown });
    if (drawdown > config.drawdownStopPct && !config.frozen) {
      const reason = `drawdown ${(drawdown * 100).toFixed(1)}% oltre la soglia ${(config.drawdownStopPct * 100).toFixed(0)}%`;
      await saveConfig(db, { frozen: true, frozenReason: reason });
      await audit(db, runId, "error", "circuit-breaker", `Agente congelato: ${reason}`);
      await notify(credentials, "critical", "Autopilot congelato", [reason, `Equity ${snapshot.equityUsd} USD \xB7 massimo storico ${hwm} USD`]);
      await finishRun(db, runId, "frozen", equityUsd, reason);
      return { runId, status: "frozen", reason };
    }
    if (kind === "heartbeat") {
      await finishRun(db, runId, "ok", equityUsd);
      return { runId, status: "ok", kind, equityUsd };
    }
    const universe = await resolveUniverse(client, env, config);
    if (!universe.size) throw new Error("nessuno strumento della whitelist risolto su eToro");
    const [candles, external] = await Promise.all([
      loadCandles(client, env, universe),
      collectExternalContext({
        finnhubKey: credentials.finnhubKey,
        marketauxKey: credentials.marketauxKey,
        fmpKey: credentials.fmpKey,
        symbols: [...universe.keys()]
      })
    ]);
    const history = await equityHistory(db, 400);
    const features = buildFeatures({ snapshot, universe, candles, external, config, equityHistory: history });
    await saveFeatures(db, runId, features);
    const failedSources = features.sourceDiagnostics.filter((item) => !item.ok);
    await audit(db, runId, "info", "features", `Feature calcolate su ${features.instruments.length} strumenti, regime ${features.regime.label}`, { failedSources: failedSources.map((item) => item.name) });
    if (kind === "snapshot") {
      await finishRun(db, runId, "ok", equityUsd);
      return { runId, status: "ok", kind, equityUsd, regime: features.regime };
    }
    if (!credentials.openrouterApiKey) throw new Error("OpenRouter API key non configurata");
    const featuresPrompt = renderFeaturesPrompt(features, config);
    const brain = await askBrain({
      apiKey: credentials.openrouterApiKey,
      models: config.models,
      featuresPrompt,
      allowedSymbols: [...universe.keys()],
      config,
      referer: env.PUBLIC_URL
    });
    await saveProposal(db, runId, brain);
    if (!brain.ok) {
      await audit(db, runId, "error", "brain", "Nessuna proposta valida dai modelli", brain.attempts);
      await finishRun(db, runId, "error", equityUsd, brain.error);
      await notify(credentials, "warn", "Autopilot: nessuna proposta", [brain.error ?? "", `Modelli provati: ${config.models.join(", ")}`]);
      return { runId, status: "error", error: brain.error, attempts: brain.attempts };
    }
    await audit(db, runId, "info", "brain", `Proposta da ${brain.model} (confidence ${brain.parsed.confidence})`, { targets: brain.parsed.targetWeights });
    const ordersToday = await countOrdersToday(db);
    const validation = validateProposal({ proposal: brain.parsed, features, config, ordersToday });
    await saveValidation(db, runId, validation);
    await audit(
      db,
      runId,
      validation.ok ? "info" : "warn",
      "validator",
      validation.ok ? `Piano valido: ${validation.plan.orders.length} ordini, turnover ${(validation.plan.turnoverPct * 100).toFixed(1)}%` : "Piano bloccato dai guardrail",
      validation.violations
    );
    if (!validation.ok) {
      await finishRun(db, runId, "blocked", equityUsd, validation.violations.filter((item) => item.severity === "blocking").map((item) => item.message).join(" \xB7 "));
      return { runId, status: "blocked", violations: validation.violations, plan: validation.plan };
    }
    if (!validation.plan.orders.length) {
      await audit(db, runId, "info", "executor", "Nessuna azione: allocazione gi\xE0 entro le bande di tolleranza");
      await finishRun(db, runId, "ok", equityUsd);
      return { runId, status: "ok", action: "none", plan: validation.plan };
    }
    const execution = await executePlan({ db, client, runId, plan: validation.plan, mode, config });
    await audit(db, runId, "info", "executor", `Esecuzione in modalit\xE0 ${mode}: ${execution.results.length} ordini`, execution.results.map((item) => ({ symbol: item.symbol, side: item.side, amount: item.amountUsd, state: item.state })));
    let reconciliation = null;
    if (mode === "live" && execution.executed) {
      reconciliation = await reconcile({ client, plan: validation.plan, config });
      await audit(db, runId, reconciliation.ok ? "info" : "error", "reconcile", `Divergenza massima ${(reconciliation.worstDivergence * 100).toFixed(2)}%`, reconciliation.rows);
      if (!reconciliation.ok) {
        await saveConfig(db, { frozen: true, frozenReason: `riconciliazione fuori tolleranza (${(reconciliation.worstDivergence * 100).toFixed(2)}%)` });
        await notify(credentials, "critical", "Autopilot congelato dopo riconciliazione", [`Divergenza ${(reconciliation.worstDivergence * 100).toFixed(2)}%`, "Verifica manualmente le posizioni su eToro."]);
      }
    }
    const summary = execution.results.map((item) => `${item.side === "buy" ? "+" : "\u2212"}${item.amountUsd} USD ${item.symbol} [${item.state}]`);
    await notify(credentials, mode === "live" ? "info" : "info", `Autopilot ${mode} \xB7 ${validation.plan.orders.length} ordini`, [
      brain.parsed.rationale.slice(0, 400),
      ...summary
    ]);
    await finishRun(db, runId, "ok", equityUsd);
    return { runId, status: "ok", mode, plan: validation.plan, execution, reconciliation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(db, runId, "error", "pipeline", message);
    await finishRun(db, runId, "error", equityUsd, message);
    await notify(credentials, "warn", "Autopilot: run fallita", [message]);
    return { runId, status: "error", error: message };
  }
}
__name(runPipeline, "runPipeline");

// worker/lib/api.js
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
function json2(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
  });
}
__name(json2, "json");
function isAuthorized(request, env) {
  const token = env.CONTROL_TOKEN;
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match) && safeEqual(match[1].trim(), token);
}
__name(isAuthorized, "isAuthorized");
var NUMERIC_BOUNDS = {
  budgetEur: [10, 1e5],
  maxOrdersPerRun: [1, 20],
  maxOrdersPerDay: [1, 40],
  minOrderUsd: [1, 1e4],
  maxOrderUsd: [5, 1e5],
  maxTurnoverPct: [0.01, 1],
  minRebalanceBandAbs: [1e-3, 0.5],
  minRebalanceBandRel: [0.01, 2],
  minCashPct: [0, 0.9],
  maxCashPct: [0.05, 1],
  drawdownStopPct: [0.02, 0.6],
  reconcileTolerancePct: [5e-3, 0.3],
  minConfidence: [0, 1],
  rebalanceWeekday: [1, 7],
  rebalanceDayOfMonth: [1, 28],
  rebalanceHour: [0, 23],
  rebalanceMinute: [0, 59],
  llmTemperature: [0, 1.5],
  llmMaxTokens: [256, 8e3],
  fallbackEurUsd: [0.5, 2]
};
function sanitizeConfigPatch(patch) {
  const out = {};
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_CONFIG)) {
      rejected.push(`${key}: chiave sconosciuta`);
      continue;
    }
    if (key === "executionMode") {
      rejected.push("executionMode: usa POST /agent/mode");
      continue;
    }
    if (key === "frozen" || key === "frozenReason") {
      rejected.push(`${key}: usa /agent/freeze o /agent/unfreeze`);
      continue;
    }
    if (key in NUMERIC_BOUNDS) {
      const numeric = Number(value);
      const [min, max] = NUMERIC_BOUNDS[key];
      if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
        rejected.push(`${key}: fuori intervallo [${min}, ${max}]`);
        continue;
      }
      out[key] = numeric;
      continue;
    }
    if (key === "cadence") {
      if (!["daily", "weekly", "monthly"].includes(value)) {
        rejected.push("cadence: valore non ammesso");
        continue;
      }
      out[key] = value;
      continue;
    }
    if (key === "whitelist") {
      if (!Array.isArray(value) || !value.length) {
        rejected.push("whitelist: deve essere un array non vuoto");
        continue;
      }
      const cleaned = value.filter((item) => item && typeof item.symbol === "string").map((item) => ({
        symbol: String(item.symbol).trim().toUpperCase().slice(0, 16),
        name: String(item.name ?? item.symbol).slice(0, 80),
        class: ["etf", "stock", "bond", "commodity", "crypto"].includes(item.class) ? item.class : "etf",
        maxWeight: Math.max(0.01, Math.min(1, Number(item.maxWeight) || 0.2))
      }));
      if (!cleaned.length) {
        rejected.push("whitelist: nessuna voce valida");
        continue;
      }
      out[key] = cleaned;
      continue;
    }
    if (key === "models") {
      if (!Array.isArray(value) || !value.length) {
        rejected.push("models: array non vuoto richiesto");
        continue;
      }
      out[key] = value.map(String).slice(0, 8);
      continue;
    }
    if (key === "snapshotHours") {
      if (!Array.isArray(value)) {
        rejected.push("snapshotHours: array richiesto");
        continue;
      }
      out[key] = [...new Set(value.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))];
      continue;
    }
    if (key === "maxWeightPerClass") {
      if (!value || typeof value !== "object") {
        rejected.push("maxWeightPerClass: oggetto richiesto");
        continue;
      }
      out[key] = Object.fromEntries(Object.entries(value).map(([klass, weight]) => [klass, Math.max(0, Math.min(1, Number(weight) || 0))]));
      continue;
    }
    if (key === "riskProfile") {
      out[key] = String(value).slice(0, 800);
      continue;
    }
    rejected.push(`${key}: tipo non gestito`);
  }
  return { patch: out, rejected };
}
__name(sanitizeConfigPatch, "sanitizeConfigPatch");
async function handleAgentApi(request, env, ctx, pathname) {
  if (!env.DB) return json2({ error: 'binding D1 "DB" non configurato' }, 500);
  if (!isAuthorized(request, env)) return json2({ error: "non autorizzato" }, 401);
  const db = env.DB;
  const route = pathname.replace(/^\/agent\/?/, "").replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await request.json().catch(() => ({})) : {};
  if (route === "state" && method === "GET") {
    const [config, runs, curve, resolved] = await Promise.all([loadConfig(db), listRuns(db, 12), equityHistory(db, 200), resolveCredentials(db, env)]);
    const last = runs[0] ?? null;
    const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : 0;
    const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : 0;
    return json2({
      config,
      lastRun: last,
      recentRuns: runs,
      equityCurve: curve,
      equityUsd: equity,
      highWaterMarkUsd: hwm,
      drawdownPct: hwm > 0 ? (hwm - equity) / hwm : 0,
      credentials: describeCredentials(resolved),
      notificationsActive: Boolean(resolved.values.telegramBotToken && resolved.values.telegramChatId || resolved.values.notifyWebhookUrl)
    });
  }
  if (route === "runs" && method === "GET") {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 30);
    return json2({ runs: await listRuns(db, Math.min(Math.max(limit, 1), 200)) });
  }
  if (route.startsWith("runs/") && method === "GET") {
    const bundle = await getRunBundle(db, route.slice("runs/".length));
    if (!bundle.run) return json2({ error: "run non trovata" }, 404);
    return json2(bundle);
  }
  if (route === "config") {
    if (method === "GET") return json2({ config: await loadConfig(db), defaults: DEFAULT_CONFIG });
    if (method === "PUT") {
      const { patch, rejected } = sanitizeConfigPatch(body);
      if (!Object.keys(patch).length) return json2({ error: "nessuna modifica valida", rejected }, 400);
      const config = await saveConfig(db, patch);
      await audit(db, null, "info", "config", "Configurazione aggiornata", { patch, rejected });
      return json2({ config, applied: Object.keys(patch), rejected });
    }
  }
  if (route === "mode" && method === "POST") {
    const mode = String(body.mode ?? "");
    if (!["shadow", "dry-run", "live"].includes(mode)) return json2({ error: "modalit\xE0 non ammessa" }, 400);
    if (mode === "live" && body.confirm !== "ATTIVA ORDINI REALI") {
      return json2({ error: 'per la modalit\xE0 live serve confirm = "ATTIVA ORDINI REALI"' }, 400);
    }
    const { values: credentials } = await resolveCredentials(db, env);
    if (mode === "live" && !credentials.etoroAgentToken) {
      return json2({ error: "token Agent Portfolio non configurato: impossibile operare in live" }, 400);
    }
    const config = await saveConfig(db, { executionMode: mode });
    await audit(db, null, "warn", "config", `Modalit\xE0 di esecuzione impostata su ${mode}`);
    await notify(credentials, mode === "live" ? "critical" : "info", `Autopilot: modalit\xE0 ${mode}`, [
      mode === "live" ? "Da ora gli ordini vengono inviati davvero su eToro." : "Nessun ordine reale verr\xE0 inviato."
    ]);
    return json2({ config });
  }
  if (route === "freeze" && method === "POST") {
    const reason = String(body.reason ?? "freeze manuale").slice(0, 300);
    const config = await saveConfig(db, { frozen: true, frozenReason: reason });
    await audit(db, null, "warn", "config", `Agente congelato: ${reason}`);
    return json2({ config });
  }
  if (route === "unfreeze" && method === "POST") {
    const config = await saveConfig(db, { frozen: false, frozenReason: "" });
    await audit(db, null, "warn", "config", "Agente riattivato");
    return json2({ config });
  }
  if (route === "trigger" && method === "POST") {
    const kind = ["snapshot", "rebalance", "heartbeat"].includes(body.kind) ? body.kind : "rebalance";
    const modeOverride = ["shadow", "dry-run", "live"].includes(body.mode) ? body.mode : void 0;
    if (modeOverride === "live" && body.confirm !== "ATTIVA ORDINI REALI") {
      return json2({ error: 'override live richiede confirm = "ATTIVA ORDINI REALI"' }, 400);
    }
    const result = await runPipeline({ env, kind, modeOverride });
    return json2(result);
  }
  if (route === "credentials") {
    if (method === "GET") {
      return json2({ credentials: describeCredentials(await resolveCredentials(db, env)) });
    }
    if (method === "PUT") {
      const { applied, rejected } = await saveCredentials(db, env, body);
      await audit(db, null, "warn", "credentials", `Credenziali aggiornate: ${applied.join(", ") || "nessuna"}`, { rejected });
      return json2({ credentials: describeCredentials(await resolveCredentials(db, env)), applied, rejected });
    }
    if (method === "DELETE") {
      await clearCredentials(db);
      await audit(db, null, "warn", "credentials", "Vault credenziali svuotato");
      return json2({ credentials: describeCredentials(await resolveCredentials(db, env)) });
    }
  }
  if (route === "notify-test" && method === "POST") {
    const { values: credentials } = await resolveCredentials(db, env);
    try {
      return json2(await notifyTest(credentials));
    } catch (error) {
      return json2({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
  if (route === "models" && method === "GET") {
    try {
      const { values: credentials } = await resolveCredentials(db, env);
      return json2({ models: await listFreeModels(credentials.openrouterApiKey) });
    } catch (error) {
      return json2({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }
  if (route === "health" && method === "GET") {
    return json2({ ok: true, at: Date.now() });
  }
  return json2({ error: "rotta non trovata" }, 404);
}
__name(handleAgentApi, "handleAgentApi");

// worker/lib/mcp.js
var PROTOCOL_VERSION = "2024-11-05";
var DISCOVERY_TOOLS = [
  {
    name: "search",
    description: "Cerca fra run, configurazione e stato dell'Autopilot eToro. Restituisce documenti con un id da passare a fetch.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Termini di ricerca, oppure un id di run" } }, required: ["query"], additionalProperties: false }
  },
  {
    name: "fetch",
    description: "Recupera il contenuto completo di un documento dell'Autopilot a partire dall'id restituito da search.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  }
];
var TOOLS = [
  {
    name: "autopilot_get_state",
    description: "Stato corrente dell'agente: configurazione, modalit\xE0 di esecuzione, equity, drawdown e ultime run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "autopilot_list_runs",
    description: "Elenca le run recenti con esito, modalit\xE0 ed equity.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Numero massimo di run (default 20)" } }, additionalProperties: false }
  },
  {
    name: "autopilot_get_run",
    description: "Dettaglio completo di una run: snapshot, feature, proposta del modello, violazioni dei guardrail, ordini e log.",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false }
  },
  {
    name: "autopilot_get_config",
    description: "Configurazione completa: whitelist, guardrail, cadenza, modelli.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "autopilot_update_config",
    description: "Aggiorna parametri di configurazione. Non pu\xF2 cambiare la modalit\xE0 di esecuzione n\xE9 lo stato di freeze.",
    inputSchema: { type: "object", properties: { patch: { type: "object", description: "Oggetto parziale di configurazione" } }, required: ["patch"], additionalProperties: false }
  },
  {
    name: "autopilot_trigger_run",
    description: "Lancia una run immediata in modalit\xE0 shadow o dry-run. Non invia mai ordini reali.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["snapshot", "rebalance"], description: "Tipo di run" },
        mode: { type: "string", enum: ["shadow", "dry-run"], description: "Modalit\xE0 forzata" }
      },
      additionalProperties: false
    }
  },
  {
    name: "autopilot_freeze",
    description: "Congela immediatamente l'agente: nessuna run potr\xE0 eseguire ordini finch\xE9 non viene riattivato.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "autopilot_unfreeze",
    description: "Rimuove il freeze. Da usare solo dopo aver verificato le posizioni su eToro.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];
var rpcResult = /* @__PURE__ */ __name((id, result) => ({ jsonrpc: "2.0", id, result }), "rpcResult");
var rpcError = /* @__PURE__ */ __name((id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } }), "rpcError");
var toolText = /* @__PURE__ */ __name((payload) => ({ content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] }), "toolText");
function publicUrl(env, path) {
  const base = String(env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}
__name(publicUrl, "publicUrl");
async function searchDocuments(env, query) {
  const db = env.DB;
  const term = String(query ?? "").trim().toLowerCase();
  const results = [
    { id: "state", title: "Stato corrente dell'Autopilot", url: publicUrl(env, "/agent/state") },
    { id: "config", title: "Configurazione e guardrail", url: publicUrl(env, "/agent/config") }
  ];
  const runs = await listRuns(db, 60);
  const matched = runs.filter((run) => {
    if (!term) return true;
    const when = new Date(run.started_at).toLocaleString("it-IT");
    return `${run.id} ${run.kind} ${run.status} ${run.execution_mode} ${when} ${run.error ?? ""}`.toLowerCase().includes(term);
  });
  for (const run of (matched.length ? matched : runs).slice(0, 30)) {
    results.push({
      id: `run:${run.id}`,
      title: `Run ${run.kind} del ${new Date(run.started_at).toLocaleString("it-IT")} \u2014 ${run.status} (${run.execution_mode})`,
      url: publicUrl(env, `/agent/runs/${run.id}`)
    });
  }
  return { results };
}
__name(searchDocuments, "searchDocuments");
async function fetchDocument(env, id) {
  const db = env.DB;
  const key = String(id ?? "");
  if (key === "state") {
    const [config, runs, curve] = await Promise.all([loadConfig(db), listRuns(db, 10), equityHistory(db, 60)]);
    const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : null;
    const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : null;
    return {
      id: key,
      title: "Stato corrente dell'Autopilot",
      url: publicUrl(env, "/agent/state"),
      text: [
        `Modalit\xE0 di esecuzione: ${config.executionMode}`,
        `Congelato: ${config.frozen ? `s\xEC \u2014 ${config.frozenReason}` : "no"}`,
        `Cadenza: ${config.cadence}, budget ${config.budgetEur} EUR`,
        `Equity: ${equity ?? "n/d"} USD \xB7 massimo storico ${hwm ?? "n/d"} USD`,
        `Drawdown: ${hwm && equity ? `${((hwm - equity) / hwm * 100).toFixed(2)}%` : "n/d"}`,
        `Universo: ${config.whitelist.map((item) => item.symbol).join(", ")}`,
        "",
        "Run recenti:",
        ...runs.map((run) => `- ${new Date(run.started_at).toLocaleString("it-IT")} ${run.kind} ${run.status} (${run.execution_mode}) equity=${run.equity_usd ?? "n/d"}${run.error ? ` errore: ${run.error}` : ""}`)
      ].join("\n"),
      metadata: { type: "state" }
    };
  }
  if (key === "config") {
    const config = await loadConfig(db);
    return { id: key, title: "Configurazione e guardrail", url: publicUrl(env, "/agent/config"), text: JSON.stringify(config, null, 2), metadata: { type: "config" } };
  }
  if (key.startsWith("run:")) {
    const bundle = await getRunBundle(db, key.slice(4));
    if (!bundle.run) throw new Error("run non trovata");
    const proposal = bundle.proposal?.parsed;
    const lines = [
      `Run ${bundle.run.id} \u2014 ${bundle.run.kind}, esito ${bundle.run.status}, modalit\xE0 ${bundle.run.execution_mode}`,
      `Avvio: ${new Date(bundle.run.started_at).toLocaleString("it-IT")}`,
      bundle.run.error ? `Errore: ${bundle.run.error}` : "",
      "",
      bundle.snapshot ? `PORTAFOGLIO equity=${bundle.snapshot.equity_usd} USD cash=${bundle.snapshot.cash_usd} USD investito=${bundle.snapshot.invested_usd} USD` : "",
      bundle.features ? `REGIME ${bundle.features.regime.label} (score ${bundle.features.regime.score}) VIX=${bundle.features.regime.vix} curva=${bundle.features.regime.yieldCurveBp}bp news=${bundle.features.regime.newsNet}` : "",
      bundle.features ? `ALLOCAZIONE ${Object.entries(bundle.features.allocationByClass).map(([klass, weight]) => `${klass}=${(weight * 100).toFixed(1)}%`).join(" ")}` : "",
      "",
      proposal ? `PROPOSTA (modello ${bundle.proposal.model}, confidence ${proposal.confidence})` : `PROPOSTA assente: ${bundle.proposal?.error ?? "non generata"}`,
      proposal ? `Target: ${Object.entries(proposal.targetWeights).map(([symbol, weight]) => `${symbol} ${(weight * 100).toFixed(1)}%`).join(", ")}` : "",
      proposal ? `Motivazione: ${proposal.rationale}` : "",
      proposal?.risks?.length ? `Rischi: ${proposal.risks.join(" \xB7 ")}` : "",
      "",
      bundle.validation ? `GUARDRAIL: ${bundle.validation.ok ? "piano ammesso" : "piano bloccato"}` : "GUARDRAIL non valutati",
      ...(bundle.validation?.violations ?? []).map((item) => `- [${item.severity}] ${item.message}`),
      "",
      "ORDINI:",
      ...bundle.orders.length ? bundle.orders.map((order) => `- ${order.side} ${order.amount_usd} USD ${order.symbol} \u2192 ${order.state}${order.message ? ` (${order.message})` : ""}`) : ["- nessuno"],
      "",
      "LOG:",
      ...bundle.logs.map((log) => `${new Date(log.at).toLocaleTimeString("it-IT")} [${log.level}/${log.stage}] ${log.message}`)
    ];
    return {
      id: key,
      title: `Run ${bundle.run.kind} \u2014 ${bundle.run.status}`,
      url: publicUrl(env, `/agent/runs/${bundle.run.id}`),
      text: lines.filter(Boolean).join("\n"),
      metadata: { type: "run", status: bundle.run.status }
    };
  }
  throw new Error(`id non riconosciuto: ${key}`);
}
__name(fetchDocument, "fetchDocument");
async function callTool(env, name, args) {
  const db = env.DB;
  switch (name) {
    // I connector ChatGPT si aspettano il risultato sia come JSON strutturato
    // sia come testo: vengono restituiti entrambi.
    case "search": {
      const payload = await searchDocuments(env, args?.query);
      return { ...toolText(payload), structuredContent: payload };
    }
    case "fetch": {
      const payload = await fetchDocument(env, args?.id);
      return { ...toolText(payload), structuredContent: payload };
    }
    case "autopilot_get_state": {
      const [config, runs, curve] = await Promise.all([loadConfig(db), listRuns(db, 8), equityHistory(db, 60)]);
      const equity = curve.length ? Number(curve[curve.length - 1].equity_usd) : null;
      const hwm = curve.length ? Math.max(...curve.map((row) => Number(row.hwm_usd) || 0)) : null;
      return toolText({
        executionMode: config.executionMode,
        frozen: config.frozen,
        frozenReason: config.frozenReason,
        cadence: config.cadence,
        budgetEur: config.budgetEur,
        equityUsd: equity,
        highWaterMarkUsd: hwm,
        drawdownPct: hwm ? Number(((hwm - equity) / hwm).toFixed(4)) : null,
        whitelist: config.whitelist.map((item) => item.symbol),
        recentRuns: runs.map((run) => ({ id: run.id, kind: run.kind, status: run.status, mode: run.execution_mode, at: run.started_at, equityUsd: run.equity_usd, error: run.error }))
      });
    }
    case "autopilot_list_runs":
      return toolText(await listRuns(db, Math.min(Math.max(Number(args?.limit ?? 20), 1), 100)));
    case "autopilot_get_run": {
      const bundle = await getRunBundle(db, String(args?.runId ?? ""));
      if (!bundle.run) throw new Error("run non trovata");
      return toolText({
        run: bundle.run,
        equityUsd: bundle.snapshot?.equity_usd ?? null,
        regime: bundle.features?.regime ?? null,
        allocation: bundle.features?.allocationByClass ?? null,
        proposal: bundle.proposal?.parsed ?? null,
        modelUsed: bundle.proposal?.model ?? null,
        validation: bundle.validation ? { ok: bundle.validation.ok, violations: bundle.validation.violations, orders: bundle.validation.plan?.orders ?? [] } : null,
        orders: bundle.orders.map((order) => ({ symbol: order.symbol, side: order.side, amountUsd: order.amount_usd, state: order.state, message: order.message })),
        logs: bundle.logs.map((log) => ({ at: log.at, level: log.level, stage: log.stage, message: log.message }))
      });
    }
    case "autopilot_get_config":
      return toolText(await loadConfig(db));
    case "autopilot_update_config": {
      const { patch, rejected } = sanitizeConfigPatch(args?.patch);
      if (!Object.keys(patch).length) throw new Error(`nessuna modifica valida. Scartate: ${rejected.join("; ")}`);
      const config = await saveConfig(db, patch);
      await audit(db, null, "info", "mcp", "Configurazione aggiornata via MCP", { patch, rejected });
      return toolText({ applied: Object.keys(patch), rejected, config });
    }
    case "autopilot_trigger_run": {
      const kind = ["snapshot", "rebalance"].includes(args?.kind) ? args.kind : "rebalance";
      const mode = args?.mode === "dry-run" ? "dry-run" : "shadow";
      return toolText(await runPipeline({ env, kind, modeOverride: mode }));
    }
    case "autopilot_freeze": {
      const reason = String(args?.reason ?? "freeze richiesto via MCP").slice(0, 300);
      await audit(db, null, "warn", "mcp", `Freeze via MCP: ${reason}`);
      return toolText(await saveConfig(db, { frozen: true, frozenReason: reason }));
    }
    case "autopilot_unfreeze": {
      await audit(db, null, "warn", "mcp", "Unfreeze via MCP");
      return toolText(await saveConfig(db, { frozen: false, frozenReason: "" }));
    }
    default:
      throw new Error(`tool sconosciuto: ${name}`);
  }
}
__name(callTool, "callTool");
async function handleMcp(request, env) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "usare POST con payload JSON-RPC 2.0" }), { status: 405, headers: { "content-type": "application/json" } });
  }
  const message = await request.json().catch(() => null);
  if (!message || typeof message !== "object") {
    return new Response(JSON.stringify(rpcError(null, -32700, "JSON non valido")), { status: 400, headers: { "content-type": "application/json" } });
  }
  const { id = null, method, params } = message;
  const respond = /* @__PURE__ */ __name((payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }), "respond");
  try {
    switch (method) {
      case "initialize":
        return respond(rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "torino-autopilot", version: "1.0.0" }
        }));
      case "notifications/initialized":
        return new Response(null, { status: 204 });
      case "ping":
        return respond(rpcResult(id, {}));
      case "tools/list":
        return respond(rpcResult(id, { tools: [...DISCOVERY_TOOLS, ...TOOLS] }));
      case "tools/call": {
        const name = params?.name;
        try {
          return respond(rpcResult(id, await callTool(env, name, params?.arguments ?? {})));
        } catch (error) {
          return respond(rpcResult(id, { ...toolText(`Errore: ${error instanceof Error ? error.message : String(error)}`), isError: true }));
        }
      }
      default:
        return respond(rpcError(id, -32601, `metodo non supportato: ${method}`));
    }
  } catch (error) {
    return respond(rpcError(id, -32603, error instanceof Error ? error.message : String(error)), 500);
  }
}
__name(handleMcp, "handleMcp");

// worker/index.js
var ETORO_BASES = {
  v1: "https://public-api.etoro.com/api/v1",
  v2: "https://public-api.etoro.com/api/v2"
};
var PASS_HEADERS = ["x-api-key", "x-user-key", "x-request-id", "content-type"];
var migrated = false;
async function ensureSchema(env) {
  if (migrated || !env.DB) return;
  await migrate(env.DB);
  migrated = true;
}
__name(ensureSchema, "ensureSchema");
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
__name(allowedOrigins, "allowedOrigins");
function corsHeaders(request, env, extraAllowedHeaders = []) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowList = allowedOrigins(env);
  const selfOrigin = new URL(request.url).origin;
  if (origin !== selfOrigin && !allowList.includes(origin) && !allowList.includes("*")) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": [...PASS_HEADERS, "authorization", ...extraAllowedHeaders].join(", "),
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set("X-Content-Type-Options", "nosniff");
  merged.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}
__name(withHeaders, "withHeaders");
var forbidden = /* @__PURE__ */ __name(() => new Response(JSON.stringify({ error: "origine non consentita" }), {
  status: 403,
  headers: { "content-type": "application/json" }
}), "forbidden");
async function proxyEtoro(request, env, url) {
  const cors = corsHeaders(request, env);
  if (cors === null) return forbidden();
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const version = url.pathname.startsWith("/api/v2/") ? "v2" : "v1";
  const path = url.pathname.replace(/^\/api\/v[12]\//, "");
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("x-api-key") || !headers.has("x-user-key")) {
    return withHeaders(new Response(JSON.stringify({ error: "credenziali eToro assenti" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    }), cors);
  }
  try {
    const upstream = await fetch(`${ETORO_BASES[version]}/${path}${url.search}`, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? void 0 : request.body
    });
    return withHeaders(upstream, cors);
  } catch (error) {
    return withHeaders(new Response(JSON.stringify({
      error: "eToro upstream request failed",
      message: error instanceof Error ? error.message : String(error)
    }), { status: 502, headers: { "content-type": "application/json" } }), cors);
  }
}
__name(proxyEtoro, "proxyEtoro");
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1/") || url.pathname.startsWith("/api/v2/")) {
      return proxyEtoro(request, env, url);
    }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const cors = corsHeaders(request, env, ["mcp-session-id", "mcp-protocol-version"]);
      if (cors === null) return forbidden();
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const pathToken = url.pathname.slice("/mcp/".length);
      const authorized = isAuthorized(request, env) || pathToken && env.CONTROL_TOKEN && safeEqual(pathToken, env.CONTROL_TOKEN);
      if (!authorized) {
        return withHeaders(new Response(JSON.stringify({ error: "non autorizzato" }), {
          status: 401,
          headers: { "content-type": "application/json", "WWW-Authenticate": "Bearer" }
        }), cors);
      }
      await ensureSchema(env);
      return withHeaders(await handleMcp(request, env), cors);
    }
    if (url.pathname.startsWith("/agent")) {
      const cors = corsHeaders(request, env);
      if (cors === null) return forbidden();
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      await ensureSchema(env);
      return withHeaders(await handleAgentApi(request, env, ctx, url.pathname), cors);
    }
    return env.ASSETS.fetch(request);
  },
  /**
   * Cron orario. Il tipo di run è deciso sull'ora locale Europe/Rome, così il
   * passaggio ora legale/solare non sposta il ribilanciamento.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.DB) return;
      await ensureSchema(env);
      const config = await loadConfig(env.DB);
      const parts = romeParts(new Date(event.scheduledTime));
      const kind = decideKind(config, parts);
      if (kind === "heartbeat" && config.frozen) return;
      await runPipeline({ env, kind });
    })());
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
