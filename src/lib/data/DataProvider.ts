/**
 * Interfaccia comune dei provider dati (Demo / Live).
 * Lo store (store.tsx) istanzia il provider in base alle impostazioni
 * e si sottoscrive ai suoi eventi.
 */
import type {
  Candle,
  CandleInterval,
  ConnectionStatus,
  DataMode,
  FxRate,
  Instrument,
  LogEntry,
  OrderRequest,
  OrderResult,
  PnlSummary,
  Portfolio,
  Quote,
} from './types';

export type ProviderEvent = 'quotes' | 'portfolio' | 'pnl' | 'status' | 'log';

export interface ProviderEventMap {
  quotes: Quote[];
  portfolio: Portfolio;
  pnl: PnlSummary;
  status: ConnectionStatus;
  log: LogEntry;
}

export type ProviderHandler<E extends ProviderEvent> = (payload: ProviderEventMap[E]) => void;

export interface DataProvider {
  readonly mode: DataMode;

  /** Avvia stream/simulazione. Idempotente. */
  start(): void;
  /** Ferma stream/simulazione e rilascia risorse. */
  stop(): void;

  getPortfolio(): Promise<Portfolio>;
  getPnl(): Promise<PnlSummary>;
  getQuotes(instrumentIds: number[]): Promise<Quote[]>;
  getCandles(instrumentId: number, interval: CandleInterval, count: number): Promise<Candle[]>;
  searchInstruments(query: string): Promise<Instrument[]>;
  /** Catalogo completo degli strumenti noti al provider. */
  listInstruments(): Instrument[];
  getFxRate(): FxRate;

  placeMarketOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(positionId: number): Promise<OrderResult>;

  /** Sottoscrizione eventi; ritorna funzione di unsubscribe. */
  on<E extends ProviderEvent>(event: E, handler: ProviderHandler<E>): () => void;
}

/** Emitter minimale condiviso dai provider. */
export class ProviderEmitter {
  private handlers = new Map<ProviderEvent, Set<(payload: never) => void>>();

  on<E extends ProviderEvent>(event: E, handler: ProviderHandler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set!.delete(handler as (payload: never) => void);
  }

  emit<E extends ProviderEvent>(event: E, payload: ProviderEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) (h as ProviderHandler<E>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
