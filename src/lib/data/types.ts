/**
 * Tipi condivisi del data layer di Torino.
 * Tutti i provider (Demo / Live / CSV) producono queste strutture.
 * Gli import devono usare `import type` (verbatimModuleSyntax).
 */

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'fx' | 'index' | 'cfd';

export type DataMode = 'demo' | 'live';

/** Stato connessione del provider attivo. */
export type ConnectionStatus = 'demo' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface Instrument {
  instrumentId: number;
  /** Ticker, es. "AAPL". */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Valuta di quotazione dello strumento (es. "USD"). */
  currency: string;
  exchange?: string;
}

export interface Quote {
  instrumentId: number;
  bid: number;
  ask: number;
  /** Ultimo prezzo (mid). */
  last: number;
  prevClose: number;
  /** Variazione % vs prevClose in punti percentuali (es. 1.27 = +1,27%). */
  changePct: number;
  timestamp: number;
}

export interface Candle {
  /** Unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type CandleInterval = 'OneMinute' | 'FiveMinutes' | 'OneHour' | 'OneDay' | 'OneWeek';

export interface Position {
  positionId: number;
  instrumentId: number;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  isBuy: boolean;
  units: number;
  openPrice: number;
  /** ISO date string. */
  openDate: string;
  /** Importo investito in valuta conto (USD). */
  invested: number;
  fees: number;
  leverage: number;
  stopLossRate?: number;
  takeProfitRate?: number;
  /** Arricchiti dallo store con le quote live: */
  currentPrice?: number;
  /** Valore corrente restituito dall'endpoint P&L (USD). */
  currentValue?: number;
  /** P&L in USD. */
  pnl?: number;
  /** P&L % sull'investito. */
  pnlPct?: number;
}

export interface Portfolio {
  positions: Position[];
  /** Dettaglio dei copy portfolio / copy agent attivi. */
  copyPortfolios?: CopyPortfolio[];
  /** Cash disponibile (USD). */
  cash: number;
  /** Totale investito nelle posizioni aperte (USD). */
  totalInvested: number;
  /** Valore corrente delle sole posizioni (USD). */
  positionsValue: number;
  /** Valore corrente dei copy portfolio (USD). */
  mirrorValue?: number;
  /** Capitale investito nei copy portfolio (USD). */
  mirrorInvested?: number;
  /** cash + positionsValue (USD). */
  totalValue: number;
  currency: 'USD';
}

export interface CopyPortfolio {
  copyId: string;
  name: string;
  parentCID?: number;
  parentUsername?: string;
  isAgent?: boolean;
  status?: string;
  /** Capitale allocato al copy portfolio (USD). */
  invested: number;
  /** Valore corrente del copy portfolio (USD). */
  value: number;
  /** P&L corrente del copy portfolio (USD). */
  pnl: number;
  pnlPct: number;
  positions: Position[];
}

export interface EquityPoint {
  /** Unix seconds. */
  time: number;
  value: number;
}

export interface PnlSummary {
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  totalPnlPct: number;
  /** Storico equity giornaliero (USD), crescente nel tempo. */
  equityHistory: EquityPoint[];
}

export interface FxRate {
  pair: 'EURUSD';
  /** Quanti USD per 1 EUR (es. 1.0923). */
  rate: number;
  prevClose: number;
  changePct: number;
  timestamp: number;
}

/* ── Agent ─────────────────────────────────────────────────────────── */

export type AgentConditionType =
  | 'drop_from_avg'   // calo % dalla media mobile a N giorni
  | 'price_below'     // prezzo sotto soglia
  | 'price_above'     // prezzo sopra soglia
  | 'rsi_below';      // RSI-14 sotto soglia

export interface AgentCondition {
  type: AgentConditionType;
  /** Soglia: % per drop_from_avg, prezzo per price_*, livello RSI per rsi_below. */
  value: number;
  /** Finestra in giorni per drop_from_avg (default 20). */
  windowDays?: number;
}

export interface AgentRule {
  id: string;
  name: string;
  groupId: string;
  instrumentIds: number[];
  condition: AgentCondition;
  action: {
    type: 'buy';
    /** Importo per ordine in USD. */
    amount: number;
    leverage: number;
  };
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggeredAt?: number;
  executionsToday: number;
}

/** Gruppo con limite di capitale (es. "Importantissimo"). */
export interface AgentGroup {
  id: string;
  name: string;
  /** Capitale massimo investibile dal gruppo (USD). */
  capitalLimit: number;
  /** Capitale già impiegato (USD). */
  usedCapital: number;
}

export type AgentExecutionStatus = 'executed' | 'pending_confirm' | 'skipped' | 'failed';

export interface AgentExecution {
  id: string;
  ruleId: string;
  ruleName: string;
  groupId: string;
  instrumentId: number;
  symbol: string;
  timestamp: number;
  amount: number;
  price: number;
  status: AgentExecutionStatus;
  mode: DataMode;
  reason?: string;
}

/* ── Log condiviso ─────────────────────────────────────────────────── */

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'agent';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
}

/* ── Ordini ────────────────────────────────────────────────────────── */

export interface OrderRequest {
  instrumentId: number;
  isBuy: boolean;
  /** Importo in USD. */
  amount: number;
  leverage?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
}

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  positionId?: number;
  message?: string;
}

/* ── Avvisi prezzo (Overview / Avvisi) ─────────────────────────────── */

export interface PriceAlert {
  id: string;
  instrumentId: number;
  symbol: string;
  /** eToro usa il prezzo del conto; Binance è un riferimento crypto esterno. */
  source?: 'etoro' | 'binance';
  direction: 'above' | 'below';
  threshold: number;
  createdAt: number;
  triggeredAt?: number;
}
