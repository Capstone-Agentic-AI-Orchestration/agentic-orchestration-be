import { Injectable, Logger } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { FRONTEND_AGENT_SYSTEM, buildAgentSystemPrompt, buildStructuredMemoryContext } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { ProjectScaffolderService } from '../scaffolding/project-scaffolder.service';
import { OutputValidationService } from '../output-validation/output-validation.service';

@Injectable()
export class FrontendAgentNode {
  private readonly logger = new Logger(FrontendAgentNode.name);

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
    this.logger.log(`[${projectId}] Frontend agent generating files`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'error', 'Frontend agent skipped: contract is missing');
      return { error: 'FrontendAgentNode: contract is null' };
    }

    await this.eventLog.logStarted(projectId, 'frontend_agent');

    this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', 'Starting frontend code generation...');
    this.streamEmitter.progress(projectId, 'frontend_agent', runId ?? '', 10, 'Loading context');

    try {
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.techStack.frontend,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'frontend',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for frontend context`);

      const frontendSourceFiles = state.contract.fileManifest.filter((f) =>
        /\.(tsx|jsx|css|scss|module\.css)$|README-frontend\.md$/i.test(f),
      );

      const coreSourceFiles = [
        'src/app/page.tsx',
        'src/app/layout.tsx',
        'src/components/ui/Button.tsx',
        'src/components/ui/Card.tsx',
        'src/styles/globals.css',
        'README-frontend.md',
      ];
      const allFrontendFiles = [
        ...new Set([...coreSourceFiles, ...frontendSourceFiles]),
      ];

      const skipCandidate = await this.memory.findSkipCandidate(
        'frontend',
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
          const candidatePath = skipCandidate.metadata['filePath'];
          const candidateArtifact: GeneratedArtifact = {
            agentType: 'frontend',
            filePath: typeof candidatePath === 'string' ? candidatePath : 'src/app/page.tsx',
            content: skipCandidate.content,
            language: 'typescript',
            source: 'skip',
          };
          const validationErrors = this.outputValidation.validateBatch([candidateArtifact], state.projectId);
          if (validationErrors.length === 0) {
            this.logger.log(
              `[${state.projectId}] Skip-generation: reusing frontend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
            );
            await this.memory.bumpUsageStats(skipCandidate.id);
            return { artifacts: this.mergeWithScaffold([candidateArtifact], state), validationFeedback: null };
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
        this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', 'Mock mode: generating predefined frontend components');
        const mockArtifacts: GeneratedArtifact[] = [
          {
            agentType: 'frontend',
            filePath: 'src/app/page.tsx',
            content: `export default function Page() { return <div>Mock Frontend for ${state.companyName}</div>; }`,
            language: 'tsx',
            source: 'mock',
          },
        ];
        const artifacts = this.mergeWithScaffold(mockArtifacts, state);
        await this.eventLog.logCompleted(state.projectId, 'frontend_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts, validationFeedback: null };
      }

      this.streamEmitter.progress(projectId, 'frontend_agent', runId ?? '', 40, `Generating ${allFrontendFiles.length} files`);
      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to generate frontend code for ${allFrontendFiles.length} files...`);

      const artifactManifest = (state.artifacts ?? [])
        .map((a) => `${a.agentType}: ${a.filePath}`)
        .join('\n');

      const feedbackContext = state.validationFeedback
        ? `Your previous attempt had these validation issues. Fix them in your new output:\n${state.validationFeedback}`
        : '';

      const structuredMemory = buildStructuredMemoryContext(memoryBundle.layers);

      const selfCritiqueFeedback = state.selfCritique
        ? `Self-review found these quality issues before validation — address them:\n${state.selfCritique}`
        : '';

      const combinedFeedback = [feedbackContext, selfCritiqueFeedback]
        .filter(Boolean)
        .join('\n\n');

      const systemPrompt = buildAgentSystemPrompt(
        FRONTEND_AGENT_SYSTEM,
        structuredMemory,
        artifactManifest,
        combinedFeedback || undefined,
        state.contractSummary || undefined,
      );

      const result = await this.llm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: resolveModelForNode('frontend_agent', 'frontend_agent'),
        subagent: 'frontend',
        onToken: (delta) => this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'token', delta),
        systemPrompt,
        userPrompt: `Generate frontend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allFrontendFiles.map((f) => `- ${f}`).join('\n')}

Generate complete, production-quality code for each file. Config files (package.json, tsconfig.json, next.config.ts, postcss.config.mjs, layout.tsx, globals.css, README-frontend.md) will be provided automatically — do not include them in your output.`,
        expectedShape: 'array',
      });

      const llmArtifacts: GeneratedArtifact[] = result.value.map((item) => ({
        agentType: 'frontend' as const,
        filePath: item.filePath,
        content: item.content,
        language: item.language ?? this.inferLanguage(item.filePath),
        source: 'llm',
      }));

      const artifacts = this.mergeWithScaffold(llmArtifacts, state);

      this.logger.log(
        `[${state.projectId}] Frontend agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      await this.eventLog.logCompleted(state.projectId, 'frontend_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      await this.prisma.artifact.createMany({
        data: artifacts.map((a) => ({
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

      this.streamEmitter.progress(projectId, 'frontend_agent', runId ?? '', 95, 'Saving artifacts');
      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', `Frontend generation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts, validationFeedback: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Frontend agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'error', `Frontend generation failed: ${humanReadableError(message)}`);
      return { error: `FrontendAgentNode failed: ${message}` };
    }
  }

  private mergeWithScaffold(
    llmArtifacts: GeneratedArtifact[],
    state: DevFlowStateType,
  ): GeneratedArtifact[] {
    const scaffoldFiles = this.scaffolder.scaffold({
      projectId: state.projectId,
      agentType: WorkOrderAgentType.FRONTEND,
      contract: state.contract!,
      companyName: state.companyName,
    });
    return this.scaffolder.merge(llmArtifacts, scaffoldFiles, 'frontend');
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'typescript';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) return 'css';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }
}
