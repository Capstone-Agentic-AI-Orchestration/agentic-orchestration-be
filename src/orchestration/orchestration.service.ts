import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { resolveAgentSystemPrompt } from '../agents/agent-prompt-resolver';
import { resolveRuntimeKey } from '../agents/built-in-agents';
import { buildDevFlowNodeImpls, type DevFlowNodeImpls } from './graph/devflow.graph';
import { buildSimulationNodeImpls } from './graph/simulation-nodes';
import {
  applyDevFlowPartial,
  createInitialDevFlowState,
  normalizeDesignGuidance,
  type DesignGuidanceInput,
  type DevFlowStateType,
} from './graph/devflow.state';
import {
  OrchestrationSequencer,
  type RunPhase,
} from './graph/orchestration-sequencer';
import { PrismaService } from '../prisma/prisma.service';
import { RequirementsParserNode } from './nodes/requirements-parser.node';
import { ContractNegotiatorNode } from './nodes/contract-negotiator.node';
import { FrontendAgentNode } from './nodes/frontend-agent.node';
import { MobileAgentNode } from './nodes/mobile-agent.node';
import { AgentRepoService } from '../agent-repo/agent-repo.service';
import { BackendAgentNode } from './nodes/backend-agent.node';
import { DatabaseAgentNode } from './nodes/database-agent.node';
import { ArchitectureAgentNode } from './nodes/architecture-agent.node';
import { ValidatorNode } from './nodes/validator.node';
import { ExecutionValidationNode } from './nodes/execution-validation.node';
import { GithubCommitNode } from './nodes/github-commit.node';
import { SelfCritiqueNode } from './nodes/self-critique.node';
import { QualityReviewNode } from './nodes/quality-review.node';
import { MemoryService } from '../memory/memory.service';
import { DevFlowGateway } from '../gateway/devflow.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import {
  GithubDeliveryStatus,
  GithubDeliveryVerification,
  GithubService,
} from '../github/github.service';
import { AgentProviderRegistry } from './providers/agent-provider.registry';
import { ArtifactContractValidator } from './providers/artifact-contract.validator';
import { OutputValidationService } from './output-validation/output-validation.service';
import {
  DirectLlmProvider,
  DirectLlmProviderVerification,
} from './providers/direct-llm.provider';
import { AgentLlmRouter } from './providers/agent-llm.router';
import { OrchestrationEmitter } from './streaming/orchestration-emitter.service';
import { StreamEmitter } from './streaming/stream-emitter.service';
import { OrchestrationRunDispatcher } from './run-dispatcher.service';
import type { IntakeContextPackage, RequirementEvidence } from '../intake/intake.types';
import {
  AgentLlmEngineStatus,
  AgentProviderMode,
  AgentProviderStatus,
} from './providers/agent-provider.types';
import {
  agentArtifactContractFor,
  ORCHESTRATION_CONTRACT_VERSION,
} from './providers/agent-contracts';
import {
  ArtifactValidationStatus,
  OrchestrationJob,
  OrchestrationJobKind,
  OrchestrationJobStatus,
  NotificationType,
  OrchestrationRunStatus,
  OrchestrationRunTrigger,
  Prisma,
  ProjectStatus,
  ProjectTaskActivityType,
  ProjectTaskStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  RepositoryKind,
  WorkOrderAgentType,
  WorkOrderExecutionStatus,
  WorkOrderStatus,
} from '@prisma/client';
import {
  ModelCatalogService,
  type GatewayModelCatalog,
  type OrchestrationModelSelection,
  type OrchestrationModelSelectionInput,
} from './models/model-catalog.service';

// ─── Status Shape ─────────────────────────────────────────────────────────────

export interface OrchestrationStatus {
  status: string;
  currentNode: string;
  retryCount: number;
  error: string | null;
  contract?: DevFlowStateType['contract'];
}

export interface OrchestrationRunControlsInput {
  tokenBudget?: number;
  maxRetries?: number;
}

// ─── Mid-run control (Phase 2) ──────────────────────────────────────────────

export type OrchestrationControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry_node'
  | 'skip_node'
  | 'modify_params';

export interface OrchestrationControlOptions {
  nodeId?: string;
  params?: Record<string, unknown>;
  actorId?: string;
}

export interface OrchestrationControlResult {
  accepted: boolean;
  action: OrchestrationControlAction;
  status: string;
}

export interface WorkOrderExecutionResult {
  executionRunId: string;
  artifactId: string;
}

interface WorkOrderExecutionOptions {
  emitLifecycleEvents?: boolean;
  parentRunId?: string;
  trigger?: OrchestrationRunTrigger;
  allowFailedRetry?: boolean;
}

interface SupervisorRecoveryOptions {
  reason: string;
  retryAttempt: number;
  maxRetries: number;
}

export interface SupervisorRecoveryResult {
  runId: string;
  readyWorkOrders: number;
  completedWorkOrders: number;
  failedWorkOrders: number;
  status: OrchestrationRunStatus;
  error: string | null;
}

export interface EveLlmProviderVerification {
  ok: boolean;
  provider: 'eve';
  model: string;
  fallbackModel: null;
  baseUrl: string;
  reason: string | null;
  usage: null;
  engineStatus: AgentLlmEngineStatus;
}

export type OrchestrationProviderStatus = AgentProviderStatus & {
  githubDelivery: GithubDeliveryStatus;
  llmEngine: AgentLlmEngineStatus;
  requestedEngine: AgentLlmEngineStatus['requestedEngine'];
  activeEngine: AgentLlmEngineStatus['activeEngine'];
  fallbackReason: string | null;
  eveServiceConfigured: boolean;
  engineModel: string;
};

const MOCK_NODE = {
  LOAD_READY_WORK_ORDERS: 'load_ready_work_orders',
  EXECUTE_READY_WORK_ORDERS: 'execute_ready_work_orders',
  FINALIZE: 'finalize_mock_orchestration',
} as const;
const SUPERVISOR_RECOVERY_NODE = 'supervisor_recovery';

/**
 * Eve migration — internal state for the ported mock work-order pipeline (formerly a LangGraph
 * StateGraph, now a plain sequential method {@link OrchestrationService.runMockWorkOrders}).
 */
interface MockWorkOrderState {
  projectId: string;
  runId: string;
  trigger: OrchestrationRunTrigger;
  actorId: string | null;
  readyWorkOrderIds: string[];
  completedArtifactIds: string[];
  failedWorkOrderIds: string[];
  error: string | null;
}

export type AutoAnalyzeMode = 'fast' | 'thorough';

export interface AutoAnalyzeBriefInput {
  companyName: string;
  brief: string;
  stackKey: string;
  designGuidance?: DesignGuidanceInput;
  mode?: AutoAnalyzeMode;
}

export interface AutoAnalyzeBriefResult {
  enhancedBrief: string;
  suggestedFeatures: string[];
  suggestedTechStack: { frontend: string; backend: string; database: string; styling: string };
  complexity: 'simple' | 'medium' | 'complex';
  estimatedFiles: number;
}

type AutoAnalyzeCacheEntry =
  | { expiresAt: number; result: AutoAnalyzeBriefResult }
  | { expiresAt: number; pending: Promise<AutoAnalyzeBriefResult> };

const AUTO_ANALYZE_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTO_ANALYZE_PENDING_TTL_MS = 30 * 1000;
const DEFAULT_AUTO_ANALYZE_MAX_TOKENS = 1200;

/**
 * Gate 1 evidence rule.
 *
 * Client documents were already being injected into the requirements prompt, and the parser was
 * already asked to cite them — but nothing ever read those citations back, so a run could be
 * approved having quietly ignored every document the client supplied. This closes that loop:
 * when the locked intake package carries readable source documents, the requirements must cite
 * at least one of them before the gate can be approved. (The approver is the developer since
 * the delivery split — the rule is about grounding the build in the client's documents, so it
 * binds whoever decides, not a particular role.)
 *
 * Citations are validated against the supplied sources in the requirements parser, so anything
 * still present here is known to resolve to real text an agent received.
 *
 * Returns a human-readable reason to refuse, or null when the gate may proceed. A project with
 * no source documents is never blocked — there is nothing to cite, and the intake has an
 * explicit "no supporting documents apply" path for exactly that case.
 */
export function describeEvidenceGap(
  state: { intakeContext?: IntakeContextPackage | null; requirementsEvidence?: RequirementEvidence[] | null } | null,
): string | null {
  const sources = state?.intakeContext?.sources ?? [];
  if (sources.length === 0) return null;

  const evidence = state?.requirementsEvidence ?? [];
  if (evidence.length === 0) {
    return (
      `This project supplied ${sources.length} source document${sources.length === 1 ? '' : 's'}, but the parsed ` +
      'requirements cite none of them. Re-run requirements parsing, or lock a new intake version, ' +
      'so the build is grounded in the documents the client provided.'
    );
  }

  const citedIds = new Set(evidence.map((item) => item.documentId));
  const uncited = sources.filter((source) => !citedIds.has(source.documentId));
  if (uncited.length === sources.length) {
    // Defensive: unresolved citations are already dropped upstream, so reaching here would mean
    // every citation pointed somewhere unexpected.
    return 'The parsed requirements cite no supplied document. Re-run requirements parsing before approving.';
  }

  return null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OrchestrationService implements OnModuleInit {
  private readonly logger = new Logger(OrchestrationService.name);

  // Eve migration: the former LangGraph runtime is now a plain deterministic sequencer driving
  // swappable node-implementation maps. The live and simulation runs share one sequencer + one
  // topology and differ only by their impl map.
  private liveImpls!: DevFlowNodeImpls;
  private simulationImpls!: DevFlowNodeImpls;

  /**
   * In-flight runs keyed by runId, each with an AbortController. Created when a
   * run starts streaming; deleted when it settles. Phase 2 mid-run `cancel`
   * aborts the controller; Phase 1 only needs the lifecycle bookkeeping.
   */
  private readonly activeRuns = new Map<string, AbortController>();

  /**
   * Projects manually paused via the control API. In-memory by design: pause is
   * a short-lived interactive operation. While present, the supervisor skips
   * auto-recovery for the project (manual intervention takes precedence).
   */
  private readonly pausedRuns = new Set<string>();

  private readonly autoAnalyzeCache = new Map<string, AutoAnalyzeCacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly requirementsParser: RequirementsParserNode,
    private readonly contractNegotiator: ContractNegotiatorNode,
    private readonly frontendAgent: FrontendAgentNode,
    private readonly mobileAgent: MobileAgentNode,
    private readonly agentRepo: AgentRepoService,
    private readonly backendAgent: BackendAgentNode,
    private readonly databaseAgent: DatabaseAgentNode,
    private readonly architectureAgent: ArchitectureAgentNode,
    private readonly selfCritique: SelfCritiqueNode,
    private readonly validator: ValidatorNode,
    private readonly githubCommit: GithubCommitNode,
    private readonly memory: MemoryService,
    private readonly artifactContractValidator: ArtifactContractValidator,
    private readonly outputValidation: OutputValidationService,
    private readonly agentProviderRegistry: AgentProviderRegistry,
    private readonly notifications: NotificationsService,
    private readonly github: GithubService,
    private readonly sequencer: OrchestrationSequencer,
    @Optional() private readonly agentLlmRouter: AgentLlmRouter | null,
    @Optional() @Inject(DirectLlmProvider)
    private readonly directLlmProvider: DirectLlmProvider | null,
    // Optional: WebSocket gateway may not be present in all environments
    @Optional() private readonly gateway: DevFlowGateway | null,
    @Optional() private readonly emitter: OrchestrationEmitter | null,
    @Optional() private readonly streamEmitter: StreamEmitter | null,
    private readonly runDispatcher: OrchestrationRunDispatcher,
    private readonly modelCatalog: ModelCatalogService,
    @Optional() private readonly executionValidation?: ExecutionValidationNode,
    @Optional() private readonly qualityReview?: QualityReviewNode,
  ) {}

  getModelCatalog(): Promise<GatewayModelCatalog> {
    return this.modelCatalog.getCatalog();
  }

  validateModelSelection(
    input?: OrchestrationModelSelectionInput,
  ): Promise<OrchestrationModelSelection> {
    return this.modelCatalog.validateSelection(input);
  }

  getProviderStatus(): OrchestrationProviderStatus {
    const llmEngine = this.agentLlmRouter?.getStatus() ?? {
      requestedEngine: process.env.ORCHESTRATION_LLM_ENGINE === 'eve' ? 'eve' : 'direct',
      activeEngine: 'direct',
      fallbackReason: 'Agent LLM router is not available; using direct-provider status only.',
      eveServiceConfigured: false,
      model: this.directLlmProvider?.model() ?? 'unknown',
    } satisfies AgentLlmEngineStatus;

    return {
      ...this.agentProviderRegistry.getStatus(),
      llmEngine,
      requestedEngine: llmEngine.requestedEngine,
      activeEngine: llmEngine.activeEngine,
      fallbackReason: llmEngine.fallbackReason,
      eveServiceConfigured: llmEngine.eveServiceConfigured,
      engineModel: llmEngine.model,
      githubDelivery: this.github.getDeliveryStatus(),
    };
  }

  verifyGithubDeliveryAccess(): Promise<GithubDeliveryVerification> {
    return this.github.verifyDeliveryAccess();
  }

  async verifyLlmProviderAccess(): Promise<DirectLlmProviderVerification | EveLlmProviderVerification> {
    const engineStatus = this.agentLlmRouter?.getStatus();
    if (engineStatus?.activeEngine === 'eve') {
      return {
        ok: true,
        provider: 'eve',
        model: engineStatus.model,
        fallbackModel: null,
        baseUrl: process.env.EVE_SERVICE_URL ?? '',
        reason: null,
        usage: null,
        engineStatus,
      };
    }

    if (!this.directLlmProvider) {
      throw new Error('Direct LLM provider is not available in this runtime.');
    }

    return this.directLlmProvider.verifyConnection();
  }

  async autoAnalyzeBrief(input: AutoAnalyzeBriefInput): Promise<AutoAnalyzeBriefResult> {
    const mode = input.mode === 'thorough' ? 'thorough' : 'fast';
    const cacheKey = this.autoAnalyzeCacheKey(input, mode);
    const now = Date.now();
    const cached = this.autoAnalyzeCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return 'result' in cached ? cached.result : cached.pending;
    }

    if (cached) {
      this.autoAnalyzeCache.delete(cacheKey);
    }

    const pending = this.generateAutoAnalyzeBrief({ ...input, mode })
      .then((result) => {
        this.autoAnalyzeCache.set(cacheKey, {
          expiresAt: Date.now() + AUTO_ANALYZE_CACHE_TTL_MS,
          result,
        });
        return result;
      })
      .catch((error: unknown) => {
        this.autoAnalyzeCache.delete(cacheKey);
        throw error;
      });

    this.autoAnalyzeCache.set(cacheKey, {
      expiresAt: now + AUTO_ANALYZE_PENDING_TTL_MS,
      pending,
    });

    return pending;
  }

  private async generateAutoAnalyzeBrief(input: AutoAnalyzeBriefInput & { mode: AutoAnalyzeMode }): Promise<AutoAnalyzeBriefResult> {
    if (!this.directLlmProvider) {
      throw new BadRequestException(
        'Auto-analyze requires an LLM provider, but the direct LLM provider is not available in this runtime. Ensure the OrchestrationModule is properly configured.',
      );
    }

    if (!this.directLlmProvider.isAvailable()) {
      const keyName =
        this.directLlmProvider.providerName() === 'anthropic' ? 'ANTHROPIC_API_KEY' :
        this.directLlmProvider.providerName() === 'opencode' ? 'OPENCODE_API_KEY' :
        this.directLlmProvider.providerName() === 'gemini' ? 'GEMINI_API_KEY' :
        this.directLlmProvider.providerName() === 'openai' ? 'OPENAI_API_KEY' :
        'OPENROUTER_API_KEY';
      throw new BadRequestException(
        `Auto-analyze requires an LLM API key. Set the ${keyName} environment variable, or configure the provider in Admin > Providers.`,
      );
    }

    const memoryContext = input.mode === 'thorough'
      ? await this.memory.readRelevant(
          'requirements',
          [
            input.stackKey,
            input.brief.slice(0, 200),
            'brief analysis requirements',
          ].filter(Boolean).join(' '),
          3,
        ).catch(() => [])
      : [];

    const contextBlock = memoryContext.length > 0
      ? `\n\nContext from similar past analyses:\n${this.memory.formatAsContext(memoryContext)}`
      : '';

    const designGuidance = normalizeDesignGuidance(input.designGuidance);

    const systemPrompt = `You are a product analyst helping a PM turn a rough idea into a structured project brief.
Return a valid JSON object with this exact shape:
{
  "enhancedBrief": string,
  "suggestedFeatures": string[],
  "suggestedTechStack": {
    "frontend": string,
    "backend": string,
    "database": string,
    "styling": string
  },
  "complexity": "simple" | "medium" | "complex",
  "estimatedFiles": number
}

Rules:
- enhancedBrief: Rewrite the rough idea as a clear, professional 2-4 sentence project brief. Preserve the user's intent but add clarity.
- suggestedFeatures: 4-8 concrete features as short noun phrases (e.g. "User authentication", "Dashboard analytics").
- suggestedTechStack: Infer from the stack key hint; use sensible defaults if not clear.
- complexity: "simple" for <4 features, "medium" for 4-7, "complex" for 8+.
- estimatedFiles: Rough file count based on features and complexity.
- Account for this UI design direction when clarifying the brief, especially frontend-facing features:
  theme=${designGuidance.theme}, productFeel=${designGuidance.productFeel}, layoutDensity=${designGuidance.layoutDensity}, accessibilityLevel=${designGuidance.accessibilityLevel}, designPreset=${designGuidance.designSystem?.presetId ?? 'devflow-black-ops'}, forbiddenPatterns=${designGuidance.forbiddenPatterns.join(', ') || 'none'}, antiPatterns=${designGuidance.designSystem?.antiPatterns.join(', ') || 'none'}, notes=${designGuidance.notes ?? 'none'}
Respond ONLY with the JSON object — no markdown fences, no prose.${contextBlock}`;

    const userPrompt = `Analyze this project idea and produce a structured brief.

Company name: ${input.companyName}
Stack key: ${input.stackKey}
Rough idea: ${input.brief}`;

    const result = await this.directLlmProvider.generateJson<Record<string, unknown>>({
      agentName: 'auto_analyze',
      systemPrompt,
      userPrompt,
      expectedShape: 'object',
      maxTokens: this.autoAnalyzeMaxTokens(),
    });

    const value = result.value;
    const suggestedFeatures = Array.isArray(value['suggestedFeatures'])
      ? (value['suggestedFeatures'] as unknown[]).filter(
          (f): f is string => typeof f === 'string' && f.trim().length > 0,
        )
      : [];

    const rawTechStack = value['suggestedTechStack'];
    const techStack =
      rawTechStack && typeof rawTechStack === 'object' && !Array.isArray(rawTechStack)
        ? (rawTechStack as Record<string, unknown>)
        : {};

    const rawComplexity = value['complexity'];
    const complexity =
      rawComplexity === 'simple' || rawComplexity === 'medium' || rawComplexity === 'complex'
        ? rawComplexity
        : 'medium';

    const estimatedFiles =
      typeof value['estimatedFiles'] === 'number' && (value['estimatedFiles'] as number) > 0
        ? Math.ceil(value['estimatedFiles'] as number)
        : Math.max(suggestedFeatures.length + 6, 8);

    return {
      enhancedBrief:
        typeof value['enhancedBrief'] === 'string' && value['enhancedBrief'].trim().length > 0
          ? value['enhancedBrief'] as string
          : input.brief,
      suggestedFeatures: suggestedFeatures.length > 0 ? suggestedFeatures : ['Core application workflow'],
      suggestedTechStack: {
        frontend: typeof techStack['frontend'] === 'string' ? techStack['frontend'] : 'Next.js',
        backend: typeof techStack['backend'] === 'string' ? techStack['backend'] : 'NestJS',
        database: typeof techStack['database'] === 'string' ? techStack['database'] : 'PostgreSQL',
        styling: typeof techStack['styling'] === 'string' ? techStack['styling'] : 'Tailwind CSS',
      },
      complexity,
      estimatedFiles,
    };
  }

  private autoAnalyzeMaxTokens(): number {
    const parsed = Number.parseInt(process.env.AUTO_ANALYZE_MAX_OUTPUT_TOKENS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTO_ANALYZE_MAX_TOKENS;
  }

  private autoAnalyzeCacheKey(input: AutoAnalyzeBriefInput, mode: AutoAnalyzeMode): string {
    const designGuidance = normalizeDesignGuidance(input.designGuidance);
    return JSON.stringify({
      mode,
      companyName: this.normalizeAutoAnalyzeKeyPart(input.companyName || 'Unknown company'),
      brief: this.normalizeAutoAnalyzeKeyPart(input.brief),
      stackKey: this.normalizeAutoAnalyzeKeyPart(input.stackKey || 'nextjs-nestjs-supabase'),
      designGuidance: {
        theme: designGuidance.theme,
        productFeel: designGuidance.productFeel,
        layoutDensity: designGuidance.layoutDensity,
        accessibilityLevel: designGuidance.accessibilityLevel,
        presetId: designGuidance.designSystem?.presetId ?? 'devflow-black-ops',
        forbiddenPatterns: [...designGuidance.forbiddenPatterns].sort(),
        antiPatterns: [...(designGuidance.designSystem?.antiPatterns ?? [])].sort(),
        notes: this.normalizeAutoAnalyzeKeyPart(designGuidance.notes ?? ''),
      },
    });
  }

  private normalizeAutoAnalyzeKeyPart(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  onModuleInit(): void {
    this.logger.log('Initializing orchestration pipeline...');
    if (!this.executionValidation) {
      throw new Error('ExecutionValidationNode is not registered in OrchestrationModule.');
    }
    this.liveImpls = buildDevFlowNodeImpls(
      this.requirementsParser,
      this.contractNegotiator,
      this.frontendAgent,
      this.mobileAgent,
      this.backendAgent,
      this.databaseAgent,
      this.architectureAgent,
      this.qualityReview ?? {
        executeQa: async () => ({}),
        executeSecurity: async () => ({}),
      },
      this.selfCritique,
      this.validator,
      this.executionValidation,
      this.githubCommit,
    );
    this.simulationImpls = buildSimulationNodeImpls(this.emitter);
    this.runDispatcher.registerExecutor((job) => this.executeOrchestrationJob(job));
    this.runDispatcher.drainDueJobs();
    this.logger.log('Orchestration pipeline initialized');
  }

  private async executeOrchestrationJob(job: OrchestrationJob): Promise<void> {
    const payload = this.jobPayload(job);
    if (job.kind === OrchestrationJobKind.MOCK_WORK_ORDERS) {
      await this.runMockWorkOrders(payload.state as MockWorkOrderState);
      return;
    }

    if (
      job.kind === OrchestrationJobKind.START_RUN ||
      job.kind === OrchestrationJobKind.RESUME_GATE_1 ||
      job.kind === OrchestrationJobKind.RESUME_GATE_2 ||
      job.kind === OrchestrationJobKind.CONTROL ||
      job.kind === OrchestrationJobKind.SUPERVISOR_RECOVERY
    ) {
      const state = payload.state as DevFlowStateType | undefined;
      if (!state) {
        throw new Error(`Orchestration job ${job.id} has no rehydratable state payload.`);
      }
      const fromPhase = this.safeRunPhase(payload.fromPhase);
      const impls = payload.impls === 'simulation' ? this.simulationImpls : this.liveImpls;
      await this.driveRun(job.projectId, job.runId, state, fromPhase, impls);
      return;
    }

    throw new Error(`Unsupported orchestration job kind: ${job.kind}`);
  }

  private jobPayload(job: OrchestrationJob): Record<string, unknown> {
    return job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
      ? job.payload as Record<string, unknown>
      : {};
  }

  private safeRunPhase(value: unknown): RunPhase {
    return value === 'B' || value === 'C' ? value : 'A';
  }

  /**
   * Eve migration — drives the DevFlow pipeline via the OrchestrationSequencer (replaces
   * graph.stream). The sequencer executes phases A/B/C, persists the run-state snapshot to
   * OrchestrationRun.checkpointState after each node, pauses at gates, and reports a terminal
   * outcome. An AbortController is registered for the run's lifetime so `cancel`/`pause` can
   * interrupt between nodes; an aborted run is non-fatal (checkpoint is intact for resume).
   *
   * Fire-and-forget: callers do `void this.driveRun(...)` to return the runId immediately.
   */
  private async driveRun(
    projectId: string,
    runId: string,
    state: DevFlowStateType,
    fromPhase: RunPhase,
    impls: DevFlowNodeImpls,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    try {
      await this.prisma.orchestrationRun.updateMany({
        where: { runId, status: { in: [OrchestrationRunStatus.RUNNING, OrchestrationRunStatus.PAUSED] } },
        data: { status: OrchestrationRunStatus.RUNNING, lastHeartbeatAt: new Date() },
      });
      const outcome = await this.sequencer.run({
        impls,
        projectId,
        runId,
        state,
        fromPhase,
        signal: controller.signal,
      });

      if (outcome.kind === 'delivered') {
        await this.prisma.orchestrationRun
          .updateMany({
            where: { runId, status: OrchestrationRunStatus.RUNNING },
            data: { status: OrchestrationRunStatus.SUCCEEDED, completedAt: new Date(), lastHeartbeatAt: new Date() },
          })
          .catch(() => undefined);
      }
      // 'paused' (gate), 'aborted' (operator), and 'failed' (sequencer already recorded
      // project FAILED + run.error + run row) need no further bookkeeping here.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Run ${runId} for project ${projectId} encountered an error: ${message}`,
      );
      this.emitter?.runError(projectId, runId, {
        code: 'NODE_FAILED',
        severity: 'permanent',
        message,
      });
      await this.markRunFailed(runId, 'sequencer', message);
    } finally {
      if (this.activeRuns.get(runId) === controller) {
        this.activeRuns.delete(runId);
      }
    }
  }

  /** Loads the persisted run-state snapshot for a run, or null if none has been checkpointed. */
  private async loadCheckpointState(runId: string): Promise<DevFlowStateType | null> {
    const run = await this.prisma.orchestrationRun
      .findUnique({ where: { runId }, select: { checkpointState: true } })
      .catch(() => null);
    const raw = run?.checkpointState;
    if (!raw || typeof raw !== 'object') return null;
    return raw as unknown as DevFlowStateType;
  }

  /**
   * Starts a new graph run for a project.
   * Called by ProjectsService on POST /projects.
   * Returns the generated runId.
   */
  async startRun(
    projectId: string,
    brief: string,
    stackKey: string,
    companyName: string,
    actorId?: string,
    trigger: OrchestrationRunTrigger = OrchestrationRunTrigger.START,
    intakeContext?: IntakeContextPackage,
    designGuidance?: DesignGuidanceInput,
    modelSelection?: OrchestrationModelSelectionInput,
    runControls?: OrchestrationRunControlsInput,
  ): Promise<string> {
    const runId = createId();
    const normalizedDesignGuidance = normalizeDesignGuidance(designGuidance);
    const normalizedModelSelection = await this.modelCatalog.validateSelection(modelSelection);
    const modelSelectionSnapshot = {
      defaultModel: normalizedModelSelection.defaultModel,
      overrides: { ...normalizedModelSelection.overrides },
    } satisfies Prisma.InputJsonObject;
    this.agentProviderRegistry.getActiveProviderOrThrow();

    this.logger.log(
      `Starting run ${runId} for project ${projectId} (${companyName})`,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { runId },
    });

    const readyWorkOrders = await this.prisma.workOrder.count({
      where: {
        projectId,
        status: WorkOrderStatus.READY,
        instructions: { not: null },
      },
    });

    await this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId,
        providerMode: this.agentProviderMode(),
        trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: this.agentProviderMode() === 'mock'
          ? MOCK_NODE.LOAD_READY_WORK_ORDERS
          : 'parse_requirements',
        actorId: actorId ?? null,
        intakeSnapshotId: intakeContext?.intakeSnapshotId ?? null,
        readyWorkOrders,
        modelSelection: modelSelectionSnapshot,
      },
    });

    // Project-scoped budget counters are reset at run start until budgets become run-scoped.
    const budgetControls = {
      ...(typeof runControls?.tokenBudget === 'number'
        ? { tokenBudget: runControls.tokenBudget }
        : {}),
      ...(typeof runControls?.maxRetries === 'number'
        ? { maxRetries: runControls.maxRetries }
        : {}),
    };
    await this.prisma.runBudget.upsert({
      where: { projectId },
      update: {
        tokensConsumed: 0,
        retryCount: 0,
        ...budgetControls,
      },
      create: { projectId, ...budgetControls },
    }).catch(() => undefined);

    if (this.agentProviderMode() === 'mock') {
      this.runDispatcher.dispatch({
        label: 'mock_work_orders',
        projectId,
        runId,
        kind: OrchestrationJobKind.MOCK_WORK_ORDERS,
        payload: {
          state: {
            projectId,
            runId,
            trigger,
            actorId: actorId ?? null,
            readyWorkOrderIds: [],
            completedArtifactIds: [],
            failedWorkOrderIds: [],
            error: null,
          },
        } as unknown as Prisma.InputJsonValue,
        task: () => this.runMockWorkOrders({
          projectId,
          runId,
          trigger,
          actorId: actorId ?? null,
          readyWorkOrderIds: [],
          completedArtifactIds: [],
          failedWorkOrderIds: [],
          error: null,
        }),
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Mock orchestration run ${runId} for project ${projectId} failed: ${message}`,
          );
          return this.markRunFailed(runId, MOCK_NODE.FINALIZE, message);
        },
      });

      this.gateway?.emitStatusUpdate(
        projectId,
        ProjectStatus.GENERATING_CODE,
        MOCK_NODE.LOAD_READY_WORK_ORDERS,
      );

      return runId;
    }

    if (this.agentProviderMode() === 'simulation') {
      // Simulation runs the real pipeline with deterministic, event-rich nodes. Gate
      // approvals are pre-seeded so the run flows hands-free for UI testing (no human gate
      // steps, no LLM/GitHub access).
      const simulationState = createInitialDevFlowState({
        projectId,
        runId,
        brief: intakeContext?.canonicalBrief || brief,
        stackKey,
        companyName,
        intakeContext,
        designGuidance: normalizedDesignGuidance,
        gate1Approved: true,
        gate2Approved: true,
      });
      this.dispatchDriveRun(projectId, runId, simulationState, 'A', 'simulation', OrchestrationJobKind.START_RUN, 'simulation_run');
      this.gateway?.emitStatusUpdate(projectId, 'PARSING_REQUIREMENTS', 'parse_requirements');
      this.emitter?.runStatus(
        projectId,
        runId,
        ProjectStatus.PARSING_REQUIREMENTS,
        'parse_requirements',
      );
      return runId;
    }

    // The mobile agent is opt-in per project: it only joins the Gate 1 fan-out when the PM
    // provisioned a MOBILE repository, so backend+frontend projects spend no mobile tokens.
    const hasMobileRepo = (await this.prisma.repository
      .count({ where: { projectId, kind: RepositoryKind.MOBILE } })
      .catch(() => 0)) > 0;

    // Mint the run's repository capability. Agents read/write through the backend using this
    // token; scope is resolved from the DB, so it can only ever reach this project's repos.
    // Failing to mint is non-fatal — agents fall back to generating from the contract alone.
    const repoBranch = `run/${runId}`;
    let repoToken: string | null = null;
    // Repository tools live in the external Eve agent service. The in-process graph provider has
    // no tool-calling, so minting a token there would put "call read_repo_file" in a prompt for a
    // tool the model cannot invoke — it would hallucinate reads instead of failing loudly.
    // Both conditions must hold: the engine must be Eve AND the callback must be configured.
    const repoToolsAvailable =
      process.env.ORCHESTRATION_LLM_ENGINE === 'eve' && this.agentRepo.isEnabled();
    if (repoToolsAvailable) {
      repoToken = await this.agentRepo
        .mintSession({ runId, projectId, agentType: 'run', branch: repoBranch })
        .then((session) => session.token)
        .catch((error: unknown) => {
          this.logger.warn(
            `[${projectId}] Could not mint agent repository session: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
    }

    const initialState = createInitialDevFlowState({
      projectId,
      runId,
      brief: intakeContext?.canonicalBrief || brief,
      stackKey,
      companyName,
      intakeContext,
      hasMobileRepo,
      repoToken,
      repoBranch,
      designGuidance: normalizedDesignGuidance,
    });

    // Drive the pipeline via the dispatcher. Errors are handled inside driveRun
    // (run.error + markRunFailed); the dispatcher is a final safety net.
    this.dispatchDriveRun(projectId, runId, initialState, 'A', 'live', OrchestrationJobKind.START_RUN, 'live_run');

    // Notify subscribers that the graph has started and is parsing requirements.
    // Legacy event kept for back-compat; runGraph also emits typed run.status.
    this.gateway?.emitStatusUpdate(
      projectId,
      'PARSING_REQUIREMENTS',
      'parse_requirements',
    );
    this.emitter?.runStatus(
      projectId,
      runId,
      ProjectStatus.PARSING_REQUIREMENTS,
      'parse_requirements',
    );

    return runId;
  }

  /**
   * Called when the user approves or rejects Gate 1 (architecture review).
   *
   * Phase 2A memory write policy:
   *   REJECTED → write MISTAKE memory immediately
   *   APPROVED → no memory write yet (SKILL/PATTERN written only on Gate 2 approval)
   */
  async resumeGate1(
    projectId: string,
    approved: boolean,
    notes?: string,
    acceptOpenQuestions = false,
  ): Promise<void> {
    this.logger.log(
      `Resuming gate 1 for project ${projectId}: approved=${approved}`,
    );

    const runId = await this.getRunId(projectId);
    const state = await this.loadCheckpointState(runId);

    if (approved && state?.openQuestions?.length && !acceptOpenQuestions) {
      throw new BadRequestException(
        'This intake has unresolved requirement questions. Resolve them or set acceptOpenQuestions to true with an approval note.',
      );
    }

    if (approved) {
      const evidenceGap = describeEvidenceGap(state);
      if (evidenceGap) throw new BadRequestException(evidenceGap);
    }

    if (!approved) {
      await Promise.all([
        this.prisma.gateEvent.create({
          data: { projectId, gateType: 'ARCHITECTURE_REVIEW', decision: 'REJECTED', notes: notes ?? null },
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        }),
      ]);

      // Write mistake memory: contract that was rejected at Gate 1
      if (state?.contract) {
        await this.memory.writeMistake({
          agentType: 'contract',
          rejectedContent: JSON.stringify(state.contract, null, 2),
          rejectionNotes: notes ?? 'No reason provided',
          projectId,
          gateType: 'GATE_1',
          stackKey: state.stackKey ?? 'unknown',
          approvalSource: 'GATE_1',
        });
      }

      this.logger.log(`Gate 1 rejected for project ${projectId} — mistake recorded`);
      // Notify subscribers: gate rejection leads to FAILED state
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', 'gate_rejected', 'Gate 1 rejected');
      return;
    }

    await this.prisma.gateEvent.create({
      data: {
        projectId,
        gateType: 'ARCHITECTURE_REVIEW',
        decision: 'APPROVED',
        notes: notes ?? null,
      },
    });

    if (state?.contract) {
      await this.memory.writeProjectCoreMemory({
        projectId,
        agentType: 'project_core',
        memoryType: 'PATTERN',
        sourceType: 'gate_1_approved_contract',
        approvalSource: 'GATE_1',
        importance: 1,
        content: [
          'APPROVED ARCHITECTURE CONTRACT',
          `STACK: ${state.stackKey ?? 'unknown'}`,
          `PROJECT: ${state.contract.projectName}`,
          `DESCRIPTION: ${state.contract.description}`,
          `FILES: ${state.contract.fileManifest.join(', ')}`,
          `ACCEPTANCE: ${state.contract.acceptanceCriteria.join('; ')}`,
          notes ? `GATE NOTES: ${notes}` : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          stackKey: state.stackKey ?? 'unknown',
          gateType: 'ARCHITECTURE_REVIEW',
          projectType: state.contract.requirements.projectType,
          complexity: state.contract.requirements.complexity,
          fileCount: state.contract.fileManifest.length,
        },
      });
    }

    if (!state) {
      throw new Error(
        `Cannot resume gate 1 for project ${projectId}: no checkpointed run state for run ${runId}.`,
      );
    }
    const resumedState = applyDevFlowPartial(state, {
      gate1Approved: true,
      gate1Notes: [notes ?? '', state.openQuestions?.length && acceptOpenQuestions ? `Accepted open questions: ${state.openQuestions.join('; ')}` : ''].filter(Boolean).join('\n'),
    });

    // Notify subscribers that code generation has begun after Gate 1 approval
    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', 'gate_1_check');
    this.emitter?.runStatus(projectId, runId, ProjectStatus.GENERATING_CODE, 'gate_1_check');

    // Resume at phase B (code generation) with gate 1 now approved.
    this.dispatchDriveRun(projectId, runId, resumedState, 'B', 'live', OrchestrationJobKind.RESUME_GATE_1, 'resume_gate_1');
  }

  /**
   * Called when the user approves or rejects Gate 2 (code review).
   *
   * Phase 2A memory write policy:
   *   REJECTED → write MISTAKE memories for each artifact that failed
   *   APPROVED → write SKILL memories for all artifacts + PATTERN for the contract
   */
  async resumeGate2(
    projectId: string,
    approved: boolean,
    notes?: string,
  ): Promise<void> {
    this.logger.log(
      `Resuming gate 2 for project ${projectId}: approved=${approved}`,
    );

    const runId = await this.getRunId(projectId);
    const state = await this.loadCheckpointState(runId);

    if (!approved) {
      await Promise.all([
        this.prisma.gateEvent.create({
          data: { projectId, gateType: 'CODE_REVIEW', decision: 'REJECTED', notes: notes ?? null },
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        }),
      ]);

      // Write MISTAKE memory for each artifact that was rejected
      if (state?.artifacts?.length) {
        await Promise.allSettled(
          state.artifacts.map((artifact) =>
            this.memory.writeMistake({
              agentType: artifact.agentType,
              rejectedContent: `FILE: ${artifact.filePath}\n\n${artifact.content}`,
              rejectionNotes: notes ?? 'No reason provided',
            projectId,
            gateType: 'GATE_2',
            stackKey: state.stackKey ?? 'unknown',
            approvalSource: 'GATE_2',
          }),
        ),
      );
        this.logger.log(
          `Gate 2 rejected: ${state.artifacts.length} mistake memories written for project ${projectId}`,
        );
      }

      // Notify subscribers: gate rejection leads to FAILED state
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', 'gate_rejected', 'Gate 2 rejected');
      return;
    }

    if (this.agentProviderMode() === 'llm') {
      const githubDelivery = this.github.getDeliveryStatus();
      if (!githubDelivery.available) {
        throw new Error(
          githubDelivery.reason ??
            'GitHub delivery is not configured for Gate 2 repository delivery.',
        );
      }
    }

    // Gate 2 APPROVED — write SKILL + PATTERN memories
    await this.prisma.gateEvent.create({
      data: {
        projectId,
        gateType: 'CODE_REVIEW',
        decision: 'APPROVED',
        notes: notes ?? null,
      },
    });

    if (state?.artifacts?.length && state?.contract) {
      const projectType = state.contract.requirements.projectType;
      const stackKey = state.stackKey ?? 'unknown';

      // SKILL: one memory per artifact
      await Promise.allSettled(
        state.artifacts.map((artifact) =>
          this.memory.writeSkill({
            agentType: artifact.agentType,
            systemPrompt: '',
            artifactContent: artifact.content,
            filePath: artifact.filePath,
            projectId,
            stackKey,
            projectType,
            approvalSource: 'GATE_2',
            sourceType: 'gate_2_approved_artifact',
          }),
        ),
      );

      // PATTERN: one memory for the successful contract
      await this.memory.writePattern({
        contract: state.contract,
        projectId,
        stackKey,
        approvalSource: 'GATE_2',
        sourceType: 'gate_2_approved_contract_pattern',
      });

      await this.memory.writeProjectCoreMemory({
        projectId,
        agentType: 'project_core',
        memoryType: 'PATTERN',
        sourceType: 'gate_2_approved_delivery',
        approvalSource: 'GATE_2',
        importance: 1,
        content: [
          'APPROVED DELIVERY MEMORY',
          `STACK: ${stackKey}`,
          `PROJECT TYPE: ${projectType}`,
          `ARTIFACTS: ${state.artifacts.map((artifact) => `${artifact.agentType}:${artifact.filePath}`).join(', ')}`,
          `ACCEPTANCE: ${state.contract.acceptanceCriteria.join('; ')}`,
          notes ? `GATE NOTES: ${notes}` : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          stackKey,
          gateType: 'CODE_REVIEW',
          projectType,
          artifactCount: state.artifacts.length,
          artifactFiles: state.artifacts.map((artifact) => artifact.filePath),
        },
      });

      this.logger.log(
        `Gate 2 approved: ${state.artifacts.length} skill memories + 1 pattern + project core memory written for project ${projectId}`,
      );
    }

    if (!state) {
      throw new Error(
        `Cannot resume gate 2 for project ${projectId}: no checkpointed run state for run ${runId}.`,
      );
    }
    const resumedState = applyDevFlowPartial(state, {
      gate2Approved: true,
      gate2Notes: notes ?? '',
    });

    // Notify subscribers that commit phase has begun after Gate 2 approval
    this.gateway?.emitStatusUpdate(projectId, 'COMMITTING', 'gate_2_check');
    this.emitter?.runStatus(projectId, runId, ProjectStatus.COMMITTING, 'gate_2_check');

    // Resume at phase C (commit → delivered) with gate 2 now approved.
    this.dispatchDriveRun(projectId, runId, resumedState, 'C', 'live', OrchestrationJobKind.RESUME_GATE_2, 'resume_gate_2');
  }

  private dispatchDriveRun(
    projectId: string,
    runId: string,
    state: DevFlowStateType,
    fromPhase: RunPhase,
    impls: 'live' | 'simulation',
    kind: OrchestrationJobKind,
    label: string,
  ): void {
    this.runDispatcher.dispatch({
      label,
      projectId,
      runId,
      kind,
      payload: { state, fromPhase, impls } as unknown as Prisma.InputJsonValue,
      task: () => this.driveRun(
        projectId,
        runId,
        state,
        fromPhase,
        impls === 'simulation' ? this.simulationImpls : this.liveImpls,
      ),
      onError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return this.markRunFailed(runId, label, message);
      },
    });
  }

  /**
   * Returns a combined status from the latest checkpoint + DB project row.
   */
  async getStatus(projectId: string): Promise<OrchestrationStatus> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, runId: true },
    });

    if (!project?.runId) {
      return {
        status: project?.status ?? 'UNKNOWN',
        currentNode: 'none',
        retryCount: 0,
        error: null,
      };
    }

    try {
      const run = await this.prisma.orchestrationRun.findUnique({
        where: { runId: project.runId },
        select: { currentNode: true, checkpointState: true },
      });

      const channelValues =
        run?.checkpointState && typeof run.checkpointState === 'object'
          ? (run.checkpointState as unknown as DevFlowStateType)
          : null;

      const rawError = channelValues?.error ?? null;
      const publicError = rawError?.startsWith('RETRY:') ? null : rawError;

      return {
        status: project.status,
        currentNode: run?.currentNode ?? 'none',
        retryCount: channelValues?.retryCount ?? 0,
        error: publicError,
        ...(channelValues?.contract ? { contract: channelValues.contract } : {}),
      };
    } catch {
      return {
        status: project.status,
        currentNode: 'unknown',
        retryCount: 0,
        error: null,
      };
    }
  }

  async executeWorkOrder(
    projectId: string,
    workOrderId: string,
    actorId?: string,
    options: WorkOrderExecutionOptions = {},
  ): Promise<WorkOrderExecutionResult> {
    const executionRunId = createId();
    const startedAt = new Date();
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId },
      include: {
        project: {
          select: {
            id: true,
            companyName: true,
            brief: true,
            stackKey: true,
          },
        },
        task: {
          select: {
            id: true,
            title: true,
            description: true,
            assignedToId: true,
            status: true,
          },
        },
        artifact: {
          select: {
            id: true,
            filePath: true,
            displayName: true,
            content: true,
          },
        },
        workspaceAgent: {
          select: { id: true, key: true, runtimeKey: true, name: true, instructions: true },
        },
      },
    });

    if (!workOrder) {
      throw new Error(`Work order ${workOrderId} not found`);
    }

    this.assertWorkOrderExecutable(workOrder, options);

    const provider = this.agentProviderRegistry.getActiveProviderOrThrow();
    const attempt = workOrder.executionAttempt + 1;
    const nodeName = this.workOrderNodeName(workOrder.agentType);
    const contractMetadata = this.workOrderContractMetadata(workOrder.agentType);
    const orchestrationRun = await this.findOrCreateWorkOrderRun(projectId, {
      runId: options.parentRunId ?? executionRunId,
      executionRunId,
      trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
      actorId,
      currentNode: nodeName,
    });

    const executionClaim = await this.prisma.workOrder.updateMany({
      where: {
        id: workOrderId,
        projectId,
        OR: [
          { status: WorkOrderStatus.READY },
          { status: WorkOrderStatus.DISPATCHED, executionRunId: null, executionStartedAt: null },
          ...(options.allowFailedRetry ? [{ status: WorkOrderStatus.FAILED }] : []),
        ],
      },
      data: {
        status: WorkOrderStatus.DISPATCHED,
        dispatchedAt: workOrder.dispatchedAt ?? startedAt,
        executionRunId,
        executionAttempt: attempt,
        executionStartedAt: startedAt,
        executionCompletedAt: null,
        executionError: null,
        lastEventAt: startedAt,
      },
    });

    if (executionClaim.count !== 1) {
      throw new Error(`Work order ${workOrderId} was already claimed for execution`);
    }

    await this.prisma.workOrderExecution.create({
      data: {
        projectId,
        orchestrationRunId: orchestrationRun.id,
        workOrderId,
        executionRunId,
        attempt,
        agentType: workOrder.agentType,
        status: WorkOrderExecutionStatus.RUNNING,
        startedAt,
        metadata: {
          trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
          sourceArtifactId: workOrder.artifactId,
          providerMode: this.agentProviderMode(),
          requestedProviderMode: this.requestedAgentProviderMode(),
          contract: contractMetadata,
        },
      },
    });

    await this.updateRunProgress(orchestrationRun.id, {
      currentNode: nodeName,
      status: OrchestrationRunStatus.RUNNING,
    });

    if (options.emitLifecycleEvents) {
      await Promise.all([
        this.recordWorkOrderTimelineEvent(projectId, actorId, {
          type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
          taskId: workOrder.taskId,
          artifactId: workOrder.artifactId,
          title: 'Work order dispatched',
          body: workOrder.title,
          metadata: {
            workOrderId,
            executionRunId,
            attempt,
            agentType: workOrder.agentType,
          },
        }),
        this.notifyWorkOrderLifecycle(projectId, actorId, workOrder, {
          type: NotificationType.WORK_ORDER_DISPATCHED,
          title: 'Work order dispatched',
          status: WorkOrderStatus.DISPATCHED,
          executionRunId,
        }),
      ]);
    }

    await this.prisma.eventLog.create({
      data: {
        projectId,
        nodeName,
        eventType: 'STARTED',
        costMeta: {
          workOrderId,
          executionRunId,
          attempt,
          agentType: workOrder.agentType,
          providerMode: this.agentProviderMode(),
          requestedProviderMode: this.requestedAgentProviderMode(),
          contract: contractMetadata,
        },
        runTokens: 0,
        occurredAt: startedAt,
      },
    });

    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', nodeName);
    this.streamEmitter?.progress(projectId, nodeName, executionRunId, 12, 'Preparing work-order prompt');
    this.streamEmitter?.emit(
      projectId,
      nodeName,
      executionRunId,
      'decision',
      `Dispatching ${workOrder.agentType.toLowerCase()} agent for ${workOrder.title}.`,
      { workOrderId, attempt, agentType: workOrder.agentType },
    );

    try {
      const completedAt = new Date();
      let streamedTokens = 0;
      const onToken = this.streamEmitter
        ? (delta: string) => {
            streamedTokens += 1;
            if (streamedTokens === 1) {
              this.streamEmitter?.progress(projectId, nodeName, executionRunId, 35, 'Streaming model output');
            }
            this.streamEmitter?.emit(
              projectId,
              nodeName,
              executionRunId,
              'token',
              delta,
              { workOrderId, agentType: workOrder.agentType },
            );
          }
        : undefined;
      // The assigned agent's own instructions plus its attached skills, or the built-in when it
      // has none. Resolved here rather than in the provider so every provider — direct, Eve or
      // mock — receives the same already-resolved text.
      const agentProfile = workOrder.workspaceAgent
        ? {
            key: workOrder.workspaceAgent.key,
            runtimeKey: resolveRuntimeKey(workOrder.workspaceAgent),
            name: workOrder.workspaceAgent.name,
            instructions: await resolveAgentSystemPrompt(
              this.prisma,
              projectId,
              workOrder.workspaceAgent.key,
              workOrder.workspaceAgent.instructions?.trim()
                || `You are ${workOrder.workspaceAgent.name}, a DevFlow implementation agent.`,
            ),
          }
        : undefined;

      const agentContext = {
        project: workOrder.project,
        workOrder: {
          id: workOrder.id,
          title: workOrder.title,
          instructions: workOrder.instructions,
          agentType: workOrder.agentType,
          priority: workOrder.priority,
        },
        task: workOrder.task,
        sourceArtifact: workOrder.artifact,
        executionRunId,
        ...(agentProfile ? { agentProfile } : {}),
        ...(onToken ? { onToken } : {}),
      };
      const output = await provider.generateWorkOrderOutput(agentContext);
      this.streamEmitter?.flushAll(projectId);
      this.streamEmitter?.progress(projectId, nodeName, executionRunId, 76, 'Validating generated artifact');
      this.streamEmitter?.emit(
        projectId,
        nodeName,
        executionRunId,
        'decision',
        `Generated ${output.displayName}; validating contract and required signals.`,
        { workOrderId, filePath: output.filePath, language: output.language },
      );
      const validation = this.outputValidation.validate(output, agentContext);

      if (!validation.valid) {
        throw new Error(`Output validation failed: ${validation.errors.map(e => e.message).join('; ')}`);
      }

      const artifact = await this.prisma.artifact.create({
        data: {
          projectId,
          agentType: workOrder.agentType.toLowerCase(),
          filePath: output.filePath,
          displayName: output.displayName,
          content: output.content,
          clientVisible: false,
          validationStatus: ArtifactValidationStatus.PASSED,
          validationSummary: validation.summary,
          validationErrors: validation.errors as unknown as Prisma.InputJsonValue,
        },
      });

      const completionClaim = await this.prisma.workOrder.updateMany({
        where: { id: workOrderId, projectId, status: WorkOrderStatus.DISPATCHED, executionRunId },
        data: {
          status: WorkOrderStatus.COMPLETED,
          artifactId: artifact.id,
          completedAt,
          failedAt: null,
          executionCompletedAt: completedAt,
          executionError: null,
          lastEventAt: completedAt,
        },
      });

      if (completionClaim.count !== 1) {
        throw new Error(`Work order ${workOrderId} is no longer owned by execution ${executionRunId}`);
      }

      if (workOrder.taskId) {
        await this.prisma.projectTask.update({
          where: { id: workOrder.taskId },
          data: { status: ProjectTaskStatus.IN_REVIEW, artifactId: artifact.id },
        });

        await this.prisma.projectTaskActivity.create({
          data: {
            projectId,
            taskId: workOrder.taskId,
            actorId,
            type: ProjectTaskActivityType.ARTIFACT_CHANGED,
            message: 'Work order execution produced an artifact',
            metadata: {
              workOrderId,
              executionRunId,
              artifactId: artifact.id,
            },
          },
        });
      }

      await this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'COMPLETED',
          costMeta: {
            workOrderId,
            executionRunId,
            attempt,
            artifactId: artifact.id,
            agentType: workOrder.agentType,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            contract: contractMetadata,
            output: {
              filePath: output.filePath,
              language: output.language,
              metadata: output.metadata ?? {},
            },
            validation: {
              summary: validation.summary,
              errors: validation.errors as unknown as Prisma.InputJsonValue,
            } satisfies Prisma.InputJsonValue,
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      });

      await Promise.all([
        this.prisma.workOrderExecution.update({
          where: { executionRunId },
          data: {
            status: WorkOrderExecutionStatus.SUCCEEDED,
            artifactId: artifact.id,
            completedAt,
            metadata: {
              trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
              sourceArtifactId: workOrder.artifactId,
              providerMode: this.agentProviderMode(),
              requestedProviderMode: this.requestedAgentProviderMode(),
              contract: contractMetadata,
              output: {
                filePath: output.filePath,
                language: output.language,
                metadata: output.metadata ?? {},
              },
              validation: {
                summary: validation.summary,
                errors: validation.errors as unknown as Prisma.InputJsonValue,
              } satisfies Prisma.InputJsonValue,
            },
          },
        }),
        this.incrementRunCompletion(orchestrationRun.id, {
          artifactId: artifact.id,
          currentNode: nodeName,
          completeRun: !options.parentRunId,
        }),
      ]);

      if (options.emitLifecycleEvents) {
        await Promise.all([
          this.recordWorkOrderTimelineEvent(projectId, actorId, {
            type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
            taskId: workOrder.taskId,
            artifactId: artifact.id,
            title: 'Work order execution completed',
            body: workOrder.title,
            metadata: {
              workOrderId,
              from: WorkOrderStatus.DISPATCHED,
              to: WorkOrderStatus.COMPLETED,
              executionRunId,
              artifactId: artifact.id,
            },
          }),
          this.notifyWorkOrderLifecycle(projectId, actorId, workOrder, {
            type: NotificationType.WORK_ORDER_STATUS_CHANGED,
            title: 'Work order completed',
            status: WorkOrderStatus.COMPLETED,
            executionRunId,
            artifactId: artifact.id,
          }),
        ]);
      }

      this.streamEmitter?.progress(projectId, nodeName, executionRunId, 100, 'Artifact ready for review');
      this.streamEmitter?.emit(
        projectId,
        nodeName,
        executionRunId,
        'decision',
        `Artifact saved: ${artifact.filePath}.`,
        { workOrderId, artifactId: artifact.id },
      );
      this.streamEmitter?.flushAll(projectId);
      this.gateway?.emitStatusUpdate(projectId, 'AWAITING_GATE_2', nodeName);
      return { executionRunId, artifactId: artifact.id };
    } catch (error) {
      const failedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      this.streamEmitter?.emit(
        projectId,
        nodeName,
        executionRunId,
        'error',
        message,
        { workOrderId, attempt, agentType: workOrder.agentType },
      );
      this.streamEmitter?.flushAll(projectId);
      await this.prisma.workOrder.updateMany({
        where: { id: workOrderId, projectId, status: WorkOrderStatus.DISPATCHED, executionRunId },
        data: {
          status: WorkOrderStatus.FAILED,
          failedAt,
          executionError: message,
          lastEventAt: failedAt,
        },
      });
      await this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'FAILED',
          costMeta: {
            workOrderId,
            executionRunId,
            attempt,
            agentType: workOrder.agentType,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            contract: contractMetadata,
            error: message,
          },
          runTokens: 0,
          occurredAt: failedAt,
        },
      });
      await Promise.all([
        this.prisma.workOrderExecution.update({
          where: { executionRunId },
          data: {
            status: WorkOrderExecutionStatus.FAILED,
            error: message,
            completedAt: failedAt,
            metadata: {
              trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
              sourceArtifactId: workOrder.artifactId,
              providerMode: this.agentProviderMode(),
              requestedProviderMode: this.requestedAgentProviderMode(),
              contract: contractMetadata,
              error: message,
            },
          },
        }),
        this.incrementRunFailure(orchestrationRun.id, {
          error: message,
          currentNode: nodeName,
          completeRun: !options.parentRunId,
        }),
      ]);
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', nodeName, message);
      throw error;
    }
  }

  async recoverStaleProject(
    projectId: string,
    options: SupervisorRecoveryOptions,
  ): Promise<SupervisorRecoveryResult> {
    const runId = createId();
    const startedAt = new Date();
    const trigger = OrchestrationRunTrigger.RERUN_READY_WORK_ORDERS;
    const readyWorkOrders = await this.prisma.workOrder.findMany({
      where: {
        projectId,
        status: WorkOrderStatus.READY,
        instructions: { not: null },
      },
      select: { id: true, instructions: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    const readyWorkOrderIds = readyWorkOrders
      .filter((workOrder) => workOrder.instructions?.trim())
      .map((workOrder) => workOrder.id);

    await this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId,
        providerMode: this.agentProviderMode(),
        trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: SUPERVISOR_RECOVERY_NODE,
        actorId: null,
        readyWorkOrders: readyWorkOrderIds.length,
      },
    });

    await Promise.all([
      this.prisma.project.update({
        where: { id: projectId },
        data: { runId, status: ProjectStatus.GENERATING_CODE },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName: SUPERVISOR_RECOVERY_NODE,
          eventType: 'STARTED',
          costMeta: {
            runId,
            trigger,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            readyWorkOrderIds,
          },
          runTokens: 0,
          occurredAt: startedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: null,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: 'Supervisor recovery started',
          body: `${readyWorkOrderIds.length} ready work order${readyWorkOrderIds.length === 1 ? '' : 's'} queued for automatic recovery.`,
          metadata: {
            runId,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            readyWorkOrderIds,
          },
        },
      }),
    ]);

    this.gateway?.emitStatusUpdate(
      projectId,
      ProjectStatus.GENERATING_CODE,
      SUPERVISOR_RECOVERY_NODE,
    );

    const completedArtifactIds: string[] = [];
    const failedWorkOrderIds: string[] = [];
    let error: string | null = null;

    if (readyWorkOrderIds.length === 0) {
      error = 'Supervisor recovery found no READY work orders with instructions.';
    }

    for (const workOrderId of readyWorkOrderIds) {
      try {
        const result = await this.executeWorkOrder(
          projectId,
          workOrderId,
          undefined,
          {
            emitLifecycleEvents: true,
            parentRunId: runId,
            trigger,
          },
        );
        completedArtifactIds.push(result.artifactId);
      } catch (err) {
        failedWorkOrderIds.push(workOrderId);
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const failed = Boolean(error) || failedWorkOrderIds.length > 0;
    const completedAt = new Date();
    const status = failed
      ? OrchestrationRunStatus.FAILED
      : OrchestrationRunStatus.SUCCEEDED;
    const projectStatus = failed
      ? ProjectStatus.FAILED
      : ProjectStatus.AWAITING_GATE_2;
    const body = failed
      ? error
      : `${completedArtifactIds.length} recovered artifact${completedArtifactIds.length === 1 ? '' : 's'} ready for PM output review.`;

    await Promise.all([
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: projectStatus },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName: SUPERVISOR_RECOVERY_NODE,
          eventType: failed ? 'FAILED' : 'COMPLETED',
          costMeta: {
            runId,
            trigger,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            readyWorkOrderIds,
            completedArtifactIds,
            failedWorkOrderIds,
            error,
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: null,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: failed
            ? 'Supervisor recovery failed'
            : 'Supervisor recovery completed',
          body,
          metadata: {
            runId,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            readyWorkOrderIds,
            completedArtifactIds,
            failedWorkOrderIds,
            error,
          },
        },
      }),
      this.prisma.orchestrationRun.updateMany({
        where: { projectId, runId },
        data: {
          status,
          currentNode: SUPERVISOR_RECOVERY_NODE,
          error,
          completedWorkOrders: completedArtifactIds.length,
          failedWorkOrders: failedWorkOrderIds.length,
          completedArtifacts: completedArtifactIds.length,
          completedAt,
        },
      }),
    ]);

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(projectId),
      actorId: null,
      projectId,
      type: NotificationType.WORK_ORDER_STATUS_CHANGED,
      title: failed
        ? 'Supervisor recovery failed'
        : 'Supervisor recovery completed',
      body,
      metadata: {
        runId,
        reason: options.reason,
        retryAttempt: options.retryAttempt,
        maxRetries: options.maxRetries,
        completedArtifacts: completedArtifactIds.length,
        failedWorkOrders: failedWorkOrderIds.length,
      },
    });

    this.gateway?.emitStatusUpdate(
      projectId,
      projectStatus,
      SUPERVISOR_RECOVERY_NODE,
      error ?? undefined,
    );

    return {
      runId,
      readyWorkOrders: readyWorkOrderIds.length,
      completedWorkOrders: completedArtifactIds.length,
      failedWorkOrders: failedWorkOrderIds.length,
      status,
      error,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Eve migration — the mock work-order pipeline, ported from a LangGraph StateGraph to a plain
   * sequential method: load READY work orders → execute each → finalize. Behavior (status
   * writes, event logs, timeline events, notifications, run-row updates) is unchanged.
   */
  private async runMockWorkOrders(state: MockWorkOrderState): Promise<void> {
    // ── load_ready_work_orders ──
    const readyWorkOrders = await this.prisma.workOrder.findMany({
      where: { projectId: state.projectId, status: WorkOrderStatus.READY },
      select: { id: true, instructions: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    state.readyWorkOrderIds = readyWorkOrders
      .filter((workOrder) => workOrder.instructions?.trim())
      .map((workOrder) => workOrder.id);

    if (state.readyWorkOrderIds.length === 0) {
      state.error = 'No READY work orders with instructions are available for orchestration.';
    } else {
      const startedAt = new Date();
      await Promise.all([
        this.prisma.project.update({
          where: { id: state.projectId },
          data: { status: ProjectStatus.GENERATING_CODE },
        }),
        this.prisma.eventLog.create({
          data: {
            projectId: state.projectId,
            nodeName: MOCK_NODE.LOAD_READY_WORK_ORDERS,
            eventType: 'STARTED',
            costMeta: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              workOrderCount: state.readyWorkOrderIds.length,
            },
            runTokens: 0,
            occurredAt: startedAt,
          },
        }),
        this.prisma.projectTimelineEvent.create({
          data: {
            projectId: state.projectId,
            actorId: state.actorId,
            type: ProjectTimelineEventType.PROJECT_UPDATED,
            visibility: ProjectTimelineVisibility.TEAM,
            title: 'Orchestration started',
            body: `${state.readyWorkOrderIds.length} ready work order${state.readyWorkOrderIds.length === 1 ? '' : 's'} queued for mock agent execution.`,
            metadata: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              readyWorkOrderIds: state.readyWorkOrderIds,
            },
          },
        }),
      ]);
    }

    // ── execute_ready_work_orders ──
    if (!state.error) {
      for (const workOrderId of state.readyWorkOrderIds) {
        try {
          const result = await this.executeWorkOrder(
            state.projectId,
            workOrderId,
            state.actorId ?? undefined,
            {
              emitLifecycleEvents: true,
              parentRunId: state.runId,
              trigger: state.trigger,
            },
          );
          state.completedArtifactIds.push(result.artifactId);
        } catch {
          state.failedWorkOrderIds.push(workOrderId);
        }
      }
      if (state.failedWorkOrderIds.length > 0) {
        state.error = `${state.failedWorkOrderIds.length} work order execution${state.failedWorkOrderIds.length === 1 ? '' : 's'} failed.`;
      }
    }

    // ── finalize_mock_orchestration ──
    const failed = Boolean(state.error) || state.failedWorkOrderIds.length > 0;
    const completedAt = new Date();
    const status = failed ? ProjectStatus.FAILED : ProjectStatus.AWAITING_GATE_2;
    const title = failed ? 'Orchestration failed' : 'Orchestration outputs ready';
    const body = failed
      ? state.error
      : `${state.completedArtifactIds.length} artifact${state.completedArtifactIds.length === 1 ? '' : 's'} ready for PM output review.`;

    await Promise.all([
      this.prisma.project.update({
        where: { id: state.projectId },
        data: { status },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId: state.projectId,
          nodeName: MOCK_NODE.FINALIZE,
          eventType: failed ? 'FAILED' : 'COMPLETED',
          costMeta: {
            provider: this.agentProviderMode(),
            runId: state.runId,
            completedArtifactIds: state.completedArtifactIds,
            failedWorkOrderIds: state.failedWorkOrderIds,
            error: state.error,
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId: state.projectId,
          actorId: state.actorId,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title,
          body,
          metadata: {
            provider: this.agentProviderMode(),
            runId: state.runId,
            completedArtifactIds: state.completedArtifactIds,
            failedWorkOrderIds: state.failedWorkOrderIds,
          },
        },
      }),
      this.prisma.orchestrationRun.updateMany({
        where: { projectId: state.projectId, runId: state.runId },
        data: {
          status: failed ? OrchestrationRunStatus.FAILED : OrchestrationRunStatus.SUCCEEDED,
          currentNode: MOCK_NODE.FINALIZE,
          error: failed ? state.error : null,
          completedWorkOrders: state.completedArtifactIds.length,
          failedWorkOrders: state.failedWorkOrderIds.length,
          completedArtifacts: state.completedArtifactIds.length,
          completedAt,
        },
      }),
    ]);

    if (!failed) {
      await this.notifications.notify({
        recipientIds: await this.notifications.projectManagers(state.projectId),
        actorId: state.actorId,
        projectId: state.projectId,
        type: NotificationType.WORK_ORDER_STATUS_CHANGED,
        title: 'Orchestration outputs ready',
        body,
        metadata: {
          provider: this.agentProviderMode(),
          runId: state.runId,
          artifactCount: state.completedArtifactIds.length,
        },
      });
    }

    this.gateway?.emitStatusUpdate(
      state.projectId,
      status,
      MOCK_NODE.FINALIZE,
      state.error ?? undefined,
    );
  }

  private assertWorkOrderExecutable(
    workOrder: {
      id: string;
      status: WorkOrderStatus;
      instructions: string | null;
      executionRunId: string | null;
      executionStartedAt: Date | null;
    },
    options: WorkOrderExecutionOptions,
  ): void {
    const isReady = workOrder.status === WorkOrderStatus.READY;
    const isFreshManualDispatch =
      workOrder.status === WorkOrderStatus.DISPATCHED &&
      !workOrder.executionRunId &&
      !workOrder.executionStartedAt;
    const isAllowedFailedRetry =
      options.allowFailedRetry === true &&
      workOrder.status === WorkOrderStatus.FAILED;

    if (!isReady && !isFreshManualDispatch && !isAllowedFailedRetry) {
      throw new Error(
        `Work order ${workOrder.id} must be READY before agent execution`,
      );
    }

    if (!workOrder.instructions?.trim()) {
      throw new Error(
        `Work order ${workOrder.id} needs instructions before agent execution`,
      );
    }
  }

  private workOrderContractMetadata(
    agentType: WorkOrderAgentType,
  ): Prisma.InputJsonObject {
    const contract = agentArtifactContractFor(agentType);
    return {
      version: ORCHESTRATION_CONTRACT_VERSION,
      agentType,
      agentSlug: contract.slug,
      nodeName: contract.nodeName,
      requiredExtensions: contract.requiredExtensions,
      requiredSignals: contract.requiredSignals,
      handoffChecklist: contract.handoffChecklist,
    };
  }

  private agentProviderMode(): AgentProviderMode {
    return this.agentProviderRegistry.activeMode();
  }

  private requestedAgentProviderMode(): AgentProviderMode {
    return this.agentProviderRegistry.requestedMode();
  }

  // ─── Mid-run control (Phase 2) ────────────────────────────────────────────

  /**
   * Whether a project is currently paused (or otherwise manually halted) via the
   * control API. The supervisor calls this to give manual intervention
   * precedence over automatic stuck-run recovery.
   */
  isManuallyHalted(projectId: string): boolean {
    return this.pausedRuns.has(projectId);
  }

  /**
   * Mid-run control entry point. Routes a control action to its handler. Built
   * on the same primitives as gate resume — graph.updateState() + re-stream via
   * runGraph(), plus the per-run AbortController for pause/cancel.
   */
  async control(
    projectId: string,
    action: OrchestrationControlAction,
    options: OrchestrationControlOptions = {},
  ): Promise<OrchestrationControlResult> {
    const runId = await this.getRunId(projectId);
    this.logger.log(`Control '${action}' for project ${projectId} (run ${runId})`);

    switch (action) {
      case 'cancel':
        return this.cancelRun(projectId, runId, options.actorId);
      case 'pause':
        return this.pauseRun(projectId, runId);
      case 'resume':
        return this.resumeRun(projectId, runId);
      case 'retry_node':
        return this.retryNode(projectId, runId, options.nodeId);
      case 'skip_node':
        return this.skipNode(projectId, runId, options.nodeId);
      case 'modify_params':
        return this.modifyParams(projectId, runId, options.params);
      default:
        throw new BadRequestException(`Unknown control action: ${String(action)}`);
    }
  }

  private async cancelRun(
    projectId: string,
    runId: string,
    actorId?: string,
  ): Promise<OrchestrationControlResult> {
    this.activeRuns.get(runId)?.abort();
    this.activeRuns.delete(runId);
    this.pausedRuns.delete(projectId);

    const now = new Date();
    const reason = `Cancelled${actorId ? ` by ${actorId}` : ''}`;
    await Promise.allSettled([
      this.prisma.orchestrationRun.updateMany({
        where: { runId, status: OrchestrationRunStatus.RUNNING },
        data: { status: OrchestrationRunStatus.CANCELLED, error: reason, completedAt: now },
      }),
      // ProjectStatus has no CANCELLED — FAILED is the terminal state that
      // excludes the project from supervisor auto-recovery.
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.FAILED },
      }),
      this.prisma.workOrder.updateMany({
        where: { projectId, status: WorkOrderStatus.DISPATCHED },
        data: { status: WorkOrderStatus.CANCELLED, executionCompletedAt: now, lastEventAt: now },
      }),
      this.prisma.orchestrationJob.updateMany({
        where: { runId, status: { in: [OrchestrationJobStatus.PENDING, OrchestrationJobStatus.RUNNING] } },
        data: { status: OrchestrationJobStatus.CANCELLED, completedAt: now, lockedBy: null, lockedUntil: null },
      }),
    ]);

    this.emitter?.runStatus(projectId, runId, 'CANCELLED', 'cancelled');
    this.emitter?.runError(projectId, runId, {
      code: 'CANCELLED',
      severity: 'permanent',
      message: reason,
    });

    return { accepted: true, action: 'cancel', status: 'CANCELLED' };
  }

  private async pauseRun(
    projectId: string,
    runId: string,
  ): Promise<OrchestrationControlResult> {
    this.pausedRuns.add(projectId);
    // Abort the in-flight run. The sequencer persists the checkpoint after each node and only
    // checks the abort signal between nodes, so at most the in-flight node is lost; resume
    // re-enters from the persisted checkpoint. driveRun treats the abort as non-fatal.
    this.activeRuns.get(runId)?.abort();
    this.activeRuns.delete(runId);

    await Promise.allSettled([
      this.prisma.orchestrationRun.updateMany({
        where: { runId, status: OrchestrationRunStatus.RUNNING },
        data: { status: OrchestrationRunStatus.PAUSED, currentNode: 'paused', lastHeartbeatAt: new Date() },
      }),
      this.prisma.orchestrationJob.updateMany({
        where: { runId, status: OrchestrationJobStatus.PENDING },
        data: { availableAt: new Date(Date.now() + 60_000), lastError: 'Paused by operator' },
      }),
    ]);

    this.emitter?.runStatus(projectId, runId, 'PAUSED', 'paused');
    return { accepted: true, action: 'pause', status: 'PAUSED' };
  }

  private async resumeRun(
    projectId: string,
    runId: string,
  ): Promise<OrchestrationControlResult> {
    const run = await this.prisma.orchestrationRun.findUnique({
      where: { runId },
      select: { status: true },
    });
    if (run?.status === OrchestrationRunStatus.CANCELLED) {
      throw new BadRequestException('Run was cancelled and cannot be resumed');
    }

    const state = await this.loadCheckpointState(runId);
    if (!state) {
      throw new BadRequestException('Run has no checkpointed state and cannot be resumed');
    }

    this.pausedRuns.delete(projectId);
    this.emitter?.runStatus(projectId, runId, ProjectStatus.GENERATING_CODE, 'resumed');
    await this.prisma.orchestrationRun.updateMany({
      where: { runId, status: OrchestrationRunStatus.PAUSED },
      data: { status: OrchestrationRunStatus.RUNNING, error: null, completedAt: null },
    });
    this.dispatchDriveRun(
      projectId,
      runId,
      state,
      OrchestrationSequencer.phaseFromState(state),
      'live',
      OrchestrationJobKind.CONTROL,
      'control_resume',
    );
    return { accepted: true, action: 'resume', status: 'RUNNING' };
  }

  private async retryNode(
    projectId: string,
    runId: string,
    nodeId?: string,
  ): Promise<OrchestrationControlResult> {
    // Clear the error and reset the retry counter, then re-enter the run from the phase implied
    // by its gate approvals. Precise per-node re-routing remains future work (the sequencer
    // re-runs the phase, not a single node).
    const state = await this.loadCheckpointState(runId);
    if (!state) {
      throw new BadRequestException('Run has no checkpointed state and cannot be retried');
    }
    const resumed = applyDevFlowPartial(state, { error: null, retryCount: 0 });
    await this.prisma.orchestrationRun.updateMany({
      where: { runId },
      data: { status: OrchestrationRunStatus.RUNNING, error: null, completedAt: null },
    });

    this.pausedRuns.delete(projectId);
    this.emitter?.runStatus(
      projectId,
      runId,
      ProjectStatus.GENERATING_CODE,
      nodeId ?? 'retry',
    );
    this.dispatchDriveRun(
      projectId,
      runId,
      resumed,
      OrchestrationSequencer.phaseFromState(resumed),
      'live',
      OrchestrationJobKind.CONTROL,
      'control_retry_node',
    );
    return { accepted: true, action: 'retry_node', status: 'RUNNING' };
  }

  private async skipNode(
    projectId: string,
    runId: string,
    nodeId?: string,
  ): Promise<OrchestrationControlResult> {
    if (!nodeId) {
      throw new BadRequestException('skip_node requires a nodeId');
    }
    // Clear the error and re-enter from the phase implied by the run's gate approvals. (The
    // sequencer re-runs the phase rather than skipping a single node — best effort.)
    const state = await this.loadCheckpointState(runId);
    if (!state) {
      throw new BadRequestException('Run has no checkpointed state and cannot skip a node');
    }
    const resumed = applyDevFlowPartial(state, { error: null });

    this.pausedRuns.delete(projectId);
    this.emitter?.nodeLifecycle(projectId, runId, nodeId, 'skipped');
    this.emitter?.runStatus(projectId, runId, ProjectStatus.GENERATING_CODE, nodeId);
    this.dispatchDriveRun(
      projectId,
      runId,
      resumed,
      OrchestrationSequencer.phaseFromState(resumed),
      'live',
      OrchestrationJobKind.CONTROL,
      'control_skip_node',
    );
    return { accepted: true, action: 'skip_node', status: 'RUNNING' };
  }

  private async modifyParams(
    projectId: string,
    runId: string,
    params?: Record<string, unknown>,
  ): Promise<OrchestrationControlResult> {
    if (!params || typeof params !== 'object') {
      throw new BadRequestException('modify_params requires a params object');
    }

    // Whitelist run-state fields that are safe to patch mid-run.
    const patch: Partial<DevFlowStateType> = {};
    if (typeof params.retryCount === 'number') patch.retryCount = params.retryCount;
    if (typeof params.brief === 'string') patch.brief = params.brief;
    if (typeof params.gate1Notes === 'string') patch.gate1Notes = params.gate1Notes;
    if (typeof params.gate2Notes === 'string') patch.gate2Notes = params.gate2Notes;

    // Budget knobs live on RunBudget, not run state.
    const budgetPatch: { tokenBudget?: number; maxRetries?: number } = {};
    if (typeof params.tokenBudget === 'number') budgetPatch.tokenBudget = params.tokenBudget;
    if (typeof params.maxRetries === 'number') budgetPatch.maxRetries = params.maxRetries;

    if (Object.keys(patch).length === 0 && Object.keys(budgetPatch).length === 0) {
      throw new BadRequestException(
        'No modifiable parameters provided (allowed: retryCount, brief, gate1Notes, gate2Notes, tokenBudget, maxRetries)',
      );
    }

    await Promise.allSettled([
      Object.keys(patch).length > 0 ? this.patchCheckpointState(runId, patch) : Promise.resolve(),
      Object.keys(budgetPatch).length > 0
        ? this.prisma.runBudget.update({ where: { projectId }, data: budgetPatch })
        : Promise.resolve(),
    ]);

    this.emitter?.runStatus(projectId, runId, 'PARAMS_UPDATED', 'modify_params');
    return { accepted: true, action: 'modify_params', status: 'RUNNING' };
  }

  /** Applies a whitelisted patch onto the persisted run-state snapshot (replaces graph.updateState). */
  private async patchCheckpointState(
    runId: string,
    patch: Partial<DevFlowStateType>,
  ): Promise<void> {
    const state = await this.loadCheckpointState(runId);
    if (!state) return;
    const next = applyDevFlowPartial(state, patch);
    await this.prisma.orchestrationRun
      .update({ where: { runId }, data: { checkpointState: next as unknown as object } })
      .catch(() => undefined);
  }

  private async getRunId(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { runId: true },
    });
    if (!project?.runId) {
      throw new Error(
        `Project ${projectId} has no runId — cannot resume graph`,
      );
    }
    return project.runId;
  }

  private async findOrCreateWorkOrderRun(
    projectId: string,
    input: {
      runId: string;
      executionRunId: string;
      trigger: OrchestrationRunTrigger;
      actorId?: string;
      currentNode: string;
    },
  ): Promise<{ id: string }> {
    const existing = await this.prisma.orchestrationRun.findUnique({
      where: { runId: input.runId },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.orchestrationRun.update({
        where: { id: existing.id },
        data: {
          currentNode: input.currentNode,
          status: OrchestrationRunStatus.RUNNING,
        },
      });
      return existing;
    }

    return this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId: input.runId,
        providerMode: this.agentProviderMode(),
        trigger: input.trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: input.currentNode,
        actorId: input.actorId ?? null,
        readyWorkOrders: 1,
      },
      select: { id: true },
    });
  }

  private async updateRunProgress(
    id: string,
    data: Prisma.OrchestrationRunUpdateInput,
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data,
    });
  }

  private async incrementRunCompletion(
    id: string,
    input: { artifactId: string; currentNode: string; completeRun: boolean },
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data: {
        currentNode: input.currentNode,
        completedWorkOrders: { increment: 1 },
        completedArtifacts: { increment: 1 },
        status: input.completeRun ? OrchestrationRunStatus.SUCCEEDED : undefined,
        completedAt: input.completeRun ? new Date() : undefined,
      },
    });
  }

  private async incrementRunFailure(
    id: string,
    input: { error: string; currentNode: string; completeRun: boolean },
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data: {
        currentNode: input.currentNode,
        failedWorkOrders: { increment: 1 },
        error: input.error,
        status: input.completeRun ? OrchestrationRunStatus.FAILED : undefined,
        completedAt: input.completeRun ? new Date() : undefined,
      },
    });
  }

  private async markRunFailed(
    runId: string,
    currentNode: string,
    error: string,
  ): Promise<void> {
    await this.prisma.orchestrationRun.updateMany({
      where: { runId },
      data: {
        status: OrchestrationRunStatus.FAILED,
        currentNode,
        error,
        completedAt: new Date(),
      },
    });
  }

  private workOrderNodeName(agentType: WorkOrderAgentType): string {
    return `work_order_${agentType.toLowerCase()}`;
  }

  private async recordWorkOrderTimelineEvent(
    projectId: string,
    actorId: string | undefined,
    input: {
      type: ProjectTimelineEventType;
      title: string;
      body?: string | null;
      taskId?: string | null;
      artifactId?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await this.prisma.projectTimelineEvent.create({
      data: {
        projectId,
        actorId: actorId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        visibility: ProjectTimelineVisibility.TEAM,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }

  private async notifyWorkOrderLifecycle(
    projectId: string,
    actorId: string | undefined,
    workOrder: {
      id: string;
      title: string;
      agentType: WorkOrderAgentType;
      taskId: string | null;
      task: { assignedToId: string | null } | null;
    },
    input: {
      type: NotificationType;
      title: string;
      status: WorkOrderStatus;
      executionRunId: string;
      artifactId?: string;
    },
  ): Promise<void> {
    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(projectId)),
        ...(workOrder.task?.assignedToId ? [workOrder.task.assignedToId] : []),
      ],
      actorId: actorId ?? null,
      projectId,
      taskId: workOrder.taskId,
      artifactId: input.artifactId ?? null,
      type: input.type,
      title: input.title,
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        status: input.status,
        agentType: workOrder.agentType,
        executionRunId: input.executionRunId,
      },
    });
  }
}
