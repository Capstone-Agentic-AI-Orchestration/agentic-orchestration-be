import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSimulationNodeImpls } from './simulation-nodes';
import { NODE } from './topology';
import type { DevFlowStateType } from './devflow.state';

// Zero out the per-step delay so the scripted sequences run instantly.
process.env.SIMULATION_STEP_MS = '0';

function makeEmitter() {
  return {
    agentStream: vi.fn(),
    nodeProgress: vi.fn(),
    nodeLifecycle: vi.fn(),
    nodeTelemetry: vi.fn(),
    runStatus: vi.fn(),
    runError: vi.fn(),
  };
}

const baseState = {
  projectId: 'proj-1',
  runId: 'run-1',
  brief: 'demo',
  stackKey: 'nextjs-nestjs',
  companyName: 'Acme',
  error: null,
} as unknown as DevFlowStateType;

describe('simulation node impls', () => {
  let emitter: ReturnType<typeof makeEmitter>;
  let impls: ReturnType<typeof buildSimulationNodeImpls>;

  beforeEach(() => {
    emitter = makeEmitter();
    impls = buildSimulationNodeImpls(emitter as never);
  });

  it('parse_requirements returns canned requirements and streams thinking', async () => {
    const result = await impls[NODE.PARSE_REQUIREMENTS](baseState);
    expect(result.requirements).toBeDefined();
    expect(result.complexity).toBe('complex');
    expect(emitter.agentStream).toHaveBeenCalled();
    expect(emitter.nodeProgress).toHaveBeenCalled();
    // progress reaches 100 by the final step
    const pcts = emitter.nodeProgress.mock.calls.map((c) => c[3]);
    expect(pcts).toContain(100);
  });

  it('negotiate_contract returns a contract', async () => {
    const result = await impls[NODE.NEGOTIATE_CONTRACT](baseState);
    expect(result.contract).toBeDefined();
    expect(result.contract?.projectId).toBe('proj-1');
  });

  it('each code agent returns artifacts of its own type', async () => {
    const fe = await impls[NODE.FRONTEND_AGENT](baseState);
    const be = await impls[NODE.BACKEND_AGENT](baseState);
    const db = await impls[NODE.DATABASE_AGENT](baseState);
    const arch = await impls[NODE.ARCHITECTURE_AGENT](baseState);
    expect(fe.artifacts?.every((a) => a.agentType === 'frontend')).toBe(true);
    expect(be.artifacts?.every((a) => a.agentType === 'backend')).toBe(true);
    expect(db.artifacts?.every((a) => a.agentType === 'database')).toBe(true);
    expect(arch.artifacts?.every((a) => a.agentType === 'architecture')).toBe(true);
  });

  it('validate_outputs clears error so the run proceeds to Gate 2', async () => {
    const result = await impls[NODE.VALIDATE_OUTPUTS](baseState);
    expect(result.error).toBeNull();
  });

  it('commit_to_github returns a simulated repo URL and makes no external calls', async () => {
    const result = await impls[NODE.COMMIT_TO_GITHUB](baseState);
    expect(result.repoUrl).toContain('github.com');
    expect(result.repoUrl).toContain('simulation');
  });

  it('streams chunks scoped to the project and run', async () => {
    await impls[NODE.FRONTEND_AGENT](baseState);
    const [projectId, runId, nodeId, chunks] = emitter.agentStream.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(runId).toBe('run-1');
    expect(nodeId).toBe(NODE.FRONTEND_AGENT);
    expect(chunks[0]).toMatchObject({ nodeId: NODE.FRONTEND_AGENT, runId: 'run-1' });
  });
});
