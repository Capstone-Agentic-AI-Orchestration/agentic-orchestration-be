import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDevFlowState, type DevFlowStateType } from '../graph/devflow.state';
import {
  type CommandResult,
  ExecutionValidationService,
} from './execution-validation.service';
import { ExecutionValidationNode } from '../nodes/execution-validation.node';

const envSnapshot = { ...process.env };
let tempRoot = '';

function ok(): CommandResult {
  return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5 };
}

function fail(message: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr: message, durationMs: 7 };
}

function timeout(): CommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'command timed out',
    durationMs: 120_000,
    timedOut: true,
  };
}

function packageJson(name: string): string {
  return JSON.stringify({
    name,
    private: true,
    scripts: { build: 'echo build' },
  });
}

function state(overrides: Partial<DevFlowStateType> = {}): DevFlowStateType {
  return createInitialDevFlowState({
    projectId: 'proj-1',
    runId: 'run-1',
    artifacts: [],
    ...overrides,
  });
}

beforeEach(async () => {
  process.env = { ...envSnapshot };
  tempRoot = await mkdtemp(path.join(tmpdir(), 'devflow-exec-test-'));
  process.env.ORCHESTRATION_EXECUTION_WORKDIR = tempRoot;
  process.env.ORCHESTRATION_EXECUTION_VALIDATION = 'strict';
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...envSnapshot };
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

describe('ExecutionValidationService', () => {
  it('materializes valid artifacts and runs install/build checks', async () => {
    const service = new ExecutionValidationService();
    const commands: string[] = [];
    service.setCommandRunnerForTests(async ({ command, args }) => {
      commands.push([command, ...args].join(' '));
      return ok();
    });

    const report = await service.validate(
      state({
        artifacts: [
          {
            agentType: 'frontend',
            filePath: 'package.json',
            content: packageJson('frontend-app'),
            language: 'json',
          },
          {
            agentType: 'frontend',
            filePath: 'src/app/page.tsx',
            content: 'export default function Page() { return <main>Hello</main>; }',
            language: 'tsx',
          },
        ],
      }),
    );

    expect(report.valid).toBe(true);
    expect(report.retryPlan).toBeUndefined();
    expect(commands).toEqual([
      expect.stringContaining('install --ignore-scripts --no-audit --no-fund'),
      expect.stringContaining('run build'),
    ]);
  });

  it('rejects unsafe artifact paths before command execution', async () => {
    const service = new ExecutionValidationService();
    const runner = vi.fn(async () => ok());
    service.setCommandRunnerForTests(runner);

    const report = await service.validate(
      state({
        artifacts: [
          {
            agentType: 'frontend',
            filePath: '../outside.ts',
            content: 'export const outside = true;',
            language: 'ts',
          },
        ],
      }),
    );

    expect(report.valid).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(report.retryPlan?.[0].agentType).toBe('frontend');
    expect(report.retryPlan?.[0].feedback).toContain('Unsafe artifact path');
  });

  it('routes backend and database command failures to their responsible agents', async () => {
    const service = new ExecutionValidationService();
    service.setCommandRunnerForTests(async ({ args }) => {
      const text = args.join(' ');
      if (text === 'run build') return fail('backend compile failed');
      if (text.includes('prisma validate')) return fail('schema invalid');
      return ok();
    });

    const report = await service.validate(
      state({
        artifacts: [
          {
            agentType: 'backend',
            filePath: 'package.json',
            content: packageJson('backend-app'),
            language: 'json',
          },
          {
            agentType: 'database',
            filePath: 'prisma/schema.prisma',
            content: 'model Broken { id String @id }',
            language: 'prisma',
          },
        ],
      }),
    );

    expect(report.valid).toBe(false);
    expect(report.retryPlan?.map((directive) => directive.agentType)).toEqual([
      'backend',
      'database',
    ]);
    expect(report.retryPlan?.[0].feedback).toContain('backend compile failed');
    expect(report.retryPlan?.[1].feedback).toContain('schema invalid');
  });

  it('reports command timeouts as scoped retry feedback', async () => {
    const service = new ExecutionValidationService();
    service.setCommandRunnerForTests(async ({ args }) =>
      args.join(' ') === 'run build' ? timeout() : ok(),
    );

    const report = await service.validate(
      state({
        artifacts: [
          {
            agentType: 'backend',
            filePath: 'package.json',
            content: packageJson('backend-app'),
            language: 'json',
          },
        ],
      }),
    );

    expect(report.valid).toBe(false);
    expect(report.retryPlan?.[0].agentType).toBe('backend');
    expect(report.retryPlan?.[0].feedback).toContain('timed out');
  });

  it('can be disabled by environment', async () => {
    process.env.ORCHESTRATION_EXECUTION_VALIDATION = 'off';
    const service = new ExecutionValidationService();
    const runner = vi.fn(async () => ok());
    service.setCommandRunnerForTests(runner);

    const report = await service.validate(state());

    expect(report.valid).toBe(true);
    expect(report.checks[0].status).toBe('skipped');
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('ExecutionValidationNode', () => {
  const streamEmitter = {
    emit: vi.fn(),
    progress: vi.fn(),
  };

  it('blocks strict-mode failures with a retry plan', async () => {
    const service = {
      mode: () => 'strict',
      validate: vi.fn().mockResolvedValue({
        valid: false,
        checkedAt: new Date().toISOString(),
        checks: [
          {
            name: 'frontend-build',
            agentType: 'frontend',
            status: 'failed',
            durationMs: 1,
            summary: 'build failed',
          },
        ],
        retryPlan: [{ agentType: 'frontend', feedback: 'fix build' }],
      }),
    };
    const node = new ExecutionValidationNode(service as never, streamEmitter as never);

    const result = await node.execute(state({ retryCount: 0 }));

    expect(result.retryCount).toBe(1);
    expect(result.retryPlan).toEqual([{ agentType: 'frontend', feedback: 'fix build' }]);
    expect(result.error).toBeNull();
  });

  it('records advisory failures without blocking delivery', async () => {
    const service = {
      mode: () => 'advisory',
      validate: vi.fn().mockResolvedValue({
        valid: false,
        checkedAt: new Date().toISOString(),
        checks: [
          {
            name: 'frontend-build',
            agentType: 'frontend',
            status: 'failed',
            durationMs: 1,
            summary: 'build failed',
          },
        ],
        retryPlan: [{ agentType: 'frontend', feedback: 'fix build' }],
      }),
    };
    const node = new ExecutionValidationNode(service as never, streamEmitter as never);

    const result = await node.execute(state({ retryCount: 0 }));

    expect(result.executionValidation).toMatchObject({ valid: false });
    expect(result.retryPlan).toEqual([]);
    expect(result.error).toBeNull();
  });
});
