/**
 * env.validation.ts
 *
 * Environment variable validation for ConfigModule.
 *
 * Usage in ApiModule or service modules:
 *
 *   ConfigModule.forRoot({ validate: validateEnv })
 *
 * Design notes:
 *   - Uses a plain validate function — no Joi or class-validator runtime
 *     dependency needed. The check runs once at bootstrap.
 *   - Required vars cause a hard crash (fail-fast). Missing required config
 *     in a running service is a security risk: the service may silently fall
 *     back to insecure defaults.
 *   - Optional vars (API_CENTER_BASE_URL) emit a warning so the developer
 *     knows the feature will be unavailable, but local dev is not broken.
 *
 * Threat addressed:
 *   - Service starting with missing secrets and silently degrading to
 *     insecure fallback behaviour (e.g. empty SUPABASE_SERVICE_ROLE_KEY
 *     allowing unauthenticated DB operations, or no ALLOWED_ORIGINS
 *     causing permissive CORS).
 */

export interface EnvironmentVariables {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  ENABLE_SWAGGER: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ALLOWED_ORIGINS: string;
  API_CENTER_BASE_URL?: string;
  API_CENTER_API_KEY?: string;
  API_CENTER_TRIBE_ID?: string;
  API_CENTER_TRIBE_SECRET?: string;
  API_CENTER_TIMEOUT_MS?: string;
}

type RawEnv = Record<string, unknown>;
const SCOPED_SUPABASE_URL_SUFFIX = '_SUPABASE_URL';
const SCOPED_SUPABASE_SECRET_SUFFIXES = [
  '_SUPABASE_SECRET_KEY',
  '_SUPABASE_SERVICE_ROLE_KEY',
] as const;

interface ApiCenterConfig {
  baseUrl: string | undefined;
  tribeId: string | undefined;
  tribeSecret: string | undefined;
  apiKey: string | undefined;
  timeoutMs: string | undefined;
}

function getTrimmedString(env: RawEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return undefined;
}

function resolveApiCenterConfig(env: RawEnv): ApiCenterConfig {
  return {
    baseUrl: getTrimmedString(env, ['API_CENTER_BASE_URL', 'APICENTER_URL']),
    tribeId: getTrimmedString(env, [
      'API_CENTER_TRIBE_ID',
      'APICENTER_TRIBE_ID',
    ]),
    tribeSecret: getTrimmedString(env, [
      'API_CENTER_TRIBE_SECRET',
      'APICENTER_TRIBE_SECRET',
    ]),
    apiKey: getTrimmedString(env, ['API_CENTER_API_KEY']),
    timeoutMs: getTrimmedString(env, [
      'API_CENTER_TIMEOUT_MS',
      'APICENTER_TIMEOUT_MS',
    ]),
  };
}

function extractScopedPrefix(key: string, suffix: string): string | null {
  if (!key.endsWith(suffix)) {
    return null;
  }

  const prefix = key.slice(0, -suffix.length);
  return prefix || null;
}

function getScopedSecretPrefix(key: string): string | null {
  for (const suffix of SCOPED_SUPABASE_SECRET_SUFFIXES) {
    const prefix = extractScopedPrefix(key, suffix);
    if (prefix) {
      return prefix;
    }
  }

  return null;
}

function collectScopedSupabasePrefixSets(env: RawEnv): {
  urlPrefixes: Set<string>;
  secretPrefixes: Set<string>;
} {
  const urlPrefixes = new Set<string>();
  const secretPrefixes = new Set<string>();

  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      continue;
    }

    const urlPrefix = extractScopedPrefix(key, SCOPED_SUPABASE_URL_SUFFIX);
    if (urlPrefix) {
      urlPrefixes.add(urlPrefix);
    }

    const secretPrefix = getScopedSecretPrefix(key);
    if (secretPrefix) {
      secretPrefixes.add(secretPrefix);
    }
  }

  return { urlPrefixes, secretPrefixes };
}

function countScopedSupabaseClients(env: RawEnv): number {
  const { urlPrefixes, secretPrefixes } = collectScopedSupabasePrefixSets(env);

  let count = 0;
  for (const prefix of urlPrefixes) {
    if (secretPrefixes.has(prefix)) {
      count += 1;
    }
  }

  return count;
}

function warnApiCenterConfig(config: ApiCenterConfig): void {
  if (!config.baseUrl) {
    console.warn(
      '[env] WARNING: API_CENTER_BASE_URL/APICENTER_URL is not set. Calls to APICenter will fail at runtime.',
    );
  }

  if (!config.apiKey) {
    console.warn(
      '[env] WARNING: API_CENTER_API_KEY is not set. Legacy fallback disabled; prefer tribe credentials.',
    );
  }

  if (config.tribeId && !config.tribeSecret) {
    console.warn(
      '[env] WARNING: API_CENTER_TRIBE_ID is set but API_CENTER_TRIBE_SECRET is missing. Tribe token flow will not work.',
    );
  }

  if (config.tribeSecret && !config.tribeId) {
    console.warn(
      '[env] WARNING: API_CENTER_TRIBE_SECRET is set but API_CENTER_TRIBE_ID is missing. Tribe token flow will not work.',
    );
  }
}

function validateApiCenterTimeout(config: ApiCenterConfig): void {
  if (!config.timeoutMs) {
    return;
  }

  const parsed = Number(config.timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `[env] API_CENTER_TIMEOUT_MS must be a positive number when set. Got: '${config.timeoutMs}'.`,
    );
  }
}

function validateProductionApiCenter(config: ApiCenterConfig): void {
  if (!config.baseUrl) {
    throw new Error(
      '[env] API_CENTER_BASE_URL (or APICENTER_URL) is required in production.',
    );
  }

  const hasTribeAuth = Boolean(config.tribeId && config.tribeSecret);
  const hasLegacyAuth = Boolean(config.apiKey);

  if (!hasTribeAuth && !hasLegacyAuth) {
    throw new Error(
      '[env] Production APICenter auth is missing. Set API_CENTER_TRIBE_ID + API_CENTER_TRIBE_SECRET (preferred) or API_CENTER_API_KEY (legacy).',
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireString(env: RawEnv, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `[env] Missing required environment variable: ${key}. ` +
        `Set it in .env or your deployment secrets before starting the service.`,
    );
  }
  return value.trim();
}

function requireEnum<T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
): T {
  const raw = requireString(env, key);
  if (!allowed.includes(raw as T)) {
    throw new Error(
      `[env] Invalid value for ${key}: '${raw}'. ` +
        `Allowed values: ${allowed.join(', ')}.`,
    );
  }
  return raw as T;
}

function requirePort(env: RawEnv, key: string): number {
  const raw = env[key];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `[env] ${key} must be an integer between 1 and 65535. Got: '${String(raw)}'.`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Exported validate function
// ---------------------------------------------------------------------------

/**
 * validateEnv — passed directly to ConfigModule.forRoot({ validate }).
 *
 * Called by NestJS at bootstrap with the raw process.env object.
 * Must return the parsed/typed config or throw to abort startup.
 */
export function validateEnv(env: RawEnv): EnvironmentVariables {
  // --- Required: service identity ---
  const NODE_ENV = requireEnum(env, 'NODE_ENV', [
    'development',
    'test',
    'production',
  ] as const);

  const PORT = requirePort(env, 'PORT');

  const SUPABASE_URL = getTrimmedString(env, ['SUPABASE_URL']);
  const SUPABASE_ANON_KEY = getTrimmedString(env, ['SUPABASE_ANON_KEY']);
  const SUPABASE_SERVICE_ROLE_KEY = getTrimmedString(env, [
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);

  const scopedSupabaseClientCount = countScopedSupabaseClients(env);

  const defaultSupabaseValues = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
  };

  const missingDefaultSupabaseKeys = Object.entries(defaultSupabaseValues)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (
    missingDefaultSupabaseKeys.length === 3 &&
    scopedSupabaseClientCount === 0
  ) {
    throw new Error(
      '[env] Missing Supabase configuration. Provide SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY, or define at least one scoped client pair (<SERVICE>_SUPABASE_URL + <SERVICE>_SUPABASE_SECRET_KEY).',
    );
  }

  if (
    missingDefaultSupabaseKeys.length > 0 &&
    missingDefaultSupabaseKeys.length < 3
  ) {
    if (scopedSupabaseClientCount === 0) {
      throw new Error(
        `[env] Incomplete default Supabase configuration. Missing: ${missingDefaultSupabaseKeys.join(', ')}.`,
      );
    }

    console.warn(
      `[env] WARNING: Default SUPABASE_* config is incomplete (${missingDefaultSupabaseKeys.join(', ')}). Proceeding with scoped service clients only.`,
    );
  }

  // --- Required: CORS ---
  // ALLOWED_ORIGINS must be set; corsOptions() will deny all browser-origin
  // requests if empty, which may cause confusing CORS errors in staging.
  // We require it here so misconfiguration is explicit at startup.
  const ALLOWED_ORIGINS = requireString(env, 'ALLOWED_ORIGINS');

  // --- Optional with warnings ---
  const ENABLE_SWAGGER =
    (env['ENABLE_SWAGGER'] as string | undefined) ?? 'false';

  const apiCenterConfig = resolveApiCenterConfig(env);
  warnApiCenterConfig(apiCenterConfig);
  validateApiCenterTimeout(apiCenterConfig);

  if (NODE_ENV === 'production') {
    validateProductionApiCenter(apiCenterConfig);
  }

  return {
    NODE_ENV,
    PORT,
    ENABLE_SWAGGER,
    ...(SUPABASE_URL ? { SUPABASE_URL } : {}),
    ...(SUPABASE_ANON_KEY ? { SUPABASE_ANON_KEY } : {}),
    ...(SUPABASE_SERVICE_ROLE_KEY ? { SUPABASE_SERVICE_ROLE_KEY } : {}),
    ALLOWED_ORIGINS,
    ...(apiCenterConfig.baseUrl
      ? { API_CENTER_BASE_URL: apiCenterConfig.baseUrl }
      : {}),
    ...(apiCenterConfig.apiKey
      ? { API_CENTER_API_KEY: apiCenterConfig.apiKey }
      : {}),
    ...(apiCenterConfig.tribeId
      ? { API_CENTER_TRIBE_ID: apiCenterConfig.tribeId }
      : {}),
    ...(apiCenterConfig.tribeSecret
      ? { API_CENTER_TRIBE_SECRET: apiCenterConfig.tribeSecret }
      : {}),
    ...(apiCenterConfig.timeoutMs
      ? { API_CENTER_TIMEOUT_MS: apiCenterConfig.timeoutMs }
      : {}),
  };
}
