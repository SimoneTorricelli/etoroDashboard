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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.calls += 1;
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers(userKey, requestId),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
      if (!response.ok) {
        const record = asRecord(parsed);
        const message = pick(record, 'message', 'Message', 'error', 'Error') ?? `HTTP ${response.status}`;
        throw new EtoroError(typeof message === 'string' ? message : JSON.stringify(message), response.status, parsed);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Portafoglio + posizioni aperte dell'account indicato dallo user key attivo. */
  async portfolio(userKey = this.userKey) {
    const data = await this.request('v1', 'trading/info/real/pnl', { userKey });
    const account = asRecord(pick(data, 'clientPortfolio', 'ClientPortfolio', 'portfolio', 'Portfolio')) ;
    const root = Object.keys(account).length ? account : asRecord(data);
    const rawPositions = recordList(pick(root, 'Positions', 'positions'));
    const positions = rawPositions.map((raw) => {
      const invested = num(pick(raw, 'Amount', 'amount'));
      const units = num(pick(raw, 'Units', 'units'));
      const openRate = num(pick(raw, 'OpenRate', 'openRate'));
      const leverage = num(pick(raw, 'Leverage', 'leverage'), 1) || 1;
      const currentRate = num(pick(raw, 'CurrentRate', 'currentRate', 'Rate', 'rate'), openRate);
      const isBuy = pick(raw, 'IsBuy', 'isBuy') !== false;
      const grossValue = units > 0 && currentRate > 0 ? units * currentRate : invested;
      const pnl = openRate > 0 && units > 0
        ? (isBuy ? (currentRate - openRate) : (openRate - currentRate)) * units
        : num(pick(raw, 'NetProfit', 'netProfit', 'Profit', 'profit'));
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
    const cashUsd = num(pick(root, 'Credit', 'credit'));
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
    };
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
  async searchInstruments(term) {
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
    for (const path of attempts) {
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
  async searchInstrument(symbol) {
    const original = String(symbol ?? '').trim().toUpperCase();
    if (!original) return null;
    const variants = [...new Set([
      original,
      original.split('.')[0],
      original.replace(/\.[A-Z]+$/, ''),
      `${original}USD`,
      original.replace(/USD$/, ''),
    ])].filter(Boolean);

    for (const variant of variants) {
      const candidates = await this.searchInstruments(variant);
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
      const name = String(pick(raw, 'name', 'Name', 'displayName', 'DisplayName', 'portfolioName', 'PortfolioName', 'title', 'Title') ?? '');
      return {
        id,
        name: name || `Portfolio ${id.slice(0, 8)}`,
        virtualBalanceUsd: num(pick(raw, 'virtualBalance', 'VirtualBalance', 'balance', 'Balance')),
        createdAt: String(pick(raw, 'createdAt', 'CreatedAt', 'creationDate') ?? ''),
        raw,
      };
    }).filter((item) => item.id);
  }

  /**
   * Genera un nuovo user-token per un Agent Portfolio esistente.
   * eToro mostra il segreto una sola volta: va salvato immediatamente.
   */
  async createAgentUserToken(agentPortfolioId, tokenName = `autopilot-${Date.now()}`) {
    const data = await this.request('v2', `agent-portfolios/${encodeURIComponent(agentPortfolioId)}/user-tokens`, {
      method: 'POST',
      body: { name: tokenName },
    });
    const root = asRecord(pick(asRecord(data), 'data', 'Data', 'userToken', 'UserToken') ?? data);
    const direct = pick(root, 'userTokenValue', 'UserTokenValue', 'tokenValue', 'TokenValue', 'userToken', 'UserToken', 'token', 'Token', 'value', 'Value');
    if (typeof direct === 'string' && direct.trim()) return { token: direct.trim(), name: tokenName };
    const nested = asRecord(direct);
    const nestedValue = pick(nested, 'userTokenValue', 'UserTokenValue', 'tokenValue', 'TokenValue', 'value', 'Value');
    if (typeof nestedValue === 'string' && nestedValue.trim()) return { token: nestedValue.trim(), name: tokenName };
    throw new EtoroError('eToro non ha restituito il valore del token', 502, data);
  }
}
