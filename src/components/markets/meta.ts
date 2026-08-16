/**
 * Metadati locali della pagina Mercati: settore, peso (market cap) e
 * volume medio per strumento. Il data layer non espone questi campi,
 * quindi li deriviamo in modo deterministico dall'anagrafica nota
 * (catalogo Demo) con fallback hash-based per strumenti sconosciuti
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
  /** Volume scambiato (24h, pseudo-deterministico). */
  volume: number;
  /** Capitalizzazione / peso di mercato in valuta dello strumento. */
  marketCap: number;
  /** Settore (per heatmap). */
  sector: string;
}

/** [sector, marketCap in miliardi (valuta strumento)] */
const META: Record<number, [string, number]> = {
  // Azioni US
  1001: ['Tecnologia', 3500],      // AAPL
  1002: ['Tecnologia', 3200],      // MSFT
  1003: ['Semiconduttori', 3400],  // NVDA
  1004: ['Consumi', 2200],         // AMZN
  1005: ['Tecnologia', 2100],      // GOOGL
  1006: ['Tecnologia', 1500],      // META
  1007: ['Auto', 1100],            // TSLA
  1008: ['Finanza', 690],          // JPM
  1009: ['Finanza', 610],          // V
  1010: ['Comunicazione', 390],    // NFLX
  1011: ['Semiconduttori', 200],   // AMD
  1012: ['Semiconduttori', 90],    // INTC
  1013: ['Comunicazione', 200],    // DIS
  1014: ['Industriale', 115],      // BA
  1015: ['Energia', 510],          // XOM
  // Azioni EU
  1101: ['Semiconduttori', 270],   // ASML
  1102: ['Tecnologia', 280],       // SAP
  1103: ['Lusso', 310],            // MC.PA
  1104: ['Utility', 60],           // ENEL
  1105: ['Auto', 77],              // RACE
  1106: ['Industriale', 150],      // SIE
  1107: ['Consumi', 200],          // NESN
  1108: ['Energia', 210],          // SHEL
  // ETF
  1201: ['ETF', 600], 1202: ['ETF', 300], 1203: ['ETF', 20],
  1204: ['ETF', 70], 1205: ['ETF', 75], 1206: ['ETF', 45],
  // Crypto
  1301: ['Crypto', 1900], 1302: ['Crypto', 440], 1303: ['Crypto', 105],
  1304: ['Crypto', 130], 1305: ['Crypto', 36],
  // FX (peso nozionale)
  1401: ['Valute', 500], 1402: ['Valute', 300], 1403: ['Valute', 400],
  // Indici (peso nozionale)
  1501: ['Indici', 1000], 1502: ['Indici', 800], 1503: ['Indici', 600],
  1504: ['Indici', 400], 1505: ['Indici', 350], 1506: ['Indici', 450],
};

const CLASS_SECTOR: Record<AssetClass, string> = {
  stock: 'Azioni',
  etf: 'ETF',
  crypto: 'Crypto',
  fx: 'Valute',
  index: 'Indici',
  cfd: 'Materie prime',
};

function hash(id: number): number {
  let h = id | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return Math.abs(h ^ (h >>> 16));
}

export function sectorFor(i: Instrument): string {
  return META[i.instrumentId]?.[0] ?? CLASS_SECTOR[i.assetClass];
}

/** Market cap / peso in valuta dello strumento (assoluto, non miliardi). */
export function marketCapFor(i: Instrument): number {
  const known = META[i.instrumentId]?.[1];
  const billions = known ?? 5 + (hash(i.instrumentId) % 240);
  return billions * 1e9;
}

/** Volume 24h pseudo-deterministico, scala per asset class. */
export function volumeFor(i: Instrument): number {
  const h = hash(i.instrumentId * 7 + 13);
  const base: Record<AssetClass, number> = {
    stock: 8e6, etf: 25e6, crypto: 18e9, fx: 120e9, index: 3e9, cfd: 900e6,
  };
  return Math.round(base[i.assetClass] * (0.35 + (h % 1000) / 1000));
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
