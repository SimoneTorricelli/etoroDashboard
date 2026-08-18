/**
 * Metadati locali della pagina Mercati: settore, peso (market cap) e
 * volume medio per strumento. Il data layer non espone questi campi,
 * quindi li deriviamo in modo deterministico dall'anagrafica nota
 * (catalogo iniziale) con fallback hash-based per strumenti sconosciuti
 * (es. quelli restituiti dal provider Live).
 */
import type { AssetClass, Candle, Instrument, Quote } from '@/lib/data/types';

/** Riga arricchita usata da tabella, heatmap e movers. */
export interface MarketRow {
  instrument: Instrument;
  quote?: Quote;
  /** Variazione % a 7 giorni (da candele giornaliere). */
  change7d: number | null;
  /** Variazione % a 1 mese. */
  change1m: number | null;
  /** Chiusure giornaliere ~30g per sparkline. */
  spark: number[];
  /** Volume restituito da eToro, se presente. */
  volume: number | null;
  /** Capitalizzazione / peso di mercato in valuta dello strumento. */
  marketCap: number | null;
  /** Settore (per heatmap). */
  sector: string;
}

const CLASS_SECTOR: Record<AssetClass, string> = {
  stock: 'Azioni',
  etf: 'ETF',
  crypto: 'Crypto',
  fx: 'Valute',
  index: 'Indici',
  cfd: 'Materie prime',
};

export function sectorFor(i: Instrument): string {
  return i.sector ?? CLASS_SECTOR[i.assetClass] ?? 'Non classificato';
}

/** Variazione % tra la chiusura di `daysBack` candele fa e l'ultima. */
export function changeOver(candles: Candle[], daysBack: number): number | null {
  if (candles.length < daysBack + 1) return null;
  const then = candles[candles.length - 1 - daysBack].close;
  const now = candles[candles.length - 1].close;
  if (!then) return null;
  return ((now - then) / then) * 100;
}

/** Etichetta asset class in italiano. */
export const CLASS_LABEL: Record<AssetClass, string> = {
  stock: 'Azioni',
  etf: 'ETF',
  crypto: 'Crypto',
  fx: 'Valute',
  index: 'Indici',
  cfd: 'Materie prime',
};
