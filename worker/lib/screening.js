/**
 * Screening deterministico dell'universo.
 *
 * Serve a ridurre un pool di decine di strumenti alla manciata che ha senso
 * sottoporre al modello: mandare tutto all'AI farebbe esplodere il prompt e
 * peggiorerebbe la qualità della risposta. Il punteggio è riproducibile e
 * non usa AI.
 */
import {
  annualizedVol, correlation, dailyReturns, distanceFromSma, maxDrawdown,
  momentumScore, pctChange, rsi,
} from './features.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 1) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

/**
 * Punteggio 0–100 di un singolo strumento.
 *
 * Momentum e trend premiano; volatilità fuori target, drawdown recente,
 * ipercomprato e correlazione con ciò che già possiedi penalizzano.
 */
export function scoreInstrument(closes, { targetVolPct, benchmarkReturns, heldReturns = [] }) {
  if (closes.length < 60) return null;
  const returns = dailyReturns(closes);
  const momentum = momentumScore(closes) ?? 0;
  const vol = annualizedVol(closes, 30) ?? 0;
  const drawdown = maxDrawdown(closes.slice(-63)) ?? 0;
  const relativeStrengthRaw = pctChange(closes, 63);
  const benchmark63 = benchmarkReturns.length >= 63
    ? benchmarkReturns.slice(-63).reduce((sum, value) => sum + value, 0) * 100
    : 0;
  const relativeStrength = (relativeStrengthRaw ?? 0) - benchmark63;
  const vsSma50 = distanceFromSma(closes, 50) ?? 0;
  const vsSma200 = distanceFromSma(closes, 200) ?? vsSma50;
  const rsiValue = rsi(closes, 14) ?? 50;

  // Correlazione media con le posizioni già in portafoglio: la diversificazione vale punti.
  const correlations = heldReturns
    .map((series) => correlation(returns, series))
    .filter((value) => value != null);
  const avgCorrelation = correlations.length
    ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length
    : 0;

  const [volMin, volMax] = targetVolPct;
  const volPenalty = vol > volMax ? (vol - volMax) / Math.max(volMax, 1) : vol < volMin ? (volMin - vol) / Math.max(volMin, 1) * 0.4 : 0;

  const parts = {
    momentum: clamp(momentum, -100, 100) * 0.30,
    trend: (clamp(vsSma50, -20, 20) * 1.2 + clamp(vsSma200, -30, 30) * 0.8) * 0.6,
    relativeStrength: clamp(relativeStrength, -40, 40) * 0.5,
    volatility: -clamp(volPenalty, 0, 2) * 25,
    drawdown: clamp(drawdown, -60, 0) * 0.35,
    overbought: rsiValue > 78 ? -(rsiValue - 78) * 1.6 : rsiValue < 25 ? -(25 - rsiValue) * 0.8 : 0,
    diversification: -clamp(avgCorrelation, -1, 1) * 12,
  };
  const raw = Object.values(parts).reduce((sum, value) => sum + value, 0);

  return {
    score: round(clamp(50 + raw * 0.5, 0, 100)),
    parts: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, round(value)])),
    metrics: {
      momentum: round(momentum),
      vol30: round(vol),
      drawdown3m: round(drawdown),
      relativeStrength: round(relativeStrength),
      vsSma50: round(vsSma50),
      vsSma200: round(vsSma200),
      rsi14: round(rsiValue),
      avgCorrelation: round(avgCorrelation, 2),
      ret1m: pctChange(closes, 21),
      ret3m: pctChange(closes, 63),
      ret12m: pctChange(closes, 252),
      price: round(closes[closes.length - 1], 4),
    },
  };
}

/**
 * Ordina i candidati e restituisce la shortlist.
 *
 * Le posizioni già aperte entrano sempre, con qualunque punteggio: il modello
 * deve poter decidere di mantenerle o venderle, non solo di comprare altro.
 *
 * @param {Map<string, object>} universe   symbol -> metadati
 * @param {Map<string, Array>} candles     symbol -> serie giornaliera
 * @param {Set<string>} heldSymbols
 */
export function buildShortlist({ universe, candles, heldSymbols, config, profile }) {
  const benchmarkSeries = candles.get('SPY') ?? candles.get('IWDA') ?? [];
  const benchmarkReturns = dailyReturns(benchmarkSeries.map((row) => row.close));
  const heldReturns = [...heldSymbols]
    .map((symbol) => dailyReturns((candles.get(symbol) ?? []).map((row) => row.close)))
    .filter((series) => series.length > 20);

  const scored = [];
  const skipped = [];
  for (const [symbol, meta] of universe.entries()) {
    const closes = (candles.get(symbol) ?? []).map((row) => row.close);
    const result = scoreInstrument(closes, {
      targetVolPct: profile.targetVolPct,
      benchmarkReturns,
      heldReturns: heldSymbols.has(symbol) ? [] : heldReturns,
    });
    if (!result) { skipped.push({ symbol, reason: 'storico insufficiente' }); continue; }
    scored.push({ symbol, ...meta, ...result, held: heldSymbols.has(symbol) });
  }

  scored.sort((a, b) => b.score - a.score);

  const held = scored.filter((item) => item.held);
  const rest = scored.filter((item) => !item.held);
  const slots = Math.max(0, (config.shortlistSize ?? 18) - held.length);

  // Tetto per classe anche in shortlist: evita che una sola classe la monopolizzi.
  const perClassCap = Math.ceil((config.shortlistSize ?? 18) / 3);
  const byClass = {};
  const picked = [];
  for (const item of rest) {
    if (picked.length >= slots) break;
    const used = byClass[item.class] ?? 0;
    if (used >= perClassCap) continue;
    byClass[item.class] = used + 1;
    picked.push(item);
  }

  return {
    shortlist: [...held, ...picked],
    ranked: scored,
    skipped,
    benchmarkUsed: benchmarkSeries.length ? 'SPY' : 'nessuno',
  };
}

/** Riga compatta per il prompt: una per strumento, larghezza fissa. */
export function renderShortlistPrompt(shortlist) {
  const lines = ['CANDIDATI   score  peso%  1m%    3m%    12m%   vol30  RSI  vsSMA200  mom    corr  stato'];
  for (const item of shortlist) {
    const cell = (value, width) => `${value == null ? 'n/d' : value}`.padEnd(width);
    lines.push([
      item.symbol.padEnd(11),
      cell(item.score, 6),
      cell(((item.weight ?? 0) * 100).toFixed(1), 6),
      cell(item.metrics.ret1m, 6),
      cell(item.metrics.ret3m, 6),
      cell(item.metrics.ret12m, 6),
      cell(item.metrics.vol30, 6),
      cell(item.metrics.rsi14, 4),
      cell(item.metrics.vsSma200, 9),
      cell(item.metrics.momentum, 6),
      cell(item.metrics.avgCorrelation, 5),
      item.held ? 'IN PORTAFOGLIO' : 'candidato',
    ].join(' '));
  }
  return lines.join('\n');
}
