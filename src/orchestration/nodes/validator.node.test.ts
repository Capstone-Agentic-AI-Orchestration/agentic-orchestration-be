import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidatorNode } from './validator.node';
import { OutputValidationService } from '../output-validation/output-validation.service';
import type { DevFlowStateType, GeneratedArtifact, ProjectContract } from '../graph/devflow.state';

function contract(fileManifest: string[]): ProjectContract {
  return {
    projectId: 'proj-1',
    projectName: 'Test',
    description: 'Test project',
    requirements: {
      projectType: 'app',
      features: [],
      techStack: { frontend: 'Next.js', backend: 'NestJS', database: 'PostgreSQL', styling: 'Tailwind' },
      complexity: 'medium',
      estimatedFiles: 2,
    },
    fileManifest,
    acceptanceCriteria: [],
    lockedAt: new Date().toISOString(),
  };
}

function makeNode() {
  const memory = { writeMistake: vi.fn().mockResolvedValue(undefined) };
  const streamEmitter = { emit: vi.fn(), progress: vi.fn() };
  const node = new ValidatorNode(
    memory as never,
    streamEmitter as never,
    new OutputValidationService(),
  );
  return { node, memory, streamEmitter };
}

function state(artifacts: GeneratedArtifact[], retryCount = 0): DevFlowStateType {
  return {
    projectId: 'proj-1',
    runId: 'run-1',
    stackKey: 'next-nest-pg',
    companyName: 'TestCo',
    contract: contract(artifacts.map((a) => a.filePath)),
    artifacts,
    retryCount,
  } as unknown as DevFlowStateType;
}

// A backend file with an undefined identifier (TS2304) and a frontend file with
// a missing relative import (TS2307) — two distinct agents, two distinct faults.
const FAILING_ARTIFACTS: GeneratedArtifact[] = [
  {
    agentType: 'backend',
    filePath: 'src/a.service.ts',
    content: `export class AService { run() { return doesNotExistAnywhere(); } }`,
    language: 'typescript',
  },
  {
    agentType: 'frontend',
    filePath: 'src/b.tsx',
    content: `import { Missing } from './missing-module'; export const X = Missing;`,
    language: 'typescript',
  },
];

describe('ValidatorNode multi-agent retry', () => {
  beforeEach(() => {
    delete process.env.MOCK_MODE;
    delete process.env.ORCHESTRATION_TYPECHECK;
  });

  it('emits one scoped retry directive per failing agent', async () => {
    const { node, memory } = makeNode();
    const result = await node.execute(state(FAILING_ARTIFACTS, 0));

    expect(result.error).toBeNull();
    expect(result.retryCount).toBe(1);

    const plan = result.retryPlan ?? [];
    const agents = plan.map((d) => d.agentType).sort();
    expect(agents).toEqual(['backend', 'frontend']);

    const backend = plan.find((d) => d.agentType === 'backend');
    const frontend = plan.find((d) => d.agentType === 'frontend');
    // Each agent's feedback references its own fault and not the other's file.
    expect(backend?.feedback).toContain('TYPE');
    expect(backend?.feedback).toContain('a.service.ts');
    expect(backend?.feedback).not.toContain('b.tsx');
    expect(frontend?.feedback).toContain('b.tsx');
    expect(frontend?.feedback).not.toContain('a.service.ts');

    // A mistake is remembered per failing agent.
    expect(memory.writeMistake).toHaveBeenCalledTimes(2);
  });

  it('passes cleanly when all artifacts type-check', async () => {
    const { node } = makeNode();
    const result = await node.execute(
      state([
        {
          agentType: 'backend',
          filePath: 'src/a.service.ts',
          content: `export class AService { run(): number { return 42; } }`,
          language: 'typescript',
        },
      ]),
    );
    expect(result.retryPlan ?? []).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('routes a cross-artifact integration violation to the calling agent', async () => {
    // Isolate the integration check from the type-checker (the snippets omit
    // imports for brevity, which would otherwise raise TS2304s).
    process.env.ORCHESTRATION_TYPECHECK = 'false';
    const { node } = makeNode();
    const result = await node.execute(
      state([
        {
          agentType: 'backend',
          filePath: 'orders.controller.ts',
          content: `@Controller('orders') export class OrdersController { @Get() list() { return []; } }`,
          language: 'typescript',
        },
        {
          agentType: 'frontend',
          filePath: 'invoices-page.tsx',
          content: `export default function Page() { fetch('/api/invoices'); return null; }`,
          language: 'typescript',
        },
      ]),
    );

    const plan = result.retryPlan ?? [];
    const frontend = plan.find((d) => d.agentType === 'frontend');
    expect(frontend).toBeDefined();
    expect(frontend?.feedback).toContain('INTEGRATION');
    expect(frontend?.feedback).toContain('/api/invoices');
    // Backend exposed a valid route, so it should not be told to retry.
    expect(plan.find((d) => d.agentType === 'backend')).toBeUndefined();
  });

  it('scopes missing, duplicate, and forbidden file feedback to the responsible agent', async () => {
    process.env.ORCHESTRATION_TYPECHECK = 'false';
    const { node } = makeNode();
    const invalidState = state([
      {
        agentType: 'frontend',
        filePath: 'src/app/page.tsx',
        content: `export default function Page() { return <main>Project dashboard</main>; }`,
        language: 'typescript',
      },
      {
        agentType: 'frontend',
        filePath: 'src/app/page.tsx',
        content: `export function DuplicatePage() { return <main>Duplicate dashboard</main>; }`,
        language: 'typescript',
      },
      {
        agentType: 'frontend',
        filePath: 'package.json',
        content: `{"scripts":{"build":"next build"},"dependencies":{"next":"16.0.0"}}`,
        language: 'json',
      },
    ]);
    invalidState.contract = contract(['src/app/page.tsx', 'src/app/dashboard.tsx']);

    const result = await node.execute(invalidState);
    const plan = result.retryPlan ?? [];
    const frontend = plan.find((d) => d.agentType === 'frontend');

    expect(plan.map((d) => d.agentType)).toEqual(['frontend']);
    expect(frontend?.feedback).toContain('Duplicate generated filePath');
    expect(frontend?.feedback).toContain('scaffolded by DevFlow');
    expect(frontend?.feedback).toContain('MISSING FILE: src/app/dashboard.tsx');
    expect(frontend?.feedback).toContain('RETRY SCOPE: frontend agent only');
  });

  it('terminates with an error and empty plan when retries are exhausted', async () => {
    const { node } = makeNode();
    // MAX_RETRIES = 5, so retryCount = 4 is the last attempt.
    const result = await node.execute(state(FAILING_ARTIFACTS, 4));

    expect(result.retryPlan).toEqual([]);
    expect(result.error).toContain('Validation exceeded max retries');
  });
});
