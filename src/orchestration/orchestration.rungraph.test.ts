import { describe, it, expect, vi } from 'vitest';
import { OrchestrationSequencer } from './graph/orchestration-sequencer';
import { createInitialDevFlowState, type DevFlowStateType } from './graph/devflow.state';
import type { DevFlowNodeImpls, NodeImpl } from './graph/devflow.graph';
import { NODE } from './graph/topology';

/**
 * Eve migration — exercises the OrchestrationSequencer that replaced the LangGraph stream loop:
 * it should emit a run.status event and persist currentNode for each executed node, deliver a
 * fully-approved run, and surface a node error as run.error + a FAILED run row.
 */
function passthrough(): NodeImpl {
  return () => ({});
}

function makeImpls(overrides: Partial<DevFlowNodeImpls> = {}): DevFlowNodeImpls {
  return {
    [NODE.PARSE_REQUIREMENTS]: passthrough(),
    [NODE.NEGOTIATE_CONTRACT]: passthrough(),
    [NODE.FRONTEND_AGENT]: passthrough(),
    [NODE.MOBILE_AGENT]: passthrough(),
    [NODE.BACKEND_AGENT]: passthrough(),
    [NODE.DATABASE_AGENT]: passthrough(),
    [NODE.ARCHITECTURE_AGENT]: passthrough(),
    [NODE.SELF_CRITIQUE]: passthrough(),
    [NODE.VALIDATE_OUTPUTS]: () => ({ retryPlan: [] }),
    [NODE.EXECUTION_VALIDATE_OUTPUTS]: passthrough(),
    [NODE.COMMIT_TO_GITHUB]: passthrough(),
    ...overrides,
  };
}

function makeSequencer() {
  const prisma = {
    orchestrationRun: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    project: { update: vi.fn().mockResolvedValue({}) },
  };
  const emitter = {
    runStatus: vi.fn(),
    runError: vi.fn(),
    nodeLifecycle: vi.fn(),
    nodeTelemetry: vi.fn(),
  };
  const sequencer = new OrchestrationSequencer(prisma as never, emitter as never);
  return { sequencer, prisma, emitter };
}

function seedState(overrides: Partial<DevFlowStateType> = {}): DevFlowStateType {
  return createInitialDevFlowState({ projectId: 'proj-1', runId: 'run-1', ...overrides });
}

describe('OrchestrationSequencer', () => {
  it('emits run.status and persists currentNode for each executed node, then delivers', async () => {
    const { sequencer, prisma, emitter } = makeSequencer();
    const state = seedState({ gate1Approved: true, gate2Approved: true });

    const outcome = await sequencer.run({
      impls: makeImpls(),
      projectId: 'proj-1',
      runId: 'run-1',
      state,
      fromPhase: 'A',
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('delivered');

    const nodes = emitter.runStatus.mock.calls.map((c) => c[3]);
    expect(nodes).toContain(NODE.PARSE_REQUIREMENTS);
    expect(nodes).toContain(NODE.NEGOTIATE_CONTRACT);
    expect(nodes).toContain(NODE.EXECUTION_VALIDATE_OUTPUTS);
    expect(nodes).toContain(NODE.COMMIT_TO_GITHUB);

    const persistedNodes = prisma.orchestrationRun.update.mock.calls.map((c) => c[0].data.currentNode);
    expect(persistedNodes).toContain(NODE.PARSE_REQUIREMENTS);
    expect(persistedNodes).toContain(NODE.NEGOTIATE_CONTRACT);
  });

  it('pauses at gate 1 when not approved', async () => {
    const { sequencer, prisma } = makeSequencer();
    const outcome = await sequencer.run({
      impls: makeImpls(),
      projectId: 'proj-1',
      runId: 'run-1',
      state: seedState(),
      fromPhase: 'A',
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('paused');
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_GATE_1' } }),
    );
  });

  it('surfaces a node error as run.error + a FAILED run row', async () => {
    const { sequencer, prisma, emitter } = makeSequencer();
    const outcome = await sequencer.run({
      impls: makeImpls({ [NODE.PARSE_REQUIREMENTS]: () => ({ error: 'llm exploded' }) }),
      projectId: 'proj-1',
      runId: 'run-1',
      state: seedState({ gate1Approved: true, gate2Approved: true }),
      fromPhase: 'A',
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('failed');
    expect(emitter.runError).toHaveBeenCalledWith(
      'proj-1',
      'run-1',
      expect.objectContaining({ code: 'NODE_FAILED', severity: 'permanent' }),
    );
    expect(prisma.orchestrationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('does not run execution validation when static validation requests a retry', async () => {
    const { sequencer } = makeSequencer();
    const executionValidate = vi.fn(() => ({}));
    let validationAttempts = 0;
    const outcome = await sequencer.run({
      impls: makeImpls({
        [NODE.VALIDATE_OUTPUTS]: () => {
          validationAttempts += 1;
          return validationAttempts === 1
            ? {
                retryPlan: [{ agentType: 'frontend', feedback: 'fix static validation' }],
              }
            : { error: 'static validation remained broken' };
        },
        [NODE.FRONTEND_AGENT]: () => ({ retryPlan: [] }),
        [NODE.EXECUTION_VALIDATE_OUTPUTS]: executionValidate,
      }),
      projectId: 'proj-1',
      runId: 'run-1',
      state: seedState({ gate1Approved: true, gate2Approved: true, retryCount: 4 }),
      fromPhase: 'B',
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('failed');
    expect(executionValidate).not.toHaveBeenCalled();
  });

  it('routes execution validation retry plans before gate 2', async () => {
    const { sequencer, emitter } = makeSequencer();
    let executionAttempts = 0;
    let frontendRetries = 0;

    const outcome = await sequencer.run({
      impls: makeImpls({
        [NODE.EXECUTION_VALIDATE_OUTPUTS]: () => {
          executionAttempts += 1;
          return executionAttempts === 1
            ? {
                retryCount: 1,
                retryPlan: [{ agentType: 'frontend', feedback: 'fix build' }],
              }
            : { retryPlan: [] };
        },
        [NODE.FRONTEND_AGENT]: () => {
          frontendRetries += 1;
          return {};
        },
      }),
      projectId: 'proj-1',
      runId: 'run-1',
      state: seedState({ gate1Approved: true, gate2Approved: true }),
      fromPhase: 'B',
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('delivered');
    expect(executionAttempts).toBe(2);
    expect(frontendRetries).toBe(2);
    const nodes = emitter.runStatus.mock.calls.map((c) => c[3]);
    expect(nodes).toContain(NODE.EXECUTION_VALIDATE_OUTPUTS);
    expect(nodes).toContain(NODE.COMMIT_TO_GITHUB);
  });
});
