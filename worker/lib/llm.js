/**
 * Astrazione multi-provider per il livello linguistico.
 *
 * OpenRouter sta ritirando progressivamente le varianti `:free`, quindi non può
 * essere l'unica strada. Workers AI usa un binding Cloudflare, ma la chiamata al
 * servizio rientra comunque nel budget dell'invocazione: la cascata deve quindi
 * poter passare subito anche a provider esterni configurati.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const PROVIDER_FALLBACK_ORDER = ['openrouter', 'workers-ai', 'gemini', 'groq'];

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
  'openrouter/free',
]);
const WORKERS_JSON_MODE_MODEL_SET = new Set([
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
]);
const WORKERS_NEMOTRON_MODEL = '@cf/nvidia/nemotron-3-120b-a12b';
const WORKERS_MISTRAL_SMALL_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const WORKERS_GUIDED_JSON_MODEL_SET = new Set([
  WORKERS_MISTRAL_SMALL_MODEL,
]);
const WORKERS_REASONING_MODEL_SET = new Set([
  '@cf/openai/gpt-oss-120b',
  WORKERS_NEMOTRON_MODEL,
  '@cf/qwen/qwen3-30b-a3b-fp8',
]);
const OPENROUTER_REASONING_EFFORT = new Map([
  // GLM 5.2 accetta soltanto high/xhigh: `medium` viene rifiutato da alcuni endpoint.
  ['z-ai/glm-5.2:free', 'high'],
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

export function isWorkersReasoningModel(model) {
  return WORKERS_REASONING_MODEL_SET.has(String(model ?? ''));
}

export function modelVendor(entry) {
  const model = String(entry?.model ?? '').replace(/^@cf\//, '');
  return model.split('/')[0] || String(entry?.provider ?? 'unknown');
}

const MODEL_REASONING_SCORE = new Map([
  ['nvidia/nemotron-3-ultra-550b-a55b:free', 100],
  ['z-ai/glm-5.2:free', 98],
  ['@cf/openai/gpt-oss-120b', 97],
  ['nvidia/nemotron-3-super-120b-a12b:free', 96],
  ['@cf/nvidia/nemotron-3-120b-a12b', 95],
  ['minimax/minimax-m3:free', 92],
  ['gemini-3.7-flash', 91],
  ['google/gemma-4-31b-it:free', 90],
  ['@cf/qwen/qwen3-30b-a3b-fp8', 88],
  ['openai/gpt-oss-120b', 94],
  ['qwen/qwen3.6-27b', 89],
  ['openai/gpt-oss-20b', 82],
  ['thinkingmachines/inkling:free', 87],
  ['thinkingmachines/inkling-small:free', 86],
  ['gemini-3.6-flash', 85],
  ['minimax/minimax-m2.7:free', 84],
  ['stealth/ox-alpha', 75],
  ['openrouter/free', 65],
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 45],
]);

const DEPRECATED_GROQ_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
]);

export function modelReasoningScore(entry) {
  return MODEL_REASONING_SCORE.get(String(entry?.model ?? '')) ?? 50;
}

/**
 * La qualità del modello precede sempre l'ordine del provider salvato. L'ordine
 * originario resta soltanto come spareggio stabile fra modelli non classificati.
 */
export function prioritizeReasoningPlan(plan) {
  return plan
    .map((entry, index) => ({ ...entry, index, score: modelReasoningScore(entry) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, score, ...entry }) => ({
      ...entry,
      reasoningScore: score,
      reasoningTier: score >= 90 ? 'advanced' : score >= 80 ? 'strong' : score >= 60 ? 'fallback' : 'basic-fallback',
    }));
}

/** Revisori: reasoning forte prima, poi laboratori diversi dal modello guida. */
export function prioritizeReviewPlan(plan, leadAttempt = null) {
  const leadVendor = modelVendor(leadAttempt);
  return [...plan].sort((left, right) => {
    const leftSameVendor = leadVendor && modelVendor(left) === leadVendor ? 1 : 0;
    const rightSameVendor = leadVendor && modelVendor(right) === leadVendor ? 1 : 0;
    if (leftSameVendor !== rightSameVendor) return leftSameVendor - rightSameVendor;
    return modelReasoningScore(right) - modelReasoningScore(left);
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
    defaultModels: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
  },
};

const DEBUG_PREVIEW_CHARS = 600;

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function makeAttemptId() {
  try { return crypto.randomUUID(); } catch { return `llm-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`; }
}

function messageChars(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    if (typeof message?.content === 'string') return total + message.content.length;
    try { return total + JSON.stringify(message?.content ?? '').length; } catch { return total; }
  }, 0);
}

function valueChars(value) {
  if (typeof value === 'string') return value.length;
  if (value == null) return 0;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const details = usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  return compactObject({
    promptTokens: Number.isFinite(Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount)) ? Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount) : undefined,
    completionTokens: Number.isFinite(Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount)) ? Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount) : undefined,
    totalTokens: Number.isFinite(Number(usage.total_tokens ?? usage.totalTokenCount)) ? Number(usage.total_tokens ?? usage.totalTokenCount) : undefined,
    reasoningTokens: Number.isFinite(Number(details?.reasoning_tokens ?? usage.reasoning_tokens)) ? Number(details?.reasoning_tokens ?? usage.reasoning_tokens) : undefined,
  });
}

function safeDebugUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;
  const normalized = compactObject({
    promptTokens: number(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount),
    completionTokens: number(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount),
    totalTokens: number(usage.totalTokens ?? usage.total_tokens ?? usage.totalTokenCount),
    reasoningTokens: number(usage.reasoningTokens ?? usage.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens),
  });
  return Object.keys(normalized).length ? normalized : undefined;
}

function safeRouterMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const available = Array.isArray(metadata.endpoints?.available) ? metadata.endpoints.available : [];
  const selected = available.find((item) => item?.selected);
  return compactObject({
    requested: typeof metadata.requested === 'string' ? safeModelOutputPreview(metadata.requested, 160) : undefined,
    strategy: typeof metadata.strategy === 'string' ? safeModelOutputPreview(metadata.strategy, 80) : undefined,
    region: typeof metadata.region === 'string' ? safeModelOutputPreview(metadata.region, 80) : undefined,
    summary: typeof metadata.summary === 'string' ? safeModelOutputPreview(metadata.summary, 240) : undefined,
    attempt: Number.isFinite(Number(metadata.attempt)) ? Number(metadata.attempt) : undefined,
    selectedProvider: typeof metadata.selectedProvider === 'string'
      ? safeModelOutputPreview(metadata.selectedProvider, 120)
      : typeof selected?.provider === 'string' ? safeModelOutputPreview(selected.provider, 120) : undefined,
    attempts: Array.isArray(metadata.attempts)
      ? metadata.attempts.slice(0, 8).map((item) => compactObject({
          provider: typeof item?.provider === 'string' ? safeModelOutputPreview(item.provider, 120) : undefined,
          model: typeof item?.model === 'string' ? safeModelOutputPreview(item.model, 180) : undefined,
          status: Number.isFinite(Number(item?.status)) ? Number(item.status) : undefined,
        }))
      : undefined,
    pipeline: Array.isArray(metadata.pipeline)
      ? metadata.pipeline.slice(0, 8).map((item) => compactObject({
          type: typeof item?.type === 'string' ? safeModelOutputPreview(item.type, 80) : undefined,
          name: typeof item?.name === 'string' ? safeModelOutputPreview(item.name, 120) : undefined,
        }))
      : undefined,
  });
}

/**
 * Consente al backend di loggare/persistire solo telemetria a schema chiuso.
 * Un SDK può allegare a Error.debug oggetti arbitrari, ciclici o contenenti
 * header/prompt: non devono attraversare la pipeline né arrivare a D1.
 */
function sanitizeAttemptDebug(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const string = (item, limit = 300) => typeof item === 'string' ? safeModelOutputPreview(item, limit) : undefined;
  const number = (item) => Number.isFinite(Number(item)) ? Number(item) : undefined;
  const boolean = (item) => typeof item === 'boolean' ? item : undefined;
  try {
    const payloadKeys = Array.isArray(value.payloadKeys)
      ? value.payloadKeys.filter((item) => typeof item === 'string').slice(0, 20).map((item) => safeModelOutputPreview(item, 80))
      : undefined;
    const router = safeRouterMetadata(value.router);
    return compactObject({
      version: number(value.version),
      attemptId: string(value.attemptId, 120),
      startedAt: number(value.startedAt),
      timeoutMs: number(value.timeoutMs),
      provider: string(value.provider, 80),
      requestedModel: string(value.requestedModel, 200),
      resolvedModel: string(value.resolvedModel, 200),
      structuredMode: string(value.structuredMode, 40),
      messageCount: number(value.messageCount),
      promptChars: number(value.promptChars),
      maxTokens: number(value.maxTokens),
      temperature: number(value.temperature),
      reasoningEffort: string(value.reasoningEffort, 40),
      category: string(value.category, 80),
      phase: string(value.phase, 80),
      elapsedMs: number(value.elapsedMs),
      timerFired: boolean(value.timerFired),
      httpStatus: number(value.httpStatus),
      statusText: string(value.statusText, 120),
      contentType: string(value.contentType, 160),
      bodyChars: number(value.bodyChars),
      payloadKeys,
      payloadShape: string(value.payloadShape, 500),
      responseId: string(value.responseId, 200),
      requestId: string(value.requestId, 200),
      generationId: string(value.generationId, 200),
      cfRay: string(value.cfRay, 160),
      retryAfter: typeof value.retryAfter === 'number' ? number(value.retryAfter) : string(value.retryAfter, 80),
      choiceCount: number(value.choiceCount),
      finishReason: string(value.finishReason, 120),
      nativeFinishReason: string(value.nativeFinishReason, 120),
      incompleteReason: string(value.incompleteReason, 160),
      contentPath: string(value.contentPath, 200),
      contentChars: number(value.contentChars),
      contentKind: string(value.contentKind, 80),
      reasoningChars: number(value.reasoningChars),
      usage: safeDebugUsage(value.usage),
      errorName: string(value.errorName, 120),
      errorCode: typeof value.errorCode === 'number' ? number(value.errorCode) : string(value.errorCode, 120),
      errorMessage: string(value.errorMessage, 300),
      router: router && Object.keys(router).length ? router : undefined,
    });
  } catch {
    return undefined;
  }
}

/** Anteprima dell'output del modello: mai prompt, header o credenziali. */
export function safeModelOutputPreview(value, limit = DEBUG_PREVIEW_CHARS) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value ?? ''); } catch { text = String(value ?? ''); }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:or-)?[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\bgsk_[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, Math.max(0, limit));
}

function modelOutputKind(value) {
  const text = typeof value === 'string' ? value : '';
  const trimmed = text.trimStart();
  if (!trimmed) return 'empty';
  if (trimmed.startsWith('{')) return 'json_object';
  if (trimmed.startsWith('[')) return 'json_array';
  if (trimmed.startsWith('```')) return 'code_fence';
  if (trimmed.startsWith('<')) return 'markup';
  return 'text';
}

export function supportsNativeJson(provider, model) {
  if (provider === 'openrouter') return STRUCTURED_MODEL_SET.has(model);
  if (provider === 'workers-ai') return WORKERS_JSON_MODE_MODEL_SET.has(model) || WORKERS_GUIDED_JSON_MODEL_SET.has(model);
  return ['gemini', 'groq'].includes(provider);
}

function structuredModeFor(provider, model, jsonMode, responseSchema) {
  if (!jsonMode) return 'none';
  if (!supportsNativeJson(provider, model)) return 'prompt_only';
  if (provider === 'workers-ai' && WORKERS_GUIDED_JSON_MODEL_SET.has(model)) {
    return responseSchema ? 'guided_json' : 'prompt_only';
  }
  if (responseSchema && ['openrouter', 'workers-ai'].includes(provider)) return 'json_schema';
  return 'json_object';
}

function modelContentPath(payload) {
  if (typeof payload === 'string') return '$';
  const choice = payload?.choices?.[0];
  if (choice?.message?.parsed != null) return 'choices[0].message.parsed';
  if (choice?.message?.content != null) return 'choices[0].message.content';
  if (choice?.text != null) return 'choices[0].text';
  if (payload?.output_text != null) return 'output_text';
  if (payload?.response != null) return 'response';
  if (payload?.result?.response != null) return 'result.response';
  if (Array.isArray(payload?.output)) return 'output[].content[].text';
  if (Array.isArray(payload?.result?.output)) return 'result.output[].content[].text';
  if (Array.isArray(payload?.candidates?.[0]?.content?.parts)) return 'candidates[0].content.parts[].text';
  return undefined;
}

function emptyContentCategory(debug) {
  const stopReason = `${debug?.finishReason ?? ''} ${debug?.nativeFinishReason ?? ''} ${debug?.incompleteReason ?? ''}`;
  return /length|max[_ -]?(?:output[_ -]?)?tokens?|token[_ -]?limit|incomplete/i.test(stopReason)
    ? 'truncated'
    : 'empty_content';
}

function providerErrorCategory(status, code) {
  const httpStatus = Number(status);
  const errorCode = Number(code);
  if (httpStatus === 429 || errorCode === 429 || errorCode === 3036) return 'rate_limit';
  if (errorCode === 3007) return 'timeout';
  if (errorCode === 3008) return 'aborted';
  if (errorCode === 3040) return 'capacity';
  if (httpStatus >= 500) return 'provider_error';
  if (Number.isFinite(httpStatus)) return 'http_error';
  return 'provider_error';
}

function payloadDebug(payload, { response, bodyText } = {}) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const output = payload?.output ?? payload?.result?.output;
  const directResponse = payload?.response ?? payload?.result?.response;
  const embeddedError = payload?.error ?? choice?.error ?? payload?.result?.error;
  const extractedContent = extractModelText(payload);
  const diagnosticContent = extractedContent || payload?.raw || '';
  const payloadKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).slice(0, 20)
    : [];
  const content = message?.parsed ?? message?.content;
  const reasoningChars = valueChars(message?.reasoning)
    + valueChars(message?.reasoning_details)
    + (Array.isArray(output)
      ? output.filter((item) => item?.type === 'reasoning').reduce((sum, item) => sum + valueChars(item?.summary ?? item), 0)
      : 0);
  const contentKind = Array.isArray(content) ? 'array' : content === null ? 'null' : typeof content;
  const shape = [
    Array.isArray(payload) ? `array(${payload.length})` : typeof payload,
    payloadKeys.length ? `keys:${payloadKeys.join(',')}` : null,
    Array.isArray(payload?.choices) ? `choices:${payload.choices.length}` : null,
    Array.isArray(output) ? `output:${output.map((item) => item?.type ?? typeof item).join(',')}` : null,
    directResponse !== undefined ? `response:${Array.isArray(directResponse) ? 'array' : typeof directResponse}` : null,
    message ? `message.content:${contentKind}` : null,
  ].filter(Boolean).join(' · ');
  return compactObject({
    httpStatus: response?.status,
    statusText: response?.statusText,
    contentType: response?.headers?.get?.('content-type') ?? undefined,
    bodyChars: typeof bodyText === 'string' ? bodyText.length : undefined,
    payloadKeys,
    payloadShape: shape,
    responseId: typeof payload?.id === 'string' ? payload.id : undefined,
    requestId: response?.headers?.get?.('x-request-id') ?? payload?.request_id ?? payload?.result?.request_id ?? undefined,
    generationId: response?.headers?.get?.('x-generation-id') ?? undefined,
    cfRay: response?.headers?.get?.('cf-ray') ?? undefined,
    retryAfter: response?.headers?.get?.('retry-after') ?? undefined,
    resolvedModel: typeof payload?.model === 'string' ? payload.model : undefined,
    choiceCount: Array.isArray(payload?.choices) ? payload.choices.length : undefined,
    finishReason: choice?.finish_reason ?? payload?.finish_reason ?? payload?.candidates?.[0]?.finishReason ?? undefined,
    nativeFinishReason: choice?.native_finish_reason ?? payload?.native_finish_reason ?? undefined,
    incompleteReason: payload?.incomplete_details?.reason ?? payload?.result?.incomplete_details?.reason ?? undefined,
    contentPath: modelContentPath(payload),
    contentChars: extractedContent.length || valueChars(content || directResponse || payload?.output_text),
    contentKind: modelOutputKind(diagnosticContent),
    reasoningChars: reasoningChars || undefined,
    usage: safeUsage(payload?.usage ?? payload?.usageMetadata ?? payload?.result?.usage),
    errorCode: typeof (embeddedError?.code ?? embeddedError?.type) === 'string'
      ? safeModelOutputPreview(embeddedError.code ?? embeddedError.type, 120)
      : embeddedError?.code ?? embeddedError?.type ?? undefined,
    errorMessage: typeof embeddedError?.message === 'string' ? safeModelOutputPreview(embeddedError.message, 300) : undefined,
    router: safeRouterMetadata(payload?.openrouter_metadata),
  });
}

function parsePayload(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: safeModelOutputPreview(text, 300) }; }
}

export class LlmCallError extends Error {
  constructor(message, debug = {}) {
    super(message);
    this.name = 'LlmCallError';
    this.debug = sanitizeAttemptDebug(debug) ?? {};
  }
}

export function llmErrorDebug(error) {
  if (!(error instanceof LlmCallError)) return undefined;
  return sanitizeAttemptDebug(error.debug);
}

export function extractModelText(payload) {
  if (typeof payload === 'string') return payload;
  const firstChoice = payload?.choices?.[0];
  const parsedContent = firstChoice?.message?.parsed;
  if (typeof parsedContent === 'string' && parsedContent.trim()) return parsedContent;
  if (parsedContent && typeof parsedContent === 'object') return JSON.stringify(parsedContent);
  const chatContent = firstChoice?.message?.content;
  if (typeof chatContent === 'string') return chatContent;
  if (chatContent && typeof chatContent === 'object' && !Array.isArray(chatContent)) return JSON.stringify(chatContent);
  if (Array.isArray(chatContent)) {
    const joined = chatContent.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (part?.text && typeof part.text === 'object') return JSON.stringify(part.text);
      return '';
    }).filter(Boolean).join('\n');
    if (joined) return joined;
  }
  if (typeof firstChoice?.text === 'string' && firstChoice.text.trim()) return firstChoice.text;
  for (const direct of [payload?.output_text, payload?.response, payload?.result?.response]) {
    if (typeof direct === 'string' && direct.trim()) return direct;
    // Workers AI JSON Mode restituisce ufficialmente `{ response: <object> }`.
    if (direct && typeof direct === 'object') return JSON.stringify(direct);
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
          if (part?.text && typeof part.text === 'object' && ['output_text', 'text'].includes(part.type ?? 'text')) texts.push(JSON.stringify(part.text));
        }
      }
    }
    if (texts.length) return texts.join('\n');
  }
  const geminiParts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(geminiParts)) {
    const text = geminiParts.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
    if (text) return text;
  }
  return '';
}

async function callOpenRouter({ apiKey, model, messages, temperature, maxTokens, jsonMode, responseSchema, referer, signal }) {
  if (!apiKey) throw new Error('chiave OpenRouter non configurata');
  const nativeJson = jsonMode && supportsNativeJson('openrouter', model);
  const reasoningEffort = OPENROUTER_REASONING_EFFORT.get(model) ?? 'medium';
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': referer || 'https://etorodashboard.workers.dev',
      'X-Title': 'Torino Autopilot',
      'X-OpenRouter-Metadata': 'enabled',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(REASONING_MODEL_SET.has(model) ? { reasoning: { effort: reasoningEffort, exclude: true } } : {}),
      ...(nativeJson ? {
        response_format: responseSchema ? {
          type: 'json_schema',
          json_schema: {
            name: 'portfolio_allocation',
            strict: true,
            schema: responseSchema,
          },
        } : { type: 'json_object' },
        ...(responseSchema ? { provider: { require_parameters: true } } : {}),
        plugins: [{ id: 'response-healing' }],
      } : {}),
    }),
  });
  const text = await response.text();
  const payload = parsePayload(text);
  const responseDebug = payloadDebug(payload, { response, bodyText: text });
  const embeddedError = payload?.error ?? payload?.choices?.[0]?.error;
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new LlmCallError(String(message).slice(0, 300), {
      category: providerErrorCategory(response.status, payload?.error?.code),
      phase: 'http',
      ...responseDebug,
    });
  }
  if (embeddedError) {
    const message = embeddedError?.message ?? 'OpenRouter ha restituito un errore nel payload';
    throw new LlmCallError(String(message).slice(0, 300), {
      category: providerErrorCategory(undefined, embeddedError?.code),
      phase: 'http',
      ...responseDebug,
    });
  }
  const content = extractModelText(payload);
  if (!content?.trim()) throw new LlmCallError(
    emptyContentCategory(responseDebug) === 'truncated' ? 'risposta troncata prima del contenuto finale' : 'risposta senza contenuto', {
    category: emptyContentCategory(responseDebug),
    phase: 'extract',
    ...responseDebug,
  });
  return {
    content,
    usage: payload?.usage ?? null,
    resolvedModel: payload?.model ?? model,
    responseDebug: { ...responseDebug, contentChars: content.length },
  };
}

async function callWorkersAi({ ai, model, messages, temperature, maxTokens, jsonMode, responseSchema }) {
  if (!ai) throw new Error('binding AI non configurato: aggiungi "ai": { "binding": "AI" } a wrangler.jsonc');
  const isNemotron = model === WORKERS_NEMOTRON_MODEL;
  const result = await ai.run(model, {
    messages,
    temperature,
    // Nemotron espone max_completion_tokens e reasoning_effort nel suo schema
    // Workers AI; GPT-OSS e Qwen mantengono invece max_tokens.
    ...(isNemotron
      ? { max_completion_tokens: maxTokens, reasoning_effort: 'low' }
      : { max_tokens: maxTokens }),
    ...(jsonMode && WORKERS_GUIDED_JSON_MODEL_SET.has(model) && responseSchema
      ? { guided_json: responseSchema }
      : jsonMode ? {
          response_format: responseSchema
            ? { type: 'json_schema', json_schema: responseSchema }
            : { type: 'json_object' },
        } : {}),
  });
  const responseDebug = payloadDebug(result);
  const embeddedError = result?.error ?? result?.result?.error;
  if (embeddedError) {
    throw new LlmCallError(String(embeddedError?.message ?? embeddedError).slice(0, 300), {
      category: providerErrorCategory(undefined, embeddedError?.code),
      phase: 'http',
      ...responseDebug,
    });
  }
  const content = extractModelText(result);
  if (!content?.trim()) throw new LlmCallError(
    emptyContentCategory(responseDebug) === 'truncated' ? 'risposta troncata prima del contenuto finale' : 'risposta senza contenuto', {
    category: emptyContentCategory(responseDebug),
    phase: 'extract',
    ...responseDebug,
  });
  return { content, usage: result?.usage ?? null, responseDebug: { ...responseDebug, contentChars: content.length } };
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
  const text = await response.text();
  const payload = parsePayload(text);
  const responseDebug = payloadDebug(payload, { response, bodyText: text });
  if (!response.ok) throw new LlmCallError(String(payload?.error?.message ?? `HTTP ${response.status}`).slice(0, 300), {
    category: providerErrorCategory(response.status, payload?.error?.code),
    phase: 'http',
    ...responseDebug,
  });
  if (payload?.error) throw new LlmCallError(String(payload.error?.message ?? payload.error).slice(0, 300), {
    category: providerErrorCategory(undefined, payload.error?.code),
    phase: 'http',
    ...responseDebug,
  });
  const content = extractModelText(payload);
  if (!content?.trim()) throw new LlmCallError(
    emptyContentCategory(responseDebug) === 'truncated' ? 'risposta troncata prima del contenuto finale' : 'risposta senza contenuto', {
    category: emptyContentCategory(responseDebug),
    phase: 'extract',
    ...responseDebug,
  });
  return { content, usage: payload?.usageMetadata ?? null, responseDebug: { ...responseDebug, contentChars: content.length } };
}

async function callGroq({ apiKey, model, messages, temperature, maxTokens, jsonMode, signal }) {
  if (!apiKey) throw new Error('chiave Groq non configurata');
  const isGptOss = /^openai\/gpt-oss-(?:20b|120b)$/.test(model);
  const isQwen36 = model === 'qwen/qwen3.6-27b';
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_completion_tokens: maxTokens,
      ...(isGptOss ? { reasoning_effort: 'low', include_reasoning: false } : {}),
      ...(isQwen36 ? {
        reasoning_effort: 'none',
        ...(jsonMode ? { reasoning_format: 'hidden' } : {}),
      } : {}),
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const text = await response.text();
  const payload = parsePayload(text);
  const responseDebug = payloadDebug(payload, { response, bodyText: text });
  if (!response.ok) throw new LlmCallError(String(payload?.error?.message ?? `HTTP ${response.status}`).slice(0, 300), {
    category: providerErrorCategory(response.status, payload?.error?.code),
    phase: 'http',
    ...responseDebug,
  });
  if (payload?.error) throw new LlmCallError(String(payload.error?.message ?? payload.error).slice(0, 300), {
    category: providerErrorCategory(undefined, payload.error?.code),
    phase: 'http',
    ...responseDebug,
  });
  const content = extractModelText(payload);
  if (!content?.trim()) throw new LlmCallError(
    emptyContentCategory(responseDebug) === 'truncated' ? 'risposta troncata prima del contenuto finale' : 'risposta senza contenuto', {
    category: emptyContentCategory(responseDebug),
    phase: 'extract',
    ...responseDebug,
  });
  return { content, usage: payload?.usage ?? null, responseDebug: { ...responseDebug, contentChars: content.length } };
}

/**
 * Costruisce la lista ordinata di tentativi (provider, modello) da provare.
 * Chi non ha la chiave necessaria viene saltato senza sprecare un tentativo.
 */
export function buildAttemptPlan({ config, credentials, env }) {
  const requested = Array.isArray(config.llmProviders) && config.llmProviders.length
    ? config.llmProviders
    : ['workers-ai'];
  // Le configurazioni storiche potevano disabilitare il fallback fra provider.
  // La policy quality-first corrente considera invece sempre ogni provider
  // realmente disponibile: il provider non deve precedere un modello migliore.
  const providerIds = [...new Set([...requested, ...PROVIDER_FALLBACK_ORDER])];
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
    const availableModels = providerId === 'groq'
      ? models.filter((model) => !DEPRECATED_GROQ_MODELS.has(model))
      : models;
    if (availableModels.length) routes.push({ provider: providerId, models: availableModels });
  }

  const plan = routes.flatMap((route) => route.models.map((model) => ({ provider: route.provider, model })));
  return prioritizeReasoningPlan(plan);
}

/**
 * Esegue una chiamata su un provider specifico.
 * @param {{jsonMode?: boolean, minimumMaxTokens?: number, responseSchema?: object}} options
 */
export async function callModel({ provider, model, messages, config, credentials, env, jsonMode = true, timeoutMs = 60_000, minimumMaxTokens = 0, responseSchema = null }) {
  const attemptId = makeAttemptId();
  const startedAt = Date.now();
  const structuredMode = structuredModeFor(provider, model, jsonMode, responseSchema);
  const nativeJson = ['json_object', 'json_schema', 'guided_json'].includes(structuredMode);
  const reasoningEffort = provider === 'openrouter' && REASONING_MODEL_SET.has(model)
    ? OPENROUTER_REASONING_EFFORT.get(model) ?? 'medium'
    : provider === 'groq' && /^openai\/gpt-oss-(?:20b|120b)$/.test(model)
      ? 'low'
      : provider === 'groq' && model === 'qwen/qwen3.6-27b'
        ? 'none'
        : provider === 'workers-ai' && model === WORKERS_NEMOTRON_MODEL
          ? 'low'
          : provider === 'workers-ai' && WORKERS_REASONING_MODEL_SET.has(model)
            ? 'model-default'
            : undefined;
  const configuredMaxTokens = Math.max(1, Number(config.llmMaxTokens) || 1, Number(minimumMaxTokens) || 0);
  // OpenRouter include i token di reasoning in max_tokens. Riserviamo almeno
  // ~1K token al JSON finale anche quando il modello richiede effort alto.
  // Workers AI riceve invece un minimo esplicito solo dai flussi decisionali:
  // così il watcher leggero non triplica silenziosamente il proprio budget.
  const reasoningFloor = provider === 'openrouter' && reasoningEffort === 'high'
    ? 5_120
    : ['openrouter', 'groq'].includes(provider) && reasoningEffort && reasoningEffort !== 'none'
      ? 2_048
      : 0;
  const effectiveMaxTokens = Math.max(configuredMaxTokens, reasoningFloor);
  const controller = new AbortController();
  let timerFired = false;
  let timer;
  const timeoutError = new Error(`timeout AI dopo ${timeoutMs} ms`);
  timeoutError.name = 'TimeoutError';
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timerFired = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const baseDebug = {
    version: 1,
    attemptId,
    startedAt,
    timeoutMs,
    provider,
    requestedModel: model,
    structuredMode,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    promptChars: messageChars(messages),
    maxTokens: effectiveMaxTokens,
    temperature: config.llmTemperature,
    reasoningEffort,
  };
  const common = {
    model,
    messages,
    temperature: config.llmTemperature,
    maxTokens: effectiveMaxTokens,
    jsonMode: nativeJson,
    responseSchema,
    signal: controller.signal,
  };
  try {
    const invoke = (() => {
      switch (provider) {
        case 'workers-ai': return callWorkersAi({ ...common, ai: env?.AI });
        case 'openrouter': return callOpenRouter({ ...common, apiKey: credentials?.openrouterApiKey, referer: env?.PUBLIC_URL });
        case 'gemini': return callGemini({ ...common, apiKey: credentials?.geminiApiKey });
        case 'groq': return callGroq({ ...common, apiKey: credentials?.groqApiKey });
        default: return Promise.reject(new Error(`provider sconosciuto: ${provider}`));
      }
    })();
    // Il binding Workers AI non accetta AbortSignal: il race impone comunque
    // un limite osservabile alla pipeline, anche se il runtime può continuare
    // a chiudere l'inferenza sottostante in background.
    const result = await Promise.race([invoke, timeoutPromise]);
    const debug = compactObject({
      ...baseDebug,
      category: 'ok',
      phase: 'complete',
      elapsedMs: Date.now() - startedAt,
      timerFired,
      ...result?.responseDebug,
      resolvedModel: result?.resolvedModel ?? result?.responseDebug?.resolvedModel ?? model,
      usage: safeUsage(result?.usage) ?? result?.responseDebug?.usage,
    });
    return { ...result, debug };
  } catch (error) {
    const sourceDebug = llmErrorDebug(error) ?? {};
    const timedOut = timerFired || error?.name === 'TimeoutError';
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = timedOut ? `timeout dopo ${timeoutMs} ms` : safeModelOutputPreview(rawMessage, 300);
    const debug = compactObject({
      ...baseDebug,
      ...sourceDebug,
      category: timedOut
        ? 'timeout'
        : sourceDebug.category ?? (error?.name === 'AbortError' ? 'aborted' : providerErrorCategory(undefined, error?.code)),
      phase: timedOut ? 'transport' : sourceDebug.phase ?? 'transport',
      elapsedMs: Date.now() - startedAt,
      timerFired,
      errorName: timedOut ? 'TimeoutError' : error?.name ?? 'Error',
      errorCode: sourceDebug.errorCode ?? error?.code,
      errorMessage: String(message).slice(0, 300),
    });
    console.warn('llm_attempt_failed', JSON.stringify(debug));
    throw new LlmCallError(message, debug);
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
