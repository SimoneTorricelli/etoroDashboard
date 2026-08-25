/**
 * Client eToro Public API lato server (Cloudflare Worker).
 * Le credenziali arrivano esclusivamente dai Worker Secrets: non transitano
 * mai dal browser.
 */

const BASE = {
  v1: 'https://public-api.etoro.com/api/v1',
  v2: 'https://public-api.etoro.com/api/v2',
};

export class EtoroError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'EtoroError';
    this.status = status;
    this.body = body;
  }
}

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pick = (record, ...keys) => {
  for (const key of keys) {
    if (record && record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
};

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const recordList = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);

function normalizePositions(rawPositions) {
  return recordList(rawPositions).map((raw) => {
    const invested = num(pick(raw, 'Amount', 'amount'));
    const units = num(pick(raw, 'Units', 'units'));
    const openRate = num(pick(raw, 'OpenRate', 'openRate'));
    const leverage = num(pick(raw, 'Leverage', 'leverage'), 1) || 1;
    const currentRate = num(pick(raw, 'CurrentRate', 'currentRate', 'Rate', 'rate'), openRate);
    const isBuy = pick(raw, 'IsBuy', 'isBuy') !== false;
    const grossValue = units > 0 && currentRate > 0 ? units * currentRate : invested;
    const unrealized = asRecord(pick(raw, 'UnrealizedPnL', 'unrealizedPnL', 'unrealizedPnl'));
    const reportedPnl = pick(unrealized, 'PnL', 'pnl', 'Profit', 'profit');
    const pnl = reportedPnl !== undefined
      ? num(reportedPnl)
      : openRate > 0 && units > 0
        ? (isBuy ? (currentRate - openRate) : (openRate - currentRate)) * units
        : num(pick(raw, 'NetProfit', 'netProfit', 'Profit', 'profit', 'PnL', 'pnl'));
    return {
      positionId: num(pick(raw, 'PositionID', 'positionId', 'PositionId')),
      instrumentId: num(pick(raw, 'InstrumentID', 'instrumentId', 'InstrumentId')),
      invested,
      units,
      openRate,
      currentRate,
      leverage,
      isBuy,
      valueUsd: Math.round((invested + pnl) * 100) / 100,
      grossValueUsd: Math.round(grossValue * 100) / 100,
      pnlUsd: Math.round(pnl * 100) / 100,
      openedAt: String(pick(raw, 'OpenDateTime', 'openDateTime', 'OpenTime') ?? ''),
    };
  });
}

function snapshotFromRoot(root, {
  cashKeys = ['Credit', 'credit'],
  source = 'account',
  mirrorId = null,
} = {}) {
  const positions = normalizePositions(pick(root, 'Positions', 'positions'));
  const cashUsd = num(pick(root, ...cashKeys));
  const investedUsd = positions.reduce((sum, item) => sum + item.invested, 0);
  const positionsValue = positions.reduce((sum, item) => sum + item.valueUsd, 0);
  const reportedEquity = num(pick(root, 'Equity', 'equity'), 0);
  const equityUsd = reportedEquity > 0 ? reportedEquity : cashUsd + positionsValue;
  return {
    takenAt: Date.now(),
    cashUsd: Math.round(cashUsd * 100) / 100,
    investedUsd: Math.round(investedUsd * 100) / 100,
    positionsValueUsd: Math.round(positionsValue * 100) / 100,
    equityUsd: Math.round(equityUsd * 100) / 100,
    positions,
    source,
    mirrorId: mirrorId == null ? null : String(mirrorId),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TOKEN_SECRET_KEYS = ['userToken', 'UserToken', 'userTokenValue', 'UserTokenValue'];

/** Riconosce gli identificativi UUID che eToro usa per portfolio, token e client. */
export function isUuidIdentifier(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/**
 * Estrae esclusivamente il segreto esplicito restituito dalla POST eToro.
 *
 * La risposta ufficiale mette `userTokenId` prima di `userToken`: un parser
 * euristico basato sulla parola "token" finirebbe quindi per salvare l'UUID e
 * causare un 401. I campi metadata (`*Id`, `*Name`, `clientId`) e i generici
 * `token`/`value` non sono mai accettati. Un UUID non è considerato un segreto
 * neppure se arriva per errore sotto una chiave esplicita.
 */
export function extractAgentTokenSecret(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractAgentTokenSecret(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  for (const key of TOKEN_SECRET_KEYS) {
    const candidate = value[key];
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (text.length >= 20 && !isUuidIdentifier(text) && !/^https?:/i.test(text)) return text;
  }

  // Sono ammessi wrapper/array arbitrari, ma solo una chiave esplicita può
  // produrre il risultato: attraversare i metadata non li rende candidati.
  for (const item of Object.values(value)) {
    const found = extractAgentTokenSecret(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Struttura della risposta senza i valori: utile a diagnosticare, sicura da loggare. */
function describeShape(value, depth = 0) {
  if (depth > 3 || value == null) return typeof value;
  if (Array.isArray(value)) return `[${value.length ? describeShape(value[0], depth + 1) : ''}]`;
  if (typeof value !== 'object') return typeof value;
  return `{${Object.entries(value).map(([key, item]) => `${key}:${describeShape(item, depth + 1)}`).join(',')}}`;
}

export class EtoroClient {
  /**
   * @param {{apiKey: string, userKey: string, agentToken?: string}} credentials
   */
  constructor(credentials, { timeoutMs = 15_000 } = {}) {
    this.apiKey = credentials.apiKey;
    this.userKey = credentials.userKey;
    this.agentToken = credentials.agentToken || '';
    this.timeoutMs = timeoutMs;
    this.calls = 0;
    this.readCalls = 0;
    this.writeCalls = 0;
  }

  headers(userKey = this.userKey, requestId = crypto.randomUUID()) {
    return {
      'x-api-key': this.apiKey,
      'x-user-key': userKey,
      'x-request-id': requestId,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  async request(version, path, { method = 'GET', body, userKey, requestId } = {}) {
    const url = `${BASE[version]}/${path.replace(/^\/+/, '')}`;
    const normalizedMethod = String(method).toUpperCase();
    const isRead = normalizedMethod === 'GET';
    const requestKey = requestId ?? crypto.randomUUID();
    const attempts = isRead ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (isRead && this.readCalls >= 45) throw new EtoroError('Limite interno di sicurezza: troppe letture eToro nella stessa esecuzione', 429, {});
      if (!isRead && this.writeCalls >= 16) throw new EtoroError('Limite interno di sicurezza: troppe operazioni eToro nella stessa esecuzione', 429, {});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      this.calls += 1;
      if (isRead) this.readCalls += 1;
      else this.writeCalls += 1;
      try {
        const response = await fetch(url, {
          method: normalizedMethod,
          headers: this.headers(userKey, requestKey),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
        if (response.status === 429 && isRead && attempt + 1 < attempts) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(5_000, retryAfter * 1000)
            : 350 * (2 ** attempt) + Math.floor(Math.random() * 150);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        if (!response.ok) {
          const record = asRecord(parsed);
          const nested = asRecord(pick(record, 'error', 'Error', 'data', 'Data'));
          const message = pick(record, 'errorMessage', 'ErrorMessage', 'message', 'Message', 'detail', 'Detail', 'title', 'Title')
            ?? pick(nested, 'errorMessage', 'ErrorMessage', 'message', 'Message', 'detail', 'Detail')
            ?? pick(record, 'error', 'Error');
          const code = pick(record, 'errorCode', 'ErrorCode', 'code', 'Code')
            ?? pick(nested, 'errorCode', 'ErrorCode', 'code', 'Code');
          const details = pick(record, 'errors', 'Errors', 'validationErrors', 'ValidationErrors');
          const messageText = typeof message === 'string' ? message.trim() : '';
          const codeText = typeof code === 'string' || typeof code === 'number' ? String(code).trim() : '';
          const label = codeText && messageText && codeText.toLowerCase() !== messageText.toLowerCase()
            ? `${codeText}: ${messageText}`
            : messageText || codeText || `HTTP ${response.status}`;
          const extra = details ? ` — ${JSON.stringify(details).slice(0, 300)}` : (typeof message === 'object' ? ` — ${JSON.stringify(message).slice(0, 300)}` : '');
          throw new EtoroError(`${label}${extra}`, response.status, parsed);
        }
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new EtoroError('Richiesta eToro non completata', 429, {});
  }

  /** Portafoglio + posizioni aperte dell'account indicato dallo user key attivo. */
  async portfolio(userKey = this.userKey) {
    const data = await this.request('v1', 'trading/info/real/pnl', { userKey });
    const account = asRecord(pick(data, 'clientPortfolio', 'ClientPortfolio', 'portfolio', 'Portfolio')) ;
    const root = Object.keys(account).length ? account : asRecord(data);
    return snapshotFromRoot(root);
  }

  /**
   * Capitale reale allocato dal proprietario a uno specifico copy/mirror.
   * L'Agent Portfolio opera su 10.000 USD virtuali, ma il P&L della owner key
   * contiene il mirror reale che li replica proporzionalmente.
   */
  async mirrorPortfolio(mirrorId) {
    const data = await this.request('v1', 'trading/info/real/pnl', { userKey: this.userKey });
    const account = asRecord(pick(data, 'clientPortfolio', 'ClientPortfolio', 'portfolio', 'Portfolio'));
    const root = Object.keys(account).length ? account : asRecord(data);
    const mirrors = recordList(pick(root, 'Mirrors', 'mirrors', 'CopyPortfolios', 'copyPortfolios'));
    const wanted = String(mirrorId ?? '').trim();
    const mirror = mirrors.find((item) => String(pick(item, 'MirrorID', 'mirrorID', 'mirrorId', 'MirrorId', 'CopyID', 'copyId') ?? '') === wanted);
    if (!mirror) {
      throw new EtoroError(`Mirror reale ${wanted || 'non disponibile'} non trovato nel portafoglio eToro`, 404, {
        availableMirrorIds: mirrors.map((item) => pick(item, 'MirrorID', 'mirrorID', 'mirrorId', 'MirrorId', 'CopyID', 'copyId')).filter(Boolean),
      });
    }
    return snapshotFromRoot(mirror, {
      cashKeys: ['AvailableAmount', 'availableAmount', 'Credit', 'credit'],
      source: 'owner-mirror',
      mirrorId: wanted,
    });
  }

  /** Estrae le righe da qualunque forma di risposta a lista. */
  static searchRows(data, extraKeys = []) {
    if (Array.isArray(data)) return recordList(data);
    const record = asRecord(data);
    for (const key of [...extraKeys, 'instruments', 'Instruments', 'results', 'Results', 'items', 'Items', 'data', 'Data']) {
      const value = record[key];
      if (Array.isArray(value)) return recordList(value);
      // Alcune risposte annidano l'array un livello più sotto.
      if (value && typeof value === 'object') {
        for (const inner of Object.values(value)) {
          if (Array.isArray(inner)) return recordList(inner);
        }
      }
    }
    return [];
  }

  static rowSymbols(raw) {
    return [
      pick(raw, 'internalSymbolFull', 'InternalSymbolFull'),
      pick(raw, 'symbolFull', 'SymbolFull'),
      pick(raw, 'symbol', 'Symbol'),
      pick(raw, 'ticker', 'Ticker'),
    ].filter(Boolean).map((value) => String(value).toUpperCase());
  }

  static toInstrument(raw) {
    const id = num(pick(raw, 'instrumentId', 'InstrumentID', 'instrumentID', 'InstrumentId', 'id', 'Id'));
    if (!id) return null;
    const symbols = EtoroClient.rowSymbols(raw);
    return {
      instrumentId: id,
      symbol: symbols[0] ?? `#${id}`,
      aliases: symbols,
      name: String(pick(raw, 'instrumentDisplayName', 'InstrumentDisplayName', 'name', 'Name') ?? symbols[0] ?? `#${id}`),
      assetClass: String(pick(raw, 'instrumentTypeDescription', 'InstrumentTypeDescription', 'assetClass', 'AssetClass') ?? ''),
      currency: String(pick(raw, 'currency', 'Currency') ?? 'USD'),
      price: num(pick(raw, 'currentRate', 'CurrentRate', 'lastExecution')) || null,
    };
  }

  /**
   * Ricerca strumenti con più strategie di query: eToro accetta parametri
   * diversi a seconda dell'endpoint, e una sola forma non basta.
   */
  async searchInstruments(term, { maxAttempts = 5 } = {}) {
    const query = String(term ?? '').trim();
    if (!query) return [];
    const attempts = [
      `market-data/search?internalSymbolFull=${encodeURIComponent(query)}`,
      `market-data/search?symbols=${encodeURIComponent(query)}`,
      `market-data/search?query=${encodeURIComponent(query)}`,
      `market-data/search?searchText=${encodeURIComponent(query)}`,
      `market-data/search?name=${encodeURIComponent(query)}`,
    ];
    const seen = new Map();
    for (const path of attempts.slice(0, Math.max(1, maxAttempts))) {
      let rows = [];
      try {
        rows = EtoroClient.searchRows(await this.request('v1', path));
      } catch {
        continue;
      }
      for (const raw of rows) {
        const instrument = EtoroClient.toInstrument(raw);
        if (instrument && !seen.has(instrument.instrumentId)) seen.set(instrument.instrumentId, instrument);
      }
      // Con una corrispondenza esatta si può smettere di provare altre forme.
      const wanted = query.toUpperCase();
      if ([...seen.values()].some((item) => item.aliases.includes(wanted))) break;
    }
    const wanted = query.toUpperCase();
    return [...seen.values()].sort((a, b) => {
      const scoreA = a.aliases.includes(wanted) ? 0 : a.aliases.some((alias) => alias.startsWith(wanted)) ? 1 : 2;
      const scoreB = b.aliases.includes(wanted) ? 0 : b.aliases.some((alias) => alias.startsWith(wanted)) ? 1 : 2;
      return scoreA - scoreB;
    });
  }

  /**
   * Risoluzione di un ticker in instrumentId. Prova il simbolo così com'è, poi
   * le varianti comuni (senza suffisso di borsa, con suffisso USD per le crypto).
   */
  async searchInstrument(symbol, { tryUsd = true, maxQueriesPerVariant = 5 } = {}) {
    const original = String(symbol ?? '').trim().toUpperCase();
    if (!original) return null;
    const variants = [...new Set([
      original,
      original.split('.')[0],
      original.replace(/\.[A-Z]+$/, ''),
      ...(tryUsd ? [`${original}USD`, original.replace(/USD$/, '')] : []),
    ])].filter(Boolean);

    for (const variant of variants) {
      const candidates = await this.searchInstruments(variant, { maxAttempts: maxQueriesPerVariant });
      const exact = candidates.find((item) => item.aliases.includes(variant));
      if (exact) return { ...exact, symbol: original, matchedAs: exact.aliases[0], exact: true };
      if (candidates.length && variant === original) {
        return { ...candidates[0], symbol: original, matchedAs: candidates[0].aliases[0], exact: false };
      }
    }
    return null;
  }

  async instruments(ids) {
    if (!ids.length) return [];
    const data = await this.request('v1', `market-data/instruments?instrumentIds=${ids.join(',')}`);
    return recordList(pick(asRecord(data), 'instrumentDisplayDatas', 'InstrumentDisplayDatas', 'instruments', 'data') ?? data)
      .map((raw) => ({
        instrumentId: num(pick(raw, 'instrumentID', 'instrumentId', 'InstrumentID')),
        symbol: String(pick(raw, 'symbolFull', 'SymbolFull', 'internalSymbolFull', 'symbol') ?? ''),
        name: String(pick(raw, 'instrumentDisplayName', 'InstrumentDisplayName', 'name') ?? ''),
        assetClass: String(pick(raw, 'instrumentTypeDescription', 'InstrumentTypeDescription') ?? ''),
      }));
  }

  async rates(ids) {
    if (!ids.length) return new Map();
    const data = await this.request('v1', `market-data/instruments/rates?instrumentIds=${ids.join(',')}`);
    const rows = recordList(pick(asRecord(data), 'rates', 'Rates', 'data') ?? data);
    return new Map(rows.map((raw) => [
      num(pick(raw, 'instrumentId', 'InstrumentID', 'instrumentID')),
      {
        last: num(pick(raw, 'lastExecution', 'LastExecution', 'last', 'Last', 'ask', 'Ask')),
        ask: num(pick(raw, 'ask', 'Ask')),
        bid: num(pick(raw, 'bid', 'Bid')),
        previousClose: num(pick(raw, 'previousClose', 'PreviousClose', 'closeLast', 'CloseLast')),
      },
    ]));
  }

  /** Serie storica di chiusure. `interval` tipico: OneDay. */
  async candles(instrumentId, interval = 'OneDay', count = 260) {
    const data = await this.request('v1', `market-data/instruments/${instrumentId}/history/candles/asc/${interval}/${count}`);
    const buckets = recordList(pick(asRecord(data), 'candles', 'Candles') ?? data);
    const rows = buckets.flatMap((bucket) => recordList(pick(bucket, 'candles', 'Candles')).length
      ? recordList(pick(bucket, 'candles', 'Candles'))
      : [bucket]);
    return rows
      .map((raw) => ({
        at: String(pick(raw, 'fromDate', 'FromDate', 'date', 'Date') ?? ''),
        close: num(pick(raw, 'close', 'Close')),
        high: num(pick(raw, 'high', 'High')),
        low: num(pick(raw, 'low', 'Low')),
        volume: num(pick(raw, 'volume', 'Volume')),
      }))
      .filter((row) => row.close > 0);
  }

  async eligibility(instrumentIds, userKey = this.agentToken || this.userKey) {
    const data = await this.request('v2', 'trading/info/eligibility', {
      method: 'POST',
      userKey,
      body: { instrumentIds, currency: 'USD' },
    });
    const rows = recordList(pick(asRecord(data), 'eligibilities', 'Eligibilities'));
    return new Map(rows.map((raw) => {
      const leverageConfigs = recordList(pick(raw, 'leverageConfigs', 'LeverageConfigs'));
      const longMins = leverageConfigs
        .filter((config) => {
          const direction = String(pick(config, 'direction', 'Direction') ?? '').toUpperCase();
          const values = pick(config, 'leverageValues', 'LeverageValues');
          return (!direction || direction === 'LONG') && Array.isArray(values) && values.map(Number).includes(1);
        })
        .map((config) => num(pick(config, 'minPositionAmount', 'MinPositionAmount')))
        .filter((value) => value > 0);
      return [
        num(pick(raw, 'instrumentId', 'InstrumentId')),
        {
          allowOpenPosition: Boolean(pick(raw, 'allowOpenPosition', 'AllowOpenPosition')),
          minPositionUsd: Math.max(num(pick(raw, 'minPositionExposure', 'MinPositionExposure')), longMins.length ? Math.min(...longMins) : 0),
        },
      ];
    }));
  }

  /** Apertura posizione a mercato sull'Agent Portfolio. */
  async openOrder({ instrumentId, amountUsd, requestId }) {
    return this.request('v2', 'trading/execution/orders', {
      method: 'POST',
      userKey: this.agentToken,
      requestId,
      body: {
        action: 'open',
        transaction: 'buy',
        instrumentId,
        orderType: 'mkt',
        leverage: 1,
        amount: Math.round(amountUsd * 100) / 100,
        orderCurrency: 'usd',
      },
    });
  }

  /** Chiusura (totale o parziale) di una posizione dell'Agent Portfolio. */
  async closeOrder({ positionId, amountUsd, requestId }) {
    const body = { action: 'close', positionId, orderType: 'mkt', orderCurrency: 'usd' };
    if (amountUsd != null) body.amount = Math.round(amountUsd * 100) / 100;
    try {
      return await this.request('v2', 'trading/execution/orders', {
        method: 'POST',
        userKey: this.agentToken,
        requestId,
        body,
      });
    } catch (error) {
      if (amountUsd != null) throw error;
      // Fallback: endpoint legacy di chiusura totale.
      return this.request('v1', `trading/execution/real/market-close-orders/positions/${positionId}`, {
        method: 'POST',
        userKey: this.agentToken,
        requestId,
        body: { PositionID: positionId },
      });
    }
  }

  async lookupOrder({ orderId, referenceId }) {
    const query = orderId ? `orderId=${encodeURIComponent(orderId)}` : `referenceId=${encodeURIComponent(referenceId)}`;
    const data = await this.request('v2', `trading/info/orders:lookup?${query}`, { userKey: this.agentToken });
    const root = asRecord(pick(asRecord(data), 'data', 'Data') ?? data);
    const statusRecord = asRecord(pick(root, 'status', 'Status'));
    const label = String(pick(statusRecord, 'name', 'Name') ?? pick(root, 'statusName', 'StatusName') ?? 'Pending');
    const statusId = num(pick(statusRecord, 'id', 'Id'));
    const executions = recordList(pick(root, 'positionExecutions', 'PositionExecutions'));
    const normalized = label.toLowerCase();
    const isPartial = statusId === 5 || statusId === 10 || /partial/.test(normalized);
    const isFilled = statusId === 3 || (!isPartial && /filled|executed|completed/.test(normalized));
    const isRejected = statusId === 4 || (!isPartial && /reject|cancel|fail|expired/.test(normalized));
    return {
      orderId: num(pick(root, 'orderId', 'OrderId', 'OrderID'), orderId ?? 0),
      state: isFilled ? 'filled' : isPartial ? 'partial' : isRejected ? 'rejected' : 'pending',
      label,
      filledUsd: executions.reduce((sum, item) => sum + num(pick(item, 'investedAmountCurrency', 'InvestedAmountCurrency', 'initialExposureAccountCurrency')), 0),
      positionIds: executions.map((item) => num(pick(item, 'positionId', 'PositionId', 'PositionID'))).filter(Boolean),
      error: String(pick(statusRecord, 'errorMessage', 'ErrorMessage') ?? '').trim() || undefined,
    };
  }

  async agentPortfolios() {
    const data = await this.request('v1', 'agent-portfolios');
    const rows = EtoroClient.searchRows(data, ['agentPortfolios', 'AgentPortfolios', 'portfolios', 'Portfolios']);
    return rows.map((raw) => {
      const id = String(pick(raw, 'agentPortfolioId', 'AgentPortfolioId', 'portfolioId', 'id', 'Id') ?? '');
      const name = String(pick(raw, 'agentPortfolioName', 'AgentPortfolioName', 'name', 'Name', 'displayName', 'DisplayName', 'portfolioName', 'PortfolioName', 'title', 'Title') ?? '');
      return {
        id,
        name: name || `Portfolio ${id.slice(0, 8)}`,
        virtualBalanceUsd: num(pick(raw, 'agentPortfolioVirtualBalance', 'AgentPortfolioVirtualBalance', 'virtualBalance', 'VirtualBalance', 'balance', 'Balance')),
        mirrorId: String(pick(raw, 'mirrorId', 'MirrorId', 'MirrorID', 'mirrorID') ?? ''),
        createdAt: String(pick(raw, 'createdAt', 'CreatedAt', 'creationDate') ?? ''),
        raw,
      };
    }).filter((item) => item.id);
  }

  /** Scope minimi perché il token possa leggere e operare sull'Agent Portfolio. */
  static get AGENT_SCOPES() {
    return ['etoro-public:trade.real:read', 'etoro-public:trade.real:write'];
  }

  /** Verifica che gli scope necessari siano concessi prima di creare il token. */
  async assertAgentScopes() {
    const data = await this.request('v2', 'agent-portfolios/user-tokens/scopes');
    const rows = EtoroClient.searchRows(data, ['scopes', 'Scopes', 'scopeNames', 'ScopeNames']);
    const allowed = new Set(rows.flatMap((raw) => [
      pick(raw, 'scopeName', 'ScopeName', 'name', 'Name', 'scope', 'Scope'),
    ].filter(Boolean).map(String)));
    // Alcune risposte restituiscono direttamente un array di stringhe.
    if (Array.isArray(data)) for (const value of data) if (typeof value === 'string') allowed.add(value);
    if (!allowed.size) return;
    const missing = EtoroClient.AGENT_SCOPES.filter((scope) => !allowed.has(scope));
    if (missing.length) {
      throw new EtoroError(`eToro non concede gli scope richiesti: ${missing.join(', ')}`, 403, { allowed: [...allowed] });
    }
  }

  /**
   * Genera un nuovo user-token per un Agent Portfolio esistente.
   * eToro mostra il segreto una sola volta: va salvato immediatamente.
   */
  async createAgentUserToken(agentPortfolioId, tokenLabel = `autopilot-${Date.now()}`) {
    await this.assertAgentScopes();
    // eToro accetta solo nomi in minuscolo con trattini, massimo 32 caratteri.
    const userTokenName = String(tokenLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'autopilot';
    const data = await this.request('v2', `agent-portfolios/${encodeURIComponent(agentPortfolioId)}/user-tokens`, {
      method: 'POST',
      body: { userTokenName, scopeNames: EtoroClient.AGENT_SCOPES },
    });
    const token = extractAgentTokenSecret(data);
    if (token) return { token, name: userTokenName };
    throw new EtoroError(
      `eToro ha creato il token ma non ne ha restituito il segreto. Struttura ricevuta: ${describeShape(data)}`,
      502,
      data,
    );
  }
}
