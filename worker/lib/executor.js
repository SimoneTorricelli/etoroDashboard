/**
 * Esecuzione ordini con idempotenza e riconciliazione.
 *
 * Ogni ordine ha un id deterministico derivato da (runId, seq, simbolo, lato):
 * un retry della stessa run non può duplicare una posizione, perché l'id è già
 * presente in D1 con stato diverso da `intent`.
 */
import { upsertOrder, getOrder, audit } from './db.js';

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** UUID v4-shaped derivato in modo deterministico: usabile come x-request-id. */
export async function deterministicId(...parts) {
  const data = new TextEncoder().encode(parts.join('|'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pre-check di ammissibilità sugli acquisti: mercato aperto e taglio minimo. */
async function checkEligibility(client, orders, executionScale) {
  const buys = orders.filter((order) => order.side === 'buy');
  if (!buys.length) return { ok: true, issues: [], checks: [] };
  const map = await client.eligibility([...new Set(buys.map((order) => order.instrumentId))]);
  const issues = [];
  const checks = buys.map((order) => {
    const info = map.get(order.instrumentId);
    const executionAmountUsd = round(order.amountUsd * executionScale, 2);
    const realMinimumUsd = info?.minPositionUsd ? round(info.minPositionUsd / executionScale, 2) : null;
    let detail = 'ammesso';
    if (!info) detail = 'eToro non ha restituito l’ammissibilità';
    else if (!info.allowOpenPosition) detail = 'mercato chiuso o strumento non negoziabile';
    else if (executionAmountUsd + 0.005 < info.minPositionUsd) detail = `sotto il minimo reale equivalente di ${realMinimumUsd} USD`;
    const eligible = detail === 'ammesso';
    if (!eligible) issues.push(`${order.symbol}: ${detail}`);
    return {
      symbol: order.symbol,
      instrumentId: order.instrumentId,
      eligible,
      detail,
      minPositionUsd: realMinimumUsd,
      agentMinimumUsd: info?.minPositionUsd ?? null,
    };
  });
  return { ok: issues.length === 0, issues, checks };
}

/**
 * @param {'shadow'|'dry-run'|'live'} mode
 */
export async function executePlan({ db, client, runId, plan, mode, config }) {
  const results = [];
  const executionScale = Number(plan.executionScale) > 0 ? Number(plan.executionScale) : 1;

  // Fail closed: solo il valore esatto "live" può raggiungere gli endpoint
  // di trading. Configurazioni corrotte, spazi o maiuscole non vengono
  // reinterpretati e non fanno nemmeno il pre-check di rete.
  if (!['shadow', 'dry-run', 'live'].includes(mode)) {
    const message = `modalità di esecuzione non valida: ${String(mode)}`;
    if (db) await audit(db, runId, 'error', 'executor', message);
    return { mode, executed: false, results, eligibility: null, blocked: true, error: message };
  }

  if (mode === 'shadow') {
    for (const order of plan.orders) {
      const id = await deterministicId(runId, order.seq, order.symbol, order.side);
      const record = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode, state: 'simulated', message: 'shadow mode: nessun ordine costruito' };
      await upsertOrder(db, record);
      results.push(record);
    }
    return { mode, executed: false, results, eligibility: null };
  }

  const eligibility = await checkEligibility(client, plan.orders, executionScale).catch((error) => ({
    ok: false,
    issues: [`pre-check ammissibilità fallito: ${error.message}`],
    checks: [],
  }));

  if (!eligibility.ok) {
    await audit(db, runId, 'warn', 'executor', 'Piano bloccato dal pre-check di ammissibilità', eligibility.issues);
    for (const order of plan.orders) {
      const id = await deterministicId(runId, order.seq, order.symbol, order.side);
      const record = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode, state: 'skipped', message: eligibility.issues.join(' · ').slice(0, 500) };
      await upsertOrder(db, record);
      results.push(record);
    }
    return { mode, executed: false, results, eligibility, blocked: true };
  }

  for (const order of plan.orders) {
    const id = await deterministicId(runId, order.seq, order.symbol, order.side);
    const existing = await getOrder(db, id);
    if (existing && existing.state !== 'intent') {
      results.push({ ...existing, skippedDuplicate: true });
      continue;
    }

    const executionAmountUsd = round(order.amountUsd * executionScale, 2);
    const base = {
      id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId,
      side: order.side, amountUsd: order.amountUsd, executionAmountUsd, positionId: order.positionId, mode,
    };

    if (mode === 'dry-run') {
      const record = { ...base, state: 'simulated', message: `dry-run: ${order.side} ${order.amountUsd} USD reali non inviato` };
      await upsertOrder(db, record);
      results.push(record);
      continue;
    }

    await upsertOrder(db, { ...base, state: 'intent', message: 'in invio' });

    try {
      const response = order.side === 'buy'
        ? await client.openOrder({ instrumentId: order.instrumentId, amountUsd: executionAmountUsd, requestId: id })
        : await client.closeOrder({ positionId: order.positionId, amountUsd: order.fullExit ? null : executionAmountUsd, requestId: id });

      const etoroOrderId = String(response?.orderId ?? response?.OrderId ?? response?.OrderID ?? '') || null;
      const record = { ...base, state: 'sent', etoroOrderId, message: 'accettato, in verifica' };
      await upsertOrder(db, record);
      results.push(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = { ...base, state: 'failed', message };
      await upsertOrder(db, record);
      results.push(record);
      await audit(db, runId, 'error', 'executor', `Invio interrotto su ${order.symbol}`, { message });
      // Interruzione immediata: meglio un piano parziale noto che uno incontrollato.
      for (const remaining of plan.orders.filter((item) => item.seq > order.seq)) {
        const skippedId = await deterministicId(runId, remaining.seq, remaining.symbol, remaining.side);
        const skipped = { id: skippedId, runId, seq: remaining.seq, symbol: remaining.symbol, instrumentId: remaining.instrumentId, side: remaining.side, amountUsd: remaining.amountUsd, positionId: remaining.positionId, mode, state: 'skipped', message: 'non inviato: interruzione dopo errore precedente' };
        await upsertOrder(db, skipped);
        results.push(skipped);
      }
      break;
    }
  }

  if (mode === 'live') await verifyOrders({ db, client, results, executionScale });
  return { mode, executed: mode === 'live', results, eligibility };
}

/** Due letture ravvicinate dello stato ordine: sufficienti senza rischiare 429. */
async function verifyOrders({ db, client, results, executionScale = 1 }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = results.filter((item) => item.state === 'sent');
    if (!pending.length) return;
    if (attempt > 0) await sleep(1500);
    for (const record of pending) {
      try {
        const lookup = await client.lookupOrder({ orderId: record.etoroOrderId, referenceId: record.id });
        record.state = lookup.state === 'pending' ? 'sent' : lookup.state;
        const virtualFilled = lookup.filledUsd || (lookup.state === 'filled' ? record.executionAmountUsd : 0);
        record.filledUsd = round(virtualFilled / executionScale, 2);
        record.positionIds = lookup.positionIds;
        record.message = lookup.error ? `${lookup.label} — ${lookup.error}` : lookup.label;
        await upsertOrder(db, record);
      } catch (error) {
        record.message = `verifica non riuscita: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
}

/**
 * Rilegge il portafoglio reale e confronta i pesi con i target attesi.
 * Una divergenza oltre soglia è un segnale di esecuzione non allineata.
 */
export async function reconcile({ client, plan, config, portfolioUserKey }) {
  const snapshot = await client.portfolio(portfolioUserKey);
  const equity = snapshot.equityUsd || 1;
  const plannedEquity = plan.equityUsd || equity;
  const byInstrument = new Map();
  for (const position of snapshot.positions) {
    byInstrument.set(position.instrumentId, (byInstrument.get(position.instrumentId) ?? 0) + position.valueUsd);
  }
  const rows = plan.deltas.map((delta) => {
    const actualWeight = round((byInstrument.get(delta.instrumentId) ?? 0) / equity, 4);
    // Il piano può essere ridotto da turnover, liquidità, taglio massimo e
    // numero ordini. La riconciliazione deve quindi confrontare il portafoglio
    // con ciò che è stato davvero ordinato, non con il target teorico dell'AI.
    const orderedDeltaUsd = plan.orders
      .filter((order) => order.instrumentId === delta.instrumentId)
      .reduce((sum, order) => sum + (order.side === 'buy' ? order.amountUsd : -order.amountUsd), 0);
    const expectedWeight = round(Math.max(0, delta.currentWeight + orderedDeltaUsd / plannedEquity), 4);
    return {
      symbol: delta.symbol,
      expectedWeight,
      actualWeight,
      divergence: round(Math.abs(actualWeight - expectedWeight), 4),
    };
  });
  const worst = rows.reduce((max, row) => Math.max(max, row.divergence), 0);
  return {
    checkedAt: Date.now(),
    equityUsd: snapshot.equityUsd,
    rows,
    worstDivergence: worst,
    ok: worst <= config.reconcileTolerancePct,
    snapshot,
  };
}
