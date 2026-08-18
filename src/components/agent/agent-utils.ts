/**
 * Utilità condivise della pagina Agent:
 * - persistenza "sidecar" su localStorage per i dati non coperti dai tipi
 *   dell'engine (SL/TP per regola, strumenti assegnati ai gruppi, presa
 *   visione auto-esecuzione);
 * - descrizioni in italiano delle condizioni;
 * - backtest-lite: simula una regola sulle candele storiche.
 */
import { computeRsi } from '@/lib/agent/engine';
import type { AgentCondition, AgentRule, Candle } from '@/lib/data/types';

export const AUTO_ACK_KEY = 'torino.agent.autoAck.v1';
const SLTP_KEY = 'torino.agent.sltp.v1';
const GROUP_META_KEY = 'torino.agent.groupMeta.v1';

/* ── SL/TP per regola (sidecar — AgentRule non ha campi SL/TP) ────── */
export interface SlTp {
  stopLossPct: number;
  takeProfitPct: number;
}

export const DEFAULT_SLTP: SlTp = { stopLossPct: 8, takeProfitPct: 15 };

export function loadSlTpMap(): Record<string, SlTp> {
  try {
    const raw = localStorage.getItem(SLTP_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SlTp>) : {};
  } catch {
    return {};
  }
}

export function saveSlTpMap(map: Record<string, SlTp>): void {
  try {
    localStorage.setItem(SLTP_KEY, JSON.stringify(map));
  } catch {
    /* ignora */
  }
}

/* ── Strumenti assegnati ai gruppi (sidecar) ───────────────────────── */
export function loadGroupMeta(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(GROUP_META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

export function saveGroupMeta(meta: Record<string, number[]>): void {
  try {
    localStorage.setItem(GROUP_META_KEY, JSON.stringify(meta));
  } catch {
    /* ignora */
  }
}

/* ── Presa visione auto-esecuzione ─────────────────────────────────── */
export function hasAutoAck(): boolean {
  try {
    return localStorage.getItem(AUTO_ACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAutoAck(): void {
  try {
    localStorage.setItem(AUTO_ACK_KEY, '1');
  } catch {
    /* ignora */
  }
}

/* ── Descrizioni condizioni ────────────────────────────────────────── */
export function conditionChip(c: AgentCondition): string {
  switch (c.type) {
    case 'drop_from_avg':
      return `−${c.value}% da media ${c.windowDays ?? 20}g`;
    case 'daily_drop':
      return `giornata ≤ −${c.value}%`;
    case 'price_below':
      return `prezzo < ${c.value}`;
    case 'price_above':
      return `prezzo > ${c.value}`;
    case 'rsi_below':
      return `RSI(14) < ${c.value}`;
  }
}

/** Frase in italiano corrente per il riepilogo del wizard. */
export function conditionSentence(c: AgentCondition, symbols: string): string {
  switch (c.type) {
    case 'drop_from_avg':
      return `se ${symbols} scende del ${c.value}% rispetto alla media a ${c.windowDays ?? 20} giorni`;
    case 'daily_drop':
      return `se ${symbols} perde almeno il ${c.value}% rispetto alla chiusura precedente`;
    case 'price_below':
      return `se il prezzo di ${symbols} scende sotto ${c.value}`;
    case 'price_above':
      return `se il prezzo di ${symbols} sale sopra ${c.value}`;
    case 'rsi_below':
      return `se l'RSI a 14 giorni di ${symbols} scende sotto ${c.value}`;
  }
}

/* ── Backtest-lite ─────────────────────────────────────────────────── */
export interface BacktestResult {
  orders: number;
  wins: number;
  losses: number;
  /** P&L totale simulato (stessa valuta dell'importo regola, USD). */
  pnl: number;
  investedTotal: number;
  maxDrawdownPct: number;
  volatilityPct: number;
  sharpe: number | null;
  estimatedCosts: number;
  /** P&L cumulato nel tempo (unix seconds → USD). */
  equity: { time: number; value: number }[];
  /** Baseline buy & hold dello stesso capitale. */
  buyHold: { time: number; value: number }[];
}

interface OpenPos {
  entryPrice: number;
  amount: number;
  entryIdx: number;
}

/**
 * Simula la regola giorno per giorno sulle candele di ogni strumento.
 * Un trigger apre una posizione da `action.amount` USD; la posizione
 * chiude a SL/TP (sui prezzi di chiusura) o resta mark-to-market.
 * Max una posizione aperta per strumento; rispetta cooldown e limite
 * di capitale del gruppo (approssimato sul capitale simultaneo).
 */
export function runBacktest(
  rule: AgentRule,
  sltp: SlTp,
  candlesByInstrument: Map<number, Candle[]>,
  capitalLimit: number,
  costs: { feeBps: number; slippageBps: number } = { feeBps: 5, slippageBps: 5 },
): BacktestResult {
  const cooldownDays = Math.max(1, Math.ceil(rule.cooldownMinutes / 1440));
  const sl = sltp.stopLossPct / 100;
  const tp = sltp.takeProfitPct / 100;

  let orders = 0;
  let wins = 0;
  let losses = 0;
  let closedPnl = 0;
  // P&L giornaliero per strumento: time → pnl cumulato dello strumento
  const perInstSeries = new Map<number, Map<number, number>>();
  const buyHoldSeries = new Map<number, Map<number, number>>();
  let deployedPeak = 0;
  let estimatedCosts = 0;
  const costRate = (costs.feeBps + costs.slippageBps) / 10_000;

  for (const [iid, candles] of candlesByInstrument) {
    if (candles.length < 30) continue;
    const closes = candles.map((c) => c.close);
    const series = new Map<number, number>();
    const bh = new Map<number, number>();
    let pos: OpenPos | null = null;
    let instPnl = 0;
    let lastTriggerIdx = -cooldownDays;
    let deployed = 0;
    const bhAmount = rule.action.amount;
    const bhEntry = closes[0];

    for (let i = 20; i < candles.length; i++) {
      const price = closes[i];
      const t = candles[i].time;

      // Gestione posizione aperta: SL/TP sui close
      if (pos) {
        const ret = (price - pos.entryPrice) / pos.entryPrice;
        if (ret >= tp || ret <= -sl) {
          const tradeCost = pos.amount * costRate * 2;
          const pnl = pos.amount * ret - tradeCost;
          estimatedCosts += tradeCost;
          instPnl += pnl;
          closedPnl += pnl;
          deployed = Math.max(0, deployed - pos.amount);
          if (pnl >= 0) wins += 1; else losses += 1;
          pos = null;
        }
      }

      // Valutazione trigger (solo se nessuna posizione aperta sullo strumento)
      if (!pos && i - lastTriggerIdx >= cooldownDays) {
        const hist = closes.slice(0, i + 1);
        if (conditionMetOnHistory(rule.condition, hist) && deployed + rule.action.amount <= capitalLimit) {
          pos = { entryPrice: price, amount: rule.action.amount, entryIdx: i };
          lastTriggerIdx = i;
          orders += 1;
          deployed += rule.action.amount;
          if (deployed > deployedPeak) deployedPeak = deployed;
        }
      }
      const mtm = pos ? pos.amount * ((price - pos.entryPrice) / pos.entryPrice) : 0;
      series.set(t, instPnl + mtm);
      bh.set(t, bhAmount * ((price - bhEntry) / bhEntry));
    }
    perInstSeries.set(iid, series);
    buyHoldSeries.set(iid, bh);
  }

  // Unisci le serie temporali (carry-forward per strumento)
  const allTimes = new Set<number>();
  for (const s of perInstSeries.values()) for (const t of s.keys()) allTimes.add(t);
  const times = [...allTimes].sort((a, b) => a - b);

  const equity: { time: number; value: number }[] = [];
  const buyHold: { time: number; value: number }[] = [];
  const lastEq = new Map<number, number>();
  const lastBh = new Map<number, number>();
  let peak = 0;
  let maxDrawdownPct = 0;

  for (const t of times) {
    let eq = 0;
    let bhv = 0;
    for (const [iid, s] of perInstSeries) {
      const v = s.get(t);
      if (v != null) lastEq.set(iid, v);
      eq += lastEq.get(iid) ?? 0;
    }
    for (const [iid, s] of buyHoldSeries) {
      const v = s.get(t);
      if (v != null) lastBh.set(iid, v);
      bhv += lastBh.get(iid) ?? 0;
    }
    equity.push({ time: t, value: eq });
    buyHold.push({ time: t, value: bhv });
    if (eq > peak) peak = eq;
    const base = Math.max(Math.abs(peak), deployedPeak, 1);
    const dd = ((peak - eq) / base) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const dailyReturns: number[] = [];
  for (let index = 1; index < equity.length; index += 1) dailyReturns.push((equity[index].value - equity[index - 1].value) / Math.max(capitalLimit, 1));
  const meanReturn = dailyReturns.length ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length : 0;
  const variance = dailyReturns.length > 1 ? dailyReturns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (dailyReturns.length - 1) : 0;
  const dailyVol = Math.sqrt(variance);
  const volatilityPct = dailyVol * Math.sqrt(252) * 100;
  const sharpe = dailyVol > 0 ? (meanReturn / dailyVol) * Math.sqrt(252) : null;

  return {
    orders,
    wins,
    losses,
    pnl: equity.length ? equity[equity.length - 1].value : closedPnl,
    investedTotal: deployedPeak,
    maxDrawdownPct,
    volatilityPct,
    sharpe,
    estimatedCosts,
    equity,
    buyHold,
  };
}

/** Valuta la condizione su una serie di close (ultimo = più recente). */
function conditionMetOnHistory(c: AgentCondition, closes: number[]): boolean {
  const price = closes[closes.length - 1];
  switch (c.type) {
    case 'price_below':
      return price < c.value;
    case 'price_above':
      return price > c.value;
    case 'daily_drop': {
      const previous = closes[closes.length - 2];
      return previous > 0 && ((previous - price) / previous) * 100 >= c.value;
    }
    case 'drop_from_avg': {
      const w = Math.min(c.windowDays ?? 20, closes.length - 1);
      if (w < 5) return false;
      const slice = closes.slice(-w - 1, -1);
      const avg = slice.reduce((s, p) => s + p, 0) / slice.length;
      return ((avg - price) / avg) * 100 >= c.value;
    }
    case 'rsi_below': {
      const rsi = computeRsi(closes.slice(-15));
      return rsi != null && rsi < c.value;
    }
  }
}
