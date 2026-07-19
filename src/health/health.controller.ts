import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationOutboxStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService } from '../github/github.service';

type HealthResponse = { status: 'ok'; checks: { apiCenter: true } };
type ReadinessState = 'ok' | 'degraded' | 'down';
type ReadinessSection = {
  status: ReadinessState;
  details?: Record<string, unknown>;
  reason?: string | null;
};
type OrchestrationReadinessResponse = {
  status: ReadinessState;
  checkedAt: string;
  checks: Record<string, ReadinessSection>;
};

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly github: GithubService | null = null,
  ) {}

  @Get(['health', 'api/v1/health'])
  live(): HealthResponse {
    return { status: 'ok', checks: { apiCenter: true } };
  }

  @Get(['health/live', 'api/v1/health/live'])
  liveness(): HealthResponse {
    return { status: 'ok', checks: { apiCenter: true } };
  }

  @Get(['health/ready', 'api/v1/health/ready'])
  async readiness(): Promise<HealthResponse & { dependencies: { database: 'ok' } }> {
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return {
        status: 'ok',
        checks: { apiCenter: true },
        dependencies: { database: 'ok' },
      };
    } catch {
      throw new ServiceUnavailableException({
        title: 'Service Unavailable',
        detail: 'Database readiness check failed',
      });
    }
  }

  @Get(['health/orchestration', 'api/v1/health/orchestration'])
  async orchestrationReadiness(): Promise<OrchestrationReadinessResponse> {
    const checks: Record<string, ReadinessSection> = {
      database: await this.databaseCheck(),
      auth: this.authCheck(),
      dispatcher: this.dispatcherCheck(),
      eve: await this.eveCheck(),
      directProvider: this.directProviderCheck(),
      github: this.githubCheck(),
      outbox: await this.outboxCheck(),
    };
    return {
      status: this.overallStatus(checks),
      checkedAt: new Date().toISOString(),
      checks,
    };
  }

  private async databaseCheck(): Promise<ReadinessSection> {
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return { status: 'ok' };
    } catch (error) {
      return { status: 'down', reason: this.errorMessage(error) };
    }
  }

  private authCheck(): ReadinessSection {
    const nodeEnv = this.config.get<string>('nodeEnv') ?? process.env.NODE_ENV ?? 'development';
    const supabaseUrl = this.config.get<string>('supabase.url') ?? process.env.SUPABASE_URL ?? '';
    const corsOrigin = process.env.CORS_ORIGIN ?? '*';
    const productionIssues = [
      nodeEnv === 'production' && !supabaseUrl ? 'SUPABASE_URL is required in production.' : null,
      nodeEnv === 'production' && (!corsOrigin || corsOrigin === '*') ? 'CORS_ORIGIN must be explicit in production.' : null,
    ].filter((issue): issue is string => Boolean(issue));

    return {
      status: productionIssues.length ? 'down' : 'ok',
      reason: productionIssues.join(' ') || null,
      details: {
        supabaseUrlConfigured: Boolean(supabaseUrl),
        corsOrigin,
        nodeEnv,
      },
    };
  }

  private dispatcherCheck(): ReadinessSection {
    const mode = process.env.ORCHESTRATION_DISPATCHER_MODE ?? 'db-lease';
    const supported = mode === 'db-lease' || mode === 'in-process';
    return {
      status: supported ? (mode === 'db-lease' ? 'ok' : 'degraded') : 'down',
      reason: supported
        ? mode === 'in-process' ? 'in-process dispatcher is local/dev compatibility only.' : null
        : `Unsupported ORCHESTRATION_DISPATCHER_MODE=${mode}.`,
      details: { mode },
    };
  }

  private async eveCheck(): Promise<ReadinessSection> {
    const engine = process.env.ORCHESTRATION_LLM_ENGINE ?? 'eve';
    const serviceUrl = process.env.EVE_SERVICE_URL?.trim() ?? '';
    const tokenConfigured = Boolean(process.env.EVE_SERVICE_TOKEN?.trim());
    if (engine !== 'eve') {
      return { status: 'ok', details: { engine, required: false } };
    }
    if (!serviceUrl) {
      return {
        status: 'degraded',
        reason: 'Eve is selected but EVE_SERVICE_URL is not configured; runs will use direct fallback before start.',
        details: { engine, serviceUrlConfigured: false, tokenConfigured },
      };
    }
    if (process.env.NODE_ENV === 'production' && !tokenConfigured) {
      return {
        status: 'down',
        reason: 'EVE_SERVICE_TOKEN is required in production when Eve is selected.',
        details: { engine, serviceUrlConfigured: true, tokenConfigured },
      };
    }
    const reachable = await this.eveReachable(serviceUrl);
    return {
      status: reachable.ok ? 'ok' : 'degraded',
      reason: reachable.reason,
      details: { engine, serviceUrlConfigured: true, tokenConfigured, reachable: reachable.ok },
    };
  }

  private directProviderCheck(): ReadinessSection {
    const provider = (process.env.LLM_PROVIDER ?? 'openrouter').toLowerCase();
    const apiKeyName = this.directProviderKeyName(provider);
    const model = process.env[`${provider.toUpperCase()}_MODEL`] ?? null;
    const configured = apiKeyName ? Boolean(process.env[apiKeyName]?.trim()) : false;
    return {
      status: configured ? 'ok' : 'degraded',
      reason: configured ? null : `${apiKeyName ?? 'provider API key'} is not configured.`,
      details: { provider, apiKeyName, model },
    };
  }

  private githubCheck(): ReadinessSection {
    const status = this.github?.getDeliveryStatus();
    if (!status) {
      return { status: 'degraded', reason: 'GitHub service is not available in this module context.' };
    }
    return {
      status: status.available ? 'ok' : 'degraded',
      reason: status.reason,
      details: {
        configured: status.configured,
        owner: status.owner,
        ownerSource: status.ownerSource,
        missingRequirements: status.missingRequirements,
      },
    };
  }

  private async outboxCheck(): Promise<ReadinessSection> {
    const enabled = this.config.get<boolean>('outboxRelay.enabled') ?? false;
    const pending = await this.prisma.integrationOutbox.count({
      where: { status: { in: [IntegrationOutboxStatus.PENDING, IntegrationOutboxStatus.FAILED] } },
    }).catch(() => null);
    return {
      status: enabled ? 'ok' : 'degraded',
      reason: enabled ? null : 'Outbox relay is disabled; integration events remain pending until a relay is enabled.',
      details: { enabled, pendingOrFailed: pending },
    };
  }

  private async eveReachable(serviceUrl: string): Promise<{ ok: boolean; reason: string | null }> {
    try {
      const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/eve/v1/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok
        ? { ok: true, reason: null }
        : { ok: false, reason: `Eve health returned HTTP ${response.status}.` };
    } catch (error) {
      return { ok: false, reason: this.errorMessage(error) };
    }
  }

  private directProviderKeyName(provider: string): string | null {
    const names: Record<string, string> = {
      openrouter: 'OPENROUTER_API_KEY',
      opencode: 'OPENCODE_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY',
    };
    return names[provider] ?? null;
  }

  private overallStatus(checks: Record<string, ReadinessSection>): ReadinessState {
    const states = Object.values(checks).map((check) => check.status);
    if (states.includes('down')) return 'down';
    if (states.includes('degraded')) return 'degraded';
    return 'ok';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
