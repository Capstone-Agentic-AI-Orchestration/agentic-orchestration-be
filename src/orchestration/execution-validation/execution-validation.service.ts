import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  DevFlowStateType,
  ExecutionValidationCheck,
  ExecutionValidationReport,
  GeneratedArtifact,
  RetryDirective,
} from '../graph/devflow.state';

type ExecutionValidationMode = 'strict' | 'advisory' | 'off';
type AgentType = RetryDirective['agentType'];

interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export type ExecutionCommandRunner = (
  request: CommandRequest,
) => Promise<CommandResult>;

const AGENT_TYPES: readonly AgentType[] = [
  'frontend',
  'backend',
  'database',
  'architecture',
];

const OUTPUT_LIMIT = 4000;

@Injectable()
export class ExecutionValidationService {
  private readonly logger = new Logger(ExecutionValidationService.name);
  private commandRunner: ExecutionCommandRunner = (request) =>
    this.runCommand(request);

  setCommandRunnerForTests(runner: ExecutionCommandRunner): void {
    this.commandRunner = runner;
  }

  mode(): ExecutionValidationMode {
    const raw = process.env.ORCHESTRATION_EXECUTION_VALIDATION?.trim();
    if (raw === 'advisory' || raw === 'off') return raw;
    return 'strict';
  }

  timeoutMs(): number {
    const parsed = Number(process.env.ORCHESTRATION_EXECUTION_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
  }

  async validate(state: DevFlowStateType): Promise<ExecutionValidationReport> {
    const checkedAt = new Date().toISOString();
    if (this.mode() === 'off') {
      return {
        valid: true,
        checkedAt,
        checks: [
          {
            name: 'execution-validation-disabled',
            agentType: 'architecture',
            status: 'skipped',
            durationMs: 0,
            summary: 'Execution validation is disabled by ORCHESTRATION_EXECUTION_VALIDATION=off.',
          },
        ],
      };
    }

    const checks: ExecutionValidationCheck[] = [];
    const createdWorkdirs: string[] = [];

    try {
      for (const agentType of AGENT_TYPES) {
        const artifacts = state.artifacts.filter(
          (artifact) => artifact.agentType === agentType,
        );
        if (artifacts.length === 0) continue;

        const workdir = await this.createWorkspace(state, agentType);
        createdWorkdirs.push(workdir);

        try {
          await this.materializeArtifacts(workdir, artifacts);
          checks.push(...(await this.runChecksForAgent(agentType, workdir, state)));
        } catch (error) {
          checks.push({
            name: `${agentType}-materialize`,
            agentType,
            status: 'failed',
            durationMs: 0,
            summary: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await this.cleanup(createdWorkdirs);
    }

    const retryPlan = this.buildRetryPlan(checks);
    return {
      valid: retryPlan.length === 0,
      checkedAt,
      checks,
      retryPlan: retryPlan.length > 0 ? retryPlan : undefined,
    };
  }

  private async createWorkspace(
    state: DevFlowStateType,
    agentType: AgentType,
  ): Promise<string> {
    const root =
      process.env.ORCHESTRATION_EXECUTION_WORKDIR?.trim() ||
      path.join(tmpdir(), 'devflow-execution-validation');
    await mkdir(root, { recursive: true });
    const safeProject = this.safeName(state.projectId || 'project');
    const safeRun = this.safeName(state.runId || 'run');
    return mkdtemp(path.join(root, `${safeProject}-${safeRun}-${agentType}-`));
  }

  private async materializeArtifacts(
    workdir: string,
    artifacts: GeneratedArtifact[],
  ): Promise<void> {
    const resolvedRoot = path.resolve(workdir);
    for (const artifact of artifacts) {
      const safePath = this.safeArtifactPath(artifact.filePath);
      const target = path.resolve(resolvedRoot, ...safePath.split('/'));
      if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Unsafe artifact path escaped sandbox: ${artifact.filePath}`);
      }

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, artifact.content, 'utf8');
    }
  }

  private safeArtifactPath(filePath: string): string {
    if (!filePath || filePath.includes('\0')) {
      throw new Error('Unsafe empty artifact path.');
    }
    const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`Unsafe artifact path rejected: ${filePath}`);
    }
    return normalized;
  }

  private async runChecksForAgent(
    agentType: AgentType,
    workdir: string,
    state: DevFlowStateType,
  ): Promise<ExecutionValidationCheck[]> {
    if (agentType === 'architecture') {
      return [await this.checkArchitectureDocs(workdir, state)];
    }
    if (agentType === 'database') {
      return this.checkDatabase(workdir);
    }
    return this.checkNodeProject(agentType, workdir);
  }

  private async checkNodeProject(
    agentType: 'frontend' | 'backend',
    workdir: string,
  ): Promise<ExecutionValidationCheck[]> {
    const packageJson = await this.readPackageJson(workdir);
    if (!packageJson) {
      return [
        {
          name: `${agentType}-package`,
          agentType,
          status: 'failed',
          durationMs: 0,
          summary: 'Missing package.json after scaffold/materialization.',
        },
      ];
    }

    const checks: ExecutionValidationCheck[] = [];
    checks.push(
      await this.runCommandCheck(agentType, `${agentType}-install`, workdir, [
        this.bin('npm'),
        ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      ]),
    );

    if (checks.some((check) => check.status === 'failed')) return checks;

    const scripts = this.packageScripts(packageJson);
    if (scripts.has('typecheck')) {
      checks.push(
        await this.runCommandCheck(agentType, `${agentType}-typecheck`, workdir, [
          this.bin('npm'),
          ['run', 'typecheck'],
        ]),
      );
      if (checks.some((check) => check.status === 'failed')) return checks;
    }

    if (scripts.has('build')) {
      checks.push(
        await this.runCommandCheck(agentType, `${agentType}-build`, workdir, [
          this.bin('npm'),
          ['run', 'build'],
        ]),
      );
    } else {
      checks.push(
        await this.runCommandCheck(agentType, `${agentType}-tsc`, workdir, [
          this.bin('npx'),
          ['tsc', '--noEmit'],
        ]),
      );
    }

    return checks;
  }

  private async checkDatabase(
    workdir: string,
  ): Promise<ExecutionValidationCheck[]> {
    const schemaPath = path.join(workdir, 'prisma', 'schema.prisma');
    const schemaExists = await readFile(schemaPath, 'utf8')
      .then(() => true)
      .catch(() => false);
    if (!schemaExists) {
      return [
        {
          name: 'database-prisma-schema',
          agentType: 'database',
          status: 'failed',
          durationMs: 0,
          summary: 'Missing prisma/schema.prisma after scaffold/materialization.',
        },
      ];
    }

    const validate = await this.runCommandCheck('database', 'database-prisma-validate', workdir, [
      this.bin('npx'),
      ['prisma', 'validate', '--schema', 'prisma/schema.prisma'],
    ]);
    if (validate.status === 'failed') return [validate];

    const generate = await this.runCommandCheck('database', 'database-prisma-generate', workdir, [
      this.bin('npx'),
      ['prisma', 'generate', '--schema', 'prisma/schema.prisma'],
    ]);
    return [validate, generate];
  }

  private async checkArchitectureDocs(
    workdir: string,
    state: DevFlowStateType,
  ): Promise<ExecutionValidationCheck> {
    const startedAt = Date.now();
    const required = ['ARCHITECTURE.md', 'API.md', 'DEPLOYMENT.md'];
    const contents: string[] = [];
    const missing: string[] = [];

    for (const filePath of required) {
      const content = await readFile(path.join(workdir, filePath), 'utf8').catch(
        () => null,
      );
      if (content == null) missing.push(filePath);
      else contents.push(content);
    }

    if (missing.length > 0) {
      return {
        name: 'architecture-docs',
        agentType: 'architecture',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        summary: `Missing required architecture docs: ${missing.join(', ')}`,
      };
    }

    const combined = contents.join('\n').toLowerCase();
    const routes = this.extractBackendRoutes(state.artifacts);
    const models = this.extractPrismaModels(state.artifacts);
    const routeReferenced =
      routes.length === 0 || routes.some((route) => combined.includes(route.toLowerCase()));
    const modelReferenced =
      models.length === 0 || models.some((model) => combined.includes(model.toLowerCase()));

    if (!routeReferenced || !modelReferenced) {
      return {
        name: 'architecture-docs',
        agentType: 'architecture',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        summary: 'Architecture docs do not reference generated backend routes or Prisma models.',
      };
    }

    return {
      name: 'architecture-docs',
      agentType: 'architecture',
      status: 'passed',
      durationMs: Date.now() - startedAt,
      summary: 'Architecture docs exist and reference generated system artifacts.',
    };
  }

  private async runCommandCheck(
    agentType: AgentType,
    name: string,
    cwd: string,
    [command, args]: [string, string[]],
  ): Promise<ExecutionValidationCheck> {
    const result = await this.commandRunner({
      command,
      args,
      cwd,
      timeoutMs: this.timeoutMs(),
    });
    const commandText = [command, ...args].join(' ');
    const outputTail = this.tail([result.stdout, result.stderr].filter(Boolean).join('\n'));
    const passed = result.exitCode === 0 && !result.timedOut;
    return {
      name,
      agentType,
      status: passed ? 'passed' : 'failed',
      command: commandText,
      durationMs: result.durationMs,
      summary: passed
        ? `${commandText} completed successfully.`
        : result.timedOut
          ? `${commandText} timed out after ${this.timeoutMs()}ms.`
          : `${commandText} failed with exit code ${result.exitCode}.`,
      outputTail: outputTail || undefined,
    };
  }

  private async readPackageJson(
    workdir: string,
  ): Promise<Record<string, unknown> | null> {
    const raw = await readFile(path.join(workdir, 'package.json'), 'utf8').catch(
      () => null,
    );
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private packageScripts(packageJson: Record<string, unknown>): Set<string> {
    const scripts =
      packageJson['scripts'] && typeof packageJson['scripts'] === 'object'
        ? (packageJson['scripts'] as Record<string, unknown>)
        : {};
    return new Set(
      Object.entries(scripts)
        .filter(([, value]) => typeof value === 'string')
        .map(([key]) => key),
    );
  }

  private buildRetryPlan(checks: ExecutionValidationCheck[]): RetryDirective[] {
    const failedByAgent = new Map<AgentType, ExecutionValidationCheck[]>();
    for (const check of checks) {
      if (check.status !== 'failed') continue;
      const group = failedByAgent.get(check.agentType) ?? [];
      group.push(check);
      failedByAgent.set(check.agentType, group);
    }

    return Array.from(failedByAgent.entries()).map(([agentType, failed]) => ({
      agentType,
      feedback: [
        `RETRY SCOPE: ${agentType} artifacts failed sandbox execution validation.`,
        'MUST FIX:',
        ...failed.map((check) =>
          `- ${check.name}: ${check.summary}${check.command ? ` Command: ${check.command}.` : ''}`,
        ),
        ...failed
          .map((check) => check.outputTail)
          .filter((tail): tail is string => Boolean(tail))
          .map((tail) => `OUTPUT TAIL:\n${tail}`),
        'Return complete replacement artifacts for this agent only. Preserve compatible paths, routes, DTOs, model names, and public names unless the failure explicitly requires a rename.',
      ].join('\n'),
    }));
  }

  private extractBackendRoutes(artifacts: GeneratedArtifact[]): string[] {
    const routes: string[] = [];
    for (const artifact of artifacts.filter((a) => a.agentType === 'backend')) {
      const controllerMatch = artifact.content.match(
        /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/,
      );
      const base = controllerMatch?.[1] ?? '';
      const methodRe =
        /@(Get|Post|Put|Patch|Delete)\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = methodRe.exec(artifact.content)) !== null) {
        const route = base
          ? `/${base}/${match[2]}`.replace(/\/+/g, '/')
          : `/${match[2]}`;
        routes.push(route);
      }
    }
    return routes;
  }

  private extractPrismaModels(artifacts: GeneratedArtifact[]): string[] {
    const models: string[] = [];
    for (const artifact of artifacts.filter((a) => a.agentType === 'database')) {
      const modelRe = /model\s+(\w+)\s*\{/g;
      let match: RegExpExecArray | null;
      while ((match = modelRe.exec(artifact.content)) !== null) {
        models.push(match[1]);
      }
    }
    return models;
  }

  private async cleanup(workdirs: string[]): Promise<void> {
    if (process.env.ORCHESTRATION_EXECUTION_KEEP_WORKDIR === 'true') return;
    const root = path.resolve(
      process.env.ORCHESTRATION_EXECUTION_WORKDIR?.trim() ||
        path.join(tmpdir(), 'devflow-execution-validation'),
    );
    await Promise.all(
      workdirs.map(async (workdir) => {
        const resolved = path.resolve(workdir);
        if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
          this.logger.warn(`Refusing to cleanup suspicious execution directory: ${workdir}`);
          return;
        }
        await rm(resolved, { recursive: true, force: true });
      }),
    );
  }

  private runCommand(request: CommandRequest): Promise<CommandResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      execFile(
        request.command,
        request.args,
        {
          cwd: request.cwd,
          timeout: request.timeoutMs,
          windowsHide: true,
          maxBuffer: 512_000,
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
          resolve({
            exitCode: err ? Number(err.code ?? 1) || 1 : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            durationMs: Date.now() - startedAt,
            timedOut: err?.killed === true || err?.signal === 'SIGTERM',
          });
        },
      );
    });
  }

  private safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'run';
  }

  private bin(name: 'npm' | 'npx'): string {
    return process.platform === 'win32' ? `${name}.cmd` : name;
  }

  private tail(value: string): string {
    return value.length > OUTPUT_LIMIT ? value.slice(-OUTPUT_LIMIT) : value;
  }
}
