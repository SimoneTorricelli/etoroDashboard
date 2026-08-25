/**
 * Livello probabilistico: interroga OpenRouter con una cascata di modelli
 * gratuiti finché uno non restituisce una proposta JSON valida.
 *
 * Contratto invariante: il modello propone SOLO un'allocazione target.
 * Non conosce l'esistenza degli ordini e non può richiederne l'invio.
 */

import { buildAttemptPlan, callModel } from './llm.js';

export { listFreeModels } from './llm.js';

const SYSTEM_PROMPT = `Sei un risk manager quantitativo. Ricevi lo stato di un portafoglio reale di piccola taglia e un insieme di indicatori già calcolati.

Il tuo unico output è un'allocazione TARGET in percentuale, in JSON valido, senza testo attorno.

Regole non negoziabili:
- Usa esclusivamente i simboli elencati in STRUMENTI, più la voce CASH.
- I pesi sono numeri decimali fra 0 e 1 e la loro somma deve fare esattamente 1.
- Non superare mai il peso massimo indicato nella colonna max% di ciascuno strumento.
- Nessuna leva, nessuna posizione short, nessuno strumento fuori lista.
- Se il quadro non è chiaro o i segnali sono contraddittori, proponi un'allocazione vicina a quella corrente e abbassa la confidence: l'inazione è una scelta legittima e spesso corretta.
- La confidence è la tua probabilità soggettiva che questa allocazione batta il mantenimento dello status quo nell'orizzonte indicato. Sii conservativo.
- rationale: massimo 600 caratteri, in italiano, concreto, cita i numeri che ti hanno guidato.

Schema di output:
{"targetWeights":{"SIMBOLO":0.00,"CASH":0.00},"confidence":0.00,"rationale":"...","risks":["..."],"watch":["..."]}`;

const DYNAMIC_SYSTEM_PROMPT = `Sei un gestore di portafoglio quantitativo. Ricevi lo stato di un portafoglio reale di piccola taglia e una shortlist di candidati già filtrata da uno screening quantitativo.

Il tuo compito: scegliere quali strumenti tenere e con quale peso. Output in JSON valido, senza testo attorno.

Regole non negoziabili:
- Puoi usare SOLO i simboli presenti in CANDIDATI, più la voce CASH.
- I pesi sono decimali fra 0 e 1 e devono sommare esattamente a 1.
- Rispetta il numero minimo e massimo di strumenti indicato nei vincoli.
- Non superare il peso massimo di ciascuno strumento né i tetti per classe.
- Nessuna leva, nessuno short.
- Il minimo di posizioni è solo una barriera di sicurezza, non un obiettivo. Se il portafoglio è vuoto, costruisci una diversificazione completa e mira al numero di posizioni preferite indicato nei VINCOLI; usa meno titoli solo con una motivazione quantitativa esplicita.
- Prima di rispondere verifica aritmeticamente che, dopo i cap per strumento e classe, la cassa resti fra minimo e massimo. Non dichiarare di rispettare un cap se il peso proposto lo supera.

Disciplina di rotazione — è la parte che conta di più:
- Le posizioni marcate IN PORTAFOGLIO hanno un vantaggio implicito: cambiarle costa spread e commissioni. Sostituiscine una solo se il candidato è NETTAMENTE migliore, non marginalmente.
- Non ruotare il portafoglio per inseguire l'ultima settimana di performance. Preferisci la stabilità quando i segnali sono deboli o contraddittori.
- L'inazione è una scelta legittima: se l'allocazione attuale è ragionevole, riproponila quasi identica e abbassa la confidence.
- Le righe elencate in VINCOLI TEMPORALI non sono negoziabili: quegli strumenti non possono essere venduti o riacquistati adesso.

La confidence è la tua probabilità soggettiva che questa allocazione batta il mantenimento dello status quo sull'orizzonte indicato. Considera anche copertura e qualità degli storici; sii conservativo, ma non abbassarla solo perché il capitale reale è piccolo: i pesi sono percentuali.
rationale: massimo 700 caratteri, in italiano, spiega le scelte citando i numeri.

Schema di output:
{"targetWeights":{"SIMBOLO":0.00,"CASH":0.00},"confidence":0.00,"rationale":"...","risks":["..."],"watch":["..."]}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetWeights', 'confidence', 'rationale'],
  properties: {
    targetWeights: { type: 'object', additionalProperties: { type: 'number' } },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    watch: { type: 'array', items: { type: 'string' } },
  },
};

/** Estrae il primo oggetto JSON bilanciato presente nel testo. */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Normalizza e verifica la forma della proposta. Non applica regole di rischio. */
export function normalizeProposal(raw, allowedSymbols) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'risposta non è un oggetto' };
  const weightsRaw = raw.targetWeights ?? raw.target_weights ?? raw.weights;
  if (!weightsRaw || typeof weightsRaw !== 'object') return { ok: false, error: 'targetWeights assente' };

  const allowed = new Set([...allowedSymbols, 'CASH']);
  const unknown = [];
  const weights = {};
  for (const [key, value] of Object.entries(weightsRaw)) {
    const symbol = String(key).trim().toUpperCase();
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    if (!allowed.has(symbol)) { unknown.push(symbol); continue; }
    // Tollera pesi espressi in percentuale (0-100) invece che in frazione.
    weights[symbol] = numeric > 1.0001 ? numeric / 100 : numeric;
  }
  if (unknown.length) return { ok: false, error: `simboli non ammessi: ${unknown.join(', ')}` };
  if (!Object.keys(weights).length) return { ok: false, error: 'nessun peso valido' };

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ok: false, error: 'somma pesi nulla' };
  if (Math.abs(total - 1) > 0.05) return { ok: false, error: `somma pesi ${total.toFixed(3)} fuori tolleranza` };
  for (const key of Object.keys(weights)) weights[key] = Math.round((weights[key] / total) * 10000) / 10000;

  const confidence = Number(raw.confidence);
  return {
    ok: true,
    value: {
      targetWeights: weights,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : 0.5,
      rationale: String(raw.rationale ?? '').slice(0, 1500),
      risks: Array.isArray(raw.risks) ? raw.risks.map(String).slice(0, 6) : [],
      watch: Array.isArray(raw.watch) ? raw.watch.map(String).slice(0, 6) : [],
    },
  };
}

/**
 * Prova ogni coppia provider/modello con una richiesta minima e riporta
 * l'errore esatto. È il modo più diretto per scoprire che un modello gratuito
 * è stato ritirato: i cataloghi cambiano di continuo.
 */
export async function probeModels({ config, credentials, env }) {
  const plan = buildAttemptPlan({ config, credentials, env });
  if (!plan.length) return [{ provider: '—', model: '—', ok: false, error: 'nessun provider configurato o chiave mancante' }];
  const results = [];
  // Il piano gratuito di Cloudflare concede 50 subrequest per invocazione:
  // un probe illimitato le esaurirebbe da solo.
  for (const attempt of plan.slice(0, 8)) {
    const startedAt = Date.now();
    try {
      const { content } = await callModel({
        ...attempt,
        messages: [{ role: 'user', content: 'Rispondi solo con: {"ok":true}' }],
        config: { ...config, llmMaxTokens: 32 },
        credentials,
        env,
        timeoutMs: 20_000,
      });
      results.push({ ...attempt, ok: Boolean(content), ms: Date.now() - startedAt });
    } catch (error) {
      results.push({ ...attempt, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt });
    }
  }
  return results;
}

/**
 * Cascata multi-provider. Per ogni coppia provider/modello prova prima la
 * modalità JSON nativa, poi il testo libero con estrazione.
 */
export async function askBrain({ config, credentials, env, featuresPrompt, allowedSymbols, dynamic = false, profileDescription = '', ledgerNotes = [] }) {
  const horizon = config.cadence === 'daily' ? 'giornaliero' : config.cadence === 'monthly' ? 'mensile' : 'settimanale';
  const userPrompt = [
    featuresPrompt,
    '',
    profileDescription ? `STRATEGIA ${profileDescription}` : '',
    ledgerNotes.length ? `VINCOLI TEMPORALI (non aggirabili)\n${ledgerNotes.map((note) => `- ${note}`).join('\n')}` : '',
    '',
    `Orizzonte del ribilanciamento: ${horizon}.`,
    'Rispondi solo con il JSON dello schema richiesto.',
  ].filter((line) => line !== '').join('\n');

  const systemPrompt = dynamic ? DYNAMIC_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const plan = buildAttemptPlan({ config, credentials, env });
  if (!plan.length) {
    return { ok: false, attempts: [], error: 'nessun provider AI disponibile: attiva Workers AI o inserisci una chiave', promptChars: userPrompt.length };
  }

  const attempts = [];
  // Due tentativi per modello e un tetto complessivo: il Worker ha un budget
  // di subrequest da rispettare.
  for (const entry of plan.slice(0, 5)) {
    for (const jsonMode of [true, false]) {
      if (attempts.length >= 10) break;
      const label = jsonMode ? 'json' : 'text';
      try {
        const { content, usage, resolvedModel } = await callModel({ ...entry, messages, config, credentials, env, jsonMode });
        const normalized = normalizeProposal(extractJson(content), allowedSymbols);
        if (!normalized.ok) {
          attempts.push({ ...entry, format: label, ok: false, error: normalized.error });
          continue;
        }
        attempts.push({ ...entry, format: label, ok: true, usage });
        return {
          ok: true,
          model: `${entry.provider}/${resolvedModel ?? entry.model}`,
          attempts,
          rawText: content,
          promptChars: userPrompt.length + systemPrompt.length,
          parsed: normalized.value,
          usage,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ ...entry, format: label, ok: false, error: message });
        // Modello ritirato o budget esaurito: inutile insistere sul formato.
        if (/unavailable|not found|404|no endpoints|subrequest|rate limit|429/i.test(message)) break;
      }
    }
  }

  const perModel = [];
  const seen = new Set();
  for (const attempt of attempts) {
    const key = `${attempt.provider}/${attempt.model}`;
    if (attempt.ok || seen.has(key)) continue;
    seen.add(key);
    perModel.push(`${key}: ${attempt.error}`);
  }
  return { ok: false, attempts, error: `nessuna proposta valida — ${perModel.join(' · ')}`, promptChars: userPrompt.length };
}
