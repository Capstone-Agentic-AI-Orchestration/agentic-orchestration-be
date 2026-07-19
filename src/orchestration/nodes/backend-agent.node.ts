import { Injectable, Logger } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { BACKEND_AGENT_SYSTEM, buildAgentSystemPrompt, buildRepoAccessBlock, buildStructuredMemoryContext } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { ProjectScaffolderService } from '../scaffolding/project-scaffolder.service';
import { OutputValidationService } from '../output-validation/output-validation.service';
import { createBackendApiContractArtifact, createOutputStructureContractArtifact, renderDomainContractContext } from '../domain-contracts';

@Injectable()
export class BackendAgentNode {
  private readonly logger = new Logger(BackendAgentNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly llm: AgentLlmRouter,
    private readonly streamEmitter: StreamEmitter,
    private readonly scaffolder: ProjectScaffolderService,
    private readonly outputValidation: OutputValidationService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(`[${projectId}] Backend agent generating files`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'error', 'Backend agent skipped: contract is missing');
      return { error: 'BackendAgentNode: contract is null' };
    }

    await this.eventLog.logStarted(projectId, 'backend_agent');

    this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', 'Starting backend code generation...');
    this.streamEmitter.progress(projectId, 'backend_agent', runId ?? '', 10, 'Loading context');

    try {
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'backend',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for backend context`);

      const backendFiles = state.contract.fileManifest.filter((f) =>
        /\.(module|controller|service|dto|guard|pipe|interceptor)\.ts$|README-backend\.md$/i.test(f),
      );

      const coreFiles = [
        'src/app.module.ts',
        'src/main.ts',
        'src/modules/core/core.module.ts',
        'src/modules/core/core.controller.ts',
        'src/modules/core/core.service.ts',
        'src/modules/core/dto/create-item.dto.ts',
        'README-backend.md',
      ];
      const allBackendFiles = [
        ...new Set([...coreFiles, ...backendFiles]),
      ];
      const apiContractArtifact = createBackendApiContractArtifact(state);
      const outputStructureArtifact = createOutputStructureContractArtifact(state);

      const skipCandidate = await this.memory.findSkipCandidate(
        'backend',
        memoryQuery,
        state.stackKey,
        state.projectId,
      );

      if (skipCandidate) {
        const isValid = this.memory.validateSkipCandidate(
          skipCandidate,
          state.contract.acceptanceCriteria,
        );
        if (isValid) {
          const rememberedFilePath = skipCandidate.metadata['filePath'];
          const candidateArtifact: GeneratedArtifact = {
            agentType: 'backend',
            filePath:
              typeof rememberedFilePath === 'string'
                ? rememberedFilePath
                : 'src/generated/artifact.ts',
            content: skipCandidate.content,
            language: 'typescript',
            source: 'skip',
          };
          const validationErrors = this.outputValidation.validateBatch([apiContractArtifact, outputStructureArtifact, candidateArtifact], state.projectId);
          if (validationErrors.length === 0) {
            this.logger.log(
              `[${state.projectId}] Skip-generation: reusing backend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
            );
            await this.memory.bumpUsageStats(skipCandidate.id);
            return { artifacts: this.mergeWithScaffold([apiContractArtifact, candidateArtifact], state), validationFeedback: null };
          }
          this.logger.warn(
            `[${state.projectId}] Skip candidate failed content validation (${validationErrors.length} errors), falling through to LLM generation`,
          );
        }
        this.logger.log(
          `[${state.projectId}] Skip candidate failed acceptance validation, proceeding with LLM generation`,
        );
      }

      if (process.env.MOCK_MODE === 'true') {
        this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', 'Mock mode: generating predefined backend files');
        const mockArtifacts: GeneratedArtifact[] = [
          apiContractArtifact,
          {
            agentType: 'backend',
            filePath: 'src/main.ts',
            content: `export function bootstrap() {\n  console.log("Mock Backend Running!");\n}`,
            language: 'typescript',
            source: 'mock',
          },
        ];
        const artifacts = this.mergeWithScaffold(mockArtifacts, state);
        await this.eventLog.logCompleted(state.projectId, 'backend_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts, validationFeedback: null };
      }
      this.streamEmitter.progress(projectId, 'backend_agent', runId ?? '', 40, `Generating ${allBackendFiles.length} files`);
      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to generate backend code for ${allBackendFiles.length} files...`);

      const artifactManifest = (state.artifacts ?? [])
        .map((a) => `${a.agentType}: ${a.filePath}`)
        .join('\n');

      const feedbackContext = state.validationFeedback
        ? `Your previous attempt had these validation issues. Fix them in your new output:\n${state.validationFeedback}`
        : '';

      const structuredMemory = buildStructuredMemoryContext(memoryBundle.layers);
      const domainContracts = renderDomainContractContext([
        ...(state.artifacts ?? []),
        outputStructureArtifact,
        apiContractArtifact,
      ]);

      const selfCritiqueFeedback = state.selfCritique
        ? `Self-review found these quality issues before validation — address them:\n${state.selfCritique}`
        : '';

      const combinedFeedback = [feedbackContext, selfCritiqueFeedback]
        .filter(Boolean)
        .join('\n\n');

      const systemPrompt = buildAgentSystemPrompt({
        basePrompt: BACKEND_AGENT_SYSTEM,
        memoryContext: structuredMemory,
        artifactManifest,
        previousFeedback: combinedFeedback || undefined,
        domainContracts,
        agentSkillRole: 'backend',
      });

      // Give the agent its repository capability so it can read the existing code before
      // generating; empty string when repository access is disabled for this run.
      const systemPromptWithRepo = systemPrompt + buildRepoAccessBlock(state.repoToken, 'backend');

      const result = await this.llm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: resolveModelForNode('backend_agent', 'backend_agent'),
        subagent: 'backend',
        correlation: {
          projectId,
          runId,
          nodeId: 'backend_agent',
          agent: 'backend',
        },
        onToken: (delta) => this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'token', delta),
        systemPrompt: systemPromptWithRepo,
        userPrompt: `Generate NestJS backend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allBackendFiles.map((f) => `- ${f}`).join('\n')}

Authoritative API_CONTRACT.json (DevFlow will persist this contract artifact automatically; do not emit API_CONTRACT.json in your JSON output):
${apiContractArtifact.content}

Authoritative OUTPUT_STRUCTURE.json (frontend owns and persists this contract; do not emit OUTPUT_STRUCTURE.json in your JSON output):
${outputStructureArtifact.content}

Generate complete NestJS code with:
- Proper @Module, @Controller, @Injectable decorators
- Full CRUD operations where applicable
- Zod-validated DTOs
- Swagger/OpenAPI decorators where appropriate
- Route groups, methods, paths, DTO names, module/service ownership, auth details, pagination conventions, Prisma access policy, response DTOs, and documented errors must match API_CONTRACT.json exactly
- Backend file paths must match OUTPUT_STRUCTURE.json, especially src/modules/<resource>/<resource>.module.ts, controller.ts, service.ts, and dto/*.dto.ts
- Use API_CONTRACT.json repairHints as the checklist when fixing validator feedback
- Config files (package.json, tsconfig.json, nest-cli.json, tsconfig.build.json, README-backend.md) will be provided automatically — do not include them in your output`,
        expectedShape: 'array',
      });

      const llmArtifacts: GeneratedArtifact[] = [
        apiContractArtifact,
        ...result.value.map((item) => ({
          agentType: 'backend' as const,
          filePath: item.filePath,
          content: item.content,
          language: item.language ?? this.inferLanguage(item.filePath),
          source: 'llm' as const,
        })),
      ];

      const artifacts = this.mergeWithScaffold(llmArtifacts, state);

      this.logger.log(
        `[${state.projectId}] Backend agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      await this.eventLog.logCompleted(state.projectId, 'backend_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      await this.prisma.artifact.createMany({
        data: artifacts.map((a: GeneratedArtifact) => ({
          projectId: state.projectId,
          agentType: a.agentType,
          filePath: a.filePath,
          content: a.content,
          language: a.language,
          source: a.source ?? 'llm',
        })),
        skipDuplicates: true,
      }).catch((err: unknown) => {
        this.logger.warn(`[${state.projectId}] Artifact persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });

      this.streamEmitter.progress(projectId, 'backend_agent', runId ?? '', 95, 'Saving artifacts');
      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', `Backend generation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts, validationFeedback: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Backend agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'error', `Backend generation failed: ${humanReadableError(message)}`);
      return { error: `BackendAgentNode failed: ${message}` };
    }
  }

  private mergeWithScaffold(
    llmArtifacts: GeneratedArtifact[],
    state: DevFlowStateType,
  ): GeneratedArtifact[] {
    const scaffoldFiles = this.scaffolder.scaffold({
      projectId: state.projectId,
      agentType: WorkOrderAgentType.BACKEND,
      contract: state.contract!,
      companyName: state.companyName,
    });
    return this.scaffolder.merge(llmArtifacts, scaffoldFiles, 'backend');
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.md')) return 'markdown';
    return 'typescript';
  }
}
