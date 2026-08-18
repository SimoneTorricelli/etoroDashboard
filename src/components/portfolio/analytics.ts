/**
 * analytics.ts — logica pura della pagina Portfolio:
 * arricchimento posizioni, allocazioni, score di diversificazione,
 * P&L mensile e generazione dei suggerimenti di ribilanciamento.
 */
import type { AssetClass, EquityPoint, Portfolio, Position } from '@/lib/data/types';

/* ── Etichette ─────────────────────────────────────────────────────── */

export const CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Azioni',
  etf: 'ETF',
  crypto: 'Crypto',
  fx: 'Valute',
  index: 'Indici',
  cfd: 'CFD',
};

export function sectorFor(p: Position): string {
  if (p.sector) return p.sector;
  if (p.assetClass === 'etf') return 'ETF / Fondi';
  if (p.assetClass === 'crypto') return 'Criptovalute';
  if (p.assetClass !== 'stock') return CLASS_LABELS[p.assetClass] ?? 'Altro';
  return 'Non classificato';
}

/** Geografia derivata dalla valuta di quotazione. */
export function geoFor(currency: string, country?: string): string {
  if (country) return country;
  switch (currency) {
    case 'USD': return 'Nord America';
    case 'EUR': return 'Europa';
    case 'GBP': return 'Regno Unito';
    case 'CHF': return 'Svizzera';
    case 'JPY': return 'Giappone';
    default: return 'Non classificato';
  }
}

/* ── Posizioni arricchite ──────────────────────────────────────────── */

export interface PositionRow extends Position {
  /** Prezzo corrente (fallback: prezzo di apertura). */
  price: number;
  /** Valore corrente in valuta conto (USD). */
  value: number;
  /** Peso sul valore totale del portafoglio (cash incluso), 0–1. */
  weight: number;
  /** P&L in USD. */
  pnlUsd: number;
  /** P&L % sull'investito. */
  pnlPctValue: number;
  sector: string;
  geo: string;
}

export function enrichPositions(portfolio: Portfolio): PositionRow[] {
  return portfolio.positions.map((p) => {
    const price = p.currentPrice ?? p.openPrice;
    const value = p.currentValue ?? p.units * price * p.leverage;
    const pnlUsd = p.pnl ?? value - p.invested - p.fees;
    return {
      ...p,
      price,
      value,
      weight: portfolio.totalValue > 0 ? value / portfolio.totalValue : 0,
      pnlUsd,
      pnlPctValue: p.pnlPct ?? (p.invested > 0 ? (pnlUsd / p.invested) * 100 : 0),
      sector: sectorFor(p),
      geo: geoFor(p.currency, p.country),
    };
  });
}

/**
 * Vista look-through: include le posizioni manuali e scompone ogni copy
 * portfolio nelle esposizioni sottostanti, poi unisce i duplicati per strumento.
 */
export function enrichLookThroughPositions(portfolio: Portfolio): PositionRow[] {
  const raw: Position[] = portfolio.positions.map((position) => ({ ...position, source: 'manual' }));
  for (const copy of portfolio.copyPortfolios ?? []) {
    const baseValues = copy.positions.map((position) => position.currentValue ?? Math.max(0, position.invested + (position.pnl ?? 0)));
    const baseTotal = baseValues.reduce((sum, value) => sum + value, 0);
    if (baseTotal <= 0) continue;
    const liveExposure = Math.max(0, copy.value - copy.availableCash);
    const scale = liveExposure / baseTotal;
    copy.positions.forEach((position, index) => {
      const value = baseValues[index] * scale;
      const invested = position.invested * scale;
      const pnl = (position.pnl ?? value - position.invested) * scale;
      raw.push({
        ...position,
        positionId: position.positionId,
        currentValue: value,
        invested,
        pnl,
        pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
        source: 'copy',
        copyId: copy.copyId,
      });
    });
  }
  const rows = enrichPositions({ ...portfolio, positions: raw });
  const grouped = new Map<number, PositionRow>();
  for (const row of rows) {
    const existing = grouped.get(row.instrumentId);
    if (!existing) {
      grouped.set(row.instrumentId, { ...row });
      continue;
    }
    const totalInvested = existing.invested + row.invested;
    existing.units += row.units;
    existing.value += row.value;
    existing.currentValue = existing.value;
    existing.pnlUsd += row.pnlUsd;
    existing.pnl = existing.pnlUsd;
    existing.invested = totalInvested;
    existing.openPrice = totalInvested > 0
      ? ((existing.openPrice * (totalInvested - row.invested)) + row.openPrice * row.invested) / totalInvested
      : existing.openPrice;
    existing.weight = portfolio.totalValue > 0 ? existing.value / portfolio.totalValue : 0;
    existing.pnlPctValue = totalInvested > 0 ? (existing.pnlUsd / totalInvested) * 100 : 0;
  }
  return [...grouped.values()].sort((a, b) => b.value - a.value);
}

/* ── Allocazioni ───────────────────────────────────────────────────── */

export interface AllocationSlice {
  key: string;
  label: string;
  /** Valore in USD. */
  value: number;
  /** Peso 0–1 sul totale. */
  weight: number;
}

export function allocate(
  rows: PositionRow[],
  keyOf: (r: PositionRow) => string,
  labelOf: (key: string) => string,
  total: number,
  extra?: AllocationSlice[],
): AllocationSlice[] {
  const map = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const r of rows) {
    const key = keyOf(r);
    map.set(key, (map.get(key) ?? 0) + r.value);
    labels.set(key, labelOf(key));
  }
  for (const item of extra ?? []) {
    map.set(item.key, (map.get(item.key) ?? 0) + item.value);
    if (!labels.has(item.key)) labels.set(item.key, item.label);
  }
  const slices: AllocationSlice[] = [...map.entries()].map(([key, value]) => ({
    key,
    label: labels.get(key) ?? labelOf(key),
    value,
    weight: total > 0 ? value / total : 0,
  }));
  return slices.sort((a, b) => b.value - a.value);
}

/* ── Score di diversificazione ─────────────────────────────────────── */

export interface SubScore {
  key: string;
  label: string;
  /** 0–100. */
  score: number;
}

export interface DiversificationScore {
  total: number;
  subs: SubScore[];
  formulaVersion: string;
  classifiedCoveragePct: number;
  factors: string[];
}

/** Herfindahl-Hirschman Index su pesi (somma = 1). */
function hhi(weights: number[]): number {
  return weights.reduce((s, w) => s + w * w, 0);
}

/**
 * Score da distribuzione categorica: numero effettivo di categorie
 * (1/HHI) rapportato a un target "ben diversificato".
 */
function distributionScore(weights: number[], targetCount: number): number {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || sum <= 0) return 0;
  /* Normalizza: i pesi passati possono non sommare a 1 (es. settori senza cash). */
  const h = hhi(weights.map((w) => w / sum));
  if (h >= 1) return 0;
  const effectiveN = 1 / h;
  const raw = ((effectiveN - 1) / (targetCount - 1)) * 100;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

export function computeDiversification(rows: PositionRow[], cash: number, totalValue: number, copyValue = 0): DiversificationScore {
  const invested = rows.reduce((s, r) => s + r.value, 0) + copyValue;
  const cashWeight = totalValue > 0 ? cash / totalValue : 0;
  const copySlice = copyValue > 0 ? [{ key: 'copy', label: 'Copy trading', value: copyValue, weight: copyValue / Math.max(totalValue, 1) }] : [];

  const classW = allocate(rows, (r) => r.assetClass, (k) => k, totalValue,
    [
      ...(cash > 0 ? [{ key: 'cash', label: 'Cash', value: cash, weight: cashWeight }] : []),
      ...copySlice,
    ])
    .map((s) => s.weight);
  const sectorW = allocate(rows, (r) => r.sector, (k) => k, totalValue, copySlice.map((s) => ({ ...s, key: 'Copy trading' }))).map((s) => s.weight);
  const geoW = allocate(rows, (r) => r.geo, (k) => k, totalValue, copyValue > 0 ? [{ key: 'copy-geo', label: 'Copy trading', value: copyValue, weight: copyValue / Math.max(totalValue, 1) }] : []).map((s) => s.weight);
  const curW = allocate(rows, (r) => r.currency, (k) => k, totalValue,
    [
      ...(cash > 0 ? [{ key: 'USD', label: 'USD', value: cash, weight: cashWeight }] : []),
      ...(copyValue > 0 ? [{ key: 'USD-copy', label: 'USD copy', value: copyValue, weight: copyValue / Math.max(totalValue, 1) }] : []),
    ])
    .map((s) => s.weight);
  const posW = [...rows.map((r) => (invested > 0 ? r.value / invested : 0)), ...(copyValue > 0 ? [copyValue / invested] : [])];

  const classScore = distributionScore(classW, 4);
  const sectorScore = distributionScore(sectorW, 6);
  const geoScore = distributionScore(geoW, 4);
  const curScore = distributionScore(curW, 3);
  /* Concentrazione: HHI sulle singole posizioni (target ~12 posizioni uguali). */
  const h = hhi(posW);
  const concScore = posW.length <= 1
    ? 0
    : Math.round(Math.max(0, Math.min(100, ((1 - h) / (1 - 1 / 12)) * 100)));

  const subs: SubScore[] = [
    { key: 'class', label: 'Asset class', score: classScore },
    { key: 'sector', label: 'Settori', score: sectorScore },
    { key: 'geo', label: 'Geografia', score: geoScore },
    { key: 'currency', label: 'Valuta', score: curScore },
    { key: 'conc', label: 'Concentrazione', score: concScore },
  ];
  const total = Math.round(subs.reduce((s, x) => s + x.score, 0) / subs.length);
  const classified = rows.filter((row) => row.sector !== 'Non classificato').reduce((sum, row) => sum + row.value, 0);
  const classifiedCoveragePct = invested > 0 ? Math.round((classified / invested) * 100) : 0;
  const factors = [...subs].sort((a, b) => a.score - b.score).slice(0, 3).map((sub) => `${sub.label}: ${sub.score}/100`);
  return { total, subs, formulaVersion: 'TOR-DIV-2.0', classifiedCoveragePct, factors };
}

/* ── P&L mensile (heatmap) ─────────────────────────────────────────── */

export interface MonthPnl {
  key: string;
  /** Etichetta breve, es. "ago 25". */
  label: string;
  /** P&L del mese in USD. */
  pnl: number;
  /** P&L % sul valore a inizio mese. */
  pct: number;
}

export function monthlyPnl(history: EquityPoint[], months = 12): MonthPnl[] {
  const buckets = new Map<string, { first: number; last: number; label: string }>();
  for (const pt of history) {
    const d = new Date(pt.time * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    const label = d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
    const b = buckets.get(key);
    if (!b) buckets.set(key, { first: pt.value, last: pt.value, label });
    else b.last = pt.value;
  }
  return [...buckets.entries()].slice(-months).map(([key, b]) => ({
    key,
    label: b.label,
    pnl: b.last - b.first,
    pct: b.first > 0 ? ((b.last - b.first) / b.first) * 100 : 0,
  }));
}

/* ── Suggerimenti di ribilanciamento ───────────────────────────────── */

export type Severity = 'alta' | 'media' | 'bassa';

export interface Suggestion {
  id: string;
  severity: Severity;
  title: string;
  /** Motivazione con numeri reali (contiene {placeholders} già risolti). */
  rationale: string;
  ctaLabel: string;
  ctaHref: string;
}

export interface SuggestionInput {
  rows: PositionRow[];
  totalValue: number;
  cash: number;
  usdExposure: number;
  usdExposurePct: number;
  score: DiversificationScore;
  fmt: (usd: number) => string;
  fmtPct: (w: number) => string;
}

export function buildSuggestions(input: SuggestionInput): Suggestion[] {
  const { rows, totalValue, usdExposurePct, fmt, fmtPct } = input;
  const out: Suggestion[] = [];
  if (rows.length === 0 || totalValue <= 0) return out;

  /* 1. Settore sopra soglia 25% */
  const sectors = allocate(rows, (r) => r.sector, (k) => k, totalValue);
  const topSector = sectors[0];
  if (topSector && topSector.weight > 0.25 && topSector.key !== 'ETF / Fondi') {
    const inSector = rows.filter((r) => r.sector === topSector.key).sort((a, b) => b.value - a.value);
    const top = inSector[0];
    const excess = (topSector.weight - 0.2) * totalValue;
    const unitsToSell = Math.max(1, Math.floor(excess / top.price));
    const freed = Math.min(unitsToSell * top.price, top.value);
    const newWeight = Math.max(0, topSector.weight - freed / totalValue);
    out.push({
      id: 'sector-trim',
      severity: 'alta',
      title: `Riduci la concentrazione in ${topSector.label}`,
      rationale: `Vendendo ${unitsToSell} unità di ${top.symbol} riduci il peso di ${topSector.label} dal ${fmtPct(topSector.weight)} al ${fmtPct(newWeight)} e liberi ~${fmt(freed)}.`,
      ctaLabel: 'Ribilancia',
      ctaHref: '/mercati',
    });
  }

  /* 2. Singola posizione dominante > 15% */
  const topPos = [...rows].sort((a, b) => b.weight - a.weight)[0];
  if (topPos && topPos.weight > 0.15) {
    out.push({
      id: 'single-name',
      severity: 'alta',
      title: `${topPos.symbol} pesa troppo sul portafoglio`,
      rationale: `${topPos.name} vale ${fmt(topPos.value)} (${fmtPct(topPos.weight)} del totale). Portare il peso sotto il 10% significa ridurre l'esposizione di ~${fmt((topPos.weight - 0.1) * totalValue)}.`,
      ctaLabel: 'Ribilancia',
      ctaHref: '/mercati',
    });
  }

  /* 3. Esposizione USD elevata */
  if (usdExposurePct > 0.65) {
    out.push({
      id: 'usd-exposure',
      severity: 'media',
      title: 'Esposizione al dollaro sopra il 65%',
      rationale: `Il ${fmtPct(usdExposurePct)} del portafoglio è in USD: un movimento del 5% in EUR/USD vale ~${fmt(usdExposurePct * totalValue * 0.05)}. Valuta una conversione parziale o una soglia di prelievo.`,
      ctaLabel: 'Vai a FX',
      ctaHref: '/fx',
    });
  }

  /* 4. Posizioni senza stop-loss */
  const unprotected = rows.filter((r) => r.stopLossRate == null);
  if (unprotected.length > 0) {
    const atRisk = unprotected.reduce((s, r) => s + r.value, 0);
    out.push({
      id: 'no-stop',
      severity: 'media',
      title: `${unprotected.length} posizioni senza stop-loss`,
      rationale: `${unprotected.map((r) => r.symbol).slice(0, 4).join(', ')}${unprotected.length > 4 ? '…' : ''} non hanno protezione: ${fmt(atRisk)} esposti senza limite di perdita automatico.`,
      ctaLabel: 'Crea regola',
      ctaHref: '/agent',
    });
  }

  /* 5. Peso ETF basso → accumulo */
  const etfWeight = rows.filter((r) => r.assetClass === 'etf').reduce((s, r) => s + r.weight, 0);
  if (etfWeight < 0.2) {
    out.push({
      id: 'etf-accumulation',
      severity: 'bassa',
      title: 'Aumenta la quota di ETF a accumulo',
      rationale: `Gli ETF pesano solo il ${fmtPct(etfWeight)}: una regola di accumulo mensile (es. ${fmt(Math.max(100, totalValue * 0.02))}/mese su un ETF mondiale) ridurrebbe la volatilità complessiva.`,
      ctaLabel: 'Crea regola',
      ctaHref: '/agent',
    });
  }

  /* 6. Crypto sopra il 15% */
  const cryptoWeight = rows.filter((r) => r.assetClass === 'crypto').reduce((s, r) => s + r.weight, 0);
  if (cryptoWeight > 0.15) {
    out.push({
      id: 'crypto-weight',
      severity: 'media',
      title: 'Quota crypto sopra il 15%',
      rationale: `Le criptovalute pesano il ${fmtPct(cryptoWeight)} (${fmt(cryptoWeight * totalValue)}): asset ad alta volatilità. Considera di fissare un tetto e prendere profitto parziale.`,
      ctaLabel: 'Ribilancia',
      ctaHref: '/mercati',
    });
  }

  const order: Record<Severity, number> = { alta: 0, media: 1, bassa: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 4);
}
