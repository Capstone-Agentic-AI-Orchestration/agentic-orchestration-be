import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MemoryService } from '../src/memory/memory.service';
import { RequirementsParserNode } from '../src/orchestration/nodes/requirements-parser.node';
import { ContractNegotiatorNode } from '../src/orchestration/nodes/contract-negotiator.node';
import { FrontendAgentNode } from '../src/orchestration/nodes/frontend-agent.node';
import { BackendAgentNode } from '../src/orchestration/nodes/backend-agent.node';
import { DatabaseAgentNode } from '../src/orchestration/nodes/database-agent.node';
import { ArchitectureAgentNode } from '../src/orchestration/nodes/architecture-agent.node';
import { ValidatorNode } from '../src/orchestration/nodes/validator.node';
import { GithubCommitNode } from '../src/orchestration/nodes/github-commit.node';
import { SelfCritiqueNode } from '../src/orchestration/nodes/self-critique.node';
import { OrchestrationSequencer } from '../src/orchestration/graph/orchestration-sequencer';
import {
  OrchestrationRunDispatcher,
  type OrchestrationDispatchOptions,
} from '../src/orchestration/run-dispatcher.service';
import { AgentProviderRegistry } from '../src/orchestration/providers/agent-provider.registry';
import { ArtifactContractValidator } from '../src/orchestration/providers/artifact-contract.validator';
import { LlmAgentProvider } from '../src/orchestration/providers/llm-agent.provider';
import { MockAgentProvider } from '../src/orchestration/providers/mock-agent.provider';
import { NotificationsService } from '../src/notifications/notifications.service';
import { GithubService } from '../src/github/github.service';
import type { RequirementsDocument, ProjectContract, GeneratedArtifact } from '../src/orchestration/graph/devflow.state';
import { ArtifactValidationStatus, ArtifactReviewStatus, OrchestrationRunStatus, OrchestrationRunTrigger, ProjectStatus, ProjectTaskStatus, WorkOrderAgentType, WorkOrderExecutionStatus, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REQUIREMENTS: RequirementsDocument = {
  projectType: 'e-commerce',
  features: ['product listing', 'cart', 'checkout'],
  techStack: {
    frontend: 'Next.js 15',
    backend: 'NestJS 10',
    database: 'PostgreSQL with Prisma',
    styling: 'Tailwind CSS',
  },
  complexity: 'medium',
  estimatedFiles: 12,
};

const MOCK_CONTRACT: ProjectContract = {
  projectId: 'test-project-id',
  projectName: 'Test Shop',
  description: 'A test e-commerce project',
  requirements: MOCK_REQUIREMENTS,
  fileManifest: [
    'src/app/page.tsx',
    'src/app/layout.tsx',
    'src/components/Header.tsx',
    'README-frontend.md',
    'src/products/products.module.ts',
    'src/products/products.controller.ts',
    'src/products/products.service.ts',
    'src/products/dto/create-product.dto.ts',
    'README-backend.md',
    'prisma/schema.prisma',
    'prisma/seed.ts',
    'README-database.md',
    'ARCHITECTURE.md',
    'API.md',
    'DEPLOYMENT.md',
  ],
  acceptanceCriteria: ['All files generated', 'No TypeScript errors'],
  lockedAt: new Date().toISOString(),
};

const makeArtifact = (agentType: GeneratedArtifact['agentType'], filePath: string): GeneratedArtifact => ({
  agentType,
  filePath,
  content: `// ${filePath}`,
  language: 'typescript',
});

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    project: {
      findUnique: vi.fn().mockResolvedValue({ id: 'test-project-id', status: 'PENDING', runId: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    gateEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    artifact: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'artifact-1' }),
    },
    workOrder: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    orchestrationRun: {
      create: vi.fn().mockResolvedValue({ id: 'orchestration-run-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workOrderExecution: {
      create: vi.fn().mockResolvedValue({ id: 'execution-1' }),
      update: vi.fn().mockResolvedValue({ id: 'execution-1' }),
    },
    runBudget: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    eventLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    projectTimelineEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    projectTask: {
      update: vi.fn().mockResolvedValue({}),
    },
    projectTaskActivity: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeNodeMock<T>(returnValue: T) {
  return { execute: vi.fn().mockResolvedValue(returnValue) };
}

function makeMemoryMock() {
  return {
    writeMistake: vi.fn().mockResolvedValue(undefined),
    writeSkill: vi.fn().mockResolvedValue(undefined),
    writePattern: vi.fn().mockResolvedValue(undefined),
    writeProjectCoreMemory: vi.fn().mockResolvedValue(undefined),
  };
}

function makeNotificationsMock() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    projectManagers: vi.fn().mockResolvedValue(['pm-2']),
  };
}

function makeGithubMock() {
  return {
    getDeliveryStatus: vi.fn().mockReturnValue({
      configured: false,
      available: false,
      owner: null,
      ownerSource: null,
      missingRequirements: ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_ORG'],
      reason: 'GitHub delivery requires GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_ORG.',
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestrationService', () => {
  let service: OrchestrationService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let requirementsParser: { execute: ReturnType<typeof vi.fn> };
  let contractNegotiator: { execute: ReturnType<typeof vi.fn> };
  let frontendAgent: { execute: ReturnType<typeof vi.fn> };
  let backendAgent: { execute: ReturnType<typeof vi.fn> };
  let databaseAgent: { execute: ReturnType<typeof vi.fn> };
  let architectureAgent: { execute: ReturnType<typeof vi.fn> };
  let validator: { execute: ReturnType<typeof vi.fn> };
  let githubCommit: { execute: ReturnType<typeof vi.fn> };
  let selfCritique: { execute: ReturnType<typeof vi.fn> };
  let sequencerStub: { run: ReturnType<typeof vi.fn> };
  let runDispatcher: { dispatch: ReturnType<typeof vi.fn> };
  let memory: ReturnType<typeof makeMemoryMock>;
  let mockAgentProvider: MockAgentProvider;
  let agentProviderRegistry: AgentProviderRegistry;
  let notifications: ReturnType<typeof makeNotificationsMock>;
  let github: ReturnType<typeof makeGithubMock>;
  let originalAgentProvider: string | undefined;
  let originalLlmProvider: string | undefined;
  let originalOpenRouterApiKey: string | undefined;
  let originalOpenRouterModel: string | undefined;
  let originalOpenRouterBaseUrl: string | undefined;
  let originalOpenRouterFallbackModel: string | undefined;
  let originalAnthropicApiKey: string | undefined;
  let originalOpenAiApiKey: string | undefined;
  let originalGeminiApiKey: string | undefined;
  let originalGeminiFallbackModel: string | undefined;

  beforeEach(() => {
    originalAgentProvider = process.env.AGENT_PROVIDER;
    originalLlmProvider = process.env.LLM_PROVIDER;
    originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
    originalOpenRouterModel = process.env.OPENROUTER_MODEL;
    originalOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
    originalOpenRouterFallbackModel = process.env.OPENROUTER_FALLBACK_MODEL;
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    originalGeminiApiKey = process.env.GEMINI_API_KEY;
    originalGeminiFallbackModel = process.env.GEMINI_FALLBACK_MODEL;
    process.env.AGENT_PROVIDER = 'mock';
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash:free';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_FALLBACK_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FALLBACK_MODEL;

    prisma = makePrismaMock();
    memory = makeMemoryMock();
    mockAgentProvider = new MockAgentProvider();
    agentProviderRegistry = new AgentProviderRegistry(
      mockAgentProvider,
      new LlmAgentProvider(),
    );
    notifications = makeNotificationsMock();
    github = makeGithubMock();

    requirementsParser = makeNodeMock({ requirements: MOCK_REQUIREMENTS });
    contractNegotiator = makeNodeMock({ contract: MOCK_CONTRACT });
    frontendAgent = makeNodeMock({
      artifacts: [
        makeArtifact('frontend', 'src/app/page.tsx'),
        makeArtifact('frontend', 'src/app/layout.tsx'),
        makeArtifact('frontend', 'src/components/Header.tsx'),
        makeArtifact('frontend', 'README-frontend.md'),
      ],
    });
    backendAgent = makeNodeMock({
      artifacts: [
        makeArtifact('backend', 'src/products/products.module.ts'),
        makeArtifact('backend', 'src/products/products.controller.ts'),
        makeArtifact('backend', 'src/products/products.service.ts'),
        makeArtifact('backend', 'src/products/dto/create-product.dto.ts'),
        makeArtifact('backend', 'README-backend.md'),
      ],
    });
    databaseAgent = makeNodeMock({
      artifacts: [
        makeArtifact('database', 'prisma/schema.prisma'),
        makeArtifact('database', 'prisma/seed.ts'),
        makeArtifact('database', 'README-database.md'),
      ],
    });
    architectureAgent = makeNodeMock({
      artifacts: [
        makeArtifact('architecture', 'ARCHITECTURE.md'),
        makeArtifact('architecture', 'API.md'),
        makeArtifact('architecture', 'DEPLOYMENT.md'),
      ],
    });
    validator = makeNodeMock({});
    githubCommit = makeNodeMock({ repoUrl: 'https://github.com/test/test-shop' });
    selfCritique = makeNodeMock({});
    // Eve migration: stub the sequencer so fire-and-forget driveRun completes without executing
    // real nodes; resume tests assert it was (or was not) invoked.
    sequencerStub = { run: vi.fn().mockResolvedValue({ kind: 'paused', gate: 'gate_1', state: {} }) };
    runDispatcher = {
      dispatch: vi.fn(({ label, task, onError }: OrchestrationDispatchOptions) => {
        if (!String(label).startsWith('resume_')) return;
        void task().catch((error: unknown) => {
          void onError?.(error);
        });
      }),
    };

    service = new OrchestrationService(
      prisma as unknown as PrismaService,
      requirementsParser as unknown as RequirementsParserNode,
      contractNegotiator as unknown as ContractNegotiatorNode,
      frontendAgent as unknown as FrontendAgentNode,
      backendAgent as unknown as BackendAgentNode,
      databaseAgent as unknown as DatabaseAgentNode,
      architectureAgent as unknown as ArchitectureAgentNode,
      selfCritique as unknown as SelfCritiqueNode,
      validator as unknown as ValidatorNode,
      githubCommit as unknown as GithubCommitNode,
      memory as unknown as MemoryService,
      new ArtifactContractValidator(),
      { validate: vi.fn().mockReturnValue({ valid: true, errors: [], summary: 'FRONTEND artifact contract mock-work-order-v1 passed' }), validateBatch: vi.fn().mockReturnValue([]) } as never,
      agentProviderRegistry,
      notifications as unknown as NotificationsService,
      github as unknown as GithubService,
      sequencerStub as unknown as OrchestrationSequencer,
      null, // agentLlmRouter
      null, // graphLlmProvider
      null, // gateway
      null, // emitter
      null, // streamEmitter
      runDispatcher as unknown as OrchestrationRunDispatcher,
    );

    // Mock checkpointer so onModuleInit doesn't need a real DB
    vi.spyOn(service as unknown as { onModuleInit: () => Promise<void> }, 'onModuleInit').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAgentProvider === undefined) {
      delete process.env.AGENT_PROVIDER;
    } else {
      process.env.AGENT_PROVIDER = originalAgentProvider;
    }
    if (originalLlmProvider === undefined) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = originalLlmProvider;
    }
    if (originalOpenRouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }
    if (originalOpenRouterModel === undefined) {
      delete process.env.OPENROUTER_MODEL;
    } else {
      process.env.OPENROUTER_MODEL = originalOpenRouterModel;
    }
    if (originalOpenRouterBaseUrl === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = originalOpenRouterBaseUrl;
    }
    if (originalOpenRouterFallbackModel === undefined) {
      delete process.env.OPENROUTER_FALLBACK_MODEL;
    } else {
      process.env.OPENROUTER_FALLBACK_MODEL = originalOpenRouterFallbackModel;
    }
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    if (originalGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }
    if (originalGeminiFallbackModel === undefined) {
      delete process.env.GEMINI_FALLBACK_MODEL;
    } else {
      process.env.GEMINI_FALLBACK_MODEL = originalGeminiFallbackModel;
    }
    vi.restoreAllMocks();
  });

  it('startRun updates project runId and returns a non-empty runId', async () => {
    // Stub graph invoke so it doesn't actually run
    (service as unknown as { mockWorkOrderGraph: { invoke: ReturnType<typeof vi.fn> } }).mockWorkOrderGraph = {
      invoke: vi.fn().mockResolvedValue({}),
    };

    const runId = await service.startRun('test-project-id', 'Build a shop', 'nextjs-nestjs', 'TestCo');
    expect(runId).toBeTruthy();
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'test-project-id' },
      data: { runId },
    });
    expect(prisma.orchestrationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        runId,
        status: 'RUNNING',
      }),
    });
    expect(prisma.runBudget.upsert).toHaveBeenCalledWith({
      where: { projectId: 'test-project-id' },
      update: {
        tokensConsumed: 0,
        retryCount: 0,
      },
      create: { projectId: 'test-project-id' },
    });
  });

  it('resumeGate1 with approved=false records REJECTED and does not resume the pipeline', async () => {
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-001' });
    prisma.orchestrationRun.findUnique.mockResolvedValue({ checkpointState: null });

    await service.resumeGate1('test-project-id', false, 'needs more work');

    expect(prisma.gateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'REJECTED' }) }),
    );
    expect(sequencerStub.run).not.toHaveBeenCalled();
  });

  it('resumeGate1 with approved=true records APPROVED and resumes at phase B', async () => {
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-001' });
    prisma.orchestrationRun.findUnique.mockResolvedValue({
      checkpointState: { projectId: 'test-project-id', runId: 'run-001', contract: MOCK_CONTRACT, gate1Approved: false, gate2Approved: false, artifacts: [] },
    });

    await service.resumeGate1('test-project-id', true);

    expect(prisma.gateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'APPROVED' }) }),
    );
    expect(sequencerStub.run).toHaveBeenCalledWith(
      expect.objectContaining({
        fromPhase: 'B',
        state: expect.objectContaining({ gate1Approved: true }),
      }),
    );
  });

  it('resumeGate2 with approved=true records APPROVED and resumes at phase C', async () => {
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-002' });
    prisma.orchestrationRun.findUnique.mockResolvedValue({
      checkpointState: { projectId: 'test-project-id', runId: 'run-002', contract: MOCK_CONTRACT, gate1Approved: true, gate2Approved: false, artifacts: [] },
    });

    await service.resumeGate2('test-project-id', true, 'looks good');

    expect(sequencerStub.run).toHaveBeenCalledWith(
      expect.objectContaining({
        fromPhase: 'C',
        state: expect.objectContaining({ gate2Approved: true, gate2Notes: 'looks good' }),
      }),
    );
  });

  it('resumeGate2 blocks LLM GitHub delivery when GitHub is not configured', async () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-002' });
    prisma.orchestrationRun.findUnique.mockResolvedValue({ checkpointState: null });

    await expect(
      service.resumeGate2('test-project-id', true, 'ship it'),
    ).rejects.toThrow('GitHub delivery requires');

    expect(prisma.gateEvent.create).not.toHaveBeenCalled();
    expect(sequencerStub.run).not.toHaveBeenCalled();
  });

  it('getStatus returns UNKNOWN when project has no runId', async () => {
    prisma.project.findUnique.mockResolvedValue({ status: 'PENDING', runId: null });

    const status = await service.getStatus('test-project-id');
    expect(status.status).toBe('PENDING');
    expect(status.currentNode).toBe('none');
    expect(status.retryCount).toBe(0);
    expect(status.error).toBeNull();
  });

  it('getStatus masks RETRY: prefix errors from public response', async () => {
    prisma.project.findUnique.mockResolvedValue({ status: 'GENERATING_CODE', runId: 'run-003' });
    prisma.orchestrationRun.findUnique.mockResolvedValue({
      currentNode: 'validate_outputs',
      checkpointState: { error: 'RETRY:frontend', retryCount: 1 },
    });

    const status = await service.getStatus('test-project-id');
    expect(status.error).toBeNull();
    expect(status.retryCount).toBe(1);
  });

  it('getProviderStatus reports mock as available default provider', () => {
    const status = service.getProviderStatus();

    expect(status).toEqual(expect.objectContaining({
      requestedMode: 'mock',
      activeMode: 'mock',
      available: true,
      fallbackMode: null,
      missingRequirements: [],
      reason: null,
    }));
    expect(status.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'mock',
        active: true,
        available: true,
        implemented: true,
      }),
      expect.objectContaining({
        mode: 'llm',
        active: false,
        available: false,
        implemented: true,
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash:free',
      }),
    ]));
    expect(status.githubDelivery).toEqual(expect.objectContaining({
      configured: false,
      available: false,
      missingRequirements: expect.arrayContaining(['GITHUB_ORG']),
    }));
  });

  it('getProviderStatus reports requested OpenRouter mode unavailable without API key', () => {
    process.env.AGENT_PROVIDER = 'llm';
    delete process.env.OPENROUTER_API_KEY;

    const status = service.getProviderStatus();

    expect(status).toEqual(expect.objectContaining({
      requestedMode: 'llm',
      activeMode: 'llm',
      available: false,
      fallbackMode: 'mock',
      missingRequirements: ['OPENROUTER_API_KEY'],
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash:free',
    }));
    expect(status.reason).toContain('OpenRouter provider requires');
  });

  it('getProviderStatus reports OpenRouter as available when a key is configured', () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';

    const status = service.getProviderStatus();

    expect(status).toEqual(expect.objectContaining({
      requestedMode: 'llm',
      activeMode: 'llm',
      available: true,
      fallbackMode: null,
      missingRequirements: [],
      reason: null,
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash:free',
      fallbackModel: 'deepseek/deepseek-v4-flash',
    }));
  });

  it('getProviderStatus reports OpenCode as available when a key is configured', () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.LLM_PROVIDER = 'opencode';
    process.env.OPENCODE_API_KEY = 'test-opencode-key';
    process.env.OPENCODE_FALLBACK_MODEL = 'deepseek-v4-pro';

    const status = service.getProviderStatus();

    expect(status).toEqual(expect.objectContaining({
      requestedMode: 'llm',
      activeMode: 'llm',
      available: true,
      fallbackMode: null,
      missingRequirements: [],
      reason: null,
      provider: 'opencode',
      model: 'deepseek-v4-flash',
      fallbackModel: 'deepseek-v4-pro',
    }));
    expect(status.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'llm',
        displayName: 'OpenCode LLM Provider',
        available: true,
      }),
    ]));
  });

  it('getProviderStatus reports Gemini as available when a key is configured', () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-3.5-pro';

    const status = service.getProviderStatus();

    expect(status).toEqual(expect.objectContaining({
      requestedMode: 'llm',
      activeMode: 'llm',
      available: true,
      fallbackMode: null,
      missingRequirements: [],
      reason: null,
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      fallbackModel: 'gemini-3.5-pro',
    }));
    expect(status.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'llm',
        displayName: 'Gemini LLM Provider',
        available: true,
      }),
    ]));
  });

  it('startRun allows LLM generation when GitHub delivery is not configured', async () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    (service as unknown as { graph: { invoke: ReturnType<typeof vi.fn> } }).graph = {
      invoke: vi.fn().mockResolvedValue({}),
    };

    const runId = await service.startRun('test-project-id', 'Build a shop', 'nextjs-nestjs', 'TestCo');

    expect(runId).toBeTruthy();
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'test-project-id' },
      data: { runId },
    });
    expect(github.getDeliveryStatus).not.toHaveBeenCalled();
  });

  it('executeWorkOrder records execution logs, creates an artifact, and links it back to work order and task', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Create the first dashboard shell.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });
    prisma.artifact.create.mockResolvedValue({
      id: 'artifact-generated-1',
      projectId: 'test-project-id',
      agentType: 'frontend',
      filePath: 'work-orders/work-order-1/frontend-output.md',
      displayName: 'Build frontend shell output',
      reviewStatus: ArtifactReviewStatus.PENDING,
    });

    const result = await service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1');

    expect(result).toEqual({
      executionRunId: expect.any(String),
      artifactId: 'artifact-generated-1',
    });
    expect(prisma.eventLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        nodeName: 'work_order_frontend',
        eventType: 'STARTED',
        costMeta: expect.objectContaining({ workOrderId: 'work-order-1' }),
      }),
    });
    expect(prisma.workOrderExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        orchestrationRunId: 'orchestration-run-1',
        workOrderId: 'work-order-1',
        executionRunId: expect.any(String),
        attempt: 1,
        agentType: WorkOrderAgentType.FRONTEND,
        status: 'RUNNING',
      }),
    });
    expect(prisma.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        agentType: 'frontend',
        filePath: 'work-orders/work-order-1/frontend-output.tsx',
        clientVisible: false,
        validationStatus: ArtifactValidationStatus.PASSED,
        validationSummary: 'FRONTEND artifact contract mock-work-order-v1 passed',
      }),
    });
    expect(prisma.workOrderExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          providerMode: 'mock',
          contract: expect.objectContaining({
            version: 'mock-work-order-v1',
            agentSlug: 'frontend',
            nodeName: 'work_order_frontend',
          }),
        }),
      }),
    });
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'work-order-1',
        projectId: 'test-project-id',
        status: WorkOrderStatus.DISPATCHED,
        executionRunId: expect.any(String),
      },
      data: expect.objectContaining({
        status: WorkOrderStatus.COMPLETED,
        artifactId: 'artifact-generated-1',
        executionCompletedAt: expect.any(Date),
      }),
    });
    expect(prisma.projectTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: {
        status: ProjectTaskStatus.IN_REVIEW,
        artifactId: 'artifact-generated-1',
      },
    });
    expect(prisma.eventLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        nodeName: 'work_order_frontend',
        eventType: 'COMPLETED',
        costMeta: expect.objectContaining({
          workOrderId: 'work-order-1',
          artifactId: 'artifact-generated-1',
        }),
      }),
    });
  });

  it('executeWorkOrder attaches graph-triggered executions to the parent orchestration run', async () => {
    prisma.orchestrationRun.findUnique.mockResolvedValue({ id: 'parent-run-db-id' });
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build backend service',
      instructions: 'Create a NestJS service handoff.',
      agentType: WorkOrderAgentType.BACKEND,
      priority: WorkOrderPriority.NORMAL,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      executionRunId: null,
      executionStartedAt: null,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Backend service',
        description: 'API task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });
    prisma.artifact.create.mockResolvedValue({
      id: 'artifact-generated-1',
      projectId: 'test-project-id',
      agentType: 'backend',
      filePath: 'work-orders/work-order-1/backend-output.ts',
      displayName: 'Build backend service output',
      reviewStatus: ArtifactReviewStatus.PENDING,
    });

    await service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1', {
      parentRunId: 'parent-run-1',
      trigger: OrchestrationRunTrigger.START,
    });

    expect(prisma.orchestrationRun.findUnique).toHaveBeenCalledWith({
      where: { runId: 'parent-run-1' },
      select: { id: true },
    });
    expect(prisma.orchestrationRun.create).not.toHaveBeenCalled();
    expect(prisma.workOrderExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orchestrationRunId: 'parent-run-db-id',
        workOrderId: 'work-order-1',
        agentType: WorkOrderAgentType.BACKEND,
        metadata: expect.objectContaining({
          trigger: 'START',
          providerMode: 'mock',
          contract: expect.objectContaining({
            version: 'mock-work-order-v1',
            agentSlug: 'backend',
            nodeName: 'work_order_backend',
          }),
        }),
      }),
    });
  });

  it('executeWorkOrder rejects non-executable completed work orders before creating an execution', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: 'artifact-1',
      title: 'Already complete',
      instructions: 'This should not run again.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.NORMAL,
      status: WorkOrderStatus.COMPLETED,
      executionAttempt: 1,
      executionRunId: 'previous-run',
      executionStartedAt: new Date('2026-05-28T00:00:00.000Z'),
      dispatchedAt: new Date('2026-05-28T00:00:00.000Z'),
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: null,
      artifact: null,
    });

    await expect(
      service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1'),
    ).rejects.toThrow('Work order work-order-1 must be READY before agent execution');

    expect(prisma.orchestrationRun.create).not.toHaveBeenCalled();
    expect(prisma.workOrderExecution.create).not.toHaveBeenCalled();
    expect(prisma.artifact.create).not.toHaveBeenCalled();
  });

  it('executeWorkOrder fails predictably when LLM mode is requested without provider keys', async () => {
    process.env.AGENT_PROVIDER = 'llm';
    delete process.env.OPENROUTER_API_KEY;
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Create the first dashboard shell.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      executionRunId: null,
      executionStartedAt: null,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });

    await expect(
      service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1'),
    ).rejects.toThrow('Agent provider llm is unavailable: OpenRouter provider requires OPENROUTER_API_KEY');

    expect(prisma.orchestrationRun.create).not.toHaveBeenCalled();
    expect(prisma.workOrderExecution.create).not.toHaveBeenCalled();
    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.artifact.create).not.toHaveBeenCalled();
  });

  it('executeWorkOrder can generate a validated artifact through OpenRouter JSON output', async () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                filePath: 'work-orders/work-order-1/frontend-output.tsx',
                displayName: 'OpenRouter frontend output',
                language: 'typescript',
                content: [
                  "import React from 'react';",
                  'export function OpenRouterFrontendOutput() {',
                  '  return <section><div>Recovered frontend work order output</div></section>;',
                  '}',
                  'export default OpenRouterFrontendOutput;',
                ].join('\n'),
                metadata: { source: 'openrouter-test' },
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Create the first dashboard shell.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      executionRunId: null,
      executionStartedAt: null,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });
    prisma.artifact.create.mockResolvedValue({
      id: 'artifact-openrouter-1',
      projectId: 'test-project-id',
      agentType: 'frontend',
      filePath: 'work-orders/work-order-1/frontend-output.tsx',
      displayName: 'OpenRouter frontend output',
      reviewStatus: ArtifactReviewStatus.PENDING,
    });

    const result = await service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1');

    expect(result.artifactId).toBe('artifact-openrouter-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-openrouter-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).toEqual(expect.objectContaining({
      model: 'deepseek/deepseek-v4-flash:free',
      response_format: { type: 'json_object' },
    }));
    expect(prisma.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        filePath: 'work-orders/work-order-1/frontend-output.tsx',
        displayName: 'OpenRouter frontend output',
        validationStatus: ArtifactValidationStatus.PASSED,
      }),
    });
    expect(prisma.workOrderExecution.update).toHaveBeenCalledWith({
      where: { executionRunId: expect.any(String) },
      data: expect.objectContaining({
        status: WorkOrderExecutionStatus.SUCCEEDED,
        metadata: expect.objectContaining({
          providerMode: 'llm',
          output: expect.objectContaining({
            metadata: expect.objectContaining({
              provider: 'openrouter',
              model: 'deepseek/deepseek-v4-flash:free',
            }),
          }),
        }),
      }),
    });
  });

  it('normalizes wrapped OpenRouter artifact JSON output', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                artifact: {
                  file_path: 'work-orders/work-order-1/frontend-output.tsx',
                  title: 'Wrapped OpenRouter frontend output',
                  code: [
                    "import React from 'react';",
                    'export function WrappedFrontendOutput() {',
                    '  return <section><div>Wrapped frontend work order output</div></section>;',
                    '}',
                  ].join('\n'),
                  metadata: { source: 'wrapped-openrouter-test' },
                },
              }),
            },
          },
        ],
      }),
    }));

    const provider = new LlmAgentProvider();
    const output = await provider.generateWorkOrderOutput({
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      workOrder: {
        id: 'work-order-1',
        title: 'Build frontend shell',
        instructions: 'Create the first dashboard shell.',
        agentType: WorkOrderAgentType.FRONTEND,
        priority: WorkOrderPriority.HIGH,
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      sourceArtifact: null,
      executionRunId: 'execution-1',
    });

    expect(output).toEqual(expect.objectContaining({
      filePath: 'work-orders/work-order-1/frontend-output.tsx',
      displayName: 'Wrapped OpenRouter frontend output',
      language: 'typescript',
      content: expect.stringContaining('export function WrappedFrontendOutput'),
      metadata: expect.objectContaining({
        source: 'wrapped-openrouter-test',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash:free',
      }),
    }));
  });

  it('executeWorkOrder fails cleanly when OpenRouter returns invalid JSON', async () => {
    process.env.AGENT_PROVIDER = 'llm';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'not json' } }],
      }),
    }));
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Create the first dashboard shell.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      executionRunId: null,
      executionStartedAt: null,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });

    await expect(
      service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1'),
    ).rejects.toThrow(/OpenRouter deepseek\/deepseek-v4-flash:free.*returned invalid JSON|OpenRouter deepseek\/deepseek-v4-flash:free.*repair returned invalid JSON/);

    expect(prisma.artifact.create).not.toHaveBeenCalled();
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'work-order-1',
        projectId: 'test-project-id',
        status: WorkOrderStatus.DISPATCHED,
        executionRunId: expect.any(String),
      },
      data: expect.objectContaining({
        status: WorkOrderStatus.FAILED,
        executionError: expect.stringMatching(/OpenRouter deepseek\/deepseek-v4-flash:free.*returned invalid JSON|OpenRouter deepseek\/deepseek-v4-flash:free.*repair returned invalid JSON/),
      }),
    });
  });

  it('recoverStaleProject creates a durable supervisor recovery run and executes ready work orders', async () => {
    prisma.workOrder.findMany.mockResolvedValue([
      { id: 'work-order-1', instructions: 'Recover this frontend handoff.' },
    ]);
    prisma.orchestrationRun.findUnique.mockResolvedValue({ id: 'orchestration-run-1' });
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Recover this frontend handoff.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 1,
      executionRunId: null,
      executionStartedAt: null,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });
    prisma.artifact.create.mockResolvedValue({
      id: 'artifact-generated-1',
      projectId: 'test-project-id',
      agentType: 'frontend',
      filePath: 'work-orders/work-order-1/frontend-output.tsx',
      displayName: 'Build frontend shell output',
      reviewStatus: ArtifactReviewStatus.PENDING,
    });

    const result = await service.recoverStaleProject('test-project-id', {
      reason: 'Supervisor detected stale run and queued retry 2/3',
      retryAttempt: 2,
      maxRetries: 3,
    });

    expect(result).toEqual({
      runId: expect.any(String),
      readyWorkOrders: 1,
      completedWorkOrders: 1,
      failedWorkOrders: 0,
      status: OrchestrationRunStatus.SUCCEEDED,
      error: null,
    });
    expect(prisma.orchestrationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        runId: result.runId,
        providerMode: 'mock',
        trigger: OrchestrationRunTrigger.RERUN_READY_WORK_ORDERS,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: 'supervisor_recovery',
        readyWorkOrders: 1,
      }),
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'test-project-id' },
      data: { runId: result.runId, status: ProjectStatus.GENERATING_CODE },
    });
    expect(prisma.workOrderExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orchestrationRunId: 'orchestration-run-1',
        workOrderId: 'work-order-1',
        attempt: 2,
        metadata: expect.objectContaining({
          trigger: OrchestrationRunTrigger.RERUN_READY_WORK_ORDERS,
          providerMode: 'mock',
        }),
      }),
    });
    expect(prisma.orchestrationRun.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'test-project-id', runId: result.runId },
      data: expect.objectContaining({
        status: OrchestrationRunStatus.SUCCEEDED,
        currentNode: 'supervisor_recovery',
        error: null,
        completedWorkOrders: 1,
        failedWorkOrders: 0,
        completedArtifacts: 1,
        completedAt: expect.any(Date),
      }),
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'test-project-id',
      title: 'Supervisor recovery completed',
      metadata: expect.objectContaining({
        runId: result.runId,
        retryAttempt: 2,
        maxRetries: 3,
      }),
    }));
  });

  it('recoverStaleProject records a failed recovery run when the requested provider is unavailable', async () => {
    process.env.AGENT_PROVIDER = 'llm';
    delete process.env.OPENROUTER_API_KEY;
    prisma.workOrder.findMany.mockResolvedValue([
      { id: 'work-order-1', instructions: 'Recover this frontend handoff.' },
    ]);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Recover this frontend handoff.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 1,
      executionRunId: null,
      executionStartedAt: null,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });

    const result = await service.recoverStaleProject('test-project-id', {
      reason: 'Supervisor detected stale run and queued retry 2/3',
      retryAttempt: 2,
      maxRetries: 3,
    });

    expect(result).toEqual({
      runId: expect.any(String),
      readyWorkOrders: 1,
      completedWorkOrders: 0,
      failedWorkOrders: 1,
      status: OrchestrationRunStatus.FAILED,
      error: expect.stringContaining('Agent provider llm is unavailable: OpenRouter provider requires OPENROUTER_API_KEY'),
    });
    expect(prisma.orchestrationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerMode: 'llm',
        status: OrchestrationRunStatus.RUNNING,
        currentNode: 'supervisor_recovery',
      }),
    });
    expect(prisma.workOrderExecution.create).not.toHaveBeenCalled();
    expect(prisma.artifact.create).not.toHaveBeenCalled();
    expect(prisma.orchestrationRun.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'test-project-id', runId: result.runId },
      data: expect.objectContaining({
        status: OrchestrationRunStatus.FAILED,
        currentNode: 'supervisor_recovery',
        error: expect.stringContaining('Agent provider llm is unavailable: OpenRouter provider requires OPENROUTER_API_KEY'),
        completedWorkOrders: 0,
        failedWorkOrders: 1,
        completedArtifacts: 0,
      }),
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'test-project-id' },
      data: { status: ProjectStatus.FAILED },
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'test-project-id',
      title: 'Supervisor recovery failed',
      body: expect.stringContaining('Agent provider llm is unavailable: OpenRouter provider requires OPENROUTER_API_KEY'),
    }));
  });

  it('executeWorkOrder fails the order when generated output violates the artifact contract', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Create the first dashboard shell.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });
    // Override the output validation mock per-test to reject invalid output.
    const outputValidationMock = { validate: vi.fn(), validateBatch: vi.fn().mockReturnValue([]) };
    (service as unknown as { outputValidation: typeof outputValidationMock }).outputValidation = outputValidationMock;
    outputValidationMock.validate.mockReturnValue({ valid: false, errors: [{ code: 'BASE', message: 'content must be at least 40 non-empty characters' }], summary: 'FRONTEND output failed' });

    vi.spyOn(mockAgentProvider, 'generateWorkOrderOutput').mockReturnValueOnce({
      filePath: 'bad-output.txt',
      displayName: 'Bad output',
      language: 'text',
      content: 'too short',
    });

    await expect(
      service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1'),
    ).rejects.toThrow('Output validation failed');

    expect(prisma.artifact.create).not.toHaveBeenCalled();
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'work-order-1',
        projectId: 'test-project-id',
        status: WorkOrderStatus.DISPATCHED,
        executionRunId: expect.any(String),
      },
      data: expect.objectContaining({
        status: WorkOrderStatus.FAILED,
        executionError: expect.stringContaining('Output validation failed'),
      }),
    });
    expect(prisma.workOrderExecution.update).toHaveBeenCalledWith({
      where: { executionRunId: expect.any(String) },
      data: expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('Output validation failed'),
      }),
    });
  });
});
