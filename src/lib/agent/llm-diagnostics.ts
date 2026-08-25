import type { LlmAttempt, LlmAttemptDebug } from './autopilot-api';

const SAFE_DEBUG_KEYS = [
  'version', 'attemptId', 'category', 'phase', 'startedAt', 'elapsedMs', 'timeoutMs',
  'timerFired', 'structuredMode', 'messageCount', 'promptChars', 'maxTokens',
  'temperature', 'reasoningEffort', 'httpStatus', 'statusText', 'contentType',
  'bodyChars', 'payloadKeys', 'payloadShape', 'responseId', 'requestId',
  'generationId', 'cfRay', 'retryAfter', 'requestedModel', 'resolvedModel',
  'choiceCount', 'finishReason', 'nativeFinishReason', 'contentChars', 'contentKind', 'candidateCount',
  'candidateKeys',
  'incompleteReason', 'contentPath', 'reasoningChars', 'usage', 'router',
  'errorName', 'errorCode', 'errorMessage', 'parseError', 'validationError',
] as const satisfies ReadonlyArray<keyof LlmAttemptDebug>;

const durationSeconds = new Intl.NumberFormat('it-IT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function redactText(value: string, limit = 1000): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:or-)?[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\bgsk_[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, limit);
}

function sanitizeUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const safe = Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => /token|cost/i.test(key) && Number.isFinite(Number(item)))
    .slice(0, 16)
    .map(([key, item]) => [key, Number(item)]));
  return Object.keys(safe).length ? safe : undefined;
}

function sanitizeRouter(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of ['requested', 'strategy', 'region', 'summary', 'selectedProvider'] as const) {
    if (typeof value[key] === 'string') safe[key] = redactText(value[key], 240);
  }
  if (Number.isFinite(Number(value.attempt))) safe.attempt = Number(value.attempt);
  if (Array.isArray(value.attempts)) safe.attempts = value.attempts.slice(0, 8).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      ...(typeof item.provider === 'string' ? { provider: redactText(item.provider, 120) } : {}),
      ...(typeof item.model === 'string' ? { model: redactText(item.model, 160) } : {}),
      ...(Number.isFinite(Number(item.status)) ? { status: Number(item.status) } : {}),
    }];
  });
  if (Array.isArray(value.pipeline)) safe.pipeline = value.pipeline.slice(0, 8).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      ...(typeof item.type === 'string' ? { type: redactText(item.type, 80) } : {}),
      ...(typeof item.name === 'string' ? { name: redactText(item.name, 120) } : {}),
    }];
  });
  return Object.keys(safe).length ? safe : undefined;
}

export function isLlmAttemptArray(value: unknown): value is LlmAttempt[] {
  return Array.isArray(value) && value.every((item) => (
    isRecord(item)
    && typeof item.model === 'string'
    && typeof item.ok === 'boolean'
  ));
}

function sanitizeDebug(debug: LlmAttemptDebug | undefined): Record<string, unknown> | undefined {
  if (!debug) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_DEBUG_KEYS) {
    const value = debug[key];
    if (value === undefined) continue;
    if (key === 'usage') {
      const usage = sanitizeUsage(value);
      if (usage) safe[key] = usage;
    } else if (key === 'router') {
      const router = sanitizeRouter(value);
      if (router) safe[key] = router;
    } else if (['payloadKeys', 'candidateKeys'].includes(key) && Array.isArray(value)) {
      safe[key] = value.filter((item): item is string => typeof item === 'string').slice(0, 20).map((item) => redactText(item, 80));
    } else if (typeof value === 'string') {
      safe[key] = redactText(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

/** Runtime allowlist: unknown future fields never enter copied technical reports. */
export function sanitizeLlmAttempts(attempts: readonly LlmAttempt[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => {
    const safe: Record<string, unknown> = {
      model: redactText(attempt.model, 200),
      ok: attempt.ok,
    };
    if (attempt.provider) safe.provider = redactText(attempt.provider, 80);
    if (attempt.format) safe.format = redactText(attempt.format, 40);
    if (attempt.error) safe.error = redactText(attempt.error);
    if (Number.isFinite(attempt.ms)) safe.ms = attempt.ms;
    if (attempt.resolvedModel) safe.resolvedModel = redactText(attempt.resolvedModel, 200);
    if (Number.isFinite(attempt.reasoningScore)) safe.reasoningScore = attempt.reasoningScore;
    if (attempt.reasoningTier) safe.reasoningTier = redactText(attempt.reasoningTier, 40);
    const usage = sanitizeUsage(attempt.usage);
    if (usage) safe.usage = usage;
    const debug = sanitizeDebug(attempt.debug);
    if (debug) safe.debug = debug;
    return safe;
  });
}

export function buildLlmTechnicalReport({
  source,
  attempts,
  runId,
  checkedAt,
}: {
  source: 'proposal' | 'diagnostics';
  attempts: readonly LlmAttempt[];
  runId?: string;
  checkedAt?: number;
}) {
  return {
    version: 1,
    source,
    ...(runId ? { runId } : {}),
    ...(Number.isFinite(checkedAt) ? { checkedAt } : {}),
    attempts: sanitizeLlmAttempts(attempts),
  };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${durationSeconds.format(ms / 1000)} s`;
}

/** Short facts for rows; full allowlisted detail remains available in copy report. */
export function llmAttemptDebugFacts(attempt: LlmAttempt): string[] {
  const debug = attempt.debug;
  const facts: string[] = [];
  const elapsedMs = Number(debug?.elapsedMs ?? attempt.ms);
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0) facts.push(formatElapsed(elapsedMs));

  const category = typeof debug?.category === 'string' ? debug.category : '';
  const phase = typeof debug?.phase === 'string' ? debug.phase : '';
  if (category || phase) facts.push([category, phase].filter(Boolean).join('/'));

  if (Number.isFinite(debug?.httpStatus)) {
    facts.push(`HTTP ${debug?.httpStatus}${debug?.statusText ? ` ${debug.statusText}` : ''}`);
  }

  const finishReason = typeof debug?.finishReason === 'string' ? debug.finishReason : '';
  const nativeFinishReason = typeof debug?.nativeFinishReason === 'string' ? debug.nativeFinishReason : '';
  if (finishReason || nativeFinishReason) {
    const finish = finishReason || nativeFinishReason;
    const native = nativeFinishReason && nativeFinishReason !== finish ? `/${nativeFinishReason}` : '';
    facts.push(`finish ${finish}${native}`);
  }

  if (Array.isArray(debug?.candidateKeys) && debug.candidateKeys.length) {
    facts.push(`chiavi JSON: ${debug.candidateKeys.slice(0, 6).join(', ')}`);
  }

  if (debug?.retryAfter !== undefined && debug.retryAfter !== null && String(debug.retryAfter).trim()) {
    facts.push(`retry-after ${String(debug.retryAfter).slice(0, 40)}`);
  }

  if (debug?.timerFired === true && !category.toLowerCase().includes('timeout')) facts.push('timer scaduto');
  return facts;
}

export async function copyJsonToClipboard(value: unknown): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard non disponibile in questo browser.');
  await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
}
