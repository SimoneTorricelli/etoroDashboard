import { exposureGroupFor } from './exposure.js';

/**
 * Feature engine deterministico. Trasforma serie storiche e snapshot in un
 * insieme compatto di numeri: è l'unico input numerico che raggiunge l'LLM.
 * Nessuna chiamata di rete, nessuna dipendenza: interamente testabile.
 */

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function pctChange(series, lookback) {
  if (!Array.isArray(series) || series.length <= lookback) return null;
  const last = series[series.length - 1];
  const past = series[series.length - 1 - lookback];
  if (!past) return null;
  return round(((last - past) / past) * 100, 2);
}

export function dailyReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i - 1] > 0) out.push(series[i] / series[i - 1] - 1);
  }
  return out;
}

export function annualizedVol(series, window = 30) {
  const returns = dailyReturns(series).slice(-window);
  if (returns.length < 5) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return round(Math.sqrt(variance) * Math.sqrt(252) * 100, 1);
}

export function maxDrawdown(series) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, (value - peak) / peak);
  }
  return round(worst * 100, 2);
}

export function rsi(series, period = 14) {
  if (series.length < period + 1) return null;
  const slice = series.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  return round(100 - 100 / (1 + gains / losses), 1);
}

export function sma(series, period) {
  if (series.length < period) return null;
  const slice = series.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

export function distanceFromSma(series, period) {
  const average = sma(series, period);
  if (!average) return null;
  return round(((series[series.length - 1] - average) / average) * 100, 2);
}

export function correlation(a, b) {
  const size = Math.min(a.length, b.length);
  if (size < 20) return null;
  const left = a.slice(-size);
  const right = b.slice(-size);
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / size;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / size;
  let cov = 0;
  let varLeft = 0;
  let varRight = 0;
  for (let i = 0; i < size; i += 1) {
    const dl = left[i] - meanLeft;
    const dr = right[i] - meanRight;
    cov += dl * dr;
    varLeft += dl * dl;
    varRight += dr * dr;
  }
  if (varLeft === 0 || varRight === 0) return null;
  return round(cov / Math.sqrt(varLeft * varRight), 2);
}

/** Momentum composito normalizzato -100…+100. */
export function momentumScore(closes) {
  const parts = [pctChange(closes, 21), pctChange(closes, 63), pctChange(closes, 126)];
  const weights = [0.5, 0.3, 0.2];
  let total = 0;
  let usedWeight = 0;
  parts.forEach((value, index) => {
    if (value == null) return;
    total += value * weights[index];
    usedWeight += weights[index];
  });
  if (usedWeight === 0) return null;
  return round(Math.max(-100, Math.min(100, (total / usedWeight) * 3)), 1);
}

/**
 * Classificazione del regime di mercato a partire da VIX, trend S&P, curva dei
 * tassi e sentiment delle notizie. Il risultato è una label più un punteggio
 * risk-on/risk-off in [-1, +1].
 */
export function marketRegime(external) {
  const spx = external?.series?.spx?.map((row) => row.close) ?? [];
  const vix = external?.series?.vix?.map((row) => row.close) ?? [];
  const us10y = external?.series?.us10y?.map((row) => row.close) ?? [];
  const us2y = external?.series?.us2y?.map((row) => row.close) ?? [];

  const vixLast = vix.length ? vix[vix.length - 1] : null;
  const spxVsSma200 = distanceFromSma(spx, 200);
  const spxVsSma50 = distanceFromSma(spx, 50);
  const curveBp = us10y.length && us2y.length
    ? round((us10y[us10y.length - 1] - us2y[us2y.length - 1]) * 100, 0)
    : null;
  const newsNet = external?.news?.net ?? 0;

  const signals = [];
  if (vixLast != null) signals.push(vixLast < 16 ? 1 : vixLast < 22 ? 0.2 : vixLast < 30 ? -0.5 : -1);
  if (spxVsSma200 != null) signals.push(spxVsSma200 > 3 ? 1 : spxVsSma200 > 0 ? 0.4 : spxVsSma200 > -5 ? -0.4 : -1);
  if (spxVsSma50 != null) signals.push(spxVsSma50 > 0 ? 0.5 : -0.5);
  if (curveBp != null) signals.push(curveBp > 20 ? 0.5 : curveBp > 0 ? 0.1 : -0.6);
  signals.push(newsNet);

  const score = signals.length ? round(signals.reduce((sum, value) => sum + value, 0) / signals.length, 2) : 0;
  const label = score > 0.45 ? 'risk-on' : score > 0.1 ? 'risk-on moderato' : score > -0.15 ? 'neutro' : score > -0.5 ? 'risk-off moderato' : 'risk-off';
  return { label, score, vix: vixLast != null ? round(vixLast, 1) : null, spxVsSma200, spxVsSma50, yieldCurveBp: curveBp, newsNet };
}

/**
 * Costruisce il payload di feature completo.
 *
 * @param {object} input
 * @param {object} input.snapshot          Snapshot del portafoglio agent.
 * @param {Map<string, object>} input.universe   symbol -> { instrumentId, name, class, maxWeight }
 * @param {Map<string, Array<{at:string, close:number}>>} input.candles symbol -> serie giornaliera
 * @param {object} input.external          Contesto esterno (sources.js)
 * @param {object} input.config
 * @param {Array<{at:number, equity_usd:number}>} input.equityHistory
 */
export function buildFeatures({ snapshot, universe, candles, external, config, equityHistory = [] }) {
  const bySymbol = new Map();
  const positionByInstrument = new Map();
  for (const position of snapshot.positions) {
    const current = positionByInstrument.get(position.instrumentId) ?? { valueUsd: 0, investedUsd: 0, pnlUsd: 0, positionIds: [] };
    current.valueUsd += position.valueUsd;
    current.investedUsd += position.invested;
    current.pnlUsd += position.pnlUsd;
    current.positionIds.push(position.positionId);
    positionByInstrument.set(position.instrumentId, current);
  }

  const equityUsd = snapshot.equityUsd || 1;
  const benchmarkReturns = dailyReturns((candles.get('SPY') ?? []).map((row) => row.close));

  for (const [symbol, meta] of universe.entries()) {
    const series = (candles.get(symbol) ?? []).map((row) => row.close);
    const held = positionByInstrument.get(meta.instrumentId);
    const valueUsd = held?.valueUsd ?? 0;
    bySymbol.set(symbol, {
      symbol,
      class: meta.class,
      sector: meta.sector ?? null,
      themes: Array.isArray(meta.themes) ? [...meta.themes] : [],
      exposureGroup: meta.exposureGroup ?? exposureGroupFor(symbol),
      instrumentId: meta.instrumentId,
      weight: round(valueUsd / equityUsd, 4),
      valueUsd: round(valueUsd, 2),
      investedUsd: round(held?.investedUsd ?? 0, 2),
      pnlUsd: round(held?.pnlUsd ?? 0, 2),
      pnlPct: held?.investedUsd ? round((held.pnlUsd / held.investedUsd) * 100, 2) : null,
      positionIds: held?.positionIds ?? [],
      price: series.length ? round(series[series.length - 1], 4) : null,
      ret1w: pctChange(series, 5),
      ret1m: pctChange(series, 21),
      ret3m: pctChange(series, 63),
      ret6m: pctChange(series, 126),
      ret12m: pctChange(series, 252),
      vol30: annualizedVol(series, 30),
      maxDd12m: series.length > 60 ? maxDrawdown(series.slice(-252)) : null,
      rsi14: rsi(series, 14),
      vsSma50: distanceFromSma(series, 50),
      vsSma200: distanceFromSma(series, 200),
      momentum: momentumScore(series),
      corrSpy: symbol === 'SPY' ? 1 : correlation(dailyReturns(series), benchmarkReturns),
      maxWeight: meta.maxWeight,
    });
  }

  const instruments = [...bySymbol.values()];
  const investedWeight = instruments.reduce((sum, item) => sum + item.weight, 0);
  const cashWeight = round(Math.max(0, 1 - investedWeight), 4);

  const byClass = {};
  for (const item of instruments) {
    byClass[item.class] = round((byClass[item.class] ?? 0) + item.weight, 4);
  }
  byClass.cash = cashWeight;

  // È una scomposizione diretta dei ticker catalogati, non un look-through
  // delle partecipazioni interne agli ETF broad-market.
  const bySector = {};
  for (const item of instruments) {
    if (!item.sector || item.weight <= 0) continue;
    bySector[item.sector] = round((bySector[item.sector] ?? 0) + item.weight, 4);
  }

  const weights = instruments.map((item) => item.weight).filter((value) => value > 0);
  const herfindahl = round(weights.reduce((sum, value) => sum + value ** 2, 0), 4);

  const equitySeries = equityHistory.map((row) => Number(row.equity_usd)).filter(Number.isFinite);
  const portfolio = {
    equityUsd: round(snapshot.equityUsd, 2),
    cashUsd: round(snapshot.cashUsd, 2),
    investedUsd: round(snapshot.investedUsd, 2),
    unrealizedPnlUsd: round(instruments.reduce((sum, item) => sum + (item.pnlUsd ?? 0), 0), 2),
    openPositions: snapshot.positions.length,
    cashWeight,
    concentrationHhi: herfindahl,
    effectivePositions: herfindahl > 0 ? round(1 / herfindahl, 1) : null,
    equityRet1w: pctChange(equitySeries, 7),
    equityRet1m: pctChange(equitySeries, 30),
    equityMaxDd: equitySeries.length > 10 ? maxDrawdown(equitySeries) : null,
    executionScale: Number(snapshot.executionScale) > 0 ? round(snapshot.executionScale, 6) : 1,
    capitalSource: snapshot.source ?? 'account',
  };

  return {
    computedAt: Date.now(),
    budgetEur: config.budgetEur,
    eurUsd: external?.eurUsd?.rate ?? config.fallbackEurUsd,
    portfolio,
    allocationByClass: byClass,
    allocationBySector: bySector,
    instruments,
    regime: marketRegime(external),
    crypto: external?.crypto ?? null,
    news: {
      net: external?.news?.net ?? 0,
      positiveHits: external?.news?.positiveHits ?? 0,
      negativeHits: external?.news?.negativeHits ?? 0,
      top: (external?.news?.items ?? []).slice(0, 10).map((item) => ({ t: item.title, s: item.score, topic: item.topic })),
    },
    fundamentals: external?.fundamentals ?? [],
    sourceDiagnostics: external?.diagnostics ?? [],
  };
}

/**
 * Serializza le feature nel prompt più compatto possibile: tabella a larghezza
 * fissa invece di JSON, così il modello riceve ~5x meno token.
 */
export function renderFeaturesPrompt(features, config, { includeInstruments = true } = {}) {
  const lines = [];
  const p = features.portfolio;
  const capitalEur = p.equityUsd / features.eurUsd;
  const bandSize = capitalEur < 100 ? 25 : capitalEur < 1_000 ? 100 : 1_000;
  const bandFloor = Math.floor(capitalEur / bandSize) * bandSize;
  const bandCeil = bandFloor + bandSize;
  const investedPct = Math.max(0, 100 - features.allocationByClass.cash * 100);
  lines.push(`PORTAFOGLIO REALE GESTITO fascia_capitale=${bandFloor}-${bandCeil} EUR cash=${(features.allocationByClass.cash * 100).toFixed(1)}% investito=${investedPct.toFixed(1)}% posizioni=${p.openPositions}`);
  lines.push(`STORICO equity 1w=${p.equityRet1w ?? 'n/d'}% 1m=${p.equityRet1m ?? 'n/d'}% maxDD=${p.equityMaxDd ?? 'n/d'}% concentrazione_HHI=${p.concentrationHhi} pos_efficaci=${p.effectivePositions ?? 'n/d'}`);
  lines.push(`CLASSI ${Object.entries(features.allocationByClass).map(([key, value]) => `${key}=${(value * 100).toFixed(1)}%`).join(' ')}`);
  const sectorEntries = Object.entries(features.allocationBySector ?? {});
  if (sectorEntries.length) {
    lines.push(`SETTORI_DIRETTI ${sectorEntries.map(([key, value]) => `${key}=${(value * 100).toFixed(1)}%`).join(' ')} (ETF broad-market esclusi: no look-through)`);
  }

  const r = features.regime;
  lines.push(`REGIME ${r.label} (score ${r.score}) VIX=${r.vix ?? 'n/d'} SPX_vs_SMA200=${r.spxVsSma200 ?? 'n/d'}% SPX_vs_SMA50=${r.spxVsSma50 ?? 'n/d'}% curva_10y2y=${r.yieldCurveBp ?? 'n/d'}bp news_net=${r.newsNet}`);
  if (features.crypto?.global) {
    const g = features.crypto.global;
    const fg = features.crypto.fearGreed;
    lines.push(`CRYPTO mcap24h=${g.marketCapChange24hPct}% btc_dom=${g.btcDominancePct}% fear_greed=${fg?.value ?? 'n/d'} (${fg?.label ?? 'n/d'})`);
  }

  if (includeInstruments) {
    lines.push('');
    lines.push('STRUMENTI  settore        peso%  max%  1m%    3m%    12m%   vol30  RSI  vsSMA50  vsSMA200  mom   corrSPY  pnl%');
    for (const item of features.instruments) {
      const cell = (value, width, suffix = '') => `${value == null ? 'n/d' : value}${suffix}`.padEnd(width);
      lines.push([
        item.symbol.padEnd(10),
        String(item.sector ?? 'broad/altro').padEnd(14).slice(0, 14),
        cell((item.weight * 100).toFixed(1), 6),
        cell((item.maxWeight * 100).toFixed(0), 5),
        cell(item.ret1m, 6),
        cell(item.ret3m, 6),
        cell(item.ret12m, 6),
        cell(item.vol30, 6),
        cell(item.rsi14, 4),
        cell(item.vsSma50, 8),
        cell(item.vsSma200, 9),
        cell(item.momentum, 5),
        cell(item.corrSpy, 8),
        cell(item.pnlPct, 6),
      ].join(' '));
    }
  }

  if (features.news.top.length) {
    lines.push('');
    lines.push(`NOTIZIE (sentiment lessicale net=${features.news.net}, +${features.news.positiveHits}/-${features.news.negativeHits})`);
    for (const item of features.news.top) {
      lines.push(`- [${item.topic}${item.s ? ` ${item.s > 0 ? '+' : ''}${item.s}` : ''}] ${item.t}`);
    }
  }

  lines.push('');
  lines.push(`VINCOLI fascia_capitale=${bandFloor}-${bandCeil} EUR posizioni_min=${config.minHoldings} posizioni_preferite=${config.preferredHoldings ?? config.minHoldings} posizioni_max=${config.maxHoldings} cash_min=${(config.minCashPct * 100).toFixed(0)}% cash_max=${(config.maxCashPct * 100).toFixed(0)}% turnover_ribilanciamenti=${(config.maxTurnoverPct * 100).toFixed(0)}% ordini_max=${config.maxOrdersPerRun} banda_minima=${(config.minRebalanceBandAbs * 100).toFixed(0)}%`);
  lines.push(`PROFILO ${config.riskProfile}`);
  return lines.join('\n');
}
