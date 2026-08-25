import { checkChurnRules, filterMarginalSubstitutions, isWorthTheCost } from './churn.js';

/**
 * Livello deterministico con diritto di veto. Trasforma la proposta dell'LLM in
 * un piano di ordini eseguibile, oppure la blocca.
 *
 * Nessuna regola qui è aggirabile dal modello: se una proposta viola un
 * guardrail viene ridotta (clamp) o l'intera run viene bloccata.
 */

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function violation(code, message, severity = 'blocking', data) {
  return { code, message, severity, data };
}

/** Riduce i pesi entro i limiti per strumento e per classe, poi rinormalizza. */
export function clampWeights(targetWeights, features, config, violations) {
  const bySymbol = new Map(features.instruments.map((item) => [item.symbol, item]));
  const weights = { ...targetWeights };

  for (const [symbol, weight] of Object.entries(weights)) {
    if (symbol === 'CASH') continue;
    const meta = bySymbol.get(symbol);
    const cap = meta?.maxWeight ?? 0;
    if (weight > cap) {
      violations.push(violation('symbol_cap', `${symbol}: peso ${(weight * 100).toFixed(1)}% ridotto al massimo ${(cap * 100).toFixed(0)}%`, 'clamped'));
      weights[symbol] = cap;
    }
  }

  const classCaps = config.maxWeightPerClass ?? {};
  const classTotals = {};
  for (const [symbol, weight] of Object.entries(weights)) {
    if (symbol === 'CASH') continue;
    const klass = bySymbol.get(symbol)?.class ?? 'other';
    classTotals[klass] = (classTotals[klass] ?? 0) + weight;
  }
  for (const [klass, total] of Object.entries(classTotals)) {
    const cap = classCaps[klass];
    if (cap == null || total <= cap || total === 0) continue;
    const factor = cap / total;
    violations.push(violation('class_cap', `classe ${klass}: ${(total * 100).toFixed(1)}% ridotta a ${(cap * 100).toFixed(0)}%`, 'clamped'));
    for (const [symbol, weight] of Object.entries(weights)) {
      if (symbol !== 'CASH' && (bySymbol.get(symbol)?.class ?? 'other') === klass) weights[symbol] = weight * factor;
    }
  }

  const invested = Object.entries(weights).reduce((sum, [symbol, weight]) => sum + (symbol === 'CASH' ? 0 : weight), 0);
  let cash = round(1 - invested, 4);

  if (cash < config.minCashPct) {
    const deficit = config.minCashPct - cash;
    violations.push(violation('cash_floor', `cash ${(cash * 100).toFixed(1)}% sotto il minimo ${(config.minCashPct * 100).toFixed(0)}%: posizioni ridotte`, 'clamped'));
    const factor = invested > 0 ? (invested - deficit) / invested : 0;
    for (const symbol of Object.keys(weights)) {
      if (symbol !== 'CASH') weights[symbol] *= factor;
    }
    cash = config.minCashPct;
  }
  if (cash > config.maxCashPct) {
    // Prova a usare la capacità residua dei simboli già proposti senza
    // inventare nuovi titoli. Se i cap rendono impossibile il deployment,
    // il piano viene bloccato invece di lasciare cassa non intenzionale.
    let excess = cash - config.maxCashPct;
    const classCurrent = {};
    for (const [symbol, weight] of Object.entries(weights)) {
      if (symbol === 'CASH') continue;
      const klass = bySymbol.get(symbol)?.class ?? 'other';
      classCurrent[klass] = (classCurrent[klass] ?? 0) + weight;
    }
    for (let pass = 0; pass < 4 && excess > 0.0001; pass += 1) {
      const capacities = Object.entries(weights)
        .filter(([symbol]) => symbol !== 'CASH')
        .map(([symbol, weight]) => {
          const meta = bySymbol.get(symbol);
          const klass = meta?.class ?? 'other';
          const symbolRoom = Math.max(0, (meta?.maxWeight ?? 0) - weight);
          const classRoom = Math.max(0, (classCaps[klass] ?? 1) - (classCurrent[klass] ?? 0));
          return { symbol, klass, room: Math.min(symbolRoom, classRoom) };
        })
        .filter((item) => item.room > 0.0001);
      if (!capacities.length) break;
      const share = excess / capacities.length;
      let filled = 0;
      for (const item of capacities) {
        const addition = Math.min(item.room, share);
        weights[item.symbol] += addition;
        classCurrent[item.klass] = (classCurrent[item.klass] ?? 0) + addition;
        filled += addition;
      }
      if (filled <= 0.0001) break;
      excess -= filled;
    }
    cash = round(1 - Object.entries(weights).reduce((sum, [symbol, weight]) => sum + (symbol === 'CASH' ? 0 : weight), 0), 4);
    if (cash > config.maxCashPct + 0.0001) {
      violations.push(violation('cash_ceiling', `cash ${(cash * 100).toFixed(1)}% sopra il massimo ${(config.maxCashPct * 100).toFixed(0)}%: capacità insufficiente entro i cap`));
    } else {
      violations.push(violation('cash_deployed', `cassa eccedente riallocata entro i cap; target ${(cash * 100).toFixed(1)}%`, 'clamped'));
    }
  }

  weights.CASH = round(cash, 4);
  for (const key of Object.keys(weights)) weights[key] = round(weights[key], 4);
  return weights;
}

/**
 * @returns {{ok: boolean, violations: Array, plan: object}}
 */
export function validateProposal({ proposal, features, config, ordersToday = 0, ledger = new Map(), scores = new Map() }) {
  const violations = [];
  const equityUsd = features.portfolio.equityUsd;
  const bySymbol = new Map(features.instruments.map((item) => [item.symbol, item]));

  if (config.frozen) violations.push(violation('frozen', `agente congelato: ${config.frozenReason || 'freeze manuale'}`));
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) violations.push(violation('no_equity', 'equity del portafoglio non disponibile'));
  if (proposal.confidence < config.minConfidence) {
    violations.push(violation('low_confidence', `confidence ${proposal.confidence.toFixed(2)} sotto la soglia ${config.minConfidence}`));
  }
  if (ordersToday >= config.maxOrdersPerDay) {
    violations.push(violation('daily_order_cap', `raggiunto il limite di ${config.maxOrdersPerDay} ordini nelle ultime 24h`));
  }

  let targets = clampWeights(proposal.targetWeights, features, config, violations);

  // Numero massimo di posizioni: si tengono i pesi più alti, il resto va a cassa.
  const invested = Object.entries(targets).filter(([symbol, weight]) => symbol !== 'CASH' && weight > 0.001);
  if (config.maxHoldings && invested.length > config.maxHoldings) {
    const keep = invested.sort((a, b) => b[1] - a[1]).slice(0, config.maxHoldings);
    const dropped = invested.slice(config.maxHoldings).map(([symbol]) => symbol);
    violations.push(violation('max_holdings', `proposti ${invested.length} strumenti, il profilo ne ammette ${config.maxHoldings}: esclusi ${dropped.join(', ')}`, 'clamped'));
    const kept = Object.fromEntries(keep);
    const total = keep.reduce((sum, [, weight]) => sum + weight, 0);
    const cashTarget = round(1 - total, 4);
    targets = { ...kept, CASH: Math.max(cashTarget, config.minCashPct) };
  }
  const targetPositionCount = Object.entries(targets)
    .filter(([symbol, weight]) => symbol !== 'CASH' && weight > 0.001)
    .length;
  if (config.minHoldings && targetPositionCount < config.minHoldings) {
    violations.push(violation(
      'min_holdings',
      `proposti ${targetPositionCount} strumenti, sotto il minimo di diversificazione ${config.minHoldings}`,
    ));
  }

  const deltas = [];
  for (const item of features.instruments) {
    const target = targets[item.symbol] ?? 0;
    const current = item.weight ?? 0;
    const deltaAbs = target - current;
    const deltaRel = current > 0.0001 ? Math.abs(deltaAbs) / current : Math.abs(deltaAbs) > 0 ? 1 : 0;
    const withinBand = Math.abs(deltaAbs) < config.minRebalanceBandAbs && deltaRel < config.minRebalanceBandRel;
    deltas.push({
      symbol: item.symbol,
      instrumentId: item.instrumentId,
      class: item.class,
      currentWeight: current,
      targetWeight: target,
      deltaWeight: round(deltaAbs, 4),
      deltaUsd: round(deltaAbs * equityUsd, 2),
      positionIds: item.positionIds,
      currentValueUsd: item.valueUsd,
      pnlPct: item.pnlPct,
      score: scores.get(item.symbol) ?? null,
      skipped: withinBand ? 'dentro banda di tolleranza' : null,
    });
  }

  let candidates = deltas.filter((item) => !item.skipped && Math.abs(item.deltaUsd) >= config.minOrderUsd);
  for (const item of deltas) {
    if (!item.skipped && Math.abs(item.deltaUsd) < config.minOrderUsd) {
      item.skipped = `sotto l'ordine minimo di ${config.minOrderUsd} USD`;
    }
  }

  // --- Disciplina anti-churn -------------------------------------------
  const stopLossPct = -(config.drawdownStopPct * 100);
  candidates = candidates.filter((item) => {
    const side = item.deltaUsd < 0 ? 'sell' : 'buy';
    const isStopLoss = side === 'sell' && item.pnlPct != null && item.pnlPct <= stopLossPct;
    const check = checkChurnRules({ symbol: item.symbol, side, ledger, config, isStopLoss });
    if (check.allowed) return true;
    item.skipped = check.reason;
    violations.push(violation('churn', `${item.symbol}: ${check.reason}`, 'clamped'));
    return false;
  });

  // Sostituzioni marginali: entrare in B uscendo da A deve valerne la pena.
  const entering = candidates.filter((item) => item.deltaUsd > 0 && item.currentWeight <= 0.001);
  const exiting = candidates.filter((item) => item.deltaUsd < 0 && item.targetWeight <= 0.001);
  if (entering.length && exiting.length) {
    const filtered = filterMarginalSubstitutions({ entering, exiting, config });
    const keptSymbols = new Set([...filtered.entering, ...filtered.exiting].map((item) => item.symbol));
    for (const item of [...entering, ...exiting]) {
      if (keptSymbols.has(item.symbol)) continue;
      item.skipped = 'sostituzione non abbastanza vantaggiosa';
    }
    for (const rejection of filtered.rejected) {
      violations.push(violation('substitution', `${rejection.symbol}: ${rejection.reason}`, 'clamped'));
    }
    candidates = candidates.filter((item) => !(entering.includes(item) || exiting.includes(item)) || keptSymbols.has(item.symbol));
  }

  // Costo di transazione: un ingresso nuovo deve battere spread e commissioni.
  candidates = candidates.filter((item) => {
    if (item.currentWeight > 0.001 || item.deltaUsd <= 0 || item.score == null) return true;
    const bestHeldScore = Math.max(0, ...features.instruments.filter((row) => row.weight > 0.001).map((row) => scores.get(row.symbol) ?? 0));
    // Un punto di score vale circa 0,1% di rendimento atteso sull'orizzonte.
    const expectedEdgePct = Math.max(0, item.score - bestHeldScore) * 0.1;
    const { worth, costUsd, benefitUsd } = isWorthTheCost({ amountUsd: Math.abs(item.deltaUsd), expectedEdgePct, config });
    if (!worth) {
      item.skipped = `beneficio atteso ${benefitUsd} USD sotto il costo stimato ${costUsd} USD`;
      violations.push(violation('transaction_cost', `${item.symbol}: ${item.skipped}`, 'clamped'));
    }
    return worth;
  });

  // Cap di turnover: scala proporzionalmente l'intero piano.
  const turnoverUsd = candidates.reduce((sum, item) => sum + Math.abs(item.deltaUsd), 0);
  const turnoverCapUsd = config.maxTurnoverPct * equityUsd;
  if (turnoverUsd > turnoverCapUsd && turnoverUsd > 0) {
    const factor = turnoverCapUsd / turnoverUsd;
    violations.push(violation('turnover_cap', `turnover ${round(turnoverUsd, 0)} USD ridotto a ${round(turnoverCapUsd, 0)} USD (${(config.maxTurnoverPct * 100).toFixed(0)}%)`, 'clamped'));
    for (const item of candidates) item.deltaUsd = round(item.deltaUsd * factor, 2);
    candidates = candidates.filter((item) => Math.abs(item.deltaUsd) >= config.minOrderUsd);
  }

  // Cap per singolo ordine: percentuale dinamica dell'equity. Il vecchio cap
  // assoluto resta fallback solo per configurazioni anteriori all'onboarding.
  const proportionalOrderCap = Number(config.maxOrderPctOfCapital) > 0
    ? equityUsd * Number(config.maxOrderPctOfCapital)
    : Number(config.maxOrderUsd);
  const absoluteSafetyCap = Number(config.maxOrderUsd) > 0 ? Number(config.maxOrderUsd) : Number.POSITIVE_INFINITY;
  const orderCapUsd = Math.max(config.minOrderUsd, Math.min(proportionalOrderCap || absoluteSafetyCap, absoluteSafetyCap));
  for (const item of candidates) {
    if (Math.abs(item.deltaUsd) > orderCapUsd) {
      violations.push(violation('order_cap', `${item.symbol}: importo ridotto al ${(Number(config.maxOrderPctOfCapital) * 100).toFixed(0)}% del capitale (${round(orderCapUsd, 2)} USD)`, 'clamped'));
      item.deltaUsd = round(Math.sign(item.deltaUsd) * orderCapUsd, 2);
    }
  }

  // Numero massimo di ordini per run: si tengono gli scostamenti più grandi.
  candidates.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  const remainingSlots = Math.max(0, Math.min(config.maxOrdersPerRun, config.maxOrdersPerDay - ordersToday));
  if (candidates.length > remainingSlots) {
    violations.push(violation('run_order_cap', `${candidates.length} ordini richiesti, ne vengono eseguiti ${remainingSlots}`, 'clamped'));
    for (const dropped of candidates.slice(remainingSlots)) dropped.skipped = 'oltre il numero massimo di ordini';
    candidates = candidates.slice(0, remainingSlots);
  }

  // Le vendite precedono gli acquisti così da liberare cassa.
  const sells = candidates.filter((item) => item.deltaUsd < 0).sort((a, b) => a.deltaUsd - b.deltaUsd);
  const buys = candidates.filter((item) => item.deltaUsd > 0).sort((a, b) => b.deltaUsd - a.deltaUsd);

  let availableCash = features.portfolio.cashUsd + sells.reduce((sum, item) => sum + Math.abs(item.deltaUsd), 0);
  const reserveUsd = config.minCashPct * equityUsd;
  const orders = [];
  let seq = 0;

  for (const item of sells) {
    const amount = Math.min(Math.abs(item.deltaUsd), item.currentValueUsd);
    if (amount < config.minOrderUsd) { item.skipped = 'posizione troppo piccola per una vendita valida'; continue; }
    const fullExit = item.targetWeight === 0 || amount >= item.currentValueUsd - 0.01;
    orders.push({
      seq: seq++,
      symbol: item.symbol,
      instrumentId: item.instrumentId,
      side: 'sell',
      amountUsd: round(amount, 2),
      positionId: item.positionIds[0] ?? null,
      positionIds: item.positionIds,
      fullExit,
      reason: `peso ${(item.currentWeight * 100).toFixed(1)}% → ${(item.targetWeight * 100).toFixed(1)}%`,
    });
  }

  for (const item of buys) {
    const spendable = Math.max(0, availableCash - reserveUsd);
    const amount = Math.min(item.deltaUsd, spendable);
    if (amount < config.minOrderUsd) {
      item.skipped = amount <= 0 ? 'liquidità insufficiente dopo la riserva di cassa' : `residuo ${round(amount, 2)} USD sotto il minimo`;
      continue;
    }
    availableCash -= amount;
    orders.push({
      seq: seq++,
      symbol: item.symbol,
      instrumentId: item.instrumentId,
      side: 'buy',
      amountUsd: round(amount, 2),
      positionId: null,
      positionIds: [],
      fullExit: false,
      reason: `peso ${(item.currentWeight * 100).toFixed(1)}% → ${(item.targetWeight * 100).toFixed(1)}%`,
    });
  }

  const blocking = violations.filter((item) => item.severity === 'blocking');
  const plan = {
    createdAt: Date.now(),
    equityUsd,
    targets,
    deltas,
    orders,
    turnoverUsd: round(orders.reduce((sum, item) => sum + item.amountUsd, 0), 2),
    turnoverPct: equityUsd > 0 ? round(orders.reduce((sum, item) => sum + item.amountUsd, 0) / equityUsd, 4) : 0,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
    risks: proposal.risks,
    watch: proposal.watch,
  };

  return { ok: blocking.length === 0, violations, plan };
}
