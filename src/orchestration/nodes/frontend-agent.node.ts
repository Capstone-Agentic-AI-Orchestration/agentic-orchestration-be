import { Injectable, Logger } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import {
  FRONTEND_AGENT_SYSTEM,
  buildAgentSystemPrompt,
  buildRepoAccessBlock,
  buildStructuredMemoryContext,
  renderDesignMarkdown,
} from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { ProjectScaffolderService } from '../scaffolding/project-scaffolder.service';
import { OutputValidationService } from '../output-validation/output-validation.service';
import { buildOutputStructureContract, createOutputStructureContractArtifact, renderDomainContractContext } from '../domain-contracts';

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

      const outputStructureContract = buildOutputStructureContract(state);
      const mvvmFeatureFiles = outputStructureContract.agents.frontend.features
        .flatMap((feature) => [
          feature.modelPath,
          feature.viewModelPath,
          feature.viewPath,
          feature.routePath,
        ]);
      const coreSourceFiles = [
        'src/app/page.tsx',
        'src/app/layout.tsx',
        'src/shared/ui/Button.tsx',
        'src/shared/ui/Card.tsx',
        'src/styles/globals.css',
        'README-frontend.md',
        ...mvvmFeatureFiles,
      ];
      const allFrontendFiles = [
        ...new Set([...coreSourceFiles, ...frontendSourceFiles]),
      ];
      const designContractArtifact = this.createDesignContractArtifact(state);
      const outputStructureArtifact = createOutputStructureContractArtifact(state);

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
          const validationErrors = this.outputValidation.validateBatch(
            [designContractArtifact, outputStructureArtifact, candidateArtifact],
            state.projectId,
            { designGuidance: state.designGuidance },
          );
          if (validationErrors.length === 0) {
            this.logger.log(
              `[${state.projectId}] Skip-generation: reusing frontend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
            );
            await this.memory.bumpUsageStats(skipCandidate.id);
            return { artifacts: this.mergeWithScaffold([designContractArtifact, candidateArtifact], state), validationFeedback: null };
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
        const primaryFeature = outputStructureContract.agents.frontend.features[0];
        const viewName = primaryFeature?.viewPath.split('/').pop()?.replace(/\.tsx$/i, '') ?? 'ItemsView';
        const viewModelModule = primaryFeature?.viewModelPath.split('/').pop()?.replace(/\.ts$/i, '') ?? 'use-items';
        const mockArtifacts: GeneratedArtifact[] = [
          designContractArtifact,
          outputStructureArtifact,
          {
            agentType: 'frontend',
            filePath: primaryFeature?.modelPath ?? 'src/features/items/model/types.ts',
            content: `export interface MockFrontendViewModel { title: string; companyName: string; }\n`,
            language: 'typescript',
            source: 'mock',
          },
          {
            agentType: 'frontend',
            filePath: primaryFeature?.viewModelPath ?? 'src/features/items/view-model/use-items.ts',
            content: `import type { MockFrontendViewModel } from '../model/types';\nexport function useMockFrontend(companyName: string): MockFrontendViewModel { return { title: 'Mock Frontend', companyName }; }\n`,
            language: 'typescript',
            source: 'mock',
          },
          {
            agentType: 'frontend',
            filePath: primaryFeature?.viewPath ?? 'src/features/items/view/ItemsView.tsx',
            content: `import { useMockFrontend } from '../view-model/${viewModelModule}';\nexport function ${viewName}() { const model = useMockFrontend('${state.companyName}'); return <main><h1>{model.title}</h1><p>{model.companyName}</p></main>; }\n`,
            language: 'tsx',
            source: 'mock',
          },
          {
            agentType: 'frontend',
            filePath: 'src/app/page.tsx',
            content: `import { ${viewName} } from '../features/${primaryFeature?.feature ?? 'items'}/view/${viewName}';\nexport default function Page() { return <${viewName} />; }\n`,
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
      const domainContracts = renderDomainContractContext([
        ...(state.artifacts ?? []),
        designContractArtifact,
        outputStructureArtifact,
      ]);

      const selfCritiqueFeedback = state.selfCritique
        ? `Self-review found these quality issues before validation — address them:\n${state.selfCritique}`
        : '';

      const combinedFeedback = [feedbackContext, selfCritiqueFeedback]
        .filter(Boolean)
        .join('\n\n');

      const systemPrompt = buildAgentSystemPrompt({
        basePrompt: FRONTEND_AGENT_SYSTEM,
        memoryContext: structuredMemory,
        artifactManifest,
        previousFeedback: combinedFeedback || undefined,
        contractSummary: state.contractSummary || undefined,
        domainContracts,
        designGuidance: state.designGuidance,
        agentSkillRole: 'frontend',
      });

      // Give the agent its repository capability so it can read the existing code before
      // generating; empty string when repository access is disabled for this run.
      const systemPromptWithRepo = systemPrompt + buildRepoAccessBlock(state.repoToken, 'frontend');

      const result = await this.llm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: resolveModelForNode('frontend_agent', 'frontend_agent'),
        subagent: 'frontend',
        correlation: {
          projectId,
          runId,
          nodeId: 'frontend_agent',
          agent: 'frontend',
        },
        onToken: (delta) => this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'token', delta),
        systemPrompt: systemPromptWithRepo,
        userPrompt: `Generate frontend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allFrontendFiles.map((f) => `- ${f}`).join('\n')}

Authoritative OUTPUT_STRUCTURE.json (DevFlow will persist this contract artifact automatically; do not emit OUTPUT_STRUCTURE.json in your JSON output):
${outputStructureArtifact.content}

Generate complete, production-quality code for each file. Follow OUTPUT_STRUCTURE.json exactly:
- Put feature models/types under src/features/<feature>/model
- Put state mapping and interaction logic under src/features/<feature>/view-model
- Put feature UI under src/features/<feature>/view
- Keep src/app/**/page.tsx as a thin shell that imports and renders a feature view
- Config files (package.json, tsconfig.json, next.config.ts, postcss.config.mjs, layout.tsx, globals.css, README-frontend.md) will be provided automatically — do not include them in your output.`,
        expectedShape: 'array',
      });

      const llmArtifacts: GeneratedArtifact[] = [
        designContractArtifact,
        outputStructureArtifact,
        ...result.value.map((item) => ({
          agentType: 'frontend' as const,
          filePath: item.filePath,
          content: item.content,
          language: item.language ?? this.inferLanguage(item.filePath),
          source: 'llm' as const,
        })),
      ];

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

  private createDesignContractArtifact(state: DevFlowStateType): GeneratedArtifact {
    return {
      agentType: 'frontend',
      filePath: 'DESIGN.md',
      content: renderDesignMarkdown(state.designGuidance),
      language: 'markdown',
      source: 'scaffold',
      domainContract: {
        kind: 'frontend-design',
        version: 'v1',
        summary: 'OpenDesign-style DevFlow visual contract for frontend artifacts',
      },
    };
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'typescript';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) return 'css';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }
}
