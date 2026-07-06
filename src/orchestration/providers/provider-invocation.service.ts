import { Injectable, Logger } from '@nestjs/common';
import { ProviderInvocationStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  DirectLlmCorrelation,
  DirectLlmJsonResult,
} from './direct-llm.provider';
import type { LlmUsage } from './base-llm.provider';

export interface ProviderInvocationStartInput {
  correlation: DirectLlmCorrelation;
  agent: string;
  engine: 'eve' | 'direct';
  provider?: string | null;
  model?: string | null;
}

export interface ProviderInvocationRecord {
  id: string;
  requestId: string;
  startedAt: Date;
}

@Injectable()
export class ProviderInvocationService {
  private readonly logger = new Logger(ProviderInvocationService.name);

  constructor(private readonly prisma: PrismaService) {}

  ensureRequestId(correlation?: DirectLlmCorrelation): string {
    return this.safeString(correlation?.requestId, 96) ?? randomUUID();
  }

  async start(input: ProviderInvocationStartInput): Promise<ProviderInvocationRecord | null> {
    const requestId = this.ensureRequestId(input.correlation);
    const startedAt = new Date();
    const run = input.correlation.runId
      ? await this.prisma.orchestrationRun.findUnique({
        where: { runId: input.correlation.runId },
        select: { id: true },
      }).catch(() => null)
      : null;

    try {
      const record = await this.prisma.providerInvocation.create({
        data: {
          projectId: this.safeString(input.correlation.projectId, 128),
          orchestrationRunId: run?.id ?? null,
          runId: this.safeString(input.correlation.runId, 128),
          workOrderId: this.safeString(input.correlation.workOrderId, 128),
          nodeId: this.safeString(input.correlation.nodeId, 128),
          agent: this.safeString(input.correlation.agent, 128) ?? input.agent,
          attempt: this.safeAttempt(input.correlation.attempt),
          engine: input.engine,
          provider: this.safeString(input.provider, 128),
          model: this.safeString(input.model, 256),
          requestId,
          status: ProviderInvocationStatus.STARTED,
          metadata: this.metadataJson(input.correlation, requestId),
          startedAt,
        },
      });
      return { id: record.id, requestId, startedAt };
    } catch (error) {
      this.logger.warn(`Provider invocation start persistence failed: ${this.errorMessage(error)}`);
      return { id: '', requestId, startedAt };
    }
  }

  async succeed<T>(record: ProviderInvocationRecord | null, result: DirectLlmJsonResult<T>): Promise<void> {
    if (!record?.id) return;
    const completedAt = new Date();
    await this.update(record.id, {
      status: ProviderInvocationStatus.SUCCEEDED,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - record.startedAt.getTime()),
      model: result.model,
      inputTokens: this.tokens(result.usage, 'inputTokens'),
      outputTokens: this.tokens(result.usage, 'outputTokens'),
      eveSessionId: result.providerMetadata?.eveSessionId,
      continuationToken: result.providerMetadata?.continuationToken,
    });
  }

  async fail(record: ProviderInvocationRecord | null, error: unknown): Promise<void> {
    if (!record?.id) return;
    const completedAt = new Date();
    await this.update(record.id, {
      status: ProviderInvocationStatus.FAILED,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - record.startedAt.getTime()),
      error: this.errorMessage(error),
    });
  }

  private async update(id: string, data: Prisma.ProviderInvocationUpdateInput): Promise<void> {
    await this.prisma.providerInvocation.update({ where: { id }, data }).catch((error) => {
      this.logger.warn(`Provider invocation update failed: ${this.errorMessage(error)}`);
    });
  }

  private metadataJson(correlation: DirectLlmCorrelation, requestId: string): Prisma.InputJsonValue {
    const metadata: Record<string, string | number> = {
      requestId,
    };
    const projectId = this.safeString(correlation.projectId, 128);
    const runId = this.safeString(correlation.runId, 128);
    const workOrderId = this.safeString(correlation.workOrderId, 128);
    const nodeId = this.safeString(correlation.nodeId, 128);
    const agent = this.safeString(correlation.agent, 128);
    const attempt = this.safeAttempt(correlation.attempt);
    if (projectId) metadata.projectId = projectId;
    if (runId) metadata.runId = runId;
    if (workOrderId) metadata.workOrderId = workOrderId;
    if (nodeId) metadata.nodeId = nodeId;
    if (agent) metadata.agent = agent;
    if (typeof attempt === 'number') metadata.attempt = attempt;
    return metadata;
  }

  private safeString(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.replace(/[^\w:./@-]/g, '_').slice(0, maxLength);
  }

  private safeAttempt(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  private tokens(usage: LlmUsage, key: keyof LlmUsage): number | null {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
