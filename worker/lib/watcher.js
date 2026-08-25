/**
 * Watcher orario.
 *
 * Ogni ora fa uno scan deterministico e gratuito. Solo quando trova
 * un'anomalia vera escala a una chiamata AI, che deve rispondere a una domanda
 * precisa: questo movimento è un deterioramento strutturale o un eccesso
 * tecnico?
 *
 * Regola non negoziabile: non si compra mai dentro il movimento. Si entra solo
 * dopo un segnale di stabilizzazione, rinunciando al minimo assoluto in cambio
 * di non prendere la seconda gamba di ribasso.
 */
import { annualizedVol, distanceFromSma, maxDrawdown, pctChange, rsi } from './features.js';
import { extractJson } from './brain.js';
import { buildAttemptPlan, callModel } from './llm.js';
import { checkChurnRules } from './churn.js';

const round = (value, digits = 2) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

/**
 * Scan deterministico: nessuna chiamata di rete, nessun costo.
 * @returns {Array} anomalie ordinate per gravità
 */
export function detectAnomalies({ universe, candles, features, config }) {
  const anomalies = [];
  const heldBySymbol = new Map(features.instruments.map((item) => [item.symbol, item]));

  for (const [symbol, meta] of universe.entries()) {
    const series = (candles.get(symbol) ?? []).map((row) => row.close);
    if (series.length < 60) continue;

    const last = series[series.length - 1];
    const previous = series[series.length - 2];
    const dayChange = previous > 0 ? (last - previous) / previous : 0;
    const week = (pctChange(series, 5) ?? 0) / 100;
    const vol30 = annualizedVol(series, 30) ?? 0;
    const vol90 = annualizedVol(series, 90) ?? vol30;
    const held = heldBySymbol.get(symbol);

    const metrics = {
      price: round(last, 4),
      dayChangePct: round(dayChange * 100),
      weekChangePct: round(week * 100),
      vol30: round(vol30, 1),
      vol90: round(vol90, 1),
      volRatio: vol90 > 0 ? round(vol30 / vol90, 2) : null,
      rsi14: rsi(series, 14),
      vsSma50: distanceFromSma(series, 50),
      vsSma200: distanceFromSma(series, 200),
      drawdown3m: maxDrawdown(series.slice(-63)),
      stabilized: isStabilized(series, config.stabilizationBars),
      heldWeight: held ? round(held.weight * 100) : 0,
      heldPnlPct: held?.pnlPct ?? null,
    };

    const kinds = [];
    if (dayChange <= -config.watcherDropPct) kinds.push({ kind: 'crash', severity: Math.abs(dayChange) });
    else if (week <= -config.watcherDropPct * 1.5) kinds.push({ kind: 'slide', severity: Math.abs(week) });
    if (dayChange >= config.watcherSpikePct) kinds.push({ kind: 'spike', severity: dayChange });
    if (vol90 > 0 && vol30 / vol90 >= config.watcherVolSpike) kinds.push({ kind: 'vol_regime', severity: vol30 / vol90 / 10 });
    if (held && held.pnlPct != null && held.pnlPct <= -(config.drawdownStopPct * 100)) {
      kinds.push({ kind: 'position_stop', severity: Math.abs(held.pnlPct) / 100 });
    }

    for (const entry of kinds) {
      anomalies.push({
        symbol,
        instrumentId: meta.instrumentId,
        name: meta.name ?? symbol,
        class: meta.class,
        held: Boolean(held),
        ...entry,
        metrics,
      });
    }
  }

  return anomalies.sort((a, b) => b.severity - a.severity);
}

/** Nessun nuovo minimo nelle ultime N chiusure: il movimento si è fermato. */
export function isStabilized(series, bars = 2) {
  if (series.length < bars + 6) return false;
  const recent = series.slice(-(bars + 1));
  const reference = Math.min(...series.slice(-(bars + 6), -(bars + 1)));
  return recent.slice(1).every((value, index) => value >= Math.min(recent[index], reference * 0.995));
}

const CLASSIFIER_SYSTEM = `Sei un analista finanziario. Ricevi i dati di un singolo strumento che ha avuto un movimento anomalo, più i titoli di stampa recenti.

Devi rispondere a UNA domanda: il movimento riflette un deterioramento strutturale dei fondamentali, oppure è una reazione eccessiva di breve termine?

Rispondi solo con JSON valido, senza testo attorno:
{"classification":"structural_break|technical_overreaction|unclear","confidence":0.00,"suggestedAction":"avoid|watch|accumulate|exit","rationale":"...","keyFactors":["..."]}

Criteri:
- structural_break: cambiano gli utili attesi, il modello di business, il quadro normativo o competitivo. Esempi: guidance tagliata, perdita di un cliente decisivo, indagine regolatoria, insolvenza, frode.
- technical_overreaction: nessuna notizia specifica proporzionata al movimento, oppure causa esogena e temporanea (rotazione settoriale, liquidazione forzata, panico generalizzato, presa di profitto).
- unclear: le notizie non bastano a decidere. Usa questa categoria senza esitazione: è la risposta corretta quando non sai.
- La confidence è la tua probabilità soggettiva di aver classificato bene. Sotto 0.7 significa che non agiremo.
- suggestedAction "accumulate" solo se sei convinto che sia un eccesso tecnico su uno strumento di qualità. In dubbio: "watch".
- rationale: massimo 400 caratteri, in italiano, cita i fatti concreti che ti hanno guidato.`;

/** Titoli plausibilmente collegati allo strumento. */
export function relevantHeadlines(anomaly, news, limit = 8) {
  const terms = [anomaly.symbol, ...String(anomaly.name ?? '').split(/[\s,.\-()]+/).filter((word) => word.length > 3)]
    .map((term) => term.toLowerCase());
  const scored = (news?.items ?? []).map((item) => {
    const text = item.title.toLowerCase();
    const hits = terms.filter((term) => text.includes(term)).length;
    return { item, hits };
  });
  const specific = scored.filter((entry) => entry.hits > 0).map((entry) => entry.item);
  // Senza notizie specifiche, il contesto generale è comunque informativo.
  const fallback = (news?.items ?? []).slice(0, 4);
  return [...specific, ...fallback].slice(0, limit);
}

export async function classifyAnomaly({ config, credentials, env, anomaly, news }) {
  const headlines = relevantHeadlines(anomaly, news);
  const prompt = [
    `STRUMENTO ${anomaly.symbol} — ${anomaly.name} (${anomaly.class})`,
    `EVENTO ${anomaly.kind} · variazione giornaliera ${anomaly.metrics.dayChangePct}% · settimanale ${anomaly.metrics.weekChangePct}%`,
    `TECNICI RSI ${anomaly.metrics.rsi14} · vs media 50gg ${anomaly.metrics.vsSma50}% · vs media 200gg ${anomaly.metrics.vsSma200}% · drawdown 3m ${anomaly.metrics.drawdown3m}%`,
    `VOLATILITÀ 30gg ${anomaly.metrics.vol30}% contro 90gg ${anomaly.metrics.vol90}% (rapporto ${anomaly.metrics.volRatio})`,
    `PREZZO ${anomaly.metrics.price} · movimento ${anomaly.metrics.stabilized ? 'stabilizzato' : 'ancora in corso'}`,
    anomaly.held ? `IN PORTAFOGLIO peso ${anomaly.metrics.heldWeight}% · P&L ${anomaly.metrics.heldPnlPct}%` : 'NON IN PORTAFOGLIO',
    '',
    'TITOLI RECENTI:',
    ...(headlines.length ? headlines.map((item) => `- ${item.title}`) : ['- nessuna notizia rilevante trovata']),
  ].join('\n');

  const messages = [
    { role: 'system', content: CLASSIFIER_SYSTEM },
    { role: 'user', content: prompt },
  ];

  // Solo due tentativi: il watcher gira ogni ora e non deve mai diventare costoso.
  for (const entry of buildAttemptPlan({ config, credentials, env }).slice(0, 2)) {
    try {
      const { content } = await callModel({
        ...entry, messages, credentials, env,
        config: { ...config, llmTemperature: 0.1, llmMaxTokens: 700 },
        timeoutMs: 30_000,
      });
      const parsed = extractJson(content);
      if (!parsed?.classification) continue;
      const confidence = Number(parsed.confidence);
      return {
        model: `${entry.provider}/${entry.model}`,
        classification: ['structural_break', 'technical_overreaction', 'unclear'].includes(parsed.classification) ? parsed.classification : 'unclear',
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : 0.5,
        suggestedAction: ['avoid', 'watch', 'accumulate', 'exit'].includes(parsed.suggestedAction) ? parsed.suggestedAction : 'watch',
        rationale: String(parsed.rationale ?? '').slice(0, 800),
        keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.map(String).slice(0, 5) : [],
        headlinesUsed: headlines.length,
      };
    } catch { /* provider non disponibile: si prova il successivo */ }
  }
  return null;
}

/**
 * Trasforma una classificazione in una decisione operativa, applicando tutti i
 * cancelli deterministici. È qui che si decide se l'AI viene ascoltata.
 */
export function decideWatcherAction({
  anomaly, verdict, config, ledger, budgetUsd, opportunisticThisWeek, equityUsd,
  holdingCount = 0, currentClassWeight = 0, availableCashUsd = Number.POSITIVE_INFINITY,
  ordersToday = 0,
}) {
  const deny = (reason) => ({ action: 'noop', reason });

  if (!verdict) return deny('nessuna classificazione disponibile');
  if (verdict.confidence < config.watcherMinConfidence) {
    return deny(`confidence ${verdict.confidence.toFixed(2)} sotto la soglia ${config.watcherMinConfidence}`);
  }

  // Uscita da una posizione che si sta deteriorando davvero.
  if (anomaly.held && verdict.classification === 'structural_break' && verdict.suggestedAction === 'exit') {
    return { action: 'propose_exit', reason: 'deterioramento strutturale su posizione aperta', amountUsd: null };
  }

  if (verdict.classification !== 'technical_overreaction' || verdict.suggestedAction !== 'accumulate') {
    return deny(`classificazione ${verdict.classification}, azione suggerita ${verdict.suggestedAction}`);
  }
  if (anomaly.kind === 'spike') return deny('non si insegue un rialzo esplosivo');
  if (!anomaly.metrics.stabilized) return deny('movimento ancora in corso: si attende la stabilizzazione');
  if (opportunisticThisWeek >= config.maxOpportunisticPerWeek) {
    return deny(`già ${opportunisticThisWeek} operazioni opportunistiche questa settimana, massimo ${config.maxOpportunisticPerWeek}`);
  }
  if (!anomaly.held && config.maxHoldings && holdingCount >= config.maxHoldings) {
    return deny(`raggiunto il massimo di ${config.maxHoldings} posizioni`);
  }
  if (ordersToday >= config.maxOrdersPerDay) {
    return deny(`raggiunto il limite giornaliero di ${config.maxOrdersPerDay} ordini`);
  }

  const churn = checkChurnRules({ symbol: anomaly.symbol, side: 'buy', ledger, config, isOpportunistic: true });
  if (!churn.allowed) return deny(churn.reason);

  const percentageCapUsd = Number(config.maxOrderPctOfCapital) > 0
    ? equityUsd * Number(config.maxOrderPctOfCapital)
    : Number.POSITIVE_INFINITY;
  const classCap = Number(config.maxWeightPerClass?.[anomaly.class] ?? 1);
  const classRoomUsd = Math.max(0, (classCap - currentClassWeight) * equityUsd);
  const spendableCashUsd = Math.max(0, availableCashUsd - (Number(config.minCashPct) || 0) * equityUsd);
  const perTradeUsd = Math.min(
    budgetUsd,
    Number(config.maxOrderUsd) || Number.POSITIVE_INFINITY,
    percentageCapUsd,
    classRoomUsd,
    spendableCashUsd,
    equityUsd * config.opportunisticBudgetPct / Math.max(1, config.maxOpportunisticPerWeek),
  );
  if (perTradeUsd < config.minOrderUsd) return deny(`budget opportunistico residuo ${round(perTradeUsd)} USD sotto l'ordine minimo`);

  return { action: 'buy', reason: verdict.rationale, amountUsd: round(perTradeUsd) };
}
