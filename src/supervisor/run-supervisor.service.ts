import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  OrchestrationRunStatus,
  ProjectStatus,
  WorkOrderExecutionStatus,
  WorkOrderStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventLogService } from './event-log.service';
import { OrchestrationService } from '../orchestration/orchestration.service';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How often the supervisor polls for stuck runs.
 * 60 seconds is suitable for development; tighten in production if SLA requires.
 */
const POLL_INTERVAL_MS = 60_000;

/**
 * A run is considered "stuck" when its project row has not transitioned to a
 * terminal status AND no EventLog entry has been written in the past 10 minutes.
 */
const STUCK_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Project statuses that represent active automation. Human-wait states such as
 * AWAITING_GATE_1 and AWAITING_GATE_2 can be idle for a long time by design.
 */
const SUPERVISED_STATUSES = [
  ProjectStatus.PARSING_REQUIREMENTS,
  ProjectStatus.NEGOTIATING_CONTRACT,
  ProjectStatus.GENERATING_CODE,
  ProjectStatus.COMMITTING,
] as const;
const SUPERVISOR_NODE = 'supervisor';

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * RunSupervisorService — polls every 60 s for stuck runs and applies the
 * deterministic recovery strategy:
 *
 *   1. Stuck run detected (no EventLog entry in > 10 minutes)
 *   2. Check RunBudget:
 *      a. retryCount >= maxRetries  →  escalateToHuman()  →  status = FAILED
 *      b. Otherwise                 →  increment retryCount, log STUCK, requeue
 *         stale dispatched work orders, then ask OrchestrationService to create
 *         and execute a durable recovery run.
 *
 * The supervisor does not execute agent work directly. It only detects stale
 * state and delegates recovery execution to OrchestrationService.
 */
@Injectable()
export class RunSupervisorService {
  private readonly logger = new Logger(RunSupervisorService.name);
  private tickInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLog: EventLogService,
    @Inject(forwardRef(() => OrchestrationService))
    private readonly orchestration: OrchestrationService,
  ) {}

  // ── Polling tick ───────────────────────────────────────────────────────────

  /**
   * Main supervisor loop. Decorated with @Interval so NestJS Schedule triggers
   * it every POLL_INTERVAL_MS milliseconds after the application boots.
   */
  @Interval(POLL_INTERVAL_MS)
  async supervisorTick(): Promise<void> {
    if (this.tickInProgress) {
      this.logger.warn(
        'Skipping supervisor tick because the previous tick is still running.',
      );
      return;
    }

    this.tickInProgress = true;

    try {
      const stuckProjects = await this.findStuckProjects();

      if (stuckProjects.length === 0) {
        return;
      }

      this.logger.warn(
        `Supervisor detected ${stuckProjects.length} stuck run(s): [${stuckProjects.map((p) => p.id).join(', ')}]`,
      );

      // Recovery can fan out into several database writes and an orchestration
      // run. Process projects sequentially so a small Prisma pool is not flooded
      // and so the next scheduled tick cannot overlap this one.
      for (const project of stuckProjects) {
        try {
          await this.handleStuckProject(project);
        } catch (err) {
          this.logger.error(
            `[${project.id}] Supervisor recovery failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Supervisor tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.tickInProgress = false;
    }
  }

  // ── Public: escalation (also called from EventLogService on budget exhaust) ──

  /**
   * Escalates a project to human review.
   *
   * Sets project status to FAILED, writes an ESCALATED event log entry, and
   * emits a WARN-level log with full context for on-call visibility.
   */
  async escalateToHuman(projectId: string, reason: string): Promise<void> {
    this.logger.warn(
      `[${projectId}] ESCALATING to human — reason: ${reason}`,
    );

    // Gather context for the warning log before mutating state.
    const [budget, lastEvent] = await Promise.allSettled([
      this.prisma.runBudget.findUnique({
        where: { projectId },
        select: {
          tokensConsumed: true,
          tokenBudget: true,
          retryCount: true,
          maxRetries: true,
        },
      }),
      this.prisma.eventLog.findFirst({
        where: { projectId },
        orderBy: { occurredAt: 'desc' },
        select: { nodeName: true, eventType: true, occurredAt: true },
      }),
    ]);

    const budgetInfo =
      budget.status === 'fulfilled' && budget.value
        ? `tokens=${budget.value.tokensConsumed}/${budget.value.tokenBudget}, retries=${budget.value.retryCount}/${budget.value.maxRetries}`
        : 'budget unavailable';

    const lastNode =
      lastEvent.status === 'fulfilled' && lastEvent.value
        ? `${lastEvent.value.nodeName}:${lastEvent.value.eventType} at ${lastEvent.value.occurredAt.toISOString()}`
        : 'no events recorded';

    this.logger.warn(
      `[${projectId}] Escalation context — ${budgetInfo} | last known node: ${lastNode} | reason: ${reason}`,
    );

    const failedAt = new Date();

    // Persist state changes and event log atomically via allSettled.
    await Promise.allSettled([
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.FAILED },
      }),
      this.failRunningRuntimeState(projectId, reason, failedAt),
      this.failDispatchedWorkOrders(projectId, reason, failedAt),
      this.eventLog.logEscalated(projectId, SUPERVISOR_NODE, reason),
    ]);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns all projects that are in active automation statuses and have had no
   * EventLog activity in the past STUCK_THRESHOLD_MS milliseconds.
   *
   * Uses a raw query to perform the correlated subquery efficiently. The status
   * list intentionally excludes human-wait states; prisma.$queryRaw returns
   * typed rows.
   */
  private async findStuckProjects(): Promise<StuckProject[]> {
    const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS);

    // Raw SQL: join Project to RunBudget and check max(occurredAt) per project.
    // Projects with no EventLog rows at all are also considered stuck.
    const rows = await this.prisma.$queryRaw<StuckProjectRow[]>`
      SELECT
        p.id,
        p.status,
        rb."retryCount",
        rb."maxRetries",
        rb."tokensConsumed",
        rb."tokenBudget"
      FROM projects."Project" p
      INNER JOIN orchestration.run_budgets rb ON rb."projectId" = p.id
      LEFT JOIN LATERAL (
        SELECT MAX(el."occurredAt") AS "lastEventAt"
        FROM orchestration.event_logs el
        WHERE el."projectId" = p.id
      ) last_event ON true
      WHERE p.status IN (
        CAST(${SUPERVISED_STATUSES[0]} AS projects."ProjectStatus"),
        CAST(${SUPERVISED_STATUSES[1]} AS projects."ProjectStatus"),
        CAST(${SUPERVISED_STATUSES[2]} AS projects."ProjectStatus"),
        CAST(${SUPERVISED_STATUSES[3]} AS projects."ProjectStatus")
      )
        AND (
          last_event."lastEventAt" IS NULL
          OR last_event."lastEventAt" < ${threshold}
        )
    `;

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      retryCount: Number(row.retryCount),
      maxRetries: Number(row.maxRetries),
      tokensConsumed: Number(row.tokensConsumed),
      tokenBudget: Number(row.tokenBudget),
    }));
  }

  /**
   * Applies the recovery strategy to a single stuck project.
   */
  private async handleStuckProject(project: StuckProject): Promise<void> {
    // Manual intervention takes precedence over automatic recovery. A project
    // paused via the control API is intentionally idle — do not auto-retry it.
    if (this.orchestration.isManuallyHalted(project.id)) {
      this.logger.log(
        `[${project.id}] Skipping auto-recovery — run is manually paused.`,
      );
      return;
    }

    const budgetExhausted = project.tokensConsumed >= project.tokenBudget;
    const retriesExhausted = project.retryCount >= project.maxRetries;

    if (budgetExhausted || retriesExhausted) {
      const reason = budgetExhausted
        ? `Token budget exhausted (${project.tokensConsumed}/${project.tokenBudget})`
        : `Max retries reached (${project.retryCount}/${project.maxRetries})`;

      await this.escalateToHuman(project.id, reason);
      return;
    }

    // Auto-retry path: increment retryCount, log STUCK event, then reset the
    // project status back to an active state so OrchestrationService can resume
    // the LangGraph run from the last checkpoint.
    this.logger.warn(
      `[${project.id}] Auto-retrying stuck run (attempt ${project.retryCount + 1}/${project.maxRetries})`,
    );

    const recoveredAt = new Date();
    const reason = `Supervisor detected stale run and queued retry ${project.retryCount + 1}/${project.maxRetries}`;

    await Promise.allSettled([
      // Increment retry counter.
      this.prisma.runBudget.update({
        where: { projectId: project.id },
        data: { retryCount: { increment: 1 } },
      }),
      // Write the STUCK audit event.
      this.eventLog.logStuck(project.id, SUPERVISOR_NODE),
      this.failRunningRuntimeState(project.id, reason, recoveredAt),
      // Reset project status to its current active state to signal re-invocation.
      // The previous status is preserved — OrchestrationService polls status and
      // resumes the graph from the LangGraph checkpoint when it sees an active state.
      this.prisma.project.update({
        where: { id: project.id },
        data: { status: project.status },
      }),
    ]);

    const requeueResult = await Promise.allSettled([
      this.requeueDispatchedWorkOrders(project.id, reason, recoveredAt),
    ]);

    if (requeueResult[0]?.status === 'rejected') {
      this.logger.error(
        `[${project.id}] Supervisor could not requeue dispatched work orders: ${requeueResult[0].reason instanceof Error ? requeueResult[0].reason.message : String(requeueResult[0].reason)}`,
      );
      return;
    }

    await this.orchestration
      .recoverStaleProject(project.id, {
        reason,
        retryAttempt: project.retryCount + 1,
        maxRetries: project.maxRetries,
      })
      .then((result) => {
        this.logger.log(
          `[${project.id}] Supervisor recovery run ${result.runId} finished with ${result.status}`,
        );
      })
      .catch((err: unknown) => {
        this.logger.error(
          `[${project.id}] Supervisor recovery execution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    this.logger.log(
      `[${project.id}] Stuck run marked for retry and recovery execution was requested.`,
    );
  }

  private async failRunningRuntimeState(
    projectId: string,
    reason: string,
    completedAt: Date,
  ): Promise<void> {
    await Promise.allSettled([
      this.prisma.orchestrationRun.updateMany({
        where: {
          projectId,
          status: OrchestrationRunStatus.RUNNING,
        },
        data: {
          status: OrchestrationRunStatus.FAILED,
          currentNode: SUPERVISOR_NODE,
          error: reason,
          completedAt,
        },
      }),
      this.prisma.workOrderExecution.updateMany({
        where: {
          projectId,
          status: WorkOrderExecutionStatus.RUNNING,
        },
        data: {
          status: WorkOrderExecutionStatus.FAILED,
          error: reason,
          completedAt,
          metadata: {
            recoveredBy: SUPERVISOR_NODE,
            reason,
            recoveredAt: completedAt.toISOString(),
          },
        },
      }),
    ]);
  }

  private async requeueDispatchedWorkOrders(
    projectId: string,
    reason: string,
    recoveredAt: Date,
  ): Promise<void> {
    await this.prisma.workOrder.updateMany({
      where: {
        projectId,
        status: WorkOrderStatus.DISPATCHED,
      },
      data: {
        status: WorkOrderStatus.READY,
        executionRunId: null,
        executionStartedAt: null,
        executionCompletedAt: recoveredAt,
        executionError: reason,
        lastEventAt: recoveredAt,
      },
    });
  }

  private async failDispatchedWorkOrders(
    projectId: string,
    reason: string,
    failedAt: Date,
  ): Promise<void> {
    await this.prisma.workOrder.updateMany({
      where: {
        projectId,
        status: WorkOrderStatus.DISPATCHED,
      },
      data: {
        status: WorkOrderStatus.FAILED,
        executionCompletedAt: failedAt,
        executionError: reason,
        lastEventAt: failedAt,
        failedAt,
      },
    });
  }
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface StuckProjectRow {
  id: string;
  status: ProjectStatus;
  retryCount: bigint | number;
  maxRetries: bigint | number;
  tokensConsumed: bigint | number;
  tokenBudget: bigint | number;
}

interface StuckProject {
  id: string;
  status: ProjectStatus;
  retryCount: number;
  maxRetries: number;
  tokensConsumed: number;
  tokenBudget: number;
}
