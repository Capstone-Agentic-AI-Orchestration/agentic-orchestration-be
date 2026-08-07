import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveAgentSystemPrompt } from '../../agents/agent-prompt-resolver';
import { DevFlowStateType, ProjectContract } from '../graph/devflow.state';
import { NODE } from '../graph/topology';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { CONTRACT_NEGOTIATOR_SYSTEM, buildAgentSystemPrompt } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { buildAgentPlan } from '../graph/agent-plan';

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class ContractNegotiatorNode {
  private readonly logger = new Logger(ContractNegotiatorNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly llm: AgentLlmRouter,
    private readonly streamEmitter: StreamEmitter,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(`[${projectId}] Negotiating project contract`);

    if (!state.requirements) {
      this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'error', 'Contract negotiation skipped: requirements are missing');
      return { error: 'ContractNegotiatorNode: requirements is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(projectId, 'contract_negotiator');

    this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'decision', 'Generating project contract from parsed requirements...');
    this.streamEmitter.progress(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 10, 'Reading requirements');

    try {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: 'NEGOTIATING_CONTRACT' },
      });

      // ── 1. Read relevant patterns from memory ──────────────────────────────
      // companyName enriches the query so industry-specific contract patterns
      // (e.g. "fintech NestJS SaaS") surface higher than generic ones.
      const memoryQuery = [
        state.requirements.projectType,
        state.stackKey,
        state.requirements.complexity,
        state.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'tool-call', 'Reading relevant contract patterns from memory', { operation: 'buildContextForAgent', agentType: 'contract' });

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'contract',
        projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      // ── 1a. Skip-generation: reuse a similar approved contract ──────────────
      const skipCandidate = await this.memory.findSkipCandidate(
        'contract',
        memoryQuery,
        state.stackKey,
        projectId,
      );

      if (skipCandidate) {
        const isValid = this.memory.validateSkipCandidate(
          skipCandidate,
          state.requirements.features.map((f) => `feature: ${f}`),
        );
        if (isValid) {
          this.logger.log(
            `[${projectId}] Skip-generation: reusing contract memory (similarity=${skipCandidate.similarity?.toFixed(3)})`,
          );
          await this.memory.bumpUsageStats(skipCandidate.id);
          const cachedContract = this.reconstructContract(skipCandidate.content, projectId, state);
          if (cachedContract) {
            this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'decision', 'Reusing previously approved contract from memory');
            await this.eventLog.logCompleted(projectId, 'contract_negotiator', {
              inputTokens: 0,
              outputTokens: 0,
              model: 'memory_skip',
            });
            return { contract: cachedContract };
          }
        }
        this.logger.log(
          `[${projectId}] Skip candidate failed validation, proceeding with LLM contract negotiation`,
        );
      }

      const requirementsSummary = JSON.stringify(state.requirements, null, 2);

      if (process.env.MOCK_MODE === 'true') {
        const fileManifest = this.normalizeFileManifest(
          ['src/app/page.tsx', 'src/main.ts', 'schema.prisma'],
          state.requirements,
          state.hasMobileRepo,
        );
        const contract: ProjectContract = {
          projectId,
          projectName: state.companyName.replace(/[^a-zA-Z]/g, '') + 'App',
          description: 'Mocked contract for basic fullstack application',
          requirements: state.requirements,
          fileManifest,
          acceptanceCriteria: ['Must compile', 'Must pass mock tests'],
          agentPlan: buildAgentPlan({
            fileManifest,
            requirements: state.requirements,
            brief: state.brief,
            hasMobileRepo: state.hasMobileRepo,
          }),
          lockedAt: new Date().toISOString()
        };
        this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'decision', 'Mock mode: returning predefined contract');
        await this.eventLog.logCompleted(projectId, 'contract_negotiator', {
          inputTokens: 0,
          outputTokens: 0,
          model: 'mock',
        });
        return { contract };
      }

      this.streamEmitter.progress(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 40, 'Calling LLM');
      this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to negotiate contract with ${memoryBundle.total} memory references...`);

      // ── 2. LLM call ───────────────────────────────────────────────────────
      // The workspace's own instructions for this agent, falling back to the compiled-in
      // prompt when it has none. This is what makes the console's Instructions field real.
      const basePrompt = await resolveAgentSystemPrompt(this.prisma, projectId, 'planner-orchestrator', CONTRACT_NEGOTIATOR_SYSTEM);

      const systemPrompt = buildAgentSystemPrompt({
        basePrompt,
        memoryContext,
        agentSkillRole: 'contract',
      });

      const result = await this.llm.generateJson<Record<string, unknown>>({
        agentName: resolveModelForNode('negotiate_contract', 'contract_negotiator'),
        subagent: 'planner-orchestrator',
        correlation: {
          projectId,
          runId,
          nodeId: NODE.NEGOTIATE_CONTRACT,
          agent: 'planner-orchestrator',
        },
        onToken: (delta) => this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'token', delta),
        systemPrompt,
        userPrompt: `Create a complete project contract for the following:

Company: ${state.companyName}
Project ID: ${state.projectId}

Original Brief:
${state.brief}

Locked Intake Context:
${state.intakeContext ? JSON.stringify(state.intakeContext, null, 2) : 'No locked intake package is available.'}

Parsed Requirements:
${requirementsSummary}

Open Questions:
${state.openQuestions.length ? state.openQuestions.map((question) => `- ${question}`).join('\n') : 'None'}

Treat the locked intake and its explicit exclusions as authoritative. Do not add features that are only future-phase or out-of-scope.

You are also the bounded Planner/Orchestrator. Select only the implementation domains required by the locked scope.
Produce a fileManifest that lists every file that will be generated. Do not invent frontend, backend, database, mobile, or architecture work when the scope does not require it.
Include 8–20 files depending on complexity. Use realistic relative paths (e.g. "src/app/page.tsx", "src/modules/users/users.service.ts").
Produce 5–10 acceptance criteria as clear, testable statements.`,
        expectedShape: 'object',
      });

      const parsed = result.value;

      const rawFileManifest = Array.isArray(parsed['fileManifest'])
        ? (parsed['fileManifest'] as unknown[]).filter((filePath): filePath is string => typeof filePath === 'string')
        : [];

      const fileManifest = this.normalizeFileManifest(
        rawFileManifest,
        state.requirements,
        state.hasMobileRepo,
      );
      const contract: ProjectContract = {
        projectId: state.projectId,
        projectName: typeof parsed['projectName'] === 'string' ? parsed['projectName'] : `${state.companyName} Project`,
        description: typeof parsed['description'] === 'string' ? parsed['description'] : state.brief,
        requirements: state.requirements,
        fileManifest,
        acceptanceCriteria: Array.isArray(parsed['acceptanceCriteria'])
          ? (parsed['acceptanceCriteria'] as string[])
          : [],
        agentPlan: buildAgentPlan({
          fileManifest,
          requirements: state.requirements,
          brief: state.brief,
          hasMobileRepo: state.hasMobileRepo,
        }),
        lockedAt: new Date().toISOString(),
      };

      this.logger.log(
        `[${projectId}] Contract negotiated: ${contract.fileManifest.length} files in manifest (${memoryBundle.total} layered memories referenced)`,
      );

      this.streamEmitter.progress(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 90, 'Finalizing contract');
      this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'tool-call', `Contract generated: ${contract.fileManifest.length} files across ${contract.acceptanceCriteria.length} acceptance criteria`);
      this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'decision', 'Contract ready for architecture review');

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      await this.eventLog.logCompleted(projectId, 'contract_negotiator', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      // Write a SKILL so future similar projects can skip the LLM call.
      await this.memory.writeSkill({
        agentType: 'contract',
        systemPrompt: '',
        artifactContent: JSON.stringify(contract, null, 2),
        filePath: `contract/${projectId}.json`,
        projectId,
        stackKey: state.stackKey,
        projectType: state.requirements.projectType,
        approvalSource: 'GATE_1',
      }).catch(() => undefined);

      return { contract };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${projectId}] Contract negotiation failed: ${message}`);

      this.streamEmitter.emit(projectId, NODE.NEGOTIATE_CONTRACT, runId ?? '', 'error', `Contract negotiation failed: ${humanReadableError(message)}`);

      await this.prisma.project
        .update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);

      return { error: `ContractNegotiatorNode failed: ${message}` };
    }
  }

  /**
   * Reconstructs a ProjectContract from a SKILL memory's stored content string.
   * The stored format is: "FILE: ...\nSTACK: ...\nTYPE: ...\n\n<JSON contract body>"
   * Returns null if parsing fails (fall through to LLM).
   */
  private reconstructContract(
    content: string,
    projectId: string,
    state: DevFlowStateType,
  ): ProjectContract | null {
    const requirements = state.requirements ?? {
      projectType: 'unknown',
      features: [],
      techStack: { frontend: 'Next.js', backend: 'NestJS', database: 'PostgreSQL', styling: 'Tailwind CSS' },
      complexity: 'medium' as const,
      estimatedFiles: 5,
    };

    try {
      // Try direct JSON parse first (clean contract storage).
      const parsed = JSON.parse(content);
      if (parsed.projectId && parsed.fileManifest) {
        const fileManifest = this.normalizeFileManifest(
          Array.isArray(parsed.fileManifest)
            ? parsed.fileManifest.filter((f: unknown): f is string => typeof f === 'string')
            : [],
          requirements,
          state.hasMobileRepo,
        );
        return {
          projectId,
          projectName: parsed.projectName ?? `${state.companyName} Project`,
          description: parsed.description ?? state.brief,
          requirements,
          fileManifest,
          acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
            ? parsed.acceptanceCriteria
            : [],
          agentPlan: buildAgentPlan({
            fileManifest,
            requirements,
            brief: state.brief,
            hasMobileRepo: state.hasMobileRepo,
          }),
          lockedAt: new Date().toISOString(),
        };
      }
    } catch {
      // Not JSON — try extracting from the prefixed format.
    }

    // Try extracting from "FILE: ...\nSTACK: ...\nTYPE: ...\n\n<contract body>".
    const bodyMatch = content.match(/\n\n([\s\S]*)$/);
    if (!bodyMatch) return null;
    try {
      const parsed = JSON.parse(bodyMatch[1]);
      if (parsed.fileManifest) {
        const fileManifest = this.normalizeFileManifest(
          Array.isArray(parsed.fileManifest)
            ? parsed.fileManifest.filter((f: unknown): f is string => typeof f === 'string')
            : [],
          requirements,
          state.hasMobileRepo,
        );
        return {
          projectId,
          projectName: parsed.projectName ?? `${state.companyName} Project`,
          description: parsed.description ?? state.brief,
          requirements,
          fileManifest,
          acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
            ? parsed.acceptanceCriteria
            : [],
          agentPlan: buildAgentPlan({
            fileManifest,
            requirements,
            brief: state.brief,
            hasMobileRepo: state.hasMobileRepo,
          }),
          lockedAt: new Date().toISOString(),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private normalizeFileManifest(
    fileManifest: string[],
    requirements: ProjectContract['requirements'],
    hasMobileRepo: boolean,
  ): string[] {
    const featureFiles = this.mvvmFeatureFiles(requirements.features);
    const supportedFile = (filePath: string) =>
      /\.(ts|tsx|jsx|css|scss|module\.css|module\.ts|controller\.ts|service\.ts|dto\.ts|guard\.ts|pipe\.ts|interceptor\.ts|prisma|sql|md)$/i.test(filePath) ||
      /seed\.(ts|js)$/i.test(filePath);
    const requestedFiles = fileManifest.filter(supportedFile);
    const joined = requestedFiles.join('\n');
    const frontend = /(?:\.tsx$|\.jsx$|\.css$|design\.md|src\/features\/|src\/app\/.*(?:page|layout))/im.test(joined);
    const backend = /(?:src\/main\.ts|app\.module\.ts|src\/modules\/|(?:controller|service|dto|guard)\.ts|api_contract)/i.test(joined);
    const database = /(?:prisma\/|\.prisma$|\.sql$|data_model)/im.test(joined);
    const architecture = /(?:architecture|deployment\.md|adrs\.md|api\.md)/i.test(joined);
    const mobile = hasMobileRepo && /(?:mobile\/|app\/\(tabs\)|app\/_layout|expo|react-native)/i.test(joined);
    const noDomainSelected = !frontend && !backend && !database && !mobile;
    const coreFiles = [
      ...(frontend || noDomainSelected
        ? [
            'DESIGN.md',
            'OUTPUT_STRUCTURE.json',
            'src/app/page.tsx',
            'src/app/layout.tsx',
            'src/shared/ui/Button.tsx',
            'src/shared/ui/Card.tsx',
            'src/styles/globals.css',
            'README-frontend.md',
            ...featureFiles,
          ]
        : []),
      ...(backend || noDomainSelected
        ? [
            'API_CONTRACT.json',
            'src/app.module.ts',
            'src/main.ts',
            'src/modules/core/core.module.ts',
            'src/modules/core/core.controller.ts',
            'src/modules/core/core.service.ts',
            'src/modules/core/dto/create-item.dto.ts',
            'README-backend.md',
          ]
        : []),
      ...(database || noDomainSelected
        ? [
            'DATA_MODEL.json',
            'prisma/schema.prisma',
            'prisma/migrations/0001_initial.sql',
            'prisma/seed.ts',
            'README-database.md',
          ]
        : []),
      ...(architecture
        ? ['ARCHITECTURE_REVIEW.md', 'ARCHITECTURE.md', 'API.md', 'DEPLOYMENT.md', 'ADRS.md']
        : []),
    ];

    return [...new Set([...coreFiles, ...requestedFiles])].slice(0, 64);
  }

  private mvvmFeatureFiles(features: string[]): string[] {
    const slugs = features
      .map((feature) => feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
      .filter(Boolean)
      .slice(0, 4);
    const featureSlugs = slugs.length > 0 ? slugs : ['items'];
    return featureSlugs.flatMap((feature) => {
      const viewName = feature
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
      return [
        `src/features/${feature}/model/types.ts`,
        `src/features/${feature}/view-model/use-${feature}.ts`,
        `src/features/${feature}/view/${viewName}View.tsx`,
        `src/app/${feature}/page.tsx`,
      ];
    });
  }
}
