import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrchestrationEmitter } from '../orchestration/streaming/orchestration-emitter.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostMeta {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// ─── Budget Thresholds ────────────────────────────────────────────────────────

/**
 * Warn when tokensConsumed reaches 90% of tokenBudget.
 * At 100% (>= tokenBudget) the run is escalated immediately.
 */
const BUDGET_WARN_THRESHOLD = 0.9;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * EventLogService — records node-level lifecycle events to the event_logs table
 * and maintains the cumulative token budget in run_budgets.
 *
 * Design principle: ALL methods use Promise.allSettled internally so that a
 * failure to write an event log row NEVER propagates to — or blocks — the
 * calling agent node. The agent continues regardless.
 */
@Injectable()
export class EventLogService {
  private readonly logger = new Logger(EventLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional to avoid a hard cycle with OrchestrationModule and to keep the
    // event log working in runtimes without the streaming layer.
    @Optional() private readonly emitter: OrchestrationEmitter | null,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Log a STARTED event when a node begins execution.
   */
  async logStarted(projectId: string, nodeName: string): Promise<void> {
    const [result] = await Promise.allSettled([
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'STARTED',
          costMeta: {},
          runTokens: await this.getCurrentTokens(projectId),
        },
      }),
    ]);

    if (result.status === 'rejected') {
      this.logger.warn(
        `[${projectId}] Failed to log STARTED for ${nodeName}: ${String(result.reason)}`,
      );
    }
  }

  /**
   * Log a COMPLETED event and atomically increment RunBudget.tokensConsumed.
   *
   * Budget enforcement:
   *   - Warn at >= 90% consumption
   *   - Escalate at >= 100% consumption (delegates to RunSupervisorService via
   *     DB state change; the supervisor detects this on its next poll)
   *
   * The token increment and event log write are performed as separate operations
   * wrapped in Promise.allSettled — a log failure does not roll back the budget
   * increment, and vice versa.
   */
  async logCompleted(
    projectId: string,
    nodeName: string,
    costMeta: CostMeta,
  ): Promise<void> {
    const tokensThisCall = costMeta.inputTokens + costMeta.outputTokens;

    // Step 1: Atomically increment tokensConsumed and read back the new total.
    const [budgetResult] = await Promise.allSettled([
      this.prisma.runBudget.update({
        where: { projectId },
        data: { tokensConsumed: { increment: tokensThisCall } },
        select: { tokensConsumed: true, tokenBudget: true, projectId: true },
      }),
    ]);

    let updatedTokens = 0;
    let tokenBudget = 200_000; // schema default, used only if DB read fails

    if (budgetResult.status === 'fulfilled') {
      updatedTokens = budgetResult.value.tokensConsumed;
      tokenBudget = budgetResult.value.tokenBudget;
    } else {
      this.logger.warn(
        `[${projectId}] Failed to increment RunBudget for ${nodeName}: ${String(budgetResult.reason)}`,
      );
    }

    // Step 2: Write the EventLog row with the cumulative token total.
    const [logResult] = await Promise.allSettled([
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'COMPLETED',
          costMeta: {
            inputTokens: costMeta.inputTokens,
            outputTokens: costMeta.outputTokens,
            model: costMeta.model,
          },
          runTokens: updatedTokens,
        },
      }),
    ]);

    if (logResult.status === 'rejected') {
      this.logger.warn(
        `[${projectId}] Failed to write COMPLETED EventLog for ${nodeName}: ${String(logResult.reason)}`,
      );
    }

    // Step 2b: Emit token/cost telemetry on the typed protocol channel.
    // runId is resolved lazily from the project (set at run start); telemetry is
    // best-effort and never blocks the node.
    if (this.emitter) {
      void this.prisma.project
        .findUnique({ where: { id: projectId }, select: { runId: true } })
        .then((project) => {
          this.emitter?.nodeTelemetry(projectId, nodeName, {
            runId: project?.runId ?? undefined,
            inputTokens: costMeta.inputTokens,
            outputTokens: costMeta.outputTokens,
            model: costMeta.model,
          });
        })
        .catch(() => undefined);
    }

    // Step 3: Budget enforcement warnings.
    if (budgetResult.status === 'fulfilled') {
      const pct = updatedTokens / tokenBudget;

      if (pct >= 1) {
        // Full budget exhausted — mark project for escalation so the supervisor
        // picks it up on its next poll without blocking this node.
        this.logger.warn(
          `[${projectId}] TOKEN BUDGET EXHAUSTED: ${updatedTokens}/${tokenBudget} tokens used after ${nodeName}. Supervisor will escalate.`,
        );
        // Write a synthetic ESCALATED event so the supervisor has a clear signal.
        await Promise.allSettled([
          this.logEscalated(projectId, nodeName, 'Token budget exhausted'),
        ]);
      } else if (pct >= BUDGET_WARN_THRESHOLD) {
        this.logger.warn(
          `[${projectId}] Budget warning: ${updatedTokens}/${tokenBudget} tokens consumed (${Math.round(pct * 100)}%) after ${nodeName}`,
        );
      }
    }
  }

  /**
   * Log a FAILED event when a node throws or returns an error.
   * The error string is stored in costMeta for auditability.
   */
  async logFailed(
    projectId: string,
    nodeName: string,
    error: string,
  ): Promise<void> {
    const [result] = await Promise.allSettled([
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'FAILED',
          costMeta: { error },
          runTokens: await this.getCurrentTokens(projectId),
        },
      }),
    ]);

    if (result.status === 'rejected') {
      this.logger.warn(
        `[${projectId}] Failed to log FAILED for ${nodeName}: ${String(result.reason)}`,
      );
    }
  }

  /**
   * Log a STUCK event — called by RunSupervisorService when a run stalls.
   */
  async logStuck(projectId: string, nodeName: string): Promise<void> {
    const [result] = await Promise.allSettled([
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'STUCK',
          costMeta: {},
          runTokens: await this.getCurrentTokens(projectId),
        },
      }),
    ]);

    if (result.status === 'rejected') {
      this.logger.warn(
        `[${projectId}] Failed to log STUCK for ${nodeName}: ${String(result.reason)}`,
      );
    }
  }

  /**
   * Log an ESCALATED event — called when budget is exhausted or retries are
   * exceeded. Records reason in costMeta for the audit trail.
   */
  async logEscalated(
    projectId: string,
    nodeName: string,
    reason: string,
  ): Promise<void> {
    const [result] = await Promise.allSettled([
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'ESCALATED',
          costMeta: { reason },
          runTokens: await this.getCurrentTokens(projectId),
        },
      }),
    ]);

    if (result.status === 'rejected') {
      this.logger.warn(
        `[${projectId}] Failed to log ESCALATED for ${nodeName}: ${String(result.reason)}`,
      );
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Reads the current cumulative token total from RunBudget.
   * Returns 0 if no budget row exists (safe default for event log rows).
   */
  private async getCurrentTokens(projectId: string): Promise<number> {
    try {
      const budget = await this.prisma.runBudget.findUnique({
        where: { projectId },
        select: { tokensConsumed: true },
      });
      return budget?.tokensConsumed ?? 0;
    } catch {
      return 0;
    }
  }
}
