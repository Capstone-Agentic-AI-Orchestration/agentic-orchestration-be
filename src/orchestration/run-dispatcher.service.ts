import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  OrchestrationJob,
  OrchestrationJobKind,
  OrchestrationJobStatus,
  OrchestrationRunStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OrchestrationDispatchOptions {
  label: string;
  projectId: string;
  runId: string;
  kind: OrchestrationJobKind;
  payload?: Prisma.InputJsonValue;
  maxAttempts?: number;
  task?: () => Promise<unknown>;
  onError?: (error: unknown) => Promise<void> | void;
}

export type OrchestrationJobExecutor = (job: OrchestrationJob) => Promise<void>;

/**
 * Owns the async handoff between the API control plane and long-running
 * orchestration execution. The default path persists a durable job row and then
 * claims it with a compare-and-swap lock. The run row still carries a second
 * lease, so duplicate API/supervisor workers cannot drive the same run at once.
 */
@Injectable()
export class OrchestrationRunDispatcher {
  private readonly logger = new Logger(OrchestrationRunDispatcher.name);
  private warnedUnsupportedMode = false;
  private readonly workerId = `${process.pid}-${randomUUID()}`;
  private executor: OrchestrationJobExecutor | null = null;
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  registerExecutor(executor: OrchestrationJobExecutor): void {
    this.executor = executor;
  }

  dispatch(options: OrchestrationDispatchOptions): void {
    const mode = process.env.ORCHESTRATION_DISPATCHER_MODE ?? 'db-lease';

    if (!['db-lease', 'in-process'].includes(mode) && !this.warnedUnsupportedMode) {
      this.warnedUnsupportedMode = true;
      this.logger.warn(
        `Unsupported ORCHESTRATION_DISPATCHER_MODE="${mode}"; falling back to db-lease dispatch.`,
      );
    }

    if (mode === 'in-process') {
      void this.dispatchInProcess(options);
      return;
    }

    void this.enqueueAndDrain(options);
  }

  drainDueJobs(): void {
    void this.drainLoop();
  }

  private async dispatchInProcess(options: OrchestrationDispatchOptions): Promise<void> {
    try {
      if (options.task) {
        await options.task();
        return;
      }
      await this.enqueueAndDrain(options);
    } catch (error) {
      await this.handleError(options, error);
    }
  }

  private async enqueueAndDrain(options: OrchestrationDispatchOptions): Promise<void> {
    try {
      await this.markQueued(options);
      await this.createJob(options);
      this.drainDueJobs();
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

  private async createJob(options: OrchestrationDispatchOptions): Promise<void> {
    const run = await this.prisma.orchestrationRun.findUnique({
      where: { runId: options.runId },
      select: { id: true },
    });

    await this.prisma.orchestrationJob.create({
      data: {
        projectId: options.projectId,
        orchestrationRunId: run?.id ?? null,
        runId: options.runId,
        kind: options.kind,
        payload: options.payload ?? {},
        maxAttempts: options.maxAttempts ?? 3,
      },
    });
  }

  private async drainLoop(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      for (;;) {
        const job = await this.claimNextJob();
        if (!job) return;
        await this.executeClaimedJob(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async claimNextJob(): Promise<OrchestrationJob | null> {
    const now = new Date();
    const candidate = await this.prisma.orchestrationJob.findFirst({
      where: {
        availableAt: { lte: now },
        OR: [
          {
            status: OrchestrationJobStatus.PENDING,
            OR: [
              { lockedUntil: null },
              { lockedUntil: { lt: now } },
            ],
          },
          {
            status: OrchestrationJobStatus.RUNNING,
            lockedUntil: { lt: now },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null;

    const lockedUntil = new Date(now.getTime() + this.jobLockMs());
    const claimed = await this.prisma.orchestrationJob.updateMany({
      where: {
        id: candidate.id,
        OR: [
          {
            status: OrchestrationJobStatus.PENDING,
            OR: [
              { lockedUntil: null },
              { lockedUntil: { lt: now } },
            ],
          },
          {
            status: OrchestrationJobStatus.RUNNING,
            lockedUntil: { lt: now },
          },
        ],
      },
      data: {
        status: OrchestrationJobStatus.RUNNING,
        lockedBy: this.workerId,
        lockedUntil,
        startedAt: now,
        attempt: { increment: 1 },
      },
    });

    if (claimed.count !== 1) return null;
    return this.prisma.orchestrationJob.findUnique({ where: { id: candidate.id } });
  }

  private async executeClaimedJob(job: OrchestrationJob): Promise<void> {
    const leaseOwner = await this.acquireLease({
      label: job.kind,
      projectId: job.projectId,
      runId: job.runId,
      kind: job.kind,
      payload: job.payload as Prisma.InputJsonValue,
    });

    if (!leaseOwner) {
      await this.prisma.orchestrationJob.update({
        where: { id: job.id },
        data: {
          status: OrchestrationJobStatus.PENDING,
          lockedBy: null,
          lockedUntil: null,
          availableAt: new Date(Date.now() + 5_000),
        },
      });
      return;
    }

    try {
      if (!this.executor) {
        throw new Error('No orchestration job executor is registered.');
      }
      await this.executor(job);
      await this.prisma.orchestrationJob.update({
        where: { id: job.id },
        data: {
          status: OrchestrationJobStatus.SUCCEEDED,
          lockedBy: null,
          lockedUntil: null,
          completedAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      await this.failOrRetryJob(job, error);
    } finally {
      await this.releaseLease({
        label: job.kind,
        projectId: job.projectId,
        runId: job.runId,
        kind: job.kind,
      }, leaseOwner);
    }
  }

  private async failOrRetryJob(job: OrchestrationJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = job.attempt < job.maxAttempts;
    await this.prisma.orchestrationJob.update({
      where: { id: job.id },
      data: {
        status: shouldRetry ? OrchestrationJobStatus.PENDING : OrchestrationJobStatus.FAILED,
        lockedBy: null,
        lockedUntil: null,
        lastError: message,
        availableAt: shouldRetry
          ? new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** Math.max(job.attempt, 0)))
          : job.availableAt,
        completedAt: shouldRetry ? null : new Date(),
      },
    });
    if (!shouldRetry) {
      this.logger.error(`Orchestration job ${job.id} (${job.kind}) failed permanently: ${message}`);
    }
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

  private jobLockMs(): number {
    const configured = Number(process.env.ORCHESTRATION_JOB_LOCK_MS);
    return Number.isInteger(configured) && configured > 0 ? configured : 15 * 60 * 1000;
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
