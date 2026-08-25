/**
 * Livello probabilistico: interroga OpenRouter con una cascata di modelli
 * gratuiti finché uno non restituisce una proposta JSON valida.
 *
 * Contratto invariante: il modello propone SOLO un'allocazione target.
 * Non conosce l'esistenza degli ordini e non può richiederne l'invio.
 */

import {
  buildAttemptPlan, callModel, isWorkersReasoningModel, llmErrorDebug, modelVendor,
  supportsNativeJson,
} from './llm.js';

export { listFreeModels } from './llm.js';

const SYSTEM_PROMPT = `Sei un risk manager quantitativo. Ricevi lo stato di un portafoglio reale di piccola taglia e un insieme di indicatori già calcolati.

Il tuo unico output è un'allocazione TARGET in percentuale, in JSON valido, senza testo attorno.

Regole non negoziabili:
- La prima chiave deve chiamarsi esattamente "targetWeights": non rinominarla in allocation, portfolio, positions o altri alias.
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
- La prima chiave deve chiamarsi esattamente "targetWeights": non rinominarla in allocation, portfolio, positions o altri alias.
- Puoi usare SOLO i simboli presenti in CANDIDATI, più la voce CASH.
- I pesi sono decimali fra 0 e 1 e devono sommare esattamente a 1.
- Rispetta il numero minimo e massimo di strumenti indicato nei vincoli.
- Non superare il peso massimo di ciascuno strumento né i tetti per classe.
- Nessuna leva, nessuno short.
- Il minimo di posizioni è solo una barriera di sicurezza, non un obiettivo. Se il portafoglio è vuoto, costruisci una diversificazione completa e mira al numero di posizioni preferite indicato nei VINCOLI; usa meno titoli solo con una motivazione quantitativa esplicita.
- Non usare due ticker dello stesso gruppo_rischio: contano come una sola esposizione e il validatore ne manterrà soltanto uno.
- Prima di rispondere verifica aritmeticamente che, dopo i cap per strumento e classe, la cassa resti fra minimo e massimo. Non dichiarare di rispettare un cap se il peso proposto lo supera.

Disciplina di rotazione — è la parte che conta di più:
- Le posizioni marcate IN PORTAFOGLIO hanno un vantaggio implicito: cambiarle costa spread e commissioni. Sostituiscine una solo se il candidato è NETTAMENTE migliore, non marginalmente.
- Non ruotare il portafoglio per inseguire l'ultima settimana di performance. Preferisci la stabilità quando i segnali sono deboli o contraddittori.
- L'inazione è una scelta legittima: se l'allocazione attuale è ragionevole, riproponila quasi identica e abbassa la confidence.
- Le righe elencate in VINCOLI TEMPORALI non sono negoziabili: quegli strumenti non possono essere venduti o riacquistati adesso.
- Se il portafoglio è vuoto, il deployment iniziale non è turnover ricorrente. I cicli successivi ribilanciano solo oltre le bande di tolleranza: non descrivere l'intera costruzione iniziale come un costo settimanale permanente.

La confidence è la tua probabilità soggettiva che questa allocazione batta il mantenimento dello status quo sull'orizzonte indicato. Considera anche copertura e qualità degli storici; sii conservativo, ma non abbassarla solo perché il capitale reale è piccolo: i pesi sono percentuali.
rationale: massimo 700 caratteri, in italiano, spiega le scelte citando i numeri.

Schema di output:
{"targetWeights":{"SIMBOLO":0.00,"CASH":0.00},"confidence":0.00,"rationale":"...","risks":["..."],"watch":["..."]}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetWeights', 'confidence', 'rationale', 'risks', 'watch'],
  properties: {
    targetWeights: {
      type: 'object',
      description: 'Pesi target per simbolo e CASH; ogni valore è tra 0 e 1 e la somma è esattamente 1.',
      minProperties: 1,
      additionalProperties: { type: 'number', minimum: 0, maximum: 1 },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 700 },
    risks: { type: 'array', maxItems: 6, items: { type: 'string' } },
    watch: { type: 'array', maxItems: 6, items: { type: 'string' } },
  },
};

function jsonParseDiagnostic(error) {
  const message = error instanceof Error ? error.message : '';
  const position = message.match(/position\s+(\d+)/i)?.[1];
  const line = message.match(/line\s+(\d+)/i)?.[1];
  const column = message.match(/column\s+(\d+)/i)?.[1];
  if (position) return `JSON non valido alla posizione ${position}`;
  if (line && column) return `JSON non valido alla riga ${line}, colonna ${column}`;
  return 'JSON non valido';
}

/** Estrae un oggetto JSON bilanciato e conserva il motivo del fallimento. */
export function extractJsonResult(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return { value: input, error: null };
  if (typeof input !== 'string' || !input.trim()) return { value: null, error: 'contenuto vuoto' };
  const cleaned = input.replace(/```(?:json)?/gi, '').trim();
  let lastError = 'nessun oggetto JSON trovato';
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (start < 0) {
      if (char === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (inString && char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') { depth += 1; continue; }
    if (char !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try { return { value: JSON.parse(cleaned.slice(start, i + 1)), error: null }; } catch (error) {
      lastError = jsonParseDiagnostic(error);
      start = -1;
      inString = false;
      escaped = false;
    }
  }
  if (start >= 0) lastError = 'oggetto JSON incompleto o troncato';
  return { value: null, error: String(lastError).slice(0, 240) };
}

/** Compatibilità con i chiamanti esistenti. */
export function extractJson(text) {
  return extractJsonResult(text).value;
}

/**
 * Elenca oggetti JSON bilanciati anche dopo esempi o preamboli malformati.
 * Il limite evita scansioni quadratiche su output ostili o accidentalmente enormi.
 */
export function extractJsonCandidates(input, limit = 32) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return { values: [input], error: null };
  if (typeof input !== 'string' || !input.trim()) return { values: [], error: 'contenuto vuoto' };
  const cleaned = input.replace(/```(?:json)?/gi, '').trim();
  const values = [];
  let checked = 0;
  let lastError = 'nessun oggetto JSON trovato';
  for (let start = cleaned.indexOf('{'); start >= 0 && checked < limit; start = cleaned.indexOf('{', start + 1)) {
    checked += 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const char = cleaned[i];
      if (escaped) { escaped = false; continue; }
      if (inString && char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === '{') { depth += 1; continue; }
      if (char !== '}') continue;
      depth -= 1;
      if (depth !== 0) continue;
      closed = true;
      try {
        const parsed = JSON.parse(cleaned.slice(start, i + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values.push(parsed);
      } catch (error) {
        lastError = jsonParseDiagnostic(error);
      }
      break;
    }
    if (!closed) lastError = 'oggetto JSON incompleto o troncato';
  }
  return { values, error: values.length ? null : lastError };
}

/** Normalizza e verifica la forma della proposta. Non applica regole di rischio. */
export function normalizeProposal(raw, allowedSymbols) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'risposta non è un oggetto' };
  const aliases = [
    raw.targetWeights,
    raw.target_weights,
    raw.targetAllocation,
    raw.target_allocation,
    raw.portfolioWeights,
    raw.portfolio_weights,
    raw.weights,
  ];
  const looksLikeWeightMap = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((item) => Number.isFinite(Number(item)));
  const wrapper = [raw.allocation, raw.allocations, raw.portfolio, raw.positions].find(looksLikeWeightMap);
  const weightsRaw = aliases.find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? wrapper;
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

  let total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ok: false, error: 'somma pesi nulla' };
  const repairs = [];
  if (Math.abs(total - 1) > 0.05) {
    const difference = 1 - total;
    if (total < 0.75 || total > 1.30) {
      const direction = difference > 0 ? `manca il ${(difference * 100).toFixed(1)}%` : `eccede del ${(-difference * 100).toFixed(1)}%`;
      return {
        ok: false,
        error: `somma pesi ${total.toFixed(3)} fuori tolleranza: ${direction}`,
        details: { kind: 'weight_total', total, difference, repairable: false },
      };
    }
    if (difference > 0) {
      weights.CASH = (weights.CASH ?? 0) + difference;
      repairs.push({
        code: 'missing_weight_to_cash',
        originalTotal: total,
        message: `Il modello aveva assegnato ${(total * 100).toFixed(1)}%: il ${(difference * 100).toFixed(1)}% mancante è stato messo provvisoriamente in cassa prima dei guardrail.`,
      });
    } else {
      for (const key of Object.keys(weights)) weights[key] /= total;
      repairs.push({
        code: 'weights_rescaled',
        originalTotal: total,
        message: `Il modello aveva assegnato ${(total * 100).toFixed(1)}%: tutti i pesi sono stati riscalati proporzionalmente al 100% prima dei guardrail.`,
      });
    }
    total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  }
  for (const key of Object.keys(weights)) weights[key] = Math.round((weights[key] / total) * 10000) / 10000;
  const roundedTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const balanceKey = Object.hasOwn(weights, 'CASH') ? 'CASH' : Object.keys(weights)[0];
  weights[balanceKey] = Math.round((weights[balanceKey] + (1 - roundedTotal)) * 10000) / 10000;

  const confidence = Number(raw.confidence);
  return {
    ok: true,
    value: {
      targetWeights: weights,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : 0.5,
      rationale: String(raw.rationale ?? '').slice(0, 1500),
      risks: Array.isArray(raw.risks) ? raw.risks.map(String).slice(0, 6) : [],
      watch: Array.isArray(raw.watch) ? raw.watch.map(String).slice(0, 6) : [],
      repairs,
    },
  };
}

/** Seleziona il primo candidato JSON che rispetta davvero lo schema allocativo. */
export function findNormalizedProposal(input, allowedSymbols) {
  const extracted = extractJsonCandidates(input);
  if (!extracted.values.length) {
    return { ok: false, kind: 'invalid_json', error: 'risposta non è un oggetto', parseError: extracted.error };
  }
  let bestFailure = null;
  const candidateKeys = [];
  for (const candidate of extracted.values) {
    for (const key of Object.keys(candidate).slice(0, 12)) {
      if (!candidateKeys.includes(key)) candidateKeys.push(key);
    }
    const normalized = normalizeProposal(candidate, allowedSymbols);
    if (normalized.ok) return { ok: true, value: normalized.value, candidateCount: extracted.values.length };
    if (!bestFailure || candidate?.targetWeights || candidate?.target_weights || candidate?.weights) bestFailure = normalized;
  }
  return {
    ok: false,
    kind: 'schema_error',
    error: bestFailure?.error ?? 'targetWeights assente',
    details: bestFailure?.details ?? null,
    candidateCount: extracted.values.length,
    candidateKeys: candidateKeys.slice(0, 20),
  };
}

function routeKey(entry) {
  return `${entry?.provider ?? ''}/${entry?.model ?? ''}`;
}

/**
 * Mantiene la qualità, ma riserva spazio ai provider e ai vendor indipendenti
 * prima di riempire il budget con altri modelli dello stesso gruppo.
 */
export function selectDiverseAttemptPlan(plan, limit = 8) {
  const unique = [];
  const routeSeen = new Set();
  for (const entry of Array.isArray(plan) ? plan : []) {
    const key = routeKey(entry);
    if (!entry?.provider || !entry?.model || routeSeen.has(key)) continue;
    routeSeen.add(key);
    unique.push(entry);
  }
  const selected = [];
  const selectedRoutes = new Set();
  const providers = new Set();
  const vendors = new Set();
  const add = (entry) => {
    const key = routeKey(entry);
    if (selected.length >= limit || selectedRoutes.has(key)) return false;
    selected.push(entry);
    selectedRoutes.add(key);
    providers.add(entry.provider);
    vendors.add(modelVendor(entry));
    return true;
  };
  for (const entry of unique) if (!providers.has(entry.provider)) add(entry);
  for (const entry of unique) if (!vendors.has(modelVendor(entry))) add(entry);
  for (const entry of unique) add(entry);
  return selected;
}

/** In un retry porta davanti le route che la run precedente non ha raggiunto. */
export function prioritizeUntriedPlan(plan, previousAttempts = []) {
  const attempted = new Set((Array.isArray(previousAttempts) ? previousAttempts : []).map(routeKey));
  return [...plan].sort((left, right) => Number(attempted.has(routeKey(left))) - Number(attempted.has(routeKey(right))));
}

function debugWithOutput(debug, content, category, phase, extra = {}) {
  return {
    ...(debug ?? {}),
    category,
    phase,
    contentChars: typeof content === 'string' ? content.length : undefined,
    ...extra,
  };
}

function shouldRetryAsText(attempt) {
  if (!attempt?.debug || !['json_object', 'json_schema', 'guided_json'].includes(attempt.debug.structuredMode)) return false;
  if (['invalid_json', 'empty_content'].includes(attempt.debug.category)) return true;
  return ['http_error', 'provider_error'].includes(attempt.debug.category)
    && /response[_ -]?format|guided[_ -]?json|json[_ -]?(?:mode|schema)|structured/i.test(`${attempt.error ?? ''} ${attempt.debug.errorMessage ?? ''}`);
}

function decisionMinimumMaxTokens(entry) {
  if (entry?.provider === 'workers-ai' && entry?.model === '@cf/openai/gpt-oss-120b') return 5_120;
  return isWorkersReasoningModel(entry?.model) ? 3_200 : 0;
}

function responseWasTruncated(debug) {
  const stop = `${debug?.finishReason ?? ''} ${debug?.nativeFinishReason ?? ''} ${debug?.incompleteReason ?? ''}`;
  return /length|max[_ -]?(?:output[_ -]?)?tokens?|token[_ -]?limit|incomplete/i.test(stop);
}

function buildCorrectionMessages(messages, previousContent, error, details = null) {
  const total = Number(details?.total);
  const arithmetic = Number.isFinite(total)
    ? ` Il totale precedente era ${(total * 100).toFixed(1)}%: ricalcola tutti i pesi e verifica che la nuova somma sia 1.0000.`
    : ' Calcola numericamente la somma dei pesi e verifica che sia 1.0000.';
  const correction = [
    `La risposta precedente è stata rifiutata: ${String(error ?? 'output non valido').slice(0, 300)}.`,
    'Rispondi di nuovo SOLO con un unico oggetto JSON completo; la prima chiave deve essere esattamente "targetWeights".',
    'Non usare alias come allocation, portfolio o positions. Usa soltanto simboli consentiti e CASH, con valori decimali tra 0 e 1.',
    `${arithmetic} Non aggiungere spiegazioni fuori dal JSON.`,
  ].join(' ');
  return [
    ...messages,
    ...(typeof previousContent === 'string' && previousContent.trim()
      ? [{ role: 'assistant', content: previousContent.slice(0, 6_000) }]
      : []),
    { role: 'user', content: correction },
  ];
}

/**
 * Prova ogni coppia provider/modello con una richiesta minima e riporta
 * l'errore esatto. È il modo più diretto per scoprire che un modello gratuito
 * è stato ritirato: i cataloghi cambiano di continuo.
 */
export async function probeModels({ config, credentials, env }) {
  const plan = selectDiverseAttemptPlan(buildAttemptPlan({ config, credentials, env }), 8);
  if (!plan.length) return [{ provider: '—', model: '—', ok: false, error: 'nessun provider configurato o chiave mancante' }];
  const results = [];
  // Il piano gratuito di Cloudflare concede 50 subrequest per invocazione:
  // un probe illimitato le esaurirebbe da solo.
  for (const attempt of plan.slice(0, 8)) {
    const startedAt = Date.now();
    const jsonMode = supportsNativeJson(attempt.provider, attempt.model);
    try {
      const response = await callModel({
        ...attempt,
        messages: [{ role: 'user', content: 'Rispondi solo con: {"ok":true}' }],
        // 32 token non lasciano spazio alla risposta finale dei reasoning model.
        config: { ...config, llmMaxTokens: Math.max(1_600, Number(config.llmMaxTokens) || 0) },
        credentials,
        env,
        jsonMode: true,
        timeoutMs: 20_000,
        minimumMaxTokens: isWorkersReasoningModel(attempt.model) ? 3_200 : 0,
      });
      const parsed = extractJson(response.content);
      if (parsed?.ok !== true) {
        results.push({
          ...attempt,
          format: jsonMode ? 'json' : 'text',
          ok: false,
          error: 'risposta di probe non valida',
          ms: Date.now() - startedAt,
          debug: debugWithOutput(response.debug, response.content, 'invalid_json', 'parse'),
        });
        continue;
      }
      results.push({ ...attempt, format: jsonMode ? 'json' : 'text', ok: true, ms: Date.now() - startedAt, debug: response.debug });
    } catch (error) {
      results.push({
        ...attempt,
        format: jsonMode ? 'json' : 'text',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - startedAt,
        debug: llmErrorDebug(error),
      });
    }
  }
  return results;
}

/** In revisione prova prima un provider diverso, poi un modello diverso. */
export function prioritizeAlternativeProvider(plan, previousModel = '') {
  const previousProvider = String(previousModel).split('/')[0];
  const previousSuffix = String(previousModel).slice(previousProvider.length + 1);
  return [...plan].sort((left, right) => {
    const rank = (entry) => {
      if (entry.provider !== previousProvider) return 0;
      return entry.model === previousSuffix ? 2 : 1;
    };
    return rank(left) - rank(right);
  });
}

/**
 * Cascata multi-provider. Prova route diverse e usa il fallback testuale solo
 * quando una risposta JSON nativa è arrivata ma non era valida.
 */
export async function askBrain({ config, credentials, env, featuresPrompt, allowedSymbols, dynamic = false, profileDescription = '', ledgerNotes = [], revisionContext = '', previousModel = '', previousAttempts = [] }) {
  const horizon = config.cadence === 'daily' ? 'giornaliero' : config.cadence === 'monthly' ? 'mensile' : 'settimanale';
  const userPrompt = [
    featuresPrompt,
    '',
    profileDescription ? `STRATEGIA ${profileDescription}` : '',
    revisionContext ? `REVISIONE RICHIESTA\n${revisionContext}` : '',
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

  const basePlan = buildAttemptPlan({ config, credentials, env });
  const alternativeFirst = previousModel ? prioritizeAlternativeProvider(basePlan, previousModel) : basePlan;
  const untriedFirst = prioritizeUntriedPlan(alternativeFirst, previousAttempts);
  const plan = selectDiverseAttemptPlan(untriedFirst, 10);
  if (!plan.length) {
    return { ok: false, attempts: [], error: 'nessun provider AI disponibile: attiva Workers AI o inserisci una chiave', promptChars: userPrompt.length };
  }

  const attempts = [];
  const runAttempt = async (entry, jsonMode, label, attemptMessages = messages, minimumMaxTokens = decisionMinimumMaxTokens(entry)) => {
    try {
      const response = await callModel({
        ...entry,
        messages: attemptMessages,
        config,
        credentials,
        env,
        jsonMode,
        minimumMaxTokens,
        responseSchema: RESPONSE_SCHEMA,
        timeoutMs: entry.provider === 'workers-ai' && entry.model === '@cf/openai/gpt-oss-120b' ? 75_000 : 60_000,
      });
      const found = findNormalizedProposal(response.content, allowedSymbols);
      if (!found.ok && found.kind === 'invalid_json') {
        const truncated = responseWasTruncated(response.debug);
        const category = truncated ? 'truncated' : 'invalid_json';
        const error = truncated ? 'risposta troncata prima del JSON completo' : 'risposta non è un oggetto';
        const debug = debugWithOutput(response.debug, response.content, category, 'parse', { parseError: found.parseError });
        const attempt = { ...entry, format: label, ok: false, error, usage: response.usage, debug };
        attempts.push(attempt);
        console.warn('llm_attempt_invalid_output', JSON.stringify({ provider: entry.provider, model: entry.model, ...debug }));
        return {
          attempt,
          retry: {
            messages: buildCorrectionMessages(attemptMessages, response.content, error),
            minimumMaxTokens: truncated ? Math.max(minimumMaxTokens, 8_000) : minimumMaxTokens,
          },
        };
      }
      if (!found.ok) {
        const debug = debugWithOutput(response.debug, response.content, 'schema_error', 'normalize', {
          validationError: found.error,
          candidateCount: found.candidateCount,
          candidateKeys: found.candidateKeys,
        });
        const attempt = {
          ...entry,
          format: label,
          ok: false,
          error: found.error,
          details: found.details ?? null,
          usage: response.usage,
          debug,
        };
        attempts.push(attempt);
        console.warn('llm_attempt_invalid_output', JSON.stringify({ provider: entry.provider, model: entry.model, ...debug }));
        return {
          attempt,
          retry: {
            messages: buildCorrectionMessages(attemptMessages, response.content, found.error, found.details),
            minimumMaxTokens,
          },
        };
      }
      attempts.push({ ...entry, format: label, ok: true, usage: response.usage, debug: response.debug });
      return {
        success: {
          ok: true,
          model: `${entry.provider}/${response.resolvedModel ?? entry.model}`,
          attempts,
          rawText: response.content,
          promptChars: userPrompt.length + systemPrompt.length,
          parsed: found.value,
          usage: response.usage,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = { ...entry, format: label, ok: false, error: message, debug: llmErrorDebug(error) };
      attempts.push(attempt);
      const retry = attempt.debug?.category === 'truncated'
        ? {
            messages: buildCorrectionMessages(attemptMessages, '', message),
            minimumMaxTokens: Math.max(minimumMaxTokens, 8_000),
          }
        : null;
      return { attempt, retry };
    }
  };

  // Prima passata: più route indipendenti. Gli slot residui vengono usati per
  // correggere output malformati o per uscire da un JSON mode incompatibile.
  const correctiveRetries = [];
  const blockedProviders = new Set();
  let primaryCalls = 0;
  for (const entry of plan) {
    if (attempts.length >= 10 || primaryCalls >= 8) break;
    if (blockedProviders.has(entry.provider)) continue;
    const nativeJson = supportsNativeJson(entry.provider, entry.model);
    const result = await runAttempt(entry, true, nativeJson ? 'json' : 'text');
    primaryCalls += 1;
    if (result.success) return result.success;
    if (shouldRetryAsText(result.attempt)) {
      correctiveRetries.push({ entry, jsonMode: false, label: 'text-fallback', messages, minimumMaxTokens: decisionMinimumMaxTokens(entry) });
    } else if (result.retry) {
      correctiveRetries.push({
        entry,
        jsonMode: true,
        label: `${nativeJson ? 'json' : 'text'}-repair`,
        ...result.retry,
      });
    }
    const status = Number(result.attempt?.debug?.httpStatus);
    // Un 429 può appartenere soltanto al modello/upstream corrente. Bloccare
    // l'intero provider impedirebbe di provare gli altri endpoint gratuiti.
    if ([401, 402].includes(status)) blockedProviders.add(entry.provider);
  }
  for (const retry of correctiveRetries) {
    if (attempts.length >= 10) break;
    if (blockedProviders.has(retry.entry.provider)) continue;
    const result = await runAttempt(
      retry.entry,
      retry.jsonMode,
      retry.label,
      retry.messages,
      retry.minimumMaxTokens,
    );
    if (result.success) return result.success;
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
