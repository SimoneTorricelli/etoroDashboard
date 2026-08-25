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
    violations.push(violation('cash_ceiling', `cash ${(cash * 100).toFixed(1)}% sopra il massimo ${(config.maxCashPct * 100).toFixed(0)}%: proposta accettata ma segnalata`, 'info'));
  }

  weights.CASH = round(cash, 4);
  for (const key of Object.keys(weights)) weights[key] = round(weights[key], 4);
  return weights;
}

/**
 * @returns {{ok: boolean, violations: Array, plan: object}}
 */
export function validateProposal({ proposal, features, config, ordersToday = 0 }) {
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

  const targets = clampWeights(proposal.targetWeights, features, config, violations);

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
      skipped: withinBand ? 'dentro banda di tolleranza' : null,
    });
  }

  let candidates = deltas.filter((item) => !item.skipped && Math.abs(item.deltaUsd) >= config.minOrderUsd);
  for (const item of deltas) {
    if (!item.skipped && Math.abs(item.deltaUsd) < config.minOrderUsd) {
      item.skipped = `sotto l'ordine minimo di ${config.minOrderUsd} USD`;
    }
  }

  // Cap di turnover: scala proporzionalmente l'intero piano.
  const turnoverUsd = candidates.reduce((sum, item) => sum + Math.abs(item.deltaUsd), 0);
  const turnoverCapUsd = config.maxTurnoverPct * equityUsd;
  if (turnoverUsd > turnoverCapUsd && turnoverUsd > 0) {
    const factor = turnoverCapUsd / turnoverUsd;
    violations.push(violation('turnover_cap', `turnover ${round(turnoverUsd, 0)} USD ridotto a ${round(turnoverCapUsd, 0)} USD (${(config.maxTurnoverPct * 100).toFixed(0)}%)`, 'clamped'));
    for (const item of candidates) item.deltaUsd = round(item.deltaUsd * factor, 2);
    candidates = candidates.filter((item) => Math.abs(item.deltaUsd) >= config.minOrderUsd);
  }

  // Cap per singolo ordine.
  for (const item of candidates) {
    if (Math.abs(item.deltaUsd) > config.maxOrderUsd) {
      violations.push(violation('order_cap', `${item.symbol}: importo ridotto a ${config.maxOrderUsd} USD`, 'clamped'));
      item.deltaUsd = round(Math.sign(item.deltaUsd) * config.maxOrderUsd, 2);
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
