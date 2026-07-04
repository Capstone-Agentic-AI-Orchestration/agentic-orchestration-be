import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestrationService } from './orchestration.service';
import { createInitialDevFlowState } from './graph/devflow.state';

/**
 * Eve migration — focused unit tests for the mid-run control dispatch. The LangGraph compiled
 * graph is gone; control now drives the injected OrchestrationSequencer and patches the
 * persisted checkpointState (OrchestrationRun). We stub only the collaborators the control
 * paths touch (prisma, the sequencer, the emitter).
 */
function makeService() {
  const checkpointState = createInitialDevFlowState({
    projectId: 'proj-1',
    runId: 'run-1',
    gate1Approved: true,
  });

  const prisma = {
    project: {
      findUnique: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    orchestrationRun: {
      updateMany: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      // Both the status check and loadCheckpointState read via findUnique.
      findUnique: vi.fn().mockResolvedValue({ status: 'RUNNING', checkpointState }),
    },
    workOrder: { updateMany: vi.fn().mockResolvedValue({}) },
    runBudget: { update: vi.fn().mockResolvedValue({}) },
  };

  // Stub sequencer so fire-and-forget driveRun completes without executing real nodes.
  const sequencer = { run: vi.fn().mockResolvedValue({ kind: 'paused', gate: 'gate_1', state: checkpointState }) };

  const emitter = {
    runStatus: vi.fn(),
    runError: vi.fn(),
    nodeLifecycle: vi.fn(),
    nodeTelemetry: vi.fn(),
  };

  // Positional constructor args: prisma(1), 15 unused node/service deps (2-16), sequencer(17),
  // graphLlmProvider(18=null), gateway(19=null), emitter(20).
  const u = undefined as unknown as never;
  const service = new OrchestrationService(
    prisma as never,
    u, u, u, u, u, u, u, u, u, u, u, u, u, u, u,
    sequencer as never,
    null as never,
    null as never,
    emitter as never,
  );

  return { service, prisma, sequencer, emitter };
}

describe('OrchestrationService.control', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('cancel: run CANCELLED + project FAILED + work orders CANCELLED', async () => {
    const res = await ctx.service.control('proj-1', 'cancel', { actorId: 'user-9' });
    expect(res).toEqual({ accepted: true, action: 'cancel', status: 'CANCELLED' });
    expect(ctx.prisma.orchestrationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(ctx.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FAILED' } }),
    );
    expect(ctx.prisma.workOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(ctx.emitter.runStatus).toHaveBeenCalled();
    expect(ctx.emitter.runError).toHaveBeenCalled();
  });

  it('pause sets the halt flag; resume clears it and drives the sequencer', async () => {
    await ctx.service.control('proj-1', 'pause', {});
    expect(ctx.service.isManuallyHalted('proj-1')).toBe(true);

    await ctx.service.control('proj-1', 'resume', {});
    expect(ctx.service.isManuallyHalted('proj-1')).toBe(false);
    expect(ctx.sequencer.run).toHaveBeenCalled();
  });

  it('resume throws if the run was cancelled', async () => {
    ctx.prisma.orchestrationRun.findUnique.mockResolvedValueOnce({ status: 'CANCELLED' });
    await expect(ctx.service.control('proj-1', 'resume', {})).rejects.toThrow();
  });

  it('modify_params patches whitelisted run state into the checkpoint', async () => {
    const res = await ctx.service.control('proj-1', 'modify_params', { params: { retryCount: 0 } });
    expect(res.action).toBe('modify_params');
    expect(ctx.prisma.orchestrationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ checkpointState: expect.anything() }) }),
    );
  });

  it('modify_params with no recognized fields throws', async () => {
    await expect(
      ctx.service.control('proj-1', 'modify_params', { params: { bogus: 1 } }),
    ).rejects.toThrow();
  });

  it('skip_node without a nodeId throws', async () => {
    await expect(ctx.service.control('proj-1', 'skip_node', {})).rejects.toThrow();
  });

  it('skip_node clears the error and re-enters via the sequencer', async () => {
    await ctx.service.control('proj-1', 'skip_node', { nodeId: 'database_agent' });
    expect(ctx.emitter.nodeLifecycle).toHaveBeenCalledWith(
      'proj-1', 'run-1', 'database_agent', 'skipped',
    );
    expect(ctx.sequencer.run).toHaveBeenCalled();
  });
});
