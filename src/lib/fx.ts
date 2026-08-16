/**
 * Modulo FX (EUR/USD) — logica pura, usata dalla pagina /fx e dai suggerimenti.
 *
 * Conto eToro in USD → ogni conversione EUR⇄USD ha un costo in pips.
 * L'advisor suggerisce quando prelevare in EUR in base al tasso corrente,
 * alla soglia target dell'utente e al costo di conversione.
 */
import type { FxRate } from './data/types';

/** Costo conversione eToro in pips (1 pip = 0.0001 su EURUSD). Default 50 pips. */
export const DEFAULT_CONVERSION_PIPS = 50;
export const PIP_SIZE = 0.0001;

export interface ConversionQuote {
  /** Importo convertito al tasso di mercato. */
  grossAmount: number;
  /** Costo di conversione nella valuta di destinazione. */
  fee: number;
  /** Importo netto ricevuto. */
  netAmount: number;
  /** Tasso effettivo applicato (peggiorato dei pips). */
  effectiveRate: number;
}

/** USD → EUR: divide per il tasso e applica il costo in pips. */
export function convertUsdToEur(usd: number, rate: number, pips = DEFAULT_CONVERSION_PIPS): ConversionQuote {
  const effectiveRate = rate + pips * PIP_SIZE; // tasso peggiore per chi compra EUR
  const netAmount = usd / effectiveRate;
  const grossAmount = usd / rate;
  return { grossAmount, fee: grossAmount - netAmount, netAmount, effectiveRate };
}

/** EUR → USD: moltiplica per il tasso meno i pips. */
export function convertEurToUsd(eur: number, rate: number, pips = DEFAULT_CONVERSION_PIPS): ConversionQuote {
  const effectiveRate = rate - pips * PIP_SIZE;
  const netAmount = eur * effectiveRate;
  const grossAmount = eur * rate;
  return { grossAmount, fee: grossAmount - netAmount, netAmount, effectiveRate };
}

export type WithdrawalVerdict = 'favorable' | 'neutral' | 'unfavorable';

export interface WithdrawalAdvice {
  verdict: WithdrawalVerdict;
  /** Titolo breve in italiano. */
  title: string;
  /** Spiegazione in una riga. */
  detail: string;
  /** Distanza % dal target (positiva = sopra target). */
  distanceToTargetPct: number;
}

/**
 * Advisor prelievo USD→EUR.
 * Investito in USD, si preleva in EUR: conviene quando EURUSD è ALTO
 * (l'euro è forte? no — con EURUSD alto servono più USD per 1 EUR…).
 *
 * Nota: il conto è in USD e il prelievo arriva in EUR. Con EURUSD alto
 * (es. 1.15) 1 USD vale MENO euro → meglio prelevare quando EURUSD è BASSO.
 * La soglia target dell'utente (default 1.08) è il tasso sotto il quale
 * il prelievo è considerato favorevole.
 */
export function withdrawalAdvisor(fx: FxRate, targetRate: number): WithdrawalAdvice {
  const distancePct = ((fx.rate - targetRate) / targetRate) * 100;
  if (fx.rate <= targetRate * 0.995) {
    return {
      verdict: 'favorable',
      title: 'Momento favorevole per prelevare',
      detail: `EUR/USD a ${fx.rate.toFixed(4)} è sotto la tua soglia ${targetRate.toFixed(2)}: il dollaro vale di più in euro.`,
      distanceToTargetPct: distancePct,
    };
  }
  if (fx.rate <= targetRate * 1.01) {
    return {
      verdict: 'neutral',
      title: 'Vicino alla soglia target',
      detail: `EUR/USD a ${fx.rate.toFixed(4)} è in linea con la soglia ${targetRate.toFixed(2)}. Valuta il costo di conversione.`,
      distanceToTargetPct: distancePct,
    };
  }
  return {
    verdict: 'unfavorable',
    title: 'Attendi prima di prelevare',
    detail: `EUR/USD a ${fx.rate.toFixed(4)} è sopra la soglia ${targetRate.toFixed(2)}: riceveresti meno euro per dollaro.`,
    distanceToTargetPct: distancePct,
  };
}

/** Costo % effettivo della conversione dato un livello di pips. */
export function conversionCostPct(rate: number, pips = DEFAULT_CONVERSION_PIPS): number {
  return ((pips * PIP_SIZE) / rate) * 100;
}
