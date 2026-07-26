import { Injectable, Logger, Optional } from '@nestjs/common';
import { OrchestrationRunStatus, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrchestrationEmitter } from '../streaming/orchestration-emitter.service';
import {
  applyDevFlowPartial,
  type DevFlowStateType,
} from './devflow.state';
import {
  DevFlowNodeImpls,
  instrument,
  type NodeImpl,
} from './devflow.graph';
import {
  codeAgentsFor,
  gate2Router,
  NODE,
  validatorRouter,
  type FanoutTarget,
  type NodeName,
} from './topology';

/**
 * Eve migration — the explicit pipeline executor that replaces the LangGraph `StateGraph`.
 *
 * The pipeline runs as three resumable phases that map 1:1 onto the old topology:
 *   A: parse_requirements → negotiate_contract → gate_1_check
 *   B: (code agents, parallel) → self_critique → validate_outputs
 *      → execution_validate_outputs → [retry loop] → gate_2_check
 *   C: commit_to_github → mark_delivered
 *
 * Gates are explicit control flow (pause + persist) rather than thrown `NodeInterrupt`s.
 * Durability is the serialized state snapshot persisted to `OrchestrationRun.checkpointState`
 * after every node, replacing the Postgres checkpointer. Resume reloads that snapshot and
 * re-enters at the phase implied by the gate approvals.
 */

export type RunPhase = 'A' | 'B' | 'C';

export interface SequencerContext {
  impls: DevFlowNodeImpls;
  projectId: string;
  runId: string;
  state: DevFlowStateType;
  fromPhase: RunPhase;
  signal: AbortSignal;
}

export type SequencerOutcome =
  | { kind: 'paused'; gate: 'gate_1' | 'gate_2'; state: DevFlowStateType }
  | { kind: 'delivered'; state: DevFlowStateType }
  | { kind: 'failed'; error: string; state: DevFlowStateType }
  | { kind: 'aborted'; state: DevFlowStateType };

/** Maps a just-completed node to the coarse project status carried in `run.status` events. */
export const NODE_PROJECT_STATUS: Record<string, ProjectStatus> = {
  [NODE.PARSE_REQUIREMENTS]: ProjectStatus.NEGOTIATING_CONTRACT,
  [NODE.NEGOTIATE_CONTRACT]: ProjectStatus.AWAITING_GATE_1,
  [NODE.GATE_1_CHECK]: ProjectStatus.GENERATING_CODE,
  [NODE.FRONTEND_AGENT]: ProjectStatus.GENERATING_CODE,
  [NODE.MOBILE_AGENT]: ProjectStatus.GENERATING_CODE,
  [NODE.BACKEND_AGENT]: ProjectStatus.GENERATING_CODE,
  [NODE.DATABASE_AGENT]: ProjectStatus.GENERATING_CODE,
  [NODE.ARCHITECTURE_AGENT]: ProjectStatus.GENERATING_CODE,
  [NODE.QA_REVIEW]: ProjectStatus.GENERATING_CODE,
  [NODE.SELF_CRITIQUE]: ProjectStatus.GENERATING_CODE,
  [NODE.SECURITY_REVIEW]: ProjectStatus.GENERATING_CODE,
  [NODE.VALIDATE_OUTPUTS]: ProjectStatus.GENERATING_CODE,
  [NODE.EXECUTION_VALIDATE_OUTPUTS]: ProjectStatus.GENERATING_CODE,
  [NODE.GATE_2_CHECK]: ProjectStatus.COMMITTING,
  [NODE.COMMIT_TO_GITHUB]: ProjectStatus.COMMITTING,
  [NODE.MARK_DELIVERED]: ProjectStatus.DELIVERED,
  [NODE.MARK_FAILED]: ProjectStatus.FAILED,
};

@Injectable()
export class OrchestrationSequencer {
  private readonly logger = new Logger(OrchestrationSequencer.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly emitter: OrchestrationEmitter | null,
  ) {}

  /** Infers the resume phase from gate approvals: before gate 1 → A, before gate 2 → B, else C. */
  static phaseFromState(state: DevFlowStateType): RunPhase {
    if (!state.gate1Approved) return 'A';
    if (!state.gate2Approved) return 'B';
    return 'C';
  }

  async run(ctx: SequencerContext): Promise<SequencerOutcome> {
    try {
      if (ctx.fromPhase === 'A') {
        const a = await this.runPhaseA(ctx);
        if (a.kind !== 'continue') return a.outcome;
        ctx = { ...ctx, state: a.state };
      }
      if (ctx.fromPhase === 'A' || ctx.fromPhase === 'B') {
        const b = await this.runPhaseB(ctx);
        if (b.kind !== 'continue') return b.outcome;
        ctx = { ...ctx, state: b.state };
      }
      return await this.runPhaseC(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.markFailed(ctx, message);
    }
  }

  // ── Phase A: parse → negotiate → gate 1 ────────────────────────────────────
  private async runPhaseA(
    ctx: SequencerContext,
  ): Promise<{ kind: 'continue'; state: DevFlowStateType } | { kind: 'stop'; outcome: SequencerOutcome }> {
    let state = ctx.state;

    state = await this.runNode(ctx, NODE.PARSE_REQUIREMENTS, ctx.impls[NODE.PARSE_REQUIREMENTS], state);
    if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
    if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };

    state = await this.runNode(ctx, NODE.NEGOTIATE_CONTRACT, ctx.impls[NODE.NEGOTIATE_CONTRACT], state);
    if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
    if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };

    // gate_1_check
    if (!state.gate1Approved) {
      this.logger.log(`[${ctx.projectId}] Pausing at gate 1`);
      await this.setProjectStatus(ctx.projectId, ProjectStatus.AWAITING_GATE_1);
      await this.persist(ctx.runId, state, NODE.GATE_1_CHECK);
      return { kind: 'stop', outcome: { kind: 'paused', gate: 'gate_1', state } };
    }
    await this.setProjectStatus(ctx.projectId, ProjectStatus.GENERATING_CODE);
    return { kind: 'continue', state };
  }

  // ── Phase B: planned agents → reviews → validate/build → retry → gate 2 ────
  private async runPhaseB(
    ctx: SequencerContext,
  ): Promise<{ kind: 'continue'; state: DevFlowStateType } | { kind: 'stop'; outcome: SequencerOutcome }> {
    let state = ctx.state;
    let targets: FanoutTarget[] = codeAgentsFor(state).map((node) => ({ node }));

    for (;;) {
      // Parallel code-agent fan-out (or scoped retry fan-out).
      state = await this.runFanout(ctx, targets, state);
      if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
      if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };

      const plannedAgents = state.contract?.agentPlan?.activeAgents;
      if (
        (!plannedAgents || plannedAgents.includes('architecture')) &&
        !targets.some((target) => target.node === NODE.ARCHITECTURE_AGENT)
      ) {
        state = await this.runNode(
          ctx,
          NODE.ARCHITECTURE_AGENT,
          ctx.impls[NODE.ARCHITECTURE_AGENT],
          state,
        );
        if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
        if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };
      }

      if (state.contract?.agentPlan?.activeAgents.includes('qa')) {
        state = await this.runNode(ctx, NODE.QA_REVIEW, ctx.impls[NODE.QA_REVIEW], state);
        if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
      }

      if (state.contract?.agentPlan?.activeAgents.includes('integration')) {
        state = await this.runNode(ctx, NODE.SELF_CRITIQUE, ctx.impls[NODE.SELF_CRITIQUE], state);
        if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
        if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };
      }

      if (state.contract?.agentPlan?.activeAgents.includes('security')) {
        state = await this.runNode(
          ctx,
          NODE.SECURITY_REVIEW,
          ctx.impls[NODE.SECURITY_REVIEW],
          state,
        );
        if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
      }

      state = await this.runNode(ctx, NODE.VALIDATE_OUTPUTS, ctx.impls[NODE.VALIDATE_OUTPUTS], state);
      if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
      if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };

      let route = validatorRouter(state);
      if (route !== NODE.GATE_2_CHECK) {
        // Non-empty retry plan → re-run only the failing agents with scoped feedback.
        targets = route as FanoutTarget[];
        continue;
      }

      state = await this.runNode(
        ctx,
        NODE.EXECUTION_VALIDATE_OUTPUTS,
        ctx.impls[NODE.EXECUTION_VALIDATE_OUTPUTS],
        state,
      );
      if (this.aborted(ctx)) return { kind: 'stop', outcome: { kind: 'aborted', state } };
      if (state.error) return { kind: 'stop', outcome: await this.markFailed({ ...ctx, state }, state.error) };

      route = validatorRouter(state);
      if (route === NODE.GATE_2_CHECK) break;
      // Non-empty retry plan → re-run only the failing agents with scoped feedback.
      targets = route as FanoutTarget[];
    }

    // gate_2_check
    if (!state.gate2Approved) {
      this.logger.log(`[${ctx.projectId}] Pausing at gate 2`);
      await this.setProjectStatus(ctx.projectId, ProjectStatus.AWAITING_GATE_2);
      await this.persist(ctx.runId, state, NODE.GATE_2_CHECK);
      return { kind: 'stop', outcome: { kind: 'paused', gate: 'gate_2', state } };
    }
    return { kind: 'continue', state };
  }

  // ── Phase C: commit → delivered ────────────────────────────────────────────
  private async runPhaseC(ctx: SequencerContext): Promise<SequencerOutcome> {
    let state = ctx.state;

    // gate_2_check error routing (gate2Router): any error is terminal.
    if (gate2Router(state) === NODE.MARK_FAILED) {
      return this.markFailed(ctx, state.error ?? 'Run failed before commit');
    }

    state = await this.runNode(ctx, NODE.COMMIT_TO_GITHUB, ctx.impls[NODE.COMMIT_TO_GITHUB], state);
    if (this.aborted(ctx)) return { kind: 'aborted', state };
    if (state.error) return this.markFailed({ ...ctx, state }, state.error);

    // mark_delivered
    await this.setProjectStatus(ctx.projectId, ProjectStatus.DELIVERED);
    await this.persist(ctx.runId, state, NODE.MARK_DELIVERED);
    this.emitter?.runStatus(ctx.projectId, ctx.runId, ProjectStatus.DELIVERED, NODE.MARK_DELIVERED);
    return { kind: 'delivered', state };
  }

  // ── Node execution + bookkeeping ───────────────────────────────────────────

  private async runNode(
    ctx: SequencerContext,
    nodeId: NodeName,
    impl: NodeImpl,
    state: DevFlowStateType,
  ): Promise<DevFlowStateType> {
    const partial = await instrument(nodeId, impl, this.emitter)(state);
    const next = applyDevFlowPartial(state, partial);
    await this.afterNode(ctx, nodeId, next);
    return next;
  }

  /** Runs a set of targets in parallel and merges their partial results onto the base state. */
  private async runFanout(
    ctx: SequencerContext,
    targets: FanoutTarget[],
    state: DevFlowStateType,
  ): Promise<DevFlowStateType> {
    const results = await Promise.all(
      targets.map((target) => {
        const input = target.patch ? applyDevFlowPartial(state, target.patch) : state;
        return instrument(target.node, ctx.impls[target.node as keyof DevFlowNodeImpls], this.emitter)(input);
      }),
    );
    let merged = state;
    for (const result of results) merged = applyDevFlowPartial(merged, result);
    // Emit lifecycle/status for each fanned-out node and persist once after the join.
    for (const target of targets) {
      this.emitStatus(ctx, target.node);
    }
    await this.persist(ctx.runId, merged, targets[targets.length - 1]?.node ?? NODE.VALIDATE_OUTPUTS);
    return merged;
  }

  private async afterNode(ctx: SequencerContext, nodeId: NodeName, state: DevFlowStateType): Promise<void> {
    this.emitStatus(ctx, nodeId);
    await this.persist(ctx.runId, state, nodeId);
  }

  private emitStatus(ctx: SequencerContext, nodeId: NodeName): void {
    const status = NODE_PROJECT_STATUS[nodeId] ?? ProjectStatus.GENERATING_CODE;
    this.emitter?.runStatus(ctx.projectId, ctx.runId, status, nodeId);
  }

  /** Persists the run-state snapshot + current node, replacing the LangGraph checkpointer. */
  private async persist(runId: string, state: DevFlowStateType, currentNode: string): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { runId },
      data: {
        currentNode,
        checkpointState: state as unknown as object,
        lastHeartbeatAt: new Date(),
      },
    });
  }

  private async setProjectStatus(projectId: string, status: ProjectStatus): Promise<void> {
    await this.prisma.project.update({ where: { id: projectId }, data: { status } });
  }

  private aborted(ctx: SequencerContext): boolean {
    return ctx.signal.aborted;
  }

  /** Terminal failure — mirrors the old mark_failed node (project FAILED + structured run.error). */
  private async markFailed(ctx: SequencerContext, reason: string): Promise<SequencerOutcome> {
    this.logger.warn(`[${ctx.projectId}] Marking run failed: ${reason}`);
    await this.setProjectStatus(ctx.projectId, ProjectStatus.FAILED);
    await this.prisma.orchestrationRun.updateMany({
      where: { runId: ctx.runId },
      data: {
        status: OrchestrationRunStatus.FAILED,
        currentNode: NODE.MARK_FAILED,
        error: reason,
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    this.emitter?.runError(ctx.projectId, ctx.runId, {
      code: /validation/i.test(reason) ? 'VALIDATION_FAILED' : 'NODE_FAILED',
      severity: 'permanent',
      message: reason,
    });
    return { kind: 'failed', error: reason, state: ctx.state };
  }
}
