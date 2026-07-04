export type LlmProviderName = 'openrouter' | 'openai' | 'anthropic' | 'opencode' | 'gemini';

const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_LLM_CONCURRENCY_LIMIT = 50;
const MAX_LLM_CONCURRENCY_LIMIT = 100;

let activeRequests = 0;
const waitingRequests: Array<() => void> = [];

export function selectedLlmProvider(): LlmProviderName {
  if (process.env.LLM_PROVIDER === 'anthropic') return 'anthropic';
  if (process.env.LLM_PROVIDER === 'opencode') return 'opencode';
  if (process.env.LLM_PROVIDER === 'openai') return 'openai';
  if (process.env.LLM_PROVIDER === 'gemini') return 'gemini';
  return 'openrouter';
}

export function llmRequestTimeoutMs(): number {
  return positiveIntegerFromEnv('LLM_REQUEST_TIMEOUT_MS', DEFAULT_LLM_REQUEST_TIMEOUT_MS);
}

export function llmConcurrencyLimit(): number {
  return Math.min(
    positiveIntegerFromEnv('LLM_CONCURRENCY_LIMIT', DEFAULT_LLM_CONCURRENCY_LIMIT),
    MAX_LLM_CONCURRENCY_LIMIT,
  );
}

export async function withLlmRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = llmRequestTimeoutMs();
  await acquireRequestSlot(llmConcurrencyLimit());

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      throw new Error(`LLM request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseRequestSlot();
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function acquireRequestSlot(limit: number): Promise<void> {
  if (activeRequests < limit && waitingRequests.length === 0) {
    activeRequests += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    waitingRequests.push(resolve);
  });
}

function releaseRequestSlot(): void {
  const next = waitingRequests.shift();
  if (next) {
    next();
    return;
  }

  activeRequests = Math.max(0, activeRequests - 1);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
