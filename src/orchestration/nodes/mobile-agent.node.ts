import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { AgentLlmRouter } from '../providers/agent-llm.router';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveAgentSystemPrompt } from '../../agents/agent-prompt-resolver';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { MOBILE_AGENT_SYSTEM, buildAgentSystemPrompt, buildRepoAccessBlock, buildStructuredMemoryContext } from '../prompts/agent-prompts';
import { resolveModelForNode } from '../providers/base-llm.provider';
import { OutputValidationService } from '../output-validation/output-validation.service';

/**
 * Generates React Native code for projects provisioned with a MOBILE repository.
 *
 * Unlike the frontend/backend/database agents this node is opt-in: the Gate 1 fan-out only
 * dispatches it when `state.hasMobileRepo` is true (see `codeAgentsFor`), so 2-repo projects
 * never pay for mobile generation. There is no scaffold merge — the mobile repository is
 * scaffolded deterministically at project creation by `repo-scaffold.ts`, so this agent only
 * produces feature code.
 */
@Injectable()
export class MobileAgentNode {
  private readonly logger = new Logger(MobileAgentNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly llm: AgentLlmRouter,
    private readonly streamEmitter: StreamEmitter,
    private readonly outputValidation: OutputValidationService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(`[${projectId}] Mobile agent generating files`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'error', 'Mobile agent skipped: contract is missing');
      return { error: 'MobileAgentNode: contract is null' };
    }

    await this.eventLog.logStarted(projectId, 'mobile_agent');

    this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'decision', 'Starting mobile code generation...');
    this.streamEmitter.progress(projectId, 'mobile_agent', runId ?? '', 10, 'Loading context');

    try {
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.techStack.mobile,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'mobile',
        projectId: state.projectId,
        query: memoryQuery,
      });

      this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for mobile context`);

      // Mobile source files from the contract, plus the screens every app needs.
      const mobileSourceFiles = state.contract.fileManifest.filter((f) =>
        /^(app|src)\/.*\.(tsx|ts)$|README-mobile\.md$/i.test(f) && !/\.(css|scss)$/i.test(f),
      );

      const coreSourceFiles = [
        'app/(tabs)/index.tsx',
        'app/_layout.tsx',
        'src/components/ui/Button.tsx',
        'README-mobile.md',
      ];
      const allMobileFiles = [
        ...new Set([...coreSourceFiles, ...mobileSourceFiles]),
      ];

      const skipCandidate = await this.memory.findSkipCandidate(
        'mobile',
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
            agentType: 'mobile',
            filePath: typeof candidatePath === 'string' ? candidatePath : 'app/(tabs)/index.tsx',
            content: skipCandidate.content,
            language: 'typescript',
            source: 'skip',
          };
          const validationErrors = this.outputValidation.validateBatch([candidateArtifact], state.projectId);
          if (validationErrors.length === 0) {
            this.logger.log(
              `[${state.projectId}] Skip-generation: reusing mobile memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
            );
            await this.memory.bumpUsageStats(skipCandidate.id);
            return { artifacts: [candidateArtifact], validationFeedback: null };
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
        this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'decision', 'Mock mode: generating predefined mobile screens');
        const mockArtifacts: GeneratedArtifact[] = [
          {
            agentType: 'mobile',
            filePath: 'app/(tabs)/index.tsx',
            content: `import { Text, View } from 'react-native';\n\nexport default function HomeScreen() {\n  return (\n    <View>\n      <Text>Mock Mobile for ${state.companyName}</Text>\n    </View>\n  );\n}\n`,
            language: 'tsx',
            source: 'mock',
          },
        ];
        await this.eventLog.logCompleted(state.projectId, 'mobile_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts: mockArtifacts, validationFeedback: null };
      }

      this.streamEmitter.progress(projectId, 'mobile_agent', runId ?? '', 40, `Generating ${allMobileFiles.length} files`);
      this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'decision', `Calling LLM (${this.llm.model()}) to generate mobile code for ${allMobileFiles.length} files...`);

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

      // The workspace's own instructions for this agent, falling back to the compiled-in
      // prompt when it has none.
      const basePrompt = await resolveAgentSystemPrompt(this.prisma, projectId, 'mobile', MOBILE_AGENT_SYSTEM);

      const systemPrompt = buildAgentSystemPrompt(
        basePrompt,
        structuredMemory,
        artifactManifest,
        combinedFeedback || undefined,
        state.contractSummary || undefined,
      );

      // Give the agent its repository capability so it can read the existing code before
      // generating; empty string when repository access is disabled for this run.
      const systemPromptWithRepo = systemPrompt + buildRepoAccessBlock(state.repoToken, 'mobile');

      const result = await this.llm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: resolveModelForNode('mobile_agent', 'mobile_agent'),
        subagent: 'mobile',
        onToken: (delta) => this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'token', delta),
        systemPrompt: systemPromptWithRepo,
        userPrompt: `Generate React Native files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allMobileFiles.map((f) => `- ${f}`).join('\n')}

Generate complete, production-quality code for each file. Config files (package.json, tsconfig.json, app.json, babel.config.js) are already provisioned in the mobile repository — do not include them in your output.`,
        expectedShape: 'array',
      });

      const artifacts: GeneratedArtifact[] = result.value.map((item) => ({
        agentType: 'mobile' as const,
        filePath: item.filePath,
        content: item.content,
        language: item.language ?? this.inferLanguage(item.filePath),
        source: 'llm',
      }));

      this.logger.log(
        `[${state.projectId}] Mobile agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      await this.eventLog.logCompleted(state.projectId, 'mobile_agent', {
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

      this.streamEmitter.progress(projectId, 'mobile_agent', runId ?? '', 95, 'Saving artifacts');
      this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'decision', `Mobile generation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts, validationFeedback: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Mobile agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'mobile_agent', runId ?? '', 'error', `Mobile generation failed: ${humanReadableError(message)}`);
      return { error: `MobileAgentNode failed: ${message}` };
    }
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'typescript';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }
}
