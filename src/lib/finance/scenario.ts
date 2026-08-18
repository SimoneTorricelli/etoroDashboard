export interface LogReturnStats {
  meanLog: number;
  volatilityLog: number;
  observations: number;
  annualizedMedianPct: number;
}

export interface ProjectedPercentiles {
  p10: number;
  p50: number;
  p90: number;
  p10ChangePct: number;
  p50ChangePct: number;
  p90ChangePct: number;
  tradingDays: number;
}

const P10_Z = 1.2815515655;

/** Statistiche giornaliere sui log-rendimenti, con estremi limitati al 5°/95° percentile. */
export function logReturnStats(values: number[]): LogReturnStats | null {
  const returns: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  if (returns.length < 19) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.05)];
  const high = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95))];
  const cleaned = returns.map((value) => Math.max(low, Math.min(high, value)));
  const meanLog = cleaned.reduce((sum, value) => sum + value, 0) / cleaned.length;
  const variance = cleaned.reduce((sum, value) => sum + (value - meanLog) ** 2, 0) / Math.max(1, cleaned.length - 1);
  return {
    meanLog,
    volatilityLog: Math.sqrt(variance),
    observations: cleaned.length,
    annualizedMedianPct: (Math.exp(meanLog * 252) - 1) * 100,
  };
}

/** Percentili lognormali: 21 sedute medie per mese, senza versamenti o ribilanciamenti. */
export function projectPercentiles(base: number, stats: Pick<LogReturnStats, 'meanLog' | 'volatilityLog'>, months: number): ProjectedPercentiles {
  const tradingDays = Math.max(1, Math.round(months * 21));
  const medianLog = stats.meanLog * tradingDays;
  const dispersion = stats.volatilityLog * Math.sqrt(tradingDays) * P10_Z;
  const p10 = base * Math.exp(medianLog - dispersion);
  const p50 = base * Math.exp(medianLog);
  const p90 = base * Math.exp(medianLog + dispersion);
  const change = (value: number) => base > 0 ? ((value / base) - 1) * 100 : 0;
  return {
    p10,
    p50,
    p90,
    p10ChangePct: change(p10),
    p50ChangePct: change(p50),
    p90ChangePct: change(p90),
    tradingDays,
  };
}
