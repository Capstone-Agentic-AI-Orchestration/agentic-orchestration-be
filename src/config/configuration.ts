import { envSchema, EnvSchema } from './env.schema';

let _config: EnvSchema | null = null;

export function normalizeGithubPrivateKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const rawPem = trimmed.replace(/\\n/g, '\n').trim();
  if (rawPem.includes('-----BEGIN')) return rawPem;

  const der = Buffer.from(trimmed, 'base64');

  // If the decoded bytes look like a PKCS#1 DER key (starts with 0x30 SEQUENCE),
  // wrap in PEM headers. Otherwise treat as plain text (e.g. raw PEM with \n escaped).
  if (der.length > 0 && der[0] === 0x30) {
    const b64 = der.toString('base64');
    const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines}\n-----END RSA PRIVATE KEY-----`;
  }

  const decodedPem = der
    .toString('utf-8')
    .trim()
    .replace(/\\n/g, '\n')
    .trim();
  if (decodedPem.includes('-----BEGIN')) return decodedPem;

  return rawPem;
}

export function getConfig(): EnvSchema {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const formatted = result.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');
      throw new Error(`Configuration error: ${formatted}`);
    }
    _config = result.data;
  }
  return _config;
}

export default () => {
  const env = envSchema.safeParse(process.env);
  if (!env.success) {
    return {};
  }
  return {
    port: env.data.PORT,
    nodeEnv: env.data.NODE_ENV,
    database: {
      url: env.data.DATABASE_URL,
    },
    orchestration: {
      agentProvider: env.data.AGENT_PROVIDER,
      llmEngine: env.data.ORCHESTRATION_LLM_ENGINE,
      dispatcherMode: env.data.ORCHESTRATION_DISPATCHER_MODE,
      llmProvider: env.data.LLM_PROVIDER,
      llmRequestTimeoutMs: env.data.LLM_REQUEST_TIMEOUT_MS,
      llmConcurrencyLimit: env.data.LLM_CONCURRENCY_LIMIT,
      eve: {
        serviceUrl: env.data.EVE_SERVICE_URL || undefined,
        tokenConfigured: Boolean(env.data.EVE_SERVICE_TOKEN),
        model: env.data.EVE_MODEL,
      },
      openrouter: {
        apiKey: env.data.OPENROUTER_API_KEY,
        baseUrl: env.data.OPENROUTER_BASE_URL,
        model: env.data.OPENROUTER_MODEL,
        fallbackModel: env.data.OPENROUTER_FALLBACK_MODEL || undefined,
      },
      opencode: {
        apiKey: env.data.OPENCODE_API_KEY,
        baseUrl: env.data.OPENCODE_BASE_URL,
        model: env.data.OPENCODE_MODEL,
        fallbackModel: env.data.OPENCODE_FALLBACK_MODEL || undefined,
      },
      gemini: {
        apiKey: env.data.GEMINI_API_KEY,
        baseUrl: env.data.GEMINI_BASE_URL,
        model: env.data.GEMINI_MODEL,
        fallbackModel: env.data.GEMINI_FALLBACK_MODEL || undefined,
      },
    },
    supabase: {
      url: env.data.SUPABASE_URL,
    },
    auth: {
      allowedProviders: env.data.AUTH_ALLOWED_PROVIDERS
        .split(',')
        .map((provider) => provider.trim().toLowerCase())
        .filter(Boolean),
    },
    anthropic: {
      apiKey: env.data.ANTHROPIC_API_KEY,
    },
    openai: {
      apiKey: env.data.OPENAI_API_KEY,
    },
    github: {
      appId: env.data.GITHUB_APP_ID || undefined,
      appSlug: env.data.GITHUB_APP_SLUG || undefined,
      privateKey: normalizeGithubPrivateKey(env.data.GITHUB_PRIVATE_KEY),
      installationId: env.data.GITHUB_INSTALLATION_ID
        ? parseInt(env.data.GITHUB_INSTALLATION_ID, 10)
        : undefined,
      org: env.data.GITHUB_ORG || undefined,
      devTeam: env.data.GITHUB_DEV_TEAM || undefined,
      pmTeam: env.data.GITHUB_PM_TEAM || undefined,
      token: env.data.GITHUB_TOKEN || undefined,
      webhookSecret: env.data.GITHUB_WEBHOOK_SECRET || undefined,
    },
    // Phase 2E — LangSmith tracing (auto-instrumented via env vars)
    langsmith: {
      apiKey: process.env.LANGCHAIN_API_KEY,
      tracingEnabled: process.env.LANGCHAIN_TRACING_V2 === 'true',
      project: process.env.LANGCHAIN_PROJECT ?? 'devflow',
    },
    outboxRelay: {
      enabled: env.data.OUTBOX_RELAY_ENABLED === 'true',
      intervalMs: env.data.OUTBOX_RELAY_INTERVAL_MS,
      batchSize: env.data.OUTBOX_RELAY_BATCH_SIZE,
      lockMs: env.data.OUTBOX_RELAY_LOCK_MS,
      maxAttempts: env.data.OUTBOX_RELAY_MAX_ATTEMPTS,
    },
  };
};
