import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { OrchestrationRunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OrchestrationDispatchOptions {
  label: string;
  projectId: string;
  runId: string;
  task: () => Promise<unknown>;
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * Owns the async handoff between the API control plane and long-running
 * orchestration execution. The current implementation keeps the execution
 * function in-process, but uses the OrchestrationRun row as a durable queue
 * marker and compare-and-swap lease so duplicate API/supervisor workers do not
 * drive the same run concurrently.
 */
@Injectable()
export class OrchestrationRunDispatcher {
  private readonly logger = new Logger(OrchestrationRunDispatcher.name);
  private warnedUnsupportedMode = false;
  private readonly workerId = `${process.pid}-${randomUUID()}`;

  constructor(private readonly prisma: PrismaService) {}

  dispatch(options: OrchestrationDispatchOptions): void {
    const mode = process.env.ORCHESTRATION_DISPATCHER_MODE ?? 'db-lease';

    if (!['db-lease', 'in-process'].includes(mode) && !this.warnedUnsupportedMode) {
      this.warnedUnsupportedMode = true;
      this.logger.warn(
        `Unsupported ORCHESTRATION_DISPATCHER_MODE="${mode}"; falling back to db-lease dispatch.`,
      );
    }

    void this.dispatchWithLease(options, mode === 'in-process');
  }

  private async dispatchWithLease(
    options: OrchestrationDispatchOptions,
    skipLease: boolean,
  ): Promise<void> {
    try {
      if (!skipLease) {
        await this.markQueued(options);
        const leaseOwner = await this.acquireLease(options);
        if (!leaseOwner) return;

        try {
          await options.task();
        } finally {
          await this.releaseLease(options, leaseOwner);
        }
        return;
      }

      await options.task();
    } catch (error: unknown) {
      await this.handleError(options, error);
    }
  }

  private async markQueued(options: OrchestrationDispatchOptions): Promise<void> {
    await this.prisma.orchestrationRun.updateMany({
      where: {
        projectId: options.projectId,
        runId: options.runId,
        status: OrchestrationRunStatus.RUNNING,
      },
      data: {
        dispatchLabel: options.label,
        dispatchQueuedAt: new Date(),
      },
    });
  }

  private async acquireLease(options: OrchestrationDispatchOptions): Promise<string | null> {
    const now = new Date();
    const leaseOwner = `${this.workerId}:${options.label}:${options.runId}`;
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs());

    const claimed = await this.prisma.orchestrationRun.updateMany({
      where: {
        projectId: options.projectId,
        runId: options.runId,
        status: OrchestrationRunStatus.RUNNING,
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        leaseOwner,
        leaseAcquiredAt: now,
        leaseExpiresAt,
      },
    });

    if (claimed.count !== 1) {
      this.logger.warn(
        `Skipped orchestration task "${options.label}" for project ${options.projectId} run ${options.runId}; another worker owns the lease.`,
      );
      return null;
    }

    return leaseOwner;
  }

  private async releaseLease(
    options: OrchestrationDispatchOptions,
    leaseOwner: string,
  ): Promise<void> {
    await this.prisma.orchestrationRun.updateMany({
      where: {
        projectId: options.projectId,
        runId: options.runId,
        leaseOwner,
      },
      data: {
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
      },
    });
  }

  private leaseDurationMs(): number {
    const configured = Number(process.env.ORCHESTRATION_DISPATCH_LEASE_MS);
    return Number.isInteger(configured) && configured > 0 ? configured : 60 * 60 * 1000;
  }

  private async handleError(
    options: OrchestrationDispatchOptions,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `Dispatched orchestration task "${options.label}" failed for project ${options.projectId} run ${options.runId}: ${message}`,
    );

    try {
      await options.onError?.(error);
    } catch (handlerError) {
      const handlerMessage = handlerError instanceof Error
        ? handlerError.message
        : String(handlerError);
      this.logger.error(
        `Error handler for orchestration task "${options.label}" failed for project ${options.projectId} run ${options.runId}: ${handlerMessage}`,
      );
    }
  }
}
