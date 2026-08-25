/**
 * Astrazione multi-provider per il livello linguistico.
 *
 * OpenRouter sta ritirando progressivamente le varianti `:free`, quindi non può
 * essere l'unica strada. Workers AI gira dentro il Worker come binding: non
 * consuma subrequest, è incluso nel piano gratuito di Cloudflare ed è sempre
 * disponibile. È quindi il provider predefinito, con gli altri come fallback.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Modelli testuali di Workers AI adatti a ragionamento strutturato.
 * Il prefisso `@cf/` è la convenzione dei modelli ospitati da Cloudflare.
 */
export const WORKERS_AI_MODELS = [
  '@cf/openai/gpt-oss-120b',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];

export const PROVIDERS = {
  'workers-ai': {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    note: 'Incluso nel piano gratuito di Cloudflare. Gira dentro il Worker: nessuna chiave, nessun limite di subrequest.',
    needsKey: false,
    defaultModels: WORKERS_AI_MODELS.slice(0, 2),
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    note: 'Catalogo ampio. Le varianti :free vengono ritirate spesso: verifica la disponibilità dalla Diagnostica.',
    needsKey: 'openrouterApiKey',
    defaultModels: [],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    note: 'Free tier generoso e stabile. Chiave gratuita da aistudio.google.com.',
    needsKey: 'geminiApiKey',
    defaultModels: ['gemini-3.7-flash', 'gemini-3.6-flash'],
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    note: 'Inferenza molto veloce, free tier a rate limit. Chiave da console.groq.com.',
    needsKey: 'groqApiKey',
    defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
};

function extractText(payload) {
  return payload?.choices?.[0]?.message?.content
    ?? payload?.response
    ?? payload?.result?.response
    ?? payload?.candidates?.[0]?.content?.parts?.[0]?.text
    ?? '';
}

async function callOpenRouter({ apiKey, model, messages, temperature, maxTokens, jsonMode, referer, signal }) {
  if (!apiKey) throw new Error('chiave OpenRouter non configurata');
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': referer || 'https://etorodashboard.workers.dev',
      'X-Title': 'Torino Autopilot',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 300));
  }
  const content = extractText(payload);
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: payload?.usage ?? null };
}

async function callWorkersAi({ ai, model, messages, temperature, maxTokens }) {
  if (!ai) throw new Error('binding AI non configurato: aggiungi "ai": { "binding": "AI" } a wrangler.jsonc');
  const result = await ai.run(model, { messages, temperature, max_tokens: maxTokens });
  const content = extractText(result) || (typeof result === 'string' ? result : '');
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: null };
}

async function callGemini({ apiKey, model, messages, temperature, maxTokens, jsonMode, signal }) {
  if (!apiKey) throw new Error('chiave Gemini non configurata');
  const system = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n');
  const contents = messages
    .filter((item) => item.role !== 'system')
    .map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] }));
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.error?.message ?? `HTTP ${response.status}`).slice(0, 300));
  const content = extractText(payload);
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: payload?.usageMetadata ?? null };
}

async function callGroq({ apiKey, model, messages, temperature, maxTokens, jsonMode, signal }) {
  if (!apiKey) throw new Error('chiave Groq non configurata');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.error?.message ?? `HTTP ${response.status}`).slice(0, 300));
  const content = extractText(payload);
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: payload?.usage ?? null };
}

/**
 * Costruisce la lista ordinata di tentativi (provider, modello) da provare.
 * Chi non ha la chiave necessaria viene saltato senza sprecare un tentativo.
 */
export function buildAttemptPlan({ config, credentials, env }) {
  const plan = [];
  for (const providerId of config.llmProviders ?? ['workers-ai']) {
    const provider = PROVIDERS[providerId];
    if (!provider) continue;
    if (provider.needsKey && !credentials?.[provider.needsKey]) continue;
    if (providerId === 'workers-ai' && !env?.AI) continue;
    const models = (config.llmModels?.[providerId] ?? provider.defaultModels ?? []).filter(Boolean);
    for (const model of models) plan.push({ provider: providerId, model });
  }
  return plan;
}

/**
 * Esegue una chiamata su un provider specifico.
 * @param {{jsonMode?: boolean}} options
 */
export async function callModel({ provider, model, messages, config, credentials, env, jsonMode = true, timeoutMs = 60_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const common = {
    model,
    messages,
    temperature: config.llmTemperature,
    maxTokens: config.llmMaxTokens,
    jsonMode,
    signal: controller.signal,
  };
  try {
    switch (provider) {
      case 'workers-ai': return await callWorkersAi({ ...common, ai: env?.AI });
      case 'openrouter': return await callOpenRouter({ ...common, apiKey: credentials?.openrouterApiKey, referer: env?.PUBLIC_URL });
      case 'gemini': return await callGemini({ ...common, apiKey: credentials?.geminiApiKey });
      case 'groq': return await callGroq({ ...common, apiKey: credentials?.groqApiKey });
      default: throw new Error(`provider sconosciuto: ${provider}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Elenco dei modelli gratuiti di OpenRouter, limitato a quelli testuali di chat. */
export async function listFreeModels(apiKey) {
  const response = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`OpenRouter models HTTP ${response.status}`);
  const payload = await response.json();
  return (payload?.data ?? [])
    .filter((model) => {
      const free = Number(model?.pricing?.prompt ?? 1) === 0 && Number(model?.pricing?.completion ?? 1) === 0;
      if (!free) return false;
      // Senza questo filtro finiscono in lista modelli di immagini, audio o musica.
      const modality = String(model?.architecture?.modality ?? '');
      const outputs = model?.architecture?.output_modalities ?? [];
      const textOut = modality.endsWith('->text') || (Array.isArray(outputs) && outputs.includes('text'));
      const textIn = !modality || modality.startsWith('text');
      return textOut && textIn;
    })
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.context_length ?? null,
    }))
    .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
}
