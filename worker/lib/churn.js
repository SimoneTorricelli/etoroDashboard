/**
 * Disciplina anti-churn.
 *
 * Con un universo dinamico il rischio principale non è scegliere male: è
 * ruotare il portafoglio ogni settimana e regalare il rendimento a spread e
 * commissioni. Queste regole sono deterministiche e hanno la precedenza sulla
 * proposta del modello.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const daysSince = (timestamp) => (timestamp ? (Date.now() - Number(timestamp)) / DAY_MS : Infinity);

/**
 * Valuta una singola operazione contro il registro delle posizioni.
 *
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkChurnRules({ symbol, side, ledger, config, isStopLoss = false, isOpportunistic = false }) {
  const row = ledger.get(symbol);

  if (side === 'sell') {
    if (isStopLoss) return { allowed: true };
    const heldDays = daysSince(row?.last_bought_at ?? row?.first_bought_at);
    if (heldDays < config.minHoldingDays) {
      return {
        allowed: false,
        reason: `detenuto da ${Math.floor(heldDays)} giorni, minimo ${config.minHoldingDays}`,
      };
    }
    return { allowed: true };
  }

  // Acquisto
  const soldDays = daysSince(row?.last_sold_at);
  if (row?.last_sold_at && soldDays < config.reentryCooldownDays) {
    return {
      allowed: false,
      reason: `venduto ${Math.floor(soldDays)} giorni fa, rientro consentito dopo ${config.reentryCooldownDays}`,
    };
  }
  if (isOpportunistic && (row?.average_down_count ?? 0) >= config.maxAverageDown) {
    return {
      allowed: false,
      reason: `già mediato al ribasso ${row.average_down_count} volte, massimo ${config.maxAverageDown}`,
    };
  }
  return { allowed: true };
}

/**
 * Il beneficio atteso deve superare il costo di andata e ritorno, altrimenti
 * l'operazione è un trasferimento netto di valore al broker.
 */
export function isWorthTheCost({ amountUsd, expectedEdgePct, config }) {
  const costUsd = amountUsd * (config.transactionCostBps / 10_000);
  const benefitUsd = amountUsd * (expectedEdgePct / 100);
  return { worth: benefitUsd > costUsd, costUsd: Math.round(costUsd * 100) / 100, benefitUsd: Math.round(benefitUsd * 100) / 100 };
}

/**
 * Filtra le sostituzioni marginali: uscire da A per entrare in B ha senso solo
 * se B è nettamente migliore, non se lo supera di un punto.
 *
 * @param {Array} entering  candidati in acquisto, con `score`
 * @param {Array} exiting   posizioni in uscita, con `score`
 */
export function filterMarginalSubstitutions({ entering, exiting, config }) {
  if (!entering.length || !exiting.length) return { entering, exiting, rejected: [] };

  const bestExitingScore = Math.max(...exiting.map((item) => item.score ?? 0));
  const rejected = [];
  const keptEntering = entering.filter((item) => {
    const edge = (item.score ?? 0) - bestExitingScore;
    if (edge < config.substitutionEdge) {
      rejected.push({
        symbol: item.symbol,
        reason: `vantaggio di ${edge.toFixed(0)} punti sotto la soglia di sostituzione (${config.substitutionEdge})`,
      });
      return false;
    }
    return true;
  });

  // Se nessun ingresso sopravvive, non ha senso nemmeno liberare spazio.
  const keptExiting = keptEntering.length ? exiting : [];
  if (!keptEntering.length && exiting.length) {
    rejected.push({ symbol: exiting.map((item) => item.symbol).join(','), reason: 'nessun candidato abbastanza migliore: si mantiene la posizione attuale' });
  }
  return { entering: keptEntering, exiting: keptExiting, rejected };
}

/** Riepilogo leggibile del registro, per il prompt e per la dashboard. */
export function describeLedger(ledger, config) {
  const rows = [];
  for (const [symbol, row] of ledger.entries()) {
    if (row.last_sold_at) {
      const days = daysSince(row.last_sold_at);
      if (days < config.reentryCooldownDays) {
        rows.push(`${symbol}: venduto ${Math.floor(days)}gg fa, non riacquistabile per altri ${Math.ceil(config.reentryCooldownDays - days)}gg`);
      }
      continue;
    }
    const held = daysSince(row.last_bought_at ?? row.first_bought_at);
    if (held < config.minHoldingDays) {
      rows.push(`${symbol}: in portafoglio da ${Math.floor(held)}gg, vincolato per altri ${Math.ceil(config.minHoldingDays - held)}gg`);
    }
  }
  return rows;
}
