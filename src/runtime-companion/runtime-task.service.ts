import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RuntimeTaskStatus, type RuntimeMachine, type RuntimeTask } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeTokenService } from './runtime-token.service';
import { isDispatchableKind } from './runtime-machine.types';

/**
 * How long a claimed task may go unheard from before the reaper takes it back.
 *
 * The companion heartbeats every 15s, so this allows several consecutive misses — long enough that a
 * slow request or a brief network drop does not steal work from a machine that is still running it.
 */
export const TASK_LEASE_MS = 90_000;

/** Attempts before a task is failed outright rather than requeued again. */
export const MAX_TASK_ATTEMPTS = 3;

/** The shape the shipped companion expects from a claim. Fixed by that client, not by us. */
export interface ClaimedTaskPayload {
  task: {
    id: string;
    issueId: string;
    projectId: string;
    status: string;
    attempt: number;
    plan: Record<string, unknown>;
    issue: { identifier: string | null; title: string; description: string | null };
    resource: { opaqueId: string; name: string; access: 'READ_ONLY' | 'READ_WRITE' };
  };
  leaseToken: string;
  leaseExpiresAt: string;
}

@Injectable()
export class RuntimeTaskService {
  private readonly logger = new Logger(RuntimeTaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: RuntimeTokenService,
  ) {}

  /**
   * Hand the next queued task for this adapter to the caller.
   *
   * The claim is a conditional `updateMany` rather than a read-then-write so two poll cycles — or two
   * daemons racing — cannot both win the same row. Only the caller that flips `QUEUED` to `LEASED`
   * proceeds, the same technique the run dispatcher uses for its leases.
   */
  async claimForAdapter(
    machine: RuntimeMachine,
    adapterId: string,
  ): Promise<ClaimedTaskPayload | null> {
    const adapter = await this.prisma.runtimeAdapter.findFirst({
      where: { id: adapterId, machineId: machine.id },
    });
    if (!adapter) {
      throw new NotFoundException('Unknown adapter for this machine');
    }

    // Belt and braces: the provider only ever queues dispatchable kinds, but a stale row must not be
    // able to send work to a CLI whose invocation we have never verified.
    if (!adapter.enabled || !isDispatchableKind(adapter.kind)) return null;

    const candidate = await this.prisma.runtimeTask.findFirst({
      where: { machineId: machine.id, adapterKind: adapter.kind, status: RuntimeTaskStatus.QUEUED },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!candidate) return null;

    const leaseToken = randomBytes(24).toString('base64url');
    const leaseExpiresAt = new Date(Date.now() + TASK_LEASE_MS);

    const claimed = await this.prisma.runtimeTask.updateMany({
      where: { id: candidate.id, status: RuntimeTaskStatus.QUEUED },
      data: {
        status: RuntimeTaskStatus.LEASED,
        leaseTokenHash: this.tokens.hash(leaseToken),
        leaseExpiresAt,
        startedAt: new Date(),
      },
    });
    // Lost the race to another poll. Reporting "no work" is correct — the next tick will look again.
    if (claimed.count !== 1) return null;

    const task = await this.prisma.runtimeTask.findUnique({
      where: { id: candidate.id },
      include: {
        workOrder: { select: { id: true, projectId: true, title: true, instructions: true } },
      },
    });
    if (!task?.workOrder) return null;

    const resource = await this.prisma.runtimeResource.findFirst({
      where: { machineId: machine.id, opaqueId: task.resourceOpaqueId },
    });
    if (!resource) {
      // The machine no longer exposes the directory this task was queued against. Fail it here rather
      // than letting the companion reject it, which would burn an attempt for no reason.
      await this.failTask(task.id, 'The project directory is no longer registered on this machine.');
      return null;
    }

    return {
      task: {
        id: task.id,
        issueId: task.workOrderId,
        projectId: task.workOrder.projectId,
        status: task.status,
        attempt: task.attempt,
        plan: (task.plan ?? {}) as Record<string, unknown>,
        issue: {
          identifier: task.workOrder.id,
          title: task.workOrder.title,
          description: task.workOrder.instructions,
        },
        resource: {
          opaqueId: resource.opaqueId,
          name: resource.name,
          access: resource.access as 'READ_ONLY' | 'READ_WRITE',
        },
      },
      leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
  }

  /**
   * Extend a lease and answer whether the work should stop.
   *
   * Doubles as the cancellation channel because it is the only one the companion has — it listens for
   * no socket event and polls nothing else while a task is running.
   */
  async heartbeatTask(
    machine: RuntimeMachine,
    taskId: string,
    leaseToken: string,
  ): Promise<{ cancelled: boolean; leaseExpiresAt: string }> {
    const task = await this.requireLeasedTask(machine, taskId, leaseToken);
    const leaseExpiresAt = new Date(Date.now() + TASK_LEASE_MS);

    // Only extend while still LEASED; a task cancelled or reaped underneath us keeps its state.
    await this.prisma.runtimeTask.updateMany({
      where: { id: task.id, status: RuntimeTaskStatus.LEASED },
      data: { leaseExpiresAt },
    });

    return { cancelled: task.cancelRequested, leaseExpiresAt: leaseExpiresAt.toISOString() };
  }

  /**
   * Record the outcome of a task.
   *
   * Idempotent on purpose. The companion reuses one idempotency key for both the success and failure
   * branches of an attempt, and a cancelled run still reports a completion afterwards — so a second
   * call for an already-finished task must be accepted quietly rather than rejected as a conflict.
   */
  async completeTask(
    machine: RuntimeMachine,
    taskId: string,
    body: {
      leaseToken: string;
      succeeded: boolean;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): Promise<{ ok: true }> {
    const task = await this.prisma.runtimeTask.findFirst({
      where: { id: taskId, machineId: machine.id },
    });
    if (!task) throw new NotFoundException('Task not found');

    if (task.status !== RuntimeTaskStatus.LEASED) {
      // Already terminal — the outcome was recorded by an earlier call or by the reaper. Saying "yes,
      // fine" is what keeps the companion from retrying something that is already settled.
      return { ok: true };
    }

    if (!task.leaseTokenHash || task.leaseTokenHash !== this.tokens.hash(body.leaseToken)) {
      throw new ForbiddenException('Invalid lease token');
    }

    const output = typeof body.result?.output === 'string' ? body.result.output : null;
    const usage =
      body.result?.usage && typeof body.result.usage === 'object'
        ? (body.result.usage as object)
        : undefined;

    await this.prisma.runtimeTask.update({
      where: { id: task.id },
      data: {
        status: body.succeeded ? RuntimeTaskStatus.SUCCEEDED : RuntimeTaskStatus.FAILED,
        output,
        ...(usage ? { usage } : {}),
        error: body.succeeded ? null : (body.error ?? 'Local execution failed').slice(0, 20_000),
        completedAt: new Date(),
        leaseTokenHash: null,
        leaseExpiresAt: null,
      },
    });

    this.logger.log(
      `Runtime task ${task.id} ${body.succeeded ? 'succeeded' : 'failed'} on machine ${machine.id}`,
    );
    return { ok: true };
  }

  /** Resolve a task that must currently be leased to this machine with this token. */
  private async requireLeasedTask(
    machine: RuntimeMachine,
    taskId: string,
    leaseToken: string,
  ): Promise<RuntimeTask> {
    const task = await this.prisma.runtimeTask.findFirst({
      where: { id: taskId, machineId: machine.id },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!task.leaseTokenHash || task.leaseTokenHash !== this.tokens.hash(leaseToken)) {
      throw new ForbiddenException('Invalid lease token');
    }
    return task;
  }

  private async failTask(taskId: string, error: string): Promise<void> {
    await this.prisma.runtimeTask.update({
      where: { id: taskId },
      data: {
        status: RuntimeTaskStatus.FAILED,
        error,
        completedAt: new Date(),
        leaseTokenHash: null,
        leaseExpiresAt: null,
      },
    });
  }
}
