/**
 * Livello probabilistico: interroga OpenRouter con una cascata di modelli
 * gratuiti finché uno non restituisce una proposta JSON valida.
 *
 * Contratto invariante: il modello propone SOLO un'allocazione target.
 * Non conosce l'esistenza degli ordini e non può richiederne l'invio.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

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

async function callOpenRouter(apiKey, model, messages, { temperature, maxTokens, responseFormat, referer }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': referer || 'https://etorodashboard.workers.dev',
        'X-Title': 'Torino Autopilot',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error('risposta senza contenuto');
    return { content: typeof content === 'string' ? content : JSON.stringify(content), usage: payload?.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/** Elenco aggiornato dei modelli gratuiti disponibili su OpenRouter. */
export async function listFreeModels(apiKey) {
  const response = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`OpenRouter models HTTP ${response.status}`);
  const payload = await response.json();
  return (payload?.data ?? [])
    .filter((model) => Number(model?.pricing?.prompt ?? 1) === 0 && Number(model?.pricing?.completion ?? 1) === 0)
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.context_length ?? null,
      supportsJsonSchema: Boolean(model?.supported_parameters?.includes?.('structured_outputs')),
    }))
    .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
}

/**
 * Esegue la cascata di modelli. Per ogni modello prova, nell'ordine:
 * json_schema → json_object → testo libero con estrazione.
 */
export async function askBrain({ apiKey, models, featuresPrompt, allowedSymbols, config, referer }) {
  const userPrompt = `${featuresPrompt}\n\nOrizzonte del ribilanciamento: ${config.cadence === 'daily' ? 'giornaliero' : config.cadence === 'monthly' ? 'mensile' : 'settimanale'}.\nRispondi solo con il JSON dello schema richiesto.`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
  const formats = [
    { type: 'json_schema', json_schema: { name: 'allocation', strict: true, schema: RESPONSE_SCHEMA } },
    { type: 'json_object' },
    null,
  ];

  const attempts = [];
  for (const model of models) {
    for (const responseFormat of formats) {
      const label = responseFormat?.type ?? 'text';
      try {
        const { content, usage } = await callOpenRouter(apiKey, model, messages, {
          temperature: config.llmTemperature,
          maxTokens: config.llmMaxTokens,
          responseFormat,
          referer,
        });
        const parsedRaw = extractJson(content);
        const normalized = normalizeProposal(parsedRaw, allowedSymbols);
        if (!normalized.ok) {
          attempts.push({ model, format: label, ok: false, error: normalized.error });
          continue;
        }
        attempts.push({ model, format: label, ok: true, usage });
        return { ok: true, model, attempts, rawText: content, promptChars: userPrompt.length + SYSTEM_PROMPT.length, parsed: normalized.value, usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ model, format: label, ok: false, error: message });
        // Un 404/400 sul formato strutturato è tipico dei modelli free: si passa al formato successivo.
        if (/rate limit|429|quota|temporarily/i.test(message)) break;
      }
    }
  }
  return { ok: false, attempts, error: 'nessun modello ha prodotto una proposta valida', promptChars: userPrompt.length };
}
