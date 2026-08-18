/**
 * Formattazione numerica in locale italiano (design.md):
 * - Valute: € 12.480,32 / $ 12,480.32 → sempre in stile italiano: $ 12.480,32
 * - Percentuali con segno: +2,4%
 * - Compatto per grandi valori: € 1,2 M
 */

const itNumber = (digits = 2) =>
  new Intl.NumberFormat('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ', JPY: '¥' };

/** "€ 12.480,32" — valuta con separatore migliaia italiano. */
export function formatCurrency(value: number, currency: 'EUR' | 'USD' | string = 'EUR', digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const sym = SYMBOLS[currency] ?? `${currency} `;
  const abs = Math.abs(value);
  const formatted = itNumber(digits).format(abs);
  const sign = value < 0 ? '-' : '';
  return `${sign}${sym} ${formatted}`;
}

/** Alias per EUR. */
export function formatEUR(value: number, digits = 2): string {
  return formatCurrency(value, 'EUR', digits);
}

/** "+2,4%" / "-1,27%" — sempre con segno. `value` è in punti percentuali. */
export function formatPercent(value: number, digits = 2, signed = true): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : signed ? '+' : '';
  return `${sign}${itNumber(digits).format(Math.abs(value))}%`;
}

/** "+€ 312,10" — valuta con segno esplicito (per P&L). */
export function formatSignedCurrency(value: number, currency: 'EUR' | 'USD' | string = 'EUR', digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatCurrency(Math.abs(value), currency, digits)}`;
}

/** "€ 1,2 M" / "€ 340 k" — compatto per grandi valori. */
export function formatCompact(value: number, currency: 'EUR' | 'USD' | string = 'EUR'): string {
  if (!Number.isFinite(value)) return '—';
  const sym = SYMBOLS[currency] ?? `${currency} `;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${sym} ${itNumber(1).format(abs / 1_000_000)} M`;
  if (abs >= 10_000) return `${sign}${sym} ${itNumber(0).format(abs / 1_000)} k`;
  return `${sign}${sym} ${itNumber(2).format(abs)}`;
}

/** Numero semplice in stile italiano: "12.480,32". */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return itNumber(digits).format(value);
}

/** Prezzo strumento con decimali adattivi (crypto grandi → 0-2, FX → 4-5). */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return itNumber(2).format(value);
  if (abs >= 100) return itNumber(2).format(value);
  if (abs >= 10) return itNumber(2).format(value);
  if (abs >= 1) return itNumber(3).format(value);
  return itNumber(5).format(value);
}

/** Quantità/units: fino a 4 decimali, senza zeri in coda. */
export function formatUnits(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('it-IT', { maximumFractionDigits: 4 }).format(value);
}

/** Tasso FX: "1,0923". */
export function formatFxRate(rate: number, digits = 4): string {
  if (!Number.isFinite(rate) || rate <= 0) return '—';
  return itNumber(digits).format(rate);
}

/** Timestamp → "12:04:31". */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Timestamp → "16 ago, 12:04". */
export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** ISO date → "16 ago 2025". */
export function formatDate(iso: string | number): string {
  return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}
