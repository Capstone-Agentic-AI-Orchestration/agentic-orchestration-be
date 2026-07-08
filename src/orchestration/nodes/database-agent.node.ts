import { Injectable, Logger } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { DATABASE_AGENT_SYSTEM, buildAgentSystemPrompt, buildStructuredMemoryContext } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { ProjectScaffolderService } from '../scaffolding/project-scaffolder.service';
import { OutputValidationService } from '../output-validation/output-validation.service';
import { createDatabaseModelContractArtifact, renderDomainContractContext } from '../domain-contracts';

@Injectable()
export class DatabaseAgentNode {
  private readonly logger = new Logger(DatabaseAgentNode.name);

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
    this.logger.log(`[${projectId}] Database agent generating files`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'error', 'Database agent skipped: contract is missing');
      return { error: 'DatabaseAgentNode: contract is null' };
    }

    await this.eventLog.logStarted(projectId, 'database_agent');

    this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'decision', 'Starting database schema generation...');
    this.streamEmitter.progress(projectId, 'database_agent', runId ?? '', 10, 'Loading context');

    try {
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.contract.requirements.techStack.database,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'database',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for database context`);

      const dbFiles = state.contract.fileManifest.filter((f) =>
        /\.(prisma|sql|seed\.(ts|js))$|README-database\.md$/i.test(f),
      );

      const coreFiles = [
        'prisma/schema.prisma',
        'prisma/migrations/0001_initial.sql',
        'prisma/seed.ts',
        'README-database.md',
      ];
      const allDbFiles = [...new Set([...coreFiles, ...dbFiles])];
      const dataModelArtifact = createDatabaseModelContractArtifact(state);

      const skipCandidate = await this.memory.findSkipCandidate(
        'database',
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
            agentType: 'database',
            filePath:
              typeof rememberedFilePath === 'string'
                ? rememberedFilePath
                : 'prisma/schema.prisma',
            content: skipCandidate.content,
            language: 'prisma',
            source: 'skip',
          };
          const validationErrors = this.outputValidation.validateBatch([dataModelArtifact, candidateArtifact], state.projectId);
          if (validationErrors.length === 0) {
            this.logger.log(
              `[${state.projectId}] Skip-generation: reusing database memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
            );
            await this.memory.bumpUsageStats(skipCandidate.id);
            return { artifacts: this.mergeWithScaffold([dataModelArtifact, candidateArtifact], state), validationFeedback: null };
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
        this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'decision', 'Mock mode: generating predefined database files');
        const mockArtifacts: GeneratedArtifact[] = [
          dataModelArtifact,
          {
            agentType: 'database',
            filePath: 'prisma/schema.prisma',
            content: `model User {\n  id Int @id @default(autoincrement())\n}`,
            language: 'prisma',
            source: 'mock',
          },
        ];
        const artifacts = this.mergeWithScaffold(mockArtifacts, state);
        await this.eventLog.logCompleted(state.projectId, 'database_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts, validationFeedback: null };
      }

      this.streamEmitter.progress(projectId, 'database_agent', runId ?? '', 40, `Generating ${allDbFiles.length} files`);
      this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to generate database schema for ${allDbFiles.length} files...`);

      const feedbackContext = state.validationFeedback
        ? `Your previous attempt had these validation issues. Fix them in your new output:\n${state.validationFeedback}`
        : '';

      const artifactManifest = (state.artifacts ?? [])
        .map((a) => `${a.agentType}: ${a.filePath}`)
        .join('\n');

      const structuredMemory = buildStructuredMemoryContext(memoryBundle.layers);
      const domainContracts = renderDomainContractContext([
        ...(state.artifacts ?? []),
        dataModelArtifact,
      ]);

      const selfCritiqueFeedback = state.selfCritique
        ? `Self-review found these quality issues before validation — address them:\n${state.selfCritique}`
        : '';

      const combinedFeedback = [feedbackContext, selfCritiqueFeedback]
        .filter(Boolean)
        .join('\n\n');

      const systemPrompt = buildAgentSystemPrompt({
        basePrompt: DATABASE_AGENT_SYSTEM,
        memoryContext: structuredMemory,
        artifactManifest,
        previousFeedback: combinedFeedback || undefined,
        domainContracts,
        agentSkillRole: 'database',
      });

      const result = await this.llm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: resolveModelForNode('database_agent', 'database_agent'),
        subagent: 'database',
        correlation: {
          projectId,
          runId,
          nodeId: 'database_agent',
          agent: 'database',
        },
        onToken: (delta) => this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'token', delta),
        systemPrompt,
        userPrompt: `Generate database files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Database: ${state.contract.requirements.techStack.database}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allDbFiles.map((f) => `- ${f}`).join('\n')}

Authoritative DATA_MODEL.json (DevFlow will persist this contract artifact automatically; do not emit DATA_MODEL.json in your JSON output):
${dataModelArtifact.content}

Requirements:
- prisma/schema.prisma: Full Prisma schema with all models, relations, and indexes (the generator client and datasource blocks will be provided automatically)
- migrations SQL: Clean DDL with CREATE TABLE, indexes, and foreign keys
- prisma/seed.ts: Realistic seed data using @prisma/client
- Entity names, fields, indexes, constraints, relations, migration policy, and seed data must match DATA_MODEL.json
- README-database.md: ERD description, migration guide, seeding instructions`,
        expectedShape: 'array',
      });

      const llmArtifacts: GeneratedArtifact[] = [
        dataModelArtifact,
        ...result.value.map((item) => ({
          agentType: 'database' as const,
          filePath: item.filePath,
          content: item.content,
          language: item.language ?? this.inferLanguage(item.filePath),
          source: 'llm' as const,
        })),
      ];

      const artifacts = this.mergeWithScaffold(llmArtifacts, state);

      this.logger.log(
        `[${state.projectId}] Database agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      await this.eventLog.logCompleted(state.projectId, 'database_agent', {
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

      this.streamEmitter.progress(projectId, 'database_agent', runId ?? '', 95, 'Saving artifacts');
      this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'decision', `Database generation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts, validationFeedback: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Database agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'database_agent', runId ?? '', 'error', `Database generation failed: ${humanReadableError(message)}`);
      return { error: `DatabaseAgentNode failed: ${message}` };
    }
  }

  private mergeWithScaffold(
    llmArtifacts: GeneratedArtifact[],
    state: DevFlowStateType,
  ): GeneratedArtifact[] {
    const scaffoldFiles = this.scaffolder.scaffold({
      projectId: state.projectId,
      agentType: WorkOrderAgentType.DATABASE,
      contract: state.contract!,
      companyName: state.companyName,
    });
    return this.scaffolder.merge(llmArtifacts, scaffoldFiles, 'database');
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.prisma')) return 'prisma';
    if (filePath.endsWith('.sql')) return 'sql';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }
}
