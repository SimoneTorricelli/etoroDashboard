/**
 * Astrazione multi-provider per il livello linguistico.
 *
 * OpenRouter sta ritirando progressivamente le varianti `:free`, quindi non può
 * essere l'unica strada. Workers AI usa un binding Cloudflare, ma la chiamata al
 * servizio rientra comunque nel budget dell'invocazione: la cascata deve quindi
 * poter passare subito anche a provider esterni configurati.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const PROVIDER_FALLBACK_ORDER = ['workers-ai', 'gemini', 'groq', 'openrouter'];

/**
 * Modelli OpenRouter gratuiti scelti per ragionamento e, quando disponibile,
 * output strutturato. I modelli musicali, di safety, coding-only o percettivi
 * non sono adatti a decidere o revisionare una policy di portafoglio.
 */
export const OPENROUTER_REASONING_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'z-ai/glm-5.2:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m3:free',
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m2.7:free',
];

const REASONING_MODEL_SET = new Set(OPENROUTER_REASONING_MODELS);
const STRUCTURED_MODEL_SET = new Set([
  'z-ai/glm-5.2:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m3:free',
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m2.7:free',
  'stealth/ox-alpha',
]);
const MODEL_FIT = new Map([
  ['nvidia/nemotron-3-ultra-550b-a55b:free', 'Guida e revisione complessa'],
  ['z-ai/glm-5.2:free', 'Verifica numerica e JSON'],
  ['nvidia/nemotron-3-super-120b-a12b:free', 'Revisione multi-step'],
  ['minimax/minimax-m3:free', 'Sintesi e fallback'],
  ['google/gemma-4-31b-it:free', 'Revisione strutturata'],
  ['minimax/minimax-m2.7:free', 'Fallback operativo'],
]);

export function isFreeOpenRouterModel(model) {
  const id = String(model ?? '').trim();
  return id === 'openrouter/free' || id.endsWith(':free') || id === 'stealth/ox-alpha';
}

export function modelVendor(entry) {
  const model = String(entry?.model ?? '').replace(/^@cf\//, '');
  return model.split('/')[0] || String(entry?.provider ?? 'unknown');
}

const REVIEW_MODEL_SCORE = new Map([
  ['nvidia/nemotron-3-ultra-550b-a55b:free', 100],
  ['z-ai/glm-5.2:free', 98],
  ['@cf/openai/gpt-oss-120b', 97],
  ['nvidia/nemotron-3-super-120b-a12b:free', 96],
  ['@cf/nvidia/nemotron-3-120b-a12b', 95],
  ['minimax/minimax-m3:free', 92],
  ['google/gemma-4-31b-it:free', 90],
  ['@cf/qwen/qwen3-30b-a3b-fp8', 88],
  ['minimax/minimax-m2.7:free', 84],
]);

/** Revisori: reasoning forte prima, poi laboratori diversi dal modello guida. */
export function prioritizeReviewPlan(plan, leadAttempt = null) {
  const leadVendor = modelVendor(leadAttempt);
  return [...plan].sort((left, right) => {
    const leftSameVendor = leadVendor && modelVendor(left) === leadVendor ? 1 : 0;
    const rightSameVendor = leadVendor && modelVendor(right) === leadVendor ? 1 : 0;
    if (leftSameVendor !== rightSameVendor) return leftSameVendor - rightSameVendor;
    return (REVIEW_MODEL_SCORE.get(right.model) ?? 0) - (REVIEW_MODEL_SCORE.get(left.model) ?? 0);
  });
}

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
    note: 'Binding Cloudflare senza chiave separata. Condivide i limiti operativi dell’invocazione del Worker.',
    needsKey: false,
    defaultModels: WORKERS_AI_MODELS.slice(0, 2),
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    note: 'Catalogo ampio. Le varianti :free vengono ritirate spesso: verifica la disponibilità dalla Diagnostica.',
    needsKey: 'openrouterApiKey',
    // Fallback ufficiale di OpenRouter: se l'utente non ha scelto un modello
    // specifico, il router seleziona un modello gratuito compatibile con JSON.
    defaultModels: [...OPENROUTER_REASONING_MODELS, 'openrouter/free'],
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

export function extractModelText(payload) {
  if (typeof payload === 'string') return payload;
  const chatContent = payload?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') return chatContent;
  if (Array.isArray(chatContent)) {
    const joined = chatContent.map((part) => typeof part === 'string' ? part : part?.text ?? '').filter(Boolean).join('\n');
    if (joined) return joined;
  }
  for (const direct of [payload?.output_text, payload?.response, payload?.result?.response]) {
    if (typeof direct === 'string' && direct.trim()) return direct;
  }
  // GPT-OSS sul binding Workers AI può restituire il formato Responses API:
  // output[].content[].text, preceduto da elementi di reasoning senza testo finale.
  const output = payload?.output ?? payload?.result?.output;
  if (Array.isArray(output)) {
    const texts = [];
    for (const item of output) {
      if (typeof item?.text === 'string') texts.push(item.text);
      if (typeof item?.content === 'string') texts.push(item.content);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string' && ['output_text', 'text'].includes(part.type ?? 'text')) texts.push(part.text);
        }
      }
    }
    if (texts.length) return texts.join('\n');
  }
  const geminiText = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof geminiText === 'string' ? geminiText : '';
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
      ...(REASONING_MODEL_SET.has(model) ? { reasoning: { effort: 'medium', exclude: true } } : {}),
      ...(jsonMode && STRUCTURED_MODEL_SET.has(model) ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 300));
  }
  const content = extractModelText(payload);
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: payload?.usage ?? null, resolvedModel: payload?.model ?? model };
}

async function callWorkersAi({ ai, model, messages, temperature, maxTokens, jsonMode }) {
  if (!ai) throw new Error('binding AI non configurato: aggiungi "ai": { "binding": "AI" } a wrangler.jsonc');
  const result = await ai.run(model, {
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  const content = extractModelText(result);
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: result?.usage ?? null };
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
  const content = extractModelText(payload);
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
  const content = extractModelText(payload);
  if (!content) throw new Error('risposta senza contenuto');
  return { content, usage: payload?.usage ?? null };
}

/**
 * Costruisce la lista ordinata di tentativi (provider, modello) da provare.
 * Chi non ha la chiave necessaria viene saltato senza sprecare un tentativo.
 */
export function buildAttemptPlan({ config, credentials, env }) {
  const requested = Array.isArray(config.llmProviders) && config.llmProviders.length
    ? config.llmProviders
    : ['workers-ai'];
  // Le vecchie configurazioni salvavano soltanto Workers AI. Salvo opt-out
  // esplicito, aggiungiamo in coda ogni provider oggi disponibile e proviamo un
  // modello per provider prima di tornare al secondo modello dello stesso.
  const providerIds = config.llmFallbackAcrossProviders === false
    ? [...new Set(requested)]
    : [...new Set([...requested, ...PROVIDER_FALLBACK_ORDER])];
  const routes = [];
  for (const providerId of providerIds) {
    const provider = PROVIDERS[providerId];
    if (!provider) continue;
    if (provider.needsKey && !credentials?.[provider.needsKey]) continue;
    if (providerId === 'workers-ai' && !env?.AI) continue;
    const configuredModels = Array.isArray(config.llmModels?.[providerId])
      ? config.llmModels[providerId]
      : [];
    const models = providerId === 'openrouter'
      ? [...new Set([...(provider.defaultModels ?? []), ...configuredModels]
        .filter((model) => model && isFreeOpenRouterModel(model)))]
      : [...new Set([...(provider.defaultModels ?? []), ...configuredModels].filter(Boolean))];
    if (models.length) routes.push({ provider: providerId, models });
  }

  const plan = [];
  const depth = Math.max(0, ...routes.map((route) => route.models.length));
  for (let index = 0; index < depth; index += 1) {
    for (const route of routes) {
      if (route.models[index]) plan.push({ provider: route.provider, model: route.models[index] });
    }
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
      const textOut = Array.isArray(outputs) && outputs.length
        ? outputs.length === 1 && outputs[0] === 'text'
        : modality.endsWith('->text');
      const textIn = !modality || modality.startsWith('text');
      return textOut && textIn && !String(model?.id ?? '').includes('content-safety');
    })
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.context_length ?? null,
      recommendedRank: OPENROUTER_REASONING_MODELS.indexOf(model.id) >= 0
        ? OPENROUTER_REASONING_MODELS.indexOf(model.id) + 1
        : null,
      fit: MODEL_FIT.get(model.id) ?? null,
      reasoning: Array.isArray(model.supported_parameters) && (model.supported_parameters.includes('reasoning') || model.supported_parameters.includes('reasoning_effort')),
      structuredOutput: Array.isArray(model.supported_parameters) && (model.supported_parameters.includes('response_format') || model.supported_parameters.includes('structured_outputs')),
    }))
    .sort((a, b) => (a.recommendedRank ?? Number.MAX_SAFE_INTEGER) - (b.recommendedRank ?? Number.MAX_SAFE_INTEGER)
      || (b.contextLength ?? 0) - (a.contextLength ?? 0));
}
