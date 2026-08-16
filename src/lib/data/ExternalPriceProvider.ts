/**
 * Quotazioni pubbliche esterne usate solo dagli avvisi esplicitamente marcati
 * come esterni. Non alimentano il portafoglio e non possono inviare ordini.
 */
const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', ADA: 'ADAUSDT', MIOTA: 'IOTAUSDT',
  DOGE: 'DOGEUSDT', DOT: 'DOTUSDT', AVAX: 'AVAXUSDT', MATIC: 'MATICUSDT', LTC: 'LTCUSDT',
};

export function externalCryptoSymbol(symbol: string): string | null {
  return BINANCE_SYMBOLS[symbol.trim().toUpperCase()] ?? null;
}

export function openBinanceTickerStream(symbols: string[], onPrice: (symbol: string, price: number) => void): () => void {
  const streams = symbols.map(externalCryptoSymbol).filter((value): value is string => Boolean(value)).map((value) => `${value.toLowerCase()}@ticker`);
  if (streams.length === 0 || typeof WebSocket === 'undefined') return () => undefined;
  const socket = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`);
  socket.onmessage = (event) => {
    try {
      const envelope = JSON.parse(String(event.data)) as Record<string, unknown>;
      const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
        ? envelope.data as Record<string, unknown>
        : envelope;
      const symbol = String(data.s ?? '').replace(/USDT$/i, '').toUpperCase();
      const price = Number(data.c ?? 0);
      if (symbol && Number.isFinite(price) && price > 0) onPrice(symbol, price);
    } catch { /* stream esterno non disponibile: il polling fallback resta attivo */ }
  };
  return () => {
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  };
}

export async function fetchBinancePrices(symbols: string[]): Promise<Record<string, number>> {
  const pairs = symbols.map(externalCryptoSymbol).filter((value): value is string => Boolean(value));
  if (pairs.length === 0) return {};
  const query = encodeURIComponent(JSON.stringify([...new Set(pairs)]));
  const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${query}`);
  if (!response.ok) throw new Error(`Binance ${response.status}`);
  const rows = (await response.json()) as Array<{ symbol?: string; price?: string }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    const symbol = String(row.symbol ?? '').replace(/USDT$/i, '').toUpperCase();
    const price = Number(row.price ?? 0);
    if (symbol && Number.isFinite(price) && price > 0) result[symbol] = price;
  }
  return result;
}
