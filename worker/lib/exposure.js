/**
 * Esposizioni economicamente equivalenti. Due ticker nello stesso gruppo non
 * contano come due fonti di rischio durante la costruzione del portafoglio.
 */
const SYMBOL_GROUPS = Object.freeze({
  GLD: 'gold-spot',
  IAU: 'gold-spot',
  BND: 'us-aggregate-bond',
  AGG: 'us-aggregate-bond',
  DBC: 'broad-commodity-basket',
  PDBC: 'broad-commodity-basket',
});

export function exposureGroupFor(itemOrSymbol) {
  if (itemOrSymbol && typeof itemOrSymbol === 'object' && itemOrSymbol.exposureGroup) {
    return String(itemOrSymbol.exposureGroup);
  }
  const symbol = typeof itemOrSymbol === 'string' ? itemOrSymbol : itemOrSymbol?.symbol;
  const normalized = String(symbol ?? '').trim().toUpperCase();
  return SYMBOL_GROUPS[normalized] ?? `symbol:${normalized}`;
}

export function uniqueExposureCount(items) {
  return new Set((items ?? []).map(exposureGroupFor)).size;
}
