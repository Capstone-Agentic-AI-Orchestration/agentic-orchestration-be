import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const PING_TIMEOUT_MS = 3_000;
const SCOPED_SUPABASE_URL_SUFFIX = '_SUPABASE_URL';
const SCOPED_SUPABASE_SECRET_SUFFIXES = [
  '_SUPABASE_SECRET_KEY',
  '_SUPABASE_SERVICE_ROLE_KEY',
] as const;

interface ScopedSupabaseConfig {
  prefix: string;
  url: string;
  secret: string;
}

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private client: SupabaseClient | null = null;
  private readonly scopedClients = new Map<string, SupabaseClient>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.initializeDefaultClient();
    this.initializeScopedClients(process.env);
  }

  getClient(): SupabaseClient | null {
    return this.client;
  }

  getClientForService(serviceName: string): SupabaseClient | null {
    const prefix = this.normalizeServiceName(serviceName);
    if (!prefix) {
      return null;
    }

    return this.scopedClients.get(prefix) ?? null;
  }

  listConfiguredServices(): string[] {
    return Array.from(this.scopedClients.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  async ping(serviceName?: string): Promise<boolean> {
    const client = serviceName
      ? this.getClientForService(serviceName)
      : this.client;

    if (client === null) {
      return false;
    }

    const attempt = async (): Promise<boolean> => {
      try {
        // Lightweight existence check — list zero users from the auth admin API.
        // This round-trips to the Supabase project without touching any
        // application table and works on any freshly created project.
        const { error } = await client.auth.admin.listUsers({
          page: 1,
          perPage: 1,
        });
        return error === null;
      } catch {
        return false;
      }
    };

    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<boolean>((resolve) => {
      timerId = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    });

    return Promise.race([attempt(), timeout]).finally(() => {
      // Clear the timer regardless of which promise won so the handle is
      // released and Node / Jest can exit cleanly without open-handle warnings.
      clearTimeout(timerId);
    });
  }

  private initializeDefaultClient(): void {
    const url = this.configService.get<string>('SUPABASE_URL')?.trim();
    const key = this.configService
      .get<string>('SUPABASE_SERVICE_ROLE_KEY')
      ?.trim();

    if (!url || !key) {
      this.logger.warn(
        'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set. ' +
          'SupabaseService will not be available.',
      );
      return;
    }

    this.client = this.buildClient(url, key);
  }

  private initializeScopedClients(
    env: Record<string, string | undefined>,
  ): void {
    const configs = this.resolveScopedConfigs(env);

    for (const config of configs) {
      this.scopedClients.set(
        config.prefix,
        this.buildClient(config.url, config.secret),
      );
    }

    if (configs.length > 0) {
      this.logger.log(
        `Configured ${configs.length} service-scoped Supabase client(s): ${configs
          .map((config) => config.prefix)
          .join(', ')}`,
      );
    }
  }

  private resolveScopedConfigs(
    env: Record<string, string | undefined>,
  ): ScopedSupabaseConfig[] {
    const { urlByPrefix, secretByPrefix } = this.collectScopedEntries(env);
    return this.buildScopedConfigs(urlByPrefix, secretByPrefix);
  }

  private collectScopedEntries(env: Record<string, string | undefined>): {
    urlByPrefix: Map<string, string>;
    secretByPrefix: Map<string, string>;
  } {
    const urlByPrefix = new Map<string, string>();
    const secretByPrefix = new Map<string, string>();

    for (const [key, raw] of Object.entries(env)) {
      const value = raw?.trim();
      if (!value) {
        continue;
      }

      const urlPrefix = this.extractPrefix(key, SCOPED_SUPABASE_URL_SUFFIX);
      if (urlPrefix) {
        urlByPrefix.set(urlPrefix, value);
      }

      const secretPrefix = this.getScopedSecretPrefix(key);
      if (secretPrefix) {
        secretByPrefix.set(secretPrefix, value);
      }
    }

    return { urlByPrefix, secretByPrefix };
  }

  private extractPrefix(key: string, suffix: string): string | null {
    if (!key.endsWith(suffix)) {
      return null;
    }

    const prefix = key.slice(0, -suffix.length);
    return prefix || null;
  }

  private getScopedSecretPrefix(key: string): string | null {
    for (const suffix of SCOPED_SUPABASE_SECRET_SUFFIXES) {
      const prefix = this.extractPrefix(key, suffix);
      if (prefix) {
        return prefix;
      }
    }

    return null;
  }

  private buildScopedConfigs(
    urlByPrefix: Map<string, string>,
    secretByPrefix: Map<string, string>,
  ): ScopedSupabaseConfig[] {
    const prefixes = new Set<string>([
      ...urlByPrefix.keys(),
      ...secretByPrefix.keys(),
    ]);
    const configs: ScopedSupabaseConfig[] = [];

    for (const prefix of prefixes) {
      const config = this.buildScopedConfigForPrefix(
        prefix,
        urlByPrefix,
        secretByPrefix,
      );

      if (config !== null) {
        configs.push(config);
      }
    }

    return configs;
  }

  private buildScopedConfigForPrefix(
    prefix: string,
    urlByPrefix: Map<string, string>,
    secretByPrefix: Map<string, string>,
  ): ScopedSupabaseConfig | null {
    const url = urlByPrefix.get(prefix);
    const secret = secretByPrefix.get(prefix);

    if (url && secret) {
      return { prefix, url, secret };
    }

    if (url || secret) {
      this.logger.warn(
        `Incomplete scoped Supabase config for '${prefix}'. Set both ${prefix}_SUPABASE_URL and ${prefix}_SUPABASE_SECRET_KEY (or ${prefix}_SUPABASE_SERVICE_ROLE_KEY).`,
      );
    }

    return null;
  }

  private buildClient(url: string, key: string): SupabaseClient {
    const client = createClient(url, key, {
      auth: {
        // Service-role key must not persist sessions
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    return client;
  }

  private normalizeServiceName(serviceName: string): string {
    const normalized = serviceName
      .trim()
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]+/g, '_');

    return this.trimEdgeUnderscores(normalized);
  }

  private trimEdgeUnderscores(value: string): string {
    let result = value;
    while (result.startsWith('_')) {
      result = result.slice(1);
    }

    while (result.endsWith('_')) {
      result = result.slice(0, -1);
    }

    return result;
  }

  async pingDefault(): Promise<boolean> {
    return this.ping();
  }

  async pingService(serviceName: string): Promise<boolean> {
    return this.ping(serviceName);
  }

  hasServiceClient(serviceName: string): boolean {
    return this.getClientForService(serviceName) !== null;
  }

  getDefaultOrServiceClient(serviceName?: string): SupabaseClient | null {
    if (!serviceName) {
      return this.client;
    }

    return this.getClientForService(serviceName);
  }
}
