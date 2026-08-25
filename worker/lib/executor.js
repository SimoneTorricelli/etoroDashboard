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
async function checkEligibility(client, orders, config) {
  const buys = orders.filter((order) => order.side === 'buy');
  if (!buys.length) return { ok: true, issues: [], checks: [] };
  const map = await client.eligibility([...new Set(buys.map((order) => order.instrumentId))]);
  const issues = [];
  const checks = buys.map((order) => {
    const info = map.get(order.instrumentId);
    let detail = 'ammesso';
    if (!info) detail = 'eToro non ha restituito l’ammissibilità';
    else if (!info.allowOpenPosition) detail = 'mercato chiuso o strumento non negoziabile';
    else if (order.amountUsd + 0.005 < info.minPositionUsd) detail = `sotto il minimo eToro di ${info.minPositionUsd} USD`;
    const eligible = detail === 'ammesso';
    if (!eligible) issues.push(`${order.symbol}: ${detail}`);
    return { symbol: order.symbol, instrumentId: order.instrumentId, eligible, detail, minPositionUsd: info?.minPositionUsd ?? null };
  });
  void config;
  return { ok: issues.length === 0, issues, checks };
}

/**
 * @param {'shadow'|'dry-run'|'live'} mode
 */
export async function executePlan({ db, client, runId, plan, mode, config }) {
  const results = [];

  if (mode === 'shadow') {
    for (const order of plan.orders) {
      const id = await deterministicId(runId, order.seq, order.symbol, order.side);
      const record = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode, state: 'simulated', message: 'shadow mode: nessun ordine costruito' };
      await upsertOrder(db, record);
      results.push(record);
    }
    return { mode, executed: false, results, eligibility: null };
  }

  const eligibility = await checkEligibility(client, plan.orders, config).catch((error) => ({
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

    const base = { id, runId, seq: order.seq, symbol: order.symbol, instrumentId: order.instrumentId, side: order.side, amountUsd: order.amountUsd, positionId: order.positionId, mode };

    if (mode === 'dry-run') {
      const record = { ...base, state: 'simulated', message: `dry-run: ${order.side} ${order.amountUsd} USD non inviato` };
      await upsertOrder(db, record);
      results.push(record);
      continue;
    }

    await upsertOrder(db, { ...base, state: 'intent', message: 'in invio' });

    try {
      const response = order.side === 'buy'
        ? await client.openOrder({ instrumentId: order.instrumentId, amountUsd: order.amountUsd, requestId: id })
        : await client.closeOrder({ positionId: order.positionId, amountUsd: order.fullExit ? null : order.amountUsd, requestId: id });

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

  if (mode === 'live') await verifyOrders({ db, client, results });
  return { mode, executed: mode === 'live', results, eligibility };
}

/** Due letture ravvicinate dello stato ordine: sufficienti senza rischiare 429. */
async function verifyOrders({ db, client, results }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = results.filter((item) => item.state === 'sent');
    if (!pending.length) return;
    if (attempt > 0) await sleep(1500);
    for (const record of pending) {
      try {
        const lookup = await client.lookupOrder({ orderId: record.etoroOrderId, referenceId: record.id });
        record.state = lookup.state === 'pending' ? 'sent' : lookup.state;
        record.filledUsd = lookup.filledUsd || (lookup.state === 'filled' ? record.amountUsd : 0);
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
export async function reconcile({ client, plan, config }) {
  const snapshot = await client.portfolio();
  const equity = snapshot.equityUsd || 1;
  const byInstrument = new Map();
  for (const position of snapshot.positions) {
    byInstrument.set(position.instrumentId, (byInstrument.get(position.instrumentId) ?? 0) + position.valueUsd);
  }
  const rows = plan.deltas.map((delta) => {
    const actualWeight = round((byInstrument.get(delta.instrumentId) ?? 0) / equity, 4);
    return {
      symbol: delta.symbol,
      expectedWeight: delta.skipped ? delta.currentWeight : delta.targetWeight,
      actualWeight,
      divergence: round(Math.abs(actualWeight - (delta.skipped ? delta.currentWeight : delta.targetWeight)), 4),
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
