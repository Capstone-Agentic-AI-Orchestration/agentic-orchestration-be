import { Injectable, Logger } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { ARCHITECTURE_AGENT_SYSTEM, buildAgentSystemPrompt, buildStructuredMemoryContext } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { ProjectScaffolderService } from '../scaffolding/project-scaffolder.service';
import { OutputValidationService } from '../output-validation/output-validation.service';

@Injectable()
export class ArchitectureAgentNode {
  private readonly logger = new Logger(ArchitectureAgentNode.name);

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
    this.logger.log(`[${projectId}] Architecture agent generating docs`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'error', 'Architecture agent skipped: contract is missing');
      return { error: 'ArchitectureAgentNode: contract is null' };
    }

    await this.eventLog.logStarted(projectId, 'architecture_agent');

    this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'decision', 'Starting architecture documentation generation...');
    this.streamEmitter.progress(projectId, 'architecture_agent', runId ?? '', 10, 'Loading context');

    try {
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.complexity,
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'architecture',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for architecture context`);

      const docFiles = ['ARCHITECTURE.md', 'API.md', 'DEPLOYMENT.md'];

      const skipCandidate = await this.memory.findSkipCandidate(
        'architecture',
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
            agentType: 'architecture',
            filePath:
              typeof rememberedFilePath === 'string'
                ? rememberedFilePath
                : 'ARCHITECTURE.md',
            content: skipCandidate.content,
            language: 'markdown',
            source: 'skip',
          };
          const validationErrors = this.outputValidation.validateBatch([candidateArtifact], state.projectId);
          if (validationErrors.length === 0) {
            this.logger.log(
              `[${state.projectId}] Skip-generation: reusing architecture memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
            );
            await this.memory.bumpUsageStats(skipCandidate.id);
            return { artifacts: [candidateArtifact] };
          }
          this.logger.warn(
            `[${state.projectId}] Skip candidate failed content validation (${validationErrors.length} errors), falling through to LLM generation`,
          );
        }
        this.logger.log(
          `[${state.projectId}] Skip candidate failed acceptance validation, proceeding with LLM generation`,
        );
      }

      const artifactSummary = state.artifacts
        .map((a) => `${a.agentType}: ${a.filePath}`)
        .join('\n');

      if (process.env.MOCK_MODE === 'true') {
        this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'decision', 'Mock mode: generating predefined architecture docs');
        const artifacts: GeneratedArtifact[] = [
          {
            agentType: 'architecture',
            filePath: 'ARCHITECTURE.md',
            content: `# Mock Architecture\n\nGenerated by Mock Mode.`,
            language: 'markdown',
            source: 'mock',
          },
        ];
        await this.eventLog.logCompleted(state.projectId, 'architecture_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts, validationFeedback: null };
      }

      this.streamEmitter.progress(projectId, 'architecture_agent', runId ?? '', 40, 'Generating docs');
      this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to generate architecture docs...`);

      const feedbackContext = state.validationFeedback
        ? `Your previous attempt had these validation issues. Fix them in your new output:\n${state.validationFeedback}`
        : '';

      const artifactManifest = (state.artifacts ?? [])
        .map((a) => `${a.agentType}: ${a.filePath}`)
        .join('\n');

      const structuredMemory = buildStructuredMemoryContext(memoryBundle.layers);

      const selfCritiqueFeedback = state.selfCritique
        ? `Self-review found these quality issues before validation — address them:\n${state.selfCritique}`
        : '';

      const combinedFeedback = [feedbackContext, selfCritiqueFeedback]
        .filter(Boolean)
        .join('\n\n');

      const systemPrompt = buildAgentSystemPrompt(
        ARCHITECTURE_AGENT_SYSTEM,
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
        agentName: resolveModelForNode('architecture_agent', 'architecture_agent'),
        subagent: 'architecture',
        correlation: {
          projectId,
          runId,
          nodeId: 'architecture_agent',
          agent: 'architecture',
        },
        onToken: (delta) => this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'token', delta),
        systemPrompt,
        userPrompt: `Generate architecture documentation for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Already generated files:
${artifactSummary}

Generate these 3 documentation files:

1. ARCHITECTURE.md
   - System overview
   - Mermaid diagram (graph TD) showing the main components and data flow
   - Component descriptions
   - Design decisions and trade-offs

2. API.md
   - OpenAPI-style documentation for all endpoints
   - Request/response schemas
   - Authentication details
   - Error codes

3. DEPLOYMENT.md
   - Prerequisites
   - Environment variable reference
   - Docker setup instructions
   - Production deployment checklist
   - Health check endpoints`,
        expectedShape: 'array',
      });

      const artifacts: GeneratedArtifact[] = result.value.map((item) => ({
        agentType: 'architecture' as const,
        filePath: item.filePath,
        content: item.content,
        language: item.language ?? 'markdown',
        source: 'llm',
      }));

      this.logger.log(
        `[${state.projectId}] Architecture agent generated ${artifacts.length} docs (${memoryBundle.total} layered memories injected)`,
      );

      await this.eventLog.logCompleted(state.projectId, 'architecture_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      await this.prisma.artifact.createMany({
        data: artifacts.map((a: GeneratedArtifact) => ({
          projectId: state.projectId, agentType: a.agentType, filePath: a.filePath, content: a.content, language: a.language, source: a.source ?? 'llm',
        })),
        skipDuplicates: true,
      }).catch(() => {});

      this.streamEmitter.progress(projectId, 'architecture_agent', runId ?? '', 95, 'Saving artifacts');
      this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'decision', `Architecture documentation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts, validationFeedback: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Architecture agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'architecture_agent', runId ?? '', 'error', `Architecture generation failed: ${humanReadableError(message)}`);
      return { error: `ArchitectureAgentNode failed: ${message}` };
    }
  }
}
