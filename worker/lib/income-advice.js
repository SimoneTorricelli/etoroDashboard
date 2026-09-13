import { buildAttemptPlan, callModel } from './llm.js';

export function incomeAdviceContext(body) {
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12;
  const pct = n => finite(n) && n <= 100;
  if (!body || !finite(body.target) || !finite(body.capital) || !['net', 'gross'].includes(body.basis) || !Number.isInteger(body.missingSources) || body.missingSources < 0 || body.missingSources > 10000 || (body.knownMonthly !== null && (typeof body.knownMonthly !== 'number' || !Number.isFinite(body.knownMonthly)))) throw new Error('Riepilogo rendite non valido');
  if (!Array.isArray(body.allocations) || body.allocations.length !== 4) throw new Error('Allocazioni non valide');
  const kinds = ['dividend', 'interest', 'staking', 'other'];
  if (new Set(body.allocations.map(a => a.kind)).size !== 4 || body.allocations.some(a => !kinds.includes(a.kind) || !pct(a.weight) || (a.weight > 0 && (!pct(a.rate) || (body.basis === 'net' && !pct(a.taxPct)))))) throw new Error('Rendimenti o ipotesi fiscali mancanti');
  if (Math.abs(body.allocations.reduce((s, a) => s + a.weight, 0) - 100) > 0.001) throw new Error('Le quote devono sommare 100%');
  const allocations = body.allocations.map(a => ({ kind: a.kind, weight: a.weight, rate: a.weight ? a.rate : 0, taxPct: body.basis === 'net' && a.weight ? a.taxPct : 0 }));
  const rate = allocations.reduce((s, a) => s + a.weight / 100 * a.rate / 100 * (1 - a.taxPct / 100), 0);
  return { targetMonthlyEur: body.target, basis: body.basis, availableCapitalEur: body.capital, knownMonthlyEur: body.knownMonthly, missingSources: body.missingSources,
    assumptions: allocations, weightedYieldPct: rate * 100, scenarioMonthlyEur: body.capital * rate / 12, requiredCapitalEur: rate > 0 ? body.target * 12 / rate : null,
    allocationForTarget: allocations.map(a => ({ kind: a.kind, capitalEur: rate > 0 ? body.target * 12 / rate * a.weight / 100 : null })),
    limitations: ['Rendimenti ipotetici, non offerte verificate', 'Media annua: calendario completo non disponibile', 'Staking valorizzato in EUR ma pagato in token', 'Nessuna garanzia di rendimento né verifica idoneità prodotti', 'Nessun ordine o trasferimento autorizzato da questo prospetto'] };
}

export async function explainIncome(body, config, credentials, env) {
  const context = incomeAdviceContext(body);
  const attempt = buildAttemptPlan({ config, credentials, env })[0];
  if (!attempt) throw new Error('Configura un provider AI in Autopilot. Il simulatore locale resta disponibile.');
  const result = await callModel({ ...attempt, config: { ...config, llmMaxTokens: 1200, llmTemperature: 0.1 }, credentials, env, jsonMode: false, timeoutMs: 45000,
    messages: [{ role: 'system', content: 'Commenta in italiano questo prospetto di rendita. Usa soltanto i dati forniti. Non inventare tassi, offerte, strumenti o stato del conto. Non impartire ordini. I numeri sono calcolati deterministicamente: non modificarli. Distingui dati mancanti, ipotesi, denaro disponibile e premi in token. Spiega la ripartizione scelta, il capitale necessario, le verifiche mancanti e alternative generiche da confrontare senza raccomandare prodotti specifici. Non promettere 100 EUR ogni mese: è una media. Massimo 350 parole.' }, { role: 'user', content: JSON.stringify(context) }] });
  if (typeof result.content !== 'string' || !result.content.trim()) throw new Error('Il modello non ha restituito un’analisi leggibile');
  return { text: result.content.slice(0, 8000), model: `${attempt.provider}/${attempt.model}`, usage: result.usage ?? null, context, asOf: Date.now() };
}
