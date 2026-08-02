import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ArtifactOutputReviewStatus, ArtifactReviewStatus, ArtifactValidationStatus, CollaborationDocumentStatus, NotificationType, OrchestrationRunTrigger, ProjectDeliveryReviewStatus, ProjectKickoffStatus, ProjectStatus, ProjectTimelineEventType, ProjectTimelineVisibility, ProjectTaskActivityType, ProjectTaskStatus, UserRole, WorkOrderAgentType, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { ProjectsService } from '../src/projects/projects.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { IntakeService } from '../src/intake/intake.service';
import { AuthUser } from '../src/auth/auth.types';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

const devUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  fullName: 'Dana Developer',
  role: UserRole.DEV,
};

function makePrismaMock() {
  return {
    project: {
      create: vi.fn().mockResolvedValue({
        id: 'project-1',
        companyName: 'Acme Logistics',
        brief: 'Build a delivery dashboard',
        stackKey: 'nextjs-nestjs-supabase',
        status: 'PENDING',
        runId: null,
        repoUrl: null,
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      }),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: 'project-1' }),
      updateMany: vi.fn(),
    },
    client: {
      // Defaults to "found" so existing tests that pass a clientId are not tripped by the
      // existence check; tests that care set their own value.
      findUnique: vi.fn().mockResolvedValue({ id: 'client-1' }),
    },
    clientInquiry: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    profile: {
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        preferences: {},
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
      }),
      update: vi.fn().mockResolvedValue({
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
      }),
    },
    projectMember: {
      findFirst: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'member-1' }),
      delete: vi.fn().mockResolvedValue({ id: 'member-1' }),
    },
    projectKickoff: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    artifact: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      update: vi.fn(),
    },
    projectDeliveryReview: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    clientInvite: {
      findFirst: vi.fn().mockResolvedValue({ id: 'invite-1' }),
    },
    collaborationDocument: {
      count: vi.fn().mockResolvedValue(0),
    },
    projectTask: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    projectTaskActivity: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    workOrder: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    orchestrationRun: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
    },
    projectTimelineEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    eventLog: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
  };
}

function makeOrchestrationMock() {
  return {
    startRun: vi.fn().mockResolvedValue('run-1'),
    resumeGate1: vi.fn().mockResolvedValue(undefined),
    resumeGate2: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({
      status: 'PENDING',
      currentNode: 'none',
      retryCount: 0,
      error: null,
    }),
    getProviderStatus: vi.fn().mockReturnValue({
      requestedMode: 'mock',
      activeMode: 'mock',
      available: true,
      fallbackMode: null,
      missingRequirements: [],
      reason: null,
      providers: [],
      githubDelivery: {
        configured: false,
        available: false,
        owner: null,
        ownerSource: null,
        missingRequirements: ['GITHUB_ORG'],
        reason: 'GitHub delivery requires GITHUB_ORG.',
      },
    }),
    verifyGithubDeliveryAccess: vi.fn().mockResolvedValue({
      ok: true,
      status: {
        configured: true,
        available: true,
        owner: 'capstone-org',
        ownerSource: 'env',
        missingRequirements: [],
        reason: null,
      },
      owner: 'capstone-org',
      installationOwner: 'capstone-org',
      repositoriesVisible: 4,
      permissions: { contents: 'write' },
      reason: null,
    }),
    verifyLlmProviderAccess: vi.fn().mockResolvedValue({
      ok: true,
      provider: 'opencode',
      model: 'deepseek-v4-flash',
      fallbackModel: 'deepseek-v4-pro',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      reason: null,
      usage: { inputTokens: 4, outputTokens: 3 },
    }),
    executeWorkOrder: vi.fn().mockResolvedValue({
      executionRunId: 'work-order-run-1',
      artifactId: 'artifact-generated-1',
    }),
    validateModelSelection: vi.fn(async (selection?: {
      defaultModel: string;
      overrides?: Record<string, string>;
    }) => ({
      defaultModel: selection?.defaultModel ?? 'gateway/default',
      overrides: selection?.overrides ?? {},
    })),
  };
}

function makeNotificationsMock() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    projectManagers: vi.fn().mockResolvedValue([pmUser.id]),
    projectClients: vi.fn().mockResolvedValue([clientUser.id]),
  };
}

describe('ProjectsService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let orchestration: ReturnType<typeof makeOrchestrationMock>;
  let notifications: ReturnType<typeof makeNotificationsMock>;
  let service: ProjectsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    orchestration = makeOrchestrationMock();
    notifications = makeNotificationsMock();
    service = new ProjectsService(
      prisma as unknown as PrismaService,
      orchestration as unknown as OrchestrationService,
      notifications as unknown as NotificationsService,
    );
  });

  it('create stores a project draft without starting orchestration', async () => {
    const project = await service.create(
      {
        companyName: 'Acme Logistics',
        brief: 'Build a delivery dashboard',
        stackKey: 'nextjs-nestjs-supabase',
      },
      pmUser,
    );

    expect(project.id).toBe('project-1');
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: {
        companyName: 'Acme Logistics',
        brief: 'Build a delivery dashboard',
        stackKey: 'nextjs-nestjs-supabase',
        createdById: pmUser.id,
        // Written explicitly: a project with no client is a supported, flagged state rather
        // than an omission, and the console surfaces it as unassigned.
        clientId: null,
      },
    });
    expect(orchestration.startRun).not.toHaveBeenCalled();
  });

  it('create rejects a clientId that does not exist', async () => {
    prisma.client.findUnique.mockResolvedValue(null);

    await expect(
      service.create(
        {
          companyName: 'Acme Logistics',
          brief: 'Build a delivery dashboard',
          stackKey: 'nextjs-nestjs-supabase',
          clientId: 'missing-client',
        },
        pmUser,
      ),
    ).rejects.toThrow('Client missing-client not found');
  });

  it('create links the project to a client when one is supplied', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'client-1' });

    await service.create(
      {
        companyName: 'Acme Logistics',
        brief: 'Build a delivery dashboard',
        stackKey: 'nextjs-nestjs-supabase',
        clientId: 'client-1',
      },
      pmUser,
    );

    expect(prisma.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientId: 'client-1' }),
    });
  });

  it('refuses orchestration while a project is still in discovery', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.READY },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });
    prisma.project.findUnique.mockResolvedValue({ status: ProjectStatus.DISCOVERY });

    // Discovery exists so the PM can agree scope and gather documents first; a run started from
    // that state would spend the client's budget on a brief nobody has agreed.
    await expect(service.startOrchestration('project-1', pmUser)).rejects.toThrow(
      'still in discovery',
    );
    expect(orchestration.startRun).not.toHaveBeenCalled();
  });

  it('startDelivery promotes a discovery project and approves its inquiry', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.project.findUnique.mockResolvedValue({
      id: 'project-1',
      status: ProjectStatus.DISCOVERY,
      companyName: 'Acme Logistics',
    });
    prisma.project.update.mockResolvedValue({
      id: 'project-1',
      status: ProjectStatus.PENDING,
      companyName: 'Acme Logistics',
    });

    await expect(service.startDelivery('project-1', pmUser)).resolves.toMatchObject({
      status: ProjectStatus.PENDING,
    });
    expect(prisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: ProjectStatus.PENDING },
    }));
    // The inquiry this came from now genuinely counts as approved.
    expect(prisma.clientInquiry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'APPROVED' },
    }));
  });

  it('startDelivery refuses a project that already left discovery', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.project.findUnique.mockResolvedValue({
      id: 'project-1',
      status: ProjectStatus.PENDING,
      companyName: 'Acme Logistics',
    });

    await expect(service.startDelivery('project-1', pmUser)).rejects.toThrow(
      'Delivery has already started',
    );
  });

  it('startOrchestration starts a run for an existing project without a runId', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.READY },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });

    await expect(service.startOrchestration('project-1', pmUser)).resolves.toEqual({
      accepted: true,
      runId: 'run-1',
    });
    expect(orchestration.startRun).toHaveBeenCalledWith(
      'project-1',
      'Build a delivery dashboard',
      'nextjs-nestjs-supabase',
      'Acme Logistics',
      pmUser.id,
      OrchestrationRunTrigger.START,
      undefined,
      undefined,
      { defaultModel: 'gateway/default', overrides: {} },
      undefined,
    );
  });

  it('startOrchestration forwards optional design guidance', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.READY },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });

    await service.startOrchestration('project-1', pmUser, {
      designGuidance: {
        theme: 'black',
        productFeel: 'operational',
        layoutDensity: 'balanced',
        accessibilityLevel: 'strict',
        forbiddenPatterns: ['gradient orb'],
      },
    });

    expect(orchestration.startRun).toHaveBeenCalledWith(
      'project-1',
      'Build a delivery dashboard',
      'nextjs-nestjs-supabase',
      'Acme Logistics',
      pmUser.id,
      OrchestrationRunTrigger.START,
      undefined,
      expect.objectContaining({
        theme: 'black',
        forbiddenPatterns: ['gradient orb'],
      }),
      { defaultModel: 'gateway/default', overrides: {} },
      undefined,
    );
  });

  it('loads and validates personal orchestration model defaults', async () => {
    prisma.profile.findUniqueOrThrow.mockResolvedValue({
      preferences: {
        emailNotifications: true,
        orchestrationModelDefaults: {
          defaultModel: 'openai/fast',
          overrides: { architecture: 'anthropic/strong' },
        },
      },
      updatedAt: new Date('2026-07-27T08:00:00.000Z'),
    });

    await expect(service.findOrchestrationModelDefaults(pmUser)).resolves.toEqual({
      selection: {
        defaultModel: 'openai/fast',
        overrides: { architecture: 'anthropic/strong' },
      },
      source: 'saved',
      warning: null,
      updatedAt: '2026-07-27T08:00:00.000Z',
    });
    expect(orchestration.validateModelSelection).toHaveBeenCalledWith({
      defaultModel: 'openai/fast',
      overrides: { architecture: 'anthropic/strong' },
    });
  });

  it('saves validated orchestration defaults without removing other profile preferences', async () => {
    prisma.profile.findUniqueOrThrow.mockResolvedValue({
      preferences: { emailNotifications: true, uiDensity: 'compact' },
    });
    prisma.profile.update.mockResolvedValue({
      updatedAt: new Date('2026-07-27T09:00:00.000Z'),
    });

    const input = {
      defaultModel: 'openai/fast',
      overrides: { critique: 'anthropic/strong' },
    };
    await expect(service.updateOrchestrationModelDefaults(pmUser, input)).resolves.toEqual({
      selection: {
        defaultModel: 'openai/fast',
        overrides: { critique: 'anthropic/strong' },
      },
      source: 'saved',
      warning: null,
      updatedAt: '2026-07-27T09:00:00.000Z',
    });
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: pmUser.id },
      data: {
        preferences: {
          emailNotifications: true,
          uiDensity: 'compact',
          orchestrationModelDefaults: {
            defaultModel: 'openai/fast',
            overrides: { critique: 'anthropic/strong' },
          },
        },
      },
      select: { updatedAt: true },
    });
  });

  it('startOrchestration forwards the user-selected model snapshot', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.READY },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });

    await service.startOrchestration('project-1', pmUser, {
      modelSelection: {
        defaultModel: 'free/fast-model',
        overrides: { backend: 'paid/strong-model' },
      },
    });

    expect(orchestration.startRun).toHaveBeenCalledWith(
      'project-1',
      'Build a delivery dashboard',
      'nextjs-nestjs-supabase',
      'Acme Logistics',
      pmUser.id,
      OrchestrationRunTrigger.START,
      undefined,
      undefined,
      {
        defaultModel: 'free/fast-model',
        overrides: { backend: 'paid/strong-model' },
      },
      undefined,
    );
  });

  it('forwards the preflight token ceiling and recovery policy', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.READY },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });

    await service.startOrchestration('project-1', pmUser, {
      runControls: {
        tokenBudget: 350_000,
        maxRetries: 2,
      },
    });

    expect(orchestration.startRun).toHaveBeenCalledWith(
      'project-1',
      'Build a delivery dashboard',
      'nextjs-nestjs-supabase',
      'Acme Logistics',
      pmUser.id,
      OrchestrationRunTrigger.START,
      undefined,
      undefined,
      { defaultModel: 'gateway/default', overrides: {} },
      {
        tokenBudget: 350_000,
        maxRetries: 2,
      },
    );
  });

  it('starts orchestration with the immutable locked intake context', async () => {
    const intakeContext = {
      schemaVersion: 'intake-context-v1' as const,
      projectId: 'project-1',
      intakeSnapshotId: 'snapshot-1',
      intakeVersion: 3,
      canonicalBrief: 'Locked client requirements',
      clientRequirements: {} as never,
      pmNotes: 'Scope reviewed',
      sources: [],
    };
    const intake = { contextForStart: vi.fn().mockResolvedValue(intakeContext) };
    const serviceWithIntake = new ProjectsService(
      prisma as unknown as PrismaService,
      orchestration as unknown as OrchestrationService,
      notifications as unknown as NotificationsService,
      intake as unknown as IntakeService,
    );
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.READY },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });

    await serviceWithIntake.startOrchestration('project-1', pmUser);

    expect(intake.contextForStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-1' }), pmUser.id);
    expect(orchestration.startRun).toHaveBeenCalledWith(
      'project-1',
      'Build a delivery dashboard',
      'nextjs-nestjs-supabase',
      'Acme Logistics',
      pmUser.id,
      OrchestrationRunTrigger.START,
      intakeContext,
      undefined,
      { defaultModel: 'gateway/default', overrides: {} },
      undefined,
    );
  });

  it('startOrchestration reuses an existing runId', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: 'run-existing',
      kickoff: { status: ProjectKickoffStatus.DRAFT },
      workOrders: [],
    });

    await expect(service.startOrchestration('project-1', pmUser)).resolves.toEqual({
      accepted: true,
      runId: 'run-existing',
    });
    expect(orchestration.startRun).not.toHaveBeenCalled();
  });

  it('startOrchestration fails for a missing project', async () => {
    prisma.project.findFirst.mockResolvedValue(null);

    await expect(
      service.startOrchestration('missing', pmUser),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('startOrchestration does not require a completed kickoff checklist', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.DRAFT },
      workOrders: [{ instructions: 'Build the first dashboard shell.' }],
    });

    await expect(service.startOrchestration('project-1', pmUser)).resolves.toEqual({
      accepted: true,
      runId: 'run-1',
    });
    expect(orchestration.startRun).toHaveBeenCalled();
  });

  it('startOrchestration prepares agent tasks automatically when none are ready', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      companyName: 'Acme Logistics',
      brief: 'Build a delivery dashboard',
      stackKey: 'nextjs-nestjs-supabase',
      runId: null,
      kickoff: { status: ProjectKickoffStatus.DRAFT },
      workOrders: [],
    });
    const prepare = vi.spyOn(service, 'createKickoffWorkOrders').mockResolvedValue({
      kickoff: { status: ProjectKickoffStatus.DRAFT } as never,
      workOrders: [
        {
          status: WorkOrderStatus.READY,
          instructions: 'Review the brief and prepare the architecture.',
        },
      ] as never,
    });

    await expect(service.startOrchestration('project-1', pmUser)).resolves.toEqual({
      accepted: true,
      runId: 'run-1',
    });
    expect(prepare).toHaveBeenCalledWith('project-1', pmUser);
    expect(orchestration.startRun).toHaveBeenCalled();
  });

  it('verifyOrchestrationGithubDelivery checks project access before live GitHub verification', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await expect(service.verifyOrchestrationGithubDelivery('project-1', pmUser)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        owner: 'capstone-org',
        installationOwner: 'capstone-org',
      }),
    );
    expect(orchestration.verifyGithubDeliveryAccess).toHaveBeenCalled();
  });

  it('verifyOrchestrationLlmProvider checks project access before live model verification', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await expect(service.verifyOrchestrationLlmProvider('project-1', pmUser)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        provider: 'opencode',
        model: 'deepseek-v4-flash',
      }),
    );
    expect(orchestration.verifyLlmProviderAccess).toHaveBeenCalled();
  });

  it('updateKickoff marks the project ready when every checklist item is complete', async () => {
    const readyKickoff = {
      id: 'kickoff-1',
      projectId: 'project-1',
      status: ProjectKickoffStatus.READY,
      completedById: pmUser.id,
      completedAt: new Date('2026-05-28T01:00:00.000Z'),
    };
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectKickoff.findUnique.mockResolvedValue(null);
    prisma.projectKickoff.upsert.mockResolvedValue(readyKickoff);

    await expect(
      service.updateKickoff('project-1', pmUser, {
        scopeConfirmed: true,
        milestonesConfirmed: true,
        documentsConfirmed: true,
        techStackConfirmed: true,
        rolesConfirmed: true,
        clientAccessConfirmed: true,
        initialTasksCreated: true,
        initialWorkOrdersCreated: true,
      }),
    ).resolves.toEqual(readyKickoff);
    expect(prisma.projectKickoff.upsert).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      update: expect.objectContaining({
        status: ProjectKickoffStatus.READY,
        completedById: pmUser.id,
        updatedById: pmUser.id,
      }),
      create: expect.objectContaining({
        projectId: 'project-1',
        status: ProjectKickoffStatus.READY,
        completedById: pmUser.id,
        updatedById: pmUser.id,
      }),
    });
  });

  it('findAll scopes client users to owned or member projects', async () => {
    await service.findAll(clientUser);

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { createdById: clientUser.id },
          { members: { some: { userId: clientUser.id } } },
        ],
      },
      select: {
        id: true,
        companyName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        groupId: true,
        runId: true,
        client: {
          select: { id: true, name: true, status: true },
        },
        kickoff: {
          select: {
            status: true,
          },
        },
        deliveryReview: {
          select: {
            status: true,
          },
        },
        clientInvites: {
          select: {
            status: true,
          },
        },
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: {
            status: true,
          },
        },
        workOrders: {
          select: {
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findAll scopes PM users to owned or member projects', async () => {
    await service.findAll(pmUser);

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { createdById: pmUser.id },
          { members: { some: { userId: pmUser.id } } },
          { group: { members: { some: { userId: pmUser.id, status: 'ACTIVE' } } } },
        ],
      },
      select: {
        id: true,
        companyName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        groupId: true,
        runId: true,
        client: {
          select: { id: true, name: true, status: true },
        },
        kickoff: {
          select: {
            status: true,
          },
        },
        deliveryReview: {
          select: {
            status: true,
          },
        },
        clientInvites: {
          select: {
            status: true,
          },
        },
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: {
            status: true,
          },
        },
        workOrders: {
          select: {
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findAll returns derived lifecycle summaries', async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 'project-1',
        companyName: 'Acme Logistics',
        status: 'PENDING',
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T01:00:00.000Z'),
        runId: null,
        kickoff: { status: ProjectKickoffStatus.READY },
        deliveryReview: null,
        clientInvites: [{ status: 'ACCEPTED' }],
        artifacts: [],
        tasks: [{ status: ProjectTaskStatus.TODO }],
        workOrders: [{ status: WorkOrderStatus.READY }],
      },
      {
        id: 'project-2',
        companyName: 'Revision Co',
        status: 'GENERATING_CODE',
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T01:00:00.000Z'),
        runId: 'run-1',
        kickoff: { status: ProjectKickoffStatus.READY },
        deliveryReview: { status: ProjectDeliveryReviewStatus.REVISION_REQUESTED },
        clientInvites: [{ status: 'ACCEPTED' }],
        artifacts: [
          {
            clientVisible: true,
            reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
            revisionHandledAt: null,
          },
        ],
        tasks: [{ status: ProjectTaskStatus.IN_PROGRESS }],
        workOrders: [{ status: WorkOrderStatus.DISPATCHED }],
      },
    ]);

    await expect(service.findAll(pmUser)).resolves.toEqual([
      expect.objectContaining({
        id: 'project-1',
        lifecycle: expect.objectContaining({
          stage: 'READY_FOR_ORCHESTRATION',
          nextAction: 'Start orchestration',
          signals: expect.objectContaining({
            kickoffReady: true,
            openTasks: 1,
            activeWorkOrders: 1,
          }),
        }),
      }),
      expect.objectContaining({
        id: 'project-2',
        lifecycle: expect.objectContaining({
          stage: 'REVISION',
          nextAction: 'Resolve revision',
          signals: expect.objectContaining({
            revisionOpen: true,
            orchestrationStarted: true,
          }),
        }),
      }),
    ]);
  });

  it('findAll returns a cursor page when pagination is requested', async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 'project-2',
        companyName: 'Second Co',
        status: 'PENDING',
        createdAt: new Date('2026-05-29T00:00:00.000Z'),
        updatedAt: new Date('2026-05-29T01:00:00.000Z'),
        runId: null,
        kickoff: { status: ProjectKickoffStatus.READY },
        deliveryReview: null,
        clientInvites: [{ status: 'ACCEPTED' }],
        artifacts: [],
        tasks: [{ status: ProjectTaskStatus.TODO }],
        workOrders: [{ status: WorkOrderStatus.READY }],
      },
      {
        id: 'project-3',
        companyName: 'Third Co',
        status: 'PENDING',
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T01:00:00.000Z'),
        runId: null,
        kickoff: null,
        deliveryReview: null,
        clientInvites: [],
        artifacts: [],
        tasks: [],
        workOrders: [],
      },
      {
        id: 'project-4',
        companyName: 'Fourth Co',
        status: 'PENDING',
        createdAt: new Date('2026-05-27T00:00:00.000Z'),
        updatedAt: new Date('2026-05-27T01:00:00.000Z'),
        runId: null,
        kickoff: null,
        deliveryReview: null,
        clientInvites: [],
        artifacts: [],
        tasks: [],
        workOrders: [],
      },
    ]);

    await expect(
      service.findAll(pmUser, { limit: '2', cursor: 'project-1' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: 'project-2',
          lifecycle: expect.objectContaining({
            stage: 'READY_FOR_ORCHESTRATION',
          }),
        }),
        expect.objectContaining({
          id: 'project-3',
          lifecycle: expect.any(Object),
        }),
      ],
      nextCursor: 'project-4',
    });

    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { createdById: pmUser.id },
          { members: { some: { userId: pmUser.id } } },
          { group: { members: { some: { userId: pmUser.id, status: 'ACTIVE' } } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'project-1' },
      skip: 1,
    }));
  });

  it('findOne lets DEV users access projects where they are members', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      gates: [],
      members: [],
      createdBy: null,
      runBudget: null,
      _count: { artifacts: 0, eventLogs: 0 },
    });

    await service.findOne('project-1', devUser);

    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'project-1',
        OR: [
          { createdById: devUser.id },
          { members: { some: { userId: devUser.id } } },
          { group: { members: { some: { userId: devUser.id, status: 'ACTIVE' } } } },
        ],
      },
      include: expect.any(Object),
    });
  });

  it('update applies editable project fields after access check', async () => {
    prisma.project.findFirst
      .mockResolvedValueOnce({ id: 'project-1' })
      .mockResolvedValueOnce({
        id: 'project-1',
        gates: [],
        members: [],
        createdBy: null,
        runBudget: null,
        _count: { artifacts: 0, eventLogs: 0 },
      });

    await service.update(
      'project-1',
      pmUser,
      {
        companyName: 'New Co',
        brief: 'A longer updated project brief',
        stackKey: 'nextjs-nestjs-supabase',
      },
    );

    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: {
        companyName: 'New Co',
        brief: 'A longer updated project brief',
        stackKey: 'nextjs-nestjs-supabase',
        status: undefined,
        repoUrl: undefined,
        version: { increment: 1 },
      },
    });
  });

  it('update rejects stale project versions without writing timeline events', async () => {
    prisma.project.findFirst.mockResolvedValueOnce({ id: 'project-1' });
    prisma.project.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.update('project-1', pmUser, {
        companyName: 'New Co',
        version: 7,
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: 'project-1', version: 7 },
      data: {
        companyName: 'New Co',
        brief: undefined,
        stackKey: undefined,
        status: undefined,
        repoUrl: undefined,
        version: { increment: 1 },
      },
    });
    expect(prisma.projectTimelineEvent.create).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('addMember upserts by email and returns project detail', async () => {
    prisma.project.findFirst
      .mockResolvedValueOnce({ id: 'project-1' })
      .mockResolvedValueOnce({
        id: 'project-1',
        gates: [],
        members: [],
        createdBy: null,
        runBudget: null,
        _count: { artifacts: 0, eventLogs: 0 },
      });
    prisma.profile.findFirst.mockResolvedValue({ id: clientUser.id, role: UserRole.CLIENT });

    await service.addMember('project-1', pmUser, {
      email: clientUser.email ?? undefined,
      role: UserRole.CLIENT,
    });

    expect(prisma.projectMember.upsert).toHaveBeenCalledWith({
      where: {
        projectId_userId: {
          projectId: 'project-1',
          userId: clientUser.id,
        },
      },
      update: { role: UserRole.CLIENT },
      create: {
        projectId: 'project-1',
        userId: clientUser.id,
        role: UserRole.CLIENT,
      },
    });
  });

  it('addMember rejects incompatible profile and project roles', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.profile.findFirst.mockResolvedValue({ id: clientUser.id, role: UserRole.CLIENT });

    await expect(
      service.addMember('project-1', pmUser, {
        email: clientUser.email ?? undefined,
        role: UserRole.DEV,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.projectMember.upsert).not.toHaveBeenCalled();
  });

  it('removeMember rejects removing the last project manager', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.project.findUnique.mockResolvedValue({
      createdById: pmUser.id,
      members: [],
    });

    await expect(
      service.removeMember('project-1', pmUser.id, pmUser),
    ).rejects.toThrow('Cannot remove the last project manager');

    expect(prisma.projectMember.delete).not.toHaveBeenCalled();
  });

  it('findEvents returns recent event logs after access check', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await service.findEvents('project-1', devUser);

    expect(prisma.eventLog.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });
  });

  it('findEvents returns a cursor page when pagination is requested', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.eventLog.findMany.mockResolvedValue([
      { id: 'event-2', projectId: 'project-1' },
      { id: 'event-3', projectId: 'project-1' },
      { id: 'event-4', projectId: 'project-1' },
    ]);

    await expect(
      service.findEvents('project-1', devUser, { limit: 2, cursor: 'event-1' }),
    ).resolves.toEqual({
      items: [
        { id: 'event-2', projectId: 'project-1' },
        { id: 'event-3', projectId: 'project-1' },
      ],
      nextCursor: 'event-4',
    });

    expect(prisma.eventLog.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'event-1' },
      skip: 1,
    });
  });

  it('findTimeline limits CLIENT users to client-visible events', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await service.findTimeline('project-1', clientUser);

    expect(prisma.projectTimelineEvent.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        visibility: { in: [ProjectTimelineVisibility.CLIENT] },
      },
      include: expect.any(Object),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  it('findTimeline returns a cursor page when pagination is requested', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTimelineEvent.findMany.mockResolvedValue([
      { id: 'timeline-2', projectId: 'project-1' },
      { id: 'timeline-3', projectId: 'project-1' },
      { id: 'timeline-4', projectId: 'project-1' },
    ]);

    await expect(
      service.findTimeline('project-1', devUser, {
        limit: '2',
        cursor: 'timeline-1',
      }),
    ).resolves.toEqual({
      items: [
        { id: 'timeline-2', projectId: 'project-1' },
        { id: 'timeline-3', projectId: 'project-1' },
      ],
      nextCursor: 'timeline-4',
    });

    expect(prisma.projectTimelineEvent.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        visibility: {
          in: [
            ProjectTimelineVisibility.TEAM,
            ProjectTimelineVisibility.CLIENT,
          ],
        },
      },
      include: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'timeline-1' },
      skip: 1,
    });
  });

  it('findTimeline lets DEV users see team and client events', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await service.findTimeline('project-1', devUser);

    expect(prisma.projectTimelineEvent.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        visibility: {
          in: [
            ProjectTimelineVisibility.TEAM,
            ProjectTimelineVisibility.CLIENT,
          ],
        },
      },
      include: expect.any(Object),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  it('findArtifact returns a project artifact after access check', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      agentType: 'frontend',
      filePath: 'src/app/page.tsx',
      content: 'export default function Page() {}',
      clientVisible: false,
      displayName: null,
      sharedAt: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.findArtifact('project-1', 'artifact-1', devUser);

    expect(prisma.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'artifact-1',
        projectId: 'project-1',
      },
    });
  });

  it('findArtifacts omits raw content for client users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await service.findArtifacts('project-1', clientUser);

    expect(prisma.artifact.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', clientVisible: true },
      select: {
        id: true,
        projectId: true,
        agentType: true,
        filePath: true,
        clientVisible: true,
        displayName: true,
        sharedAt: true,
        reviewStatus: true,
        reviewNote: true,
        reviewedAt: true,
        reviewedById: true,
        outputReviewStatus: true,
        outputReviewNote: true,
        outputReviewedAt: true,
        outputReviewedById: true,
        validationStatus: true,
        validationSummary: true,
        validationErrors: true,
        publishedAt: true,
        publishedById: true,
        revisionHandledAt: true,
        revisionHandledById: true,
        revisionResolutionNote: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('findArtifacts returns a cursor page for client-visible artifacts when pagination is requested', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findMany.mockResolvedValue([
      { id: 'artifact-2', projectId: 'project-1' },
      { id: 'artifact-3', projectId: 'project-1' },
      { id: 'artifact-4', projectId: 'project-1' },
    ]);

    await expect(
      service.findArtifacts('project-1', clientUser, {
        limit: '2',
        cursor: 'artifact-1',
      }),
    ).resolves.toEqual({
      items: [
        { id: 'artifact-2', projectId: 'project-1' },
        { id: 'artifact-3', projectId: 'project-1' },
      ],
      nextCursor: 'artifact-4',
    });

    expect(prisma.artifact.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', clientVisible: true },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'artifact-1' },
      skip: 1,
    });
  });

  it('updateArtifactSharing marks an artifact client-visible for PM users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue({ id: 'artifact-1' });
    prisma.artifact.update.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      agentType: 'frontend',
      filePath: 'src/app/page.tsx',
      content: 'export default function Page() {}',
      clientVisible: true,
      displayName: 'Frontend preview',
      sharedAt: new Date('2026-05-28T00:00:00.000Z'),
      reviewStatus: ArtifactReviewStatus.PENDING,
      reviewNote: null,
      reviewedAt: null,
      reviewedById: null,
      revisionHandledAt: null,
      revisionHandledById: null,
      revisionResolutionNote: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.updateArtifactSharing('project-1', 'artifact-1', pmUser, {
      clientVisible: true,
      displayName: 'Frontend preview',
    });

    expect(prisma.artifact.update).toHaveBeenCalledWith({
      where: { id: 'artifact-1' },
      data: {
        clientVisible: true,
        displayName: 'Frontend preview',
        sharedAt: expect.any(Date),
        reviewStatus: undefined,
        reviewNote: undefined,
        reviewedAt: undefined,
        reviewedById: undefined,
        revisionHandledAt: undefined,
        revisionHandledById: undefined,
        revisionResolutionNote: undefined,
      },
    });
  });

  it('publishArtifactOutput promotes a generated artifact to client review', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue({
      id: 'artifact-1',
      filePath: 'work-orders/work-order-1/frontend-output.md',
      displayName: 'Frontend output',
    });
    prisma.artifact.update.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      filePath: 'work-orders/work-order-1/frontend-output.md',
      displayName: 'Frontend output',
      clientVisible: true,
      outputReviewStatus: ArtifactOutputReviewStatus.PUBLISHED,
    });

    await service.publishArtifactOutput('project-1', 'artifact-1', pmUser, {
      displayName: 'Frontend output',
    });

    expect(prisma.artifact.update).toHaveBeenCalledWith({
      where: { id: 'artifact-1' },
      data: expect.objectContaining({
        clientVisible: true,
        displayName: 'Frontend output',
        reviewStatus: ArtifactReviewStatus.PENDING,
        outputReviewStatus: ArtifactOutputReviewStatus.PUBLISHED,
        publishedById: pmUser.id,
        publishedAt: expect.any(Date),
      }),
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: [clientUser.id],
      type: NotificationType.ARTIFACT_PUBLISHED,
      artifactId: 'artifact-1',
    }));
    expect(prisma.projectTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: ProjectTimelineEventType.ARTIFACT_PUBLISHED,
        visibility: ProjectTimelineVisibility.CLIENT,
        artifactId: 'artifact-1',
      }),
    });
  });

  it('reviewArtifactOutput creates developer rework from a PM rework request', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      agentType: 'frontend',
      filePath: 'work-orders/work-order-1/frontend-output.md',
      displayName: 'Frontend output',
      content: 'Generated output',
      workOrders: [
        {
          id: 'work-order-1',
          agentType: WorkOrderAgentType.FRONTEND,
          taskId: 'task-1',
          task: {
            id: 'task-1',
            title: 'Frontend shell',
            assignedToId: devUser.id,
          },
        },
      ],
    });
    prisma.artifact.update.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      filePath: 'work-orders/work-order-1/frontend-output.md',
      displayName: 'Frontend output',
      outputReviewStatus: ArtifactOutputReviewStatus.REWORK_REQUESTED,
      outputReviewNote: 'Tighten spacing.',
    });
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'member-dev' });
    prisma.projectTask.create.mockResolvedValue({
      id: 'task-rework',
      projectId: 'project-1',
      artifactId: 'artifact-1',
      title: 'Rework: Frontend output',
      description: 'Tighten spacing.',
      status: ProjectTaskStatus.TODO,
      assignedToId: devUser.id,
      createdById: pmUser.id,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      assignedTo: null,
      createdBy: null,
      artifact: null,
    });
    prisma.workOrder.create.mockResolvedValue({
      id: 'work-order-rework',
      projectId: 'project-1',
      taskId: 'task-rework',
      artifactId: 'artifact-1',
      title: 'Rework handoff: Frontend output',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      task: { assignedToId: devUser.id },
      artifact: null,
      createdBy: null,
    });

    await service.reviewArtifactOutput('project-1', 'artifact-1', pmUser, {
      status: ArtifactOutputReviewStatus.REWORK_REQUESTED,
      note: ' Tighten spacing. ',
    });

    expect(prisma.artifact.update).toHaveBeenCalledWith({
      where: { id: 'artifact-1' },
      data: {
        outputReviewStatus: ArtifactOutputReviewStatus.REWORK_REQUESTED,
        outputReviewNote: 'Tighten spacing.',
        outputReviewedAt: expect.any(Date),
        outputReviewedById: pmUser.id,
      },
    });
    expect(prisma.projectTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        artifactId: 'artifact-1',
        assignedToId: devUser.id,
        title: 'Rework: Frontend output',
      }),
      include: expect.any(Object),
    });
    expect(prisma.workOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        taskId: 'task-rework',
        artifactId: 'artifact-1',
        status: WorkOrderStatus.READY,
      }),
      include: expect.any(Object),
    });
  });

  it('reviewArtifact lets clients review shared artifacts without raw content', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue({ id: 'artifact-1' });
    prisma.artifact.update.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      agentType: 'frontend',
      filePath: 'src/app/page.tsx',
      clientVisible: true,
      displayName: 'Frontend preview',
      sharedAt: new Date('2026-05-28T00:00:00.000Z'),
      reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
      reviewNote: 'Please adjust the dashboard copy.',
      reviewedAt: new Date('2026-05-28T00:00:00.000Z'),
      reviewedById: clientUser.id,
      revisionHandledAt: null,
      revisionHandledById: null,
      revisionResolutionNote: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.reviewArtifact('project-1', 'artifact-1', clientUser, {
      reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
      reviewNote: 'Please adjust the dashboard copy.',
    });

    expect(prisma.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'artifact-1',
        projectId: 'project-1',
        clientVisible: true,
      },
      select: { id: true },
    });
    expect(prisma.artifact.update).toHaveBeenCalledWith({
      where: { id: 'artifact-1' },
      data: {
        reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
        reviewNote: 'Please adjust the dashboard copy.',
        reviewedAt: expect.any(Date),
        reviewedById: clientUser.id,
        revisionHandledAt: null,
        revisionHandledById: null,
        revisionResolutionNote: null,
      },
      select: {
        id: true,
        projectId: true,
        agentType: true,
        filePath: true,
        clientVisible: true,
        displayName: true,
        sharedAt: true,
        reviewStatus: true,
        reviewNote: true,
        reviewedAt: true,
        reviewedById: true,
        outputReviewStatus: true,
        outputReviewNote: true,
        outputReviewedAt: true,
        outputReviewedById: true,
        validationStatus: true,
        validationSummary: true,
        validationErrors: true,
        publishedAt: true,
        publishedById: true,
        revisionHandledAt: true,
        revisionHandledById: true,
        revisionResolutionNote: true,
        createdAt: true,
      },
    });
  });

  it('handleRevision marks a revision request handled for PM users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue({ id: 'artifact-1' });
    prisma.artifact.update.mockResolvedValue({
      id: 'artifact-1',
      projectId: 'project-1',
      agentType: 'frontend',
      filePath: 'src/app/page.tsx',
      content: 'export default function Page() {}',
      clientVisible: true,
      displayName: 'Frontend preview',
      sharedAt: new Date('2026-05-28T00:00:00.000Z'),
      reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
      reviewNote: 'Please adjust the dashboard copy.',
      reviewedAt: new Date('2026-05-28T00:00:00.000Z'),
      reviewedById: clientUser.id,
      revisionHandledAt: new Date('2026-05-28T01:00:00.000Z'),
      revisionHandledById: pmUser.id,
      revisionResolutionNote: 'Queued for the frontend developer.',
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.handleRevision('project-1', 'artifact-1', pmUser, {
      resolutionNote: '  Queued for the frontend developer.  ',
    });

    expect(prisma.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'artifact-1',
        projectId: 'project-1',
        reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
      },
      select: { id: true },
    });
    expect(prisma.artifact.update).toHaveBeenCalledWith({
      where: { id: 'artifact-1' },
      data: {
        revisionHandledAt: expect.any(Date),
        revisionHandledById: pmUser.id,
        revisionResolutionNote: 'Queued for the frontend developer.',
      },
    });
  });

  it('handleRevision rejects artifacts without an active revision request', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue(null);

    await expect(
      service.handleRevision('project-1', 'artifact-1', pmUser, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requestDeliveryRevision records a project-level client revision request', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectDeliveryReview.upsert.mockResolvedValue({
      id: 'delivery-review-1',
      projectId: 'project-1',
      status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
      revisionNote: 'Please adjust final handover.',
      revisionRequestedById: clientUser.id,
      revisionRequestedAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.requestDeliveryRevision('project-1', clientUser, {
      note: '  Please adjust final handover.  ',
    });

    expect(prisma.projectDeliveryReview.upsert).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      update: {
        status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
        revisionNote: 'Please adjust final handover.',
        revisionRequestedById: clientUser.id,
        revisionRequestedAt: expect.any(Date),
        revisionResolvedById: null,
        revisionResolvedAt: null,
        resolutionNote: null,
        version: { increment: 1 },
      },
      create: {
        projectId: 'project-1',
        status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
        revisionNote: 'Please adjust final handover.',
        revisionRequestedById: clientUser.id,
        revisionRequestedAt: expect.any(Date),
      },
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      type: NotificationType.DELIVERY_REVISION_REQUESTED,
      recipientIds: [pmUser.id],
    }));
  });

  it('acceptDelivery rejects final acceptance when shared artifact reviews are open', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.clientInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    prisma.artifact.findMany.mockResolvedValue([
      {
        id: 'artifact-1',
        agentType: 'frontend',
        reviewStatus: ArtifactReviewStatus.PENDING,
        revisionHandledAt: null,
        validationStatus: ArtifactValidationStatus.PASSED,
      },
    ]);

    await expect(
      service.acceptDelivery('project-1', clientUser, {}),
    ).rejects.toThrow('All published artifacts must be approved by the client before accepting delivery');

    expect(prisma.projectDeliveryReview.upsert).not.toHaveBeenCalled();
  });

  it('acceptDelivery rejects final acceptance when client-visible documents are not approved', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.clientInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    prisma.artifact.findMany.mockResolvedValue([
      {
        id: 'artifact-1',
        agentType: 'frontend',
        reviewStatus: ArtifactReviewStatus.APPROVED,
        revisionHandledAt: null,
        validationStatus: ArtifactValidationStatus.PASSED,
      },
    ]);
    prisma.collaborationDocument.count.mockResolvedValue(1);

    await expect(
      service.acceptDelivery('project-1', clientUser, {}),
    ).rejects.toThrow('Resolve all client-visible document reviews before accepting delivery');

    expect(prisma.collaborationDocument.count).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        clientVisible: true,
        status: {
          notIn: [
            CollaborationDocumentStatus.APPROVED,
            CollaborationDocumentStatus.ARCHIVED,
          ],
        },
      },
    });
    expect(prisma.projectDeliveryReview.upsert).not.toHaveBeenCalled();
  });

  it('acceptDelivery rejects clients without an accepted invite', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.clientInvite.findFirst.mockResolvedValue(null);

    await expect(
      service.acceptDelivery('project-1', clientUser, {}),
    ).rejects.toThrow('Client invite must be accepted before final delivery can be accepted');

    expect(prisma.projectDeliveryReview.upsert).not.toHaveBeenCalled();
  });

  it('acceptDelivery marks cleared delivery accepted and project delivered', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.clientInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    prisma.artifact.findMany.mockResolvedValue([
      {
        id: 'artifact-1',
        agentType: 'frontend',
        reviewStatus: ArtifactReviewStatus.APPROVED,
        revisionHandledAt: null,
        validationStatus: ArtifactValidationStatus.PASSED,
      },
    ]);
    prisma.collaborationDocument.count.mockResolvedValue(0);
    prisma.workOrder.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ agentType: WorkOrderAgentType.FRONTEND }]);
    prisma.projectDeliveryReview.upsert.mockResolvedValue({
      id: 'delivery-review-1',
      projectId: 'project-1',
      status: ProjectDeliveryReviewStatus.ACCEPTED,
      acceptanceNote: 'Looks good.',
      acceptedById: clientUser.id,
      acceptedAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.acceptDelivery('project-1', clientUser, {
      note: ' Looks good. ',
    });

    expect(prisma.projectDeliveryReview.upsert).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      update: {
        status: ProjectDeliveryReviewStatus.ACCEPTED,
        acceptanceNote: 'Looks good.',
        acceptedById: clientUser.id,
        acceptedAt: expect.any(Date),
        version: { increment: 1 },
      },
      create: {
        projectId: 'project-1',
        status: ProjectDeliveryReviewStatus.ACCEPTED,
        acceptanceNote: 'Looks good.',
        acceptedById: clientUser.id,
        acceptedAt: expect.any(Date),
      },
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { status: ProjectStatus.DELIVERED, version: { increment: 1 } },
    });
  });

  it('acceptDelivery rejects stale delivery review versions without side effects', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.clientInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    prisma.artifact.findMany.mockResolvedValue([
      {
        id: 'artifact-1',
        agentType: 'frontend',
        reviewStatus: ArtifactReviewStatus.APPROVED,
        revisionHandledAt: null,
        validationStatus: ArtifactValidationStatus.PASSED,
      },
    ]);
    prisma.collaborationDocument.count.mockResolvedValue(0);
    prisma.workOrder.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ agentType: WorkOrderAgentType.FRONTEND }]);
    prisma.projectDeliveryReview.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.acceptDelivery('project-1', clientUser, {
        note: ' Looks good. ',
        version: 3,
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.projectDeliveryReview.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', version: 3 },
      data: {
        status: ProjectDeliveryReviewStatus.ACCEPTED,
        acceptanceNote: 'Looks good.',
        acceptedById: clientUser.id,
        acceptedAt: expect.any(Date),
        version: { increment: 1 },
      },
    });
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(prisma.projectTimelineEvent.create).not.toHaveBeenCalled();
  });

  it('findDeliveryReadiness reports concrete final delivery blockers', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.clientInvite.findFirst.mockResolvedValue({ id: 'invite-1' });
    prisma.artifact.findMany.mockResolvedValue([
      {
        id: 'artifact-1',
        agentType: 'frontend',
        reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
        revisionHandledAt: null,
        validationStatus: ArtifactValidationStatus.FAILED,
      },
    ]);
    prisma.collaborationDocument.count.mockResolvedValue(1);
    prisma.workOrder.findMany
      .mockResolvedValueOnce([{ id: 'work-order-1' }])
      .mockResolvedValueOnce([{ agentType: WorkOrderAgentType.BACKEND }]);
    prisma.projectDeliveryReview.findUnique.mockResolvedValue({
      status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
    });

    const readiness = await service.findDeliveryReadiness('project-1', clientUser);

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual([
      'MISSING_REQUIRED_ARTIFACT_COVERAGE',
      'PUBLISHED_ARTIFACTS_NOT_VALIDATED',
      'PUBLISHED_ARTIFACTS_NOT_APPROVED',
      'ARTIFACT_REVISIONS_OPEN',
      'DOCUMENT_REVIEWS_OPEN',
      'WORK_ORDERS_ACTIVE_OR_FAILED',
      'DELIVERY_REVISION_OPEN',
    ]);
    expect(readiness.counts).toEqual({
      publishedArtifacts: 1,
      invalidPublishedArtifacts: 1,
      unapprovedPublishedArtifacts: 1,
      activeWorkOrders: 1,
      openDocuments: 1,
      openArtifactRevisions: 1,
      missingAgentTypes: 1,
    });
  });

  it('resolveDeliveryRevision marks the project-level request resolved for PM users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectDeliveryReview.findUnique.mockResolvedValue({
      id: 'delivery-review-1',
      projectId: 'project-1',
      status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
    });
    prisma.projectDeliveryReview.update.mockResolvedValue({
      id: 'delivery-review-1',
      projectId: 'project-1',
      status: ProjectDeliveryReviewStatus.REVISION_RESOLVED,
      resolutionNote: 'Updated the handover package.',
      revisionResolvedById: pmUser.id,
      revisionResolvedAt: new Date('2026-05-28T00:00:00.000Z'),
    });

    await service.resolveDeliveryRevision('project-1', pmUser, {
      note: ' Updated the handover package. ',
    });

    expect(prisma.projectDeliveryReview.update).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      data: {
        status: ProjectDeliveryReviewStatus.REVISION_RESOLVED,
        revisionResolvedById: pmUser.id,
        revisionResolvedAt: expect.any(Date),
        resolutionNote: 'Updated the handover package.',
        version: { increment: 1 },
      },
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      type: NotificationType.DELIVERY_REVISION_RESOLVED,
      recipientIds: [clientUser.id],
    }));
  });

  it('findTasks returns only assigned tasks for DEV users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await service.findTasks('project-1', devUser);

    expect(prisma.projectTask.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        assignedToId: devUser.id,
      },
      include: expect.any(Object),
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('findTasks returns a cursor page when pagination is requested', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findMany.mockResolvedValue([
      { id: 'task-2', projectId: 'project-1' },
      { id: 'task-3', projectId: 'project-1' },
      { id: 'task-4', projectId: 'project-1' },
    ]);

    await expect(
      service.findTasks('project-1', devUser, { limit: 2, cursor: 'task-1' }),
    ).resolves.toEqual({
      items: [
        { id: 'task-2', projectId: 'project-1' },
        { id: 'task-3', projectId: 'project-1' },
      ],
      nextCursor: 'task-4',
    });

    expect(prisma.projectTask.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        assignedToId: devUser.id,
      },
      include: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'task-1' },
      skip: 1,
    });
  });

  it('createTask creates a PM task linked to an assigned developer and artifact', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'member-1' });
    prisma.artifact.findFirst.mockResolvedValue({ id: 'artifact-1' });
    prisma.projectTask.create.mockResolvedValue({
      id: 'task-1',
      projectId: 'project-1',
      artifactId: 'artifact-1',
      title: 'Fix dashboard copy',
      description: 'Apply requested copy updates.',
      status: ProjectTaskStatus.TODO,
      assignedToId: devUser.id,
      createdById: pmUser.id,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      assignedTo: null,
      createdBy: null,
      artifact: null,
    });

    await service.createTask('project-1', pmUser, {
      title: '  Fix dashboard copy  ',
      description: '  Apply requested copy updates.  ',
      assignedToId: devUser.id,
      artifactId: 'artifact-1',
    });

    expect(prisma.projectMember.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        userId: devUser.id,
        role: UserRole.DEV,
      },
      select: { id: true },
    });
    expect(prisma.projectTask.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        title: 'Fix dashboard copy',
        description: 'Apply requested copy updates.',
        status: ProjectTaskStatus.TODO,
        assignedToId: devUser.id,
        artifactId: 'artifact-1',
        createdById: pmUser.id,
      },
      include: expect.any(Object),
    });
    expect(prisma.projectTaskActivity.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        taskId: 'task-1',
        actorId: pmUser.id,
        type: ProjectTaskActivityType.TASK_CREATED,
        message: 'Task created: Fix dashboard copy',
        metadata: {
          status: ProjectTaskStatus.TODO,
          assignedToId: devUser.id,
          artifactId: 'artifact-1',
        },
      },
    });
  });

  it('updateTask lets assigned DEV users update only status', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: devUser.id,
      artifactId: null,
      status: ProjectTaskStatus.TODO,
    });
    prisma.projectTask.update.mockResolvedValue({
      id: 'task-1',
      projectId: 'project-1',
      artifactId: null,
      title: 'Fix dashboard copy',
      description: null,
      status: ProjectTaskStatus.IN_PROGRESS,
      assignedToId: devUser.id,
      createdById: pmUser.id,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      assignedTo: null,
      createdBy: null,
      artifact: null,
    });

    await service.updateTask('project-1', 'task-1', devUser, {
      status: ProjectTaskStatus.IN_PROGRESS,
    });

    expect(prisma.projectTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: {
        title: undefined,
        description: undefined,
        status: ProjectTaskStatus.IN_PROGRESS,
        assignedToId: undefined,
        artifactId: undefined,
        version: { increment: 1 },
      },
      include: expect.any(Object),
    });
    expect(prisma.projectTaskActivity.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        taskId: 'task-1',
        actorId: devUser.id,
        type: ProjectTaskActivityType.STATUS_CHANGED,
        message: 'Status changed to IN_PROGRESS',
        metadata: {
          from: ProjectTaskStatus.TODO,
          to: ProjectTaskStatus.IN_PROGRESS,
        },
      },
    });
  });

  it('updateTask rejects DEV edits to manager-owned fields', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: devUser.id,
      artifactId: null,
      status: ProjectTaskStatus.TODO,
    });

    await expect(
      service.updateTask('project-1', 'task-1', devUser, {
        title: 'Rename task',
      }),
    ).rejects.toThrow('Developers can only update task status');
  });

  it('updateTask rejects stale versions without writing activity', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: devUser.id,
      artifactId: null,
      status: ProjectTaskStatus.TODO,
      version: 3,
    });
    prisma.projectTask.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateTask('project-1', 'task-1', devUser, {
        status: ProjectTaskStatus.IN_PROGRESS,
        version: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.projectTask.updateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', version: 2 },
      data: expect.objectContaining({
        status: ProjectTaskStatus.IN_PROGRESS,
        version: { increment: 1 },
      }),
    });
    expect(prisma.projectTaskActivity.create).not.toHaveBeenCalled();
  });

  it('findTaskActivity returns task activity for assigned DEV users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: devUser.id,
    });

    await service.findTaskActivity('project-1', 'task-1', devUser);

    expect(prisma.projectTaskActivity.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        taskId: 'task-1',
      },
      include: expect.any(Object),
      orderBy: { createdAt: 'asc' },
    });
  });

  it('findTaskActivity returns a cursor page when pagination is requested', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: devUser.id,
    });
    prisma.projectTaskActivity.findMany.mockResolvedValue([
      { id: 'activity-2', projectId: 'project-1', taskId: 'task-1' },
      { id: 'activity-3', projectId: 'project-1', taskId: 'task-1' },
      { id: 'activity-4', projectId: 'project-1', taskId: 'task-1' },
    ]);

    await expect(
      service.findTaskActivity('project-1', 'task-1', devUser, {
        limit: 2,
        cursor: 'activity-1',
      }),
    ).resolves.toEqual({
      items: [
        { id: 'activity-2', projectId: 'project-1', taskId: 'task-1' },
        { id: 'activity-3', projectId: 'project-1', taskId: 'task-1' },
      ],
      nextCursor: 'activity-4',
    });

    expect(prisma.projectTaskActivity.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        taskId: 'task-1',
      },
      include: expect.any(Object),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'activity-1' },
      skip: 1,
    });
  });

  it('addTaskComment creates a comment activity for PM users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: devUser.id,
    });
    prisma.projectTaskActivity.create.mockResolvedValue({
      id: 'activity-1',
      projectId: 'project-1',
      taskId: 'task-1',
      actorId: pmUser.id,
      type: ProjectTaskActivityType.COMMENT,
      message: 'Please prioritize this before review.',
      metadata: {},
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      actor: null,
    });

    await service.addTaskComment('project-1', 'task-1', pmUser, {
      message: '  Please prioritize this before review.  ',
    });

    expect(prisma.projectTaskActivity.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        taskId: 'task-1',
        actorId: pmUser.id,
        type: ProjectTaskActivityType.COMMENT,
        message: 'Please prioritize this before review.',
      },
      include: expect.any(Object),
    });
  });

  it('addTaskComment rejects unassigned DEV users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({
      id: 'task-1',
      assignedToId: clientUser.id,
    });

    await expect(
      service.addTaskComment('project-1', 'task-1', devUser, {
        message: 'I should not see this.',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findWorkOrders returns only assigned task work orders for DEV users', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await service.findWorkOrders('project-1', devUser);

    expect(prisma.workOrder.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        task: { assignedToId: devUser.id },
      },
      include: expect.any(Object),
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('findWorkOrders returns a cursor page when pagination is requested', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.workOrder.findMany.mockResolvedValue([
      { id: 'work-order-2', projectId: 'project-1' },
      { id: 'work-order-3', projectId: 'project-1' },
      { id: 'work-order-4', projectId: 'project-1' },
    ]);

    await expect(
      service.findWorkOrders('project-1', devUser, {
        limit: 2,
        cursor: 'work-order-1',
      }),
    ).resolves.toEqual({
      items: [
        { id: 'work-order-2', projectId: 'project-1' },
        { id: 'work-order-3', projectId: 'project-1' },
      ],
      nextCursor: 'work-order-4',
    });

    expect(prisma.workOrder.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        task: { assignedToId: devUser.id },
      },
      include: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'work-order-1' },
      skip: 1,
    });
  });

  it('createWorkOrder validates linked records and notifies the assigned developer', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.projectTask.findFirst.mockResolvedValue({ id: 'task-1' });
    prisma.artifact.findFirst.mockResolvedValue({ id: 'artifact-1' });
    prisma.workOrder.create.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'project-1',
      taskId: 'task-1',
      artifactId: 'artifact-1',
      title: 'Implement dashboard handoff',
      instructions: 'Build the dev dashboard from the approved artifact.',
      agentType: WorkOrderAgentType.FRONTEND,
      status: WorkOrderStatus.DRAFT,
      priority: WorkOrderPriority.HIGH,
      createdById: pmUser.id,
      dispatchedAt: null,
      completedAt: null,
      failedAt: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      task: {
        id: 'task-1',
        title: 'Implement dashboard',
        assignedToId: devUser.id,
        status: ProjectTaskStatus.TODO,
      },
      artifact: {
        id: 'artifact-1',
        filePath: 'src/app/page.tsx',
        displayName: 'Dashboard artifact',
        reviewStatus: ArtifactReviewStatus.PENDING,
      },
      createdBy: null,
    });

    await service.createWorkOrder('project-1', pmUser, {
      title: '  Implement dashboard handoff  ',
      instructions: '  Build the dev dashboard from the approved artifact.  ',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      taskId: 'task-1',
      artifactId: 'artifact-1',
    });

    expect(prisma.projectTask.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'task-1',
        projectId: 'project-1',
      },
      select: { id: true },
    });
    expect(prisma.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'artifact-1',
        projectId: 'project-1',
      },
      select: { id: true },
    });
    expect(prisma.workOrder.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        title: 'Implement dashboard handoff',
        instructions: 'Build the dev dashboard from the approved artifact.',
        agentType: WorkOrderAgentType.FRONTEND,
        priority: WorkOrderPriority.HIGH,
        taskId: 'task-1',
        artifactId: 'artifact-1',
        createdById: pmUser.id,
      },
      include: expect.any(Object),
    });
    expect(prisma.projectTimelineEvent.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        actorId: pmUser.id,
        taskId: 'task-1',
        artifactId: 'artifact-1',
        type: ProjectTimelineEventType.WORK_ORDER_CREATED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Work order created',
        body: 'Implement dashboard handoff',
        metadata: {
          workOrderId: 'work-order-1',
          agentType: WorkOrderAgentType.FRONTEND,
          priority: WorkOrderPriority.HIGH,
        },
      },
    });
    expect(notifications.notify).toHaveBeenCalledWith({
      recipientIds: [devUser.id],
      actorId: pmUser.id,
      projectId: 'project-1',
      taskId: 'task-1',
      artifactId: 'artifact-1',
      type: NotificationType.WORK_ORDER_CREATED,
      title: 'Work order created',
      body: 'Implement dashboard handoff',
      metadata: {
        workOrderId: 'work-order-1',
        agentType: WorkOrderAgentType.FRONTEND,
      },
    });
  });

  it('createWorkOrder rejects work orders without actionable instructions', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });

    await expect(
      service.createWorkOrder('project-1', pmUser, {
        title: 'Implement dashboard handoff',
        agentType: WorkOrderAgentType.FRONTEND,
      }),
    ).rejects.toThrow('Work order instructions are required before it can be actioned');

    expect(prisma.workOrder.create).not.toHaveBeenCalled();
  });

  it('updateWorkOrder rejects re-scoping completed work orders', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'project-1',
      title: 'Completed handoff',
      instructions: 'Already executed.',
      status: WorkOrderStatus.COMPLETED,
      taskId: 'task-1',
      artifactId: null,
      task: null,
      artifact: null,
      createdBy: null,
    });

    await expect(
      service.updateWorkOrder('project-1', 'work-order-1', pmUser, {
        title: 'Changed scope',
      }),
    ).rejects.toThrow('Dispatched or completed work orders cannot be re-scoped');

    expect(prisma.workOrder.update).not.toHaveBeenCalled();
  });

  it('updateWorkOrder rejects stale versions without creating timeline events', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'project-1',
      title: 'Build API',
      instructions: 'Implement the API route.',
      agentType: WorkOrderAgentType.BACKEND,
      status: WorkOrderStatus.READY,
      priority: WorkOrderPriority.NORMAL,
      taskId: null,
      artifactId: null,
      task: null,
      artifact: null,
      createdBy: null,
      version: 4,
    });
    prisma.workOrder.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateWorkOrder('project-1', 'work-order-1', pmUser, {
        title: 'Build updated API',
        version: 3,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'work-order-1', version: 3 },
      data: expect.objectContaining({
        title: 'Build updated API',
        version: { increment: 1 },
      }),
    });
    expect(prisma.projectTimelineEvent.create).not.toHaveBeenCalled();
  });

  it('dispatchWorkOrder marks the order dispatched and notifies stakeholders', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.workOrder.findFirst
      .mockResolvedValueOnce({
      id: 'work-order-1',
      projectId: 'project-1',
      taskId: 'task-1',
      artifactId: 'artifact-1',
      title: 'Implement dashboard handoff',
      instructions: 'Build the dev dashboard from the approved artifact.',
      agentType: WorkOrderAgentType.FRONTEND,
      status: WorkOrderStatus.READY,
      priority: WorkOrderPriority.NORMAL,
      createdById: pmUser.id,
      dispatchedAt: null,
      completedAt: null,
      failedAt: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      task: {
        id: 'task-1',
        title: 'Implement dashboard',
        assignedToId: devUser.id,
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
      createdBy: null,
    })
      .mockResolvedValueOnce({
        id: 'work-order-1',
        projectId: 'project-1',
        taskId: 'task-1',
        artifactId: 'artifact-1',
        title: 'Implement dashboard handoff',
        instructions: 'Build the dev dashboard from the approved artifact.',
        agentType: WorkOrderAgentType.FRONTEND,
        status: WorkOrderStatus.DISPATCHED,
        priority: WorkOrderPriority.NORMAL,
        createdById: pmUser.id,
        dispatchedAt: new Date('2026-05-28T01:00:00.000Z'),
        completedAt: null,
        failedAt: null,
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T01:00:00.000Z'),
        task: {
          id: 'task-1',
          title: 'Implement dashboard',
          assignedToId: devUser.id,
          status: ProjectTaskStatus.TODO,
        },
        artifact: null,
        createdBy: null,
      })
      .mockResolvedValueOnce({
        id: 'work-order-1',
        projectId: 'project-1',
        taskId: 'task-1',
        artifactId: 'artifact-generated-1',
        title: 'Implement dashboard handoff',
        instructions: 'Build the dev dashboard from the approved artifact.',
        agentType: WorkOrderAgentType.FRONTEND,
        status: WorkOrderStatus.COMPLETED,
        priority: WorkOrderPriority.NORMAL,
        createdById: pmUser.id,
        executionRunId: 'work-order-run-1',
        executionAttempt: 1,
        executionStartedAt: new Date('2026-05-28T01:00:00.000Z'),
        executionCompletedAt: new Date('2026-05-28T01:01:00.000Z'),
        executionError: null,
        lastEventAt: new Date('2026-05-28T01:01:00.000Z'),
        dispatchedAt: new Date('2026-05-28T01:00:00.000Z'),
        completedAt: new Date('2026-05-28T01:01:00.000Z'),
        failedAt: null,
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T01:01:00.000Z'),
        task: {
          id: 'task-1',
          title: 'Implement dashboard',
          assignedToId: devUser.id,
          status: ProjectTaskStatus.IN_REVIEW,
        },
        artifact: {
          id: 'artifact-generated-1',
          filePath: 'work-orders/work-order-1/frontend-output.md',
          displayName: 'Implement dashboard handoff output',
          reviewStatus: ArtifactReviewStatus.PENDING,
        },
        createdBy: null,
      });
    prisma.workOrder.update.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'project-1',
      taskId: 'task-1',
      artifactId: 'artifact-1',
      title: 'Implement dashboard handoff',
      instructions: 'Build the dev dashboard from the approved artifact.',
      agentType: WorkOrderAgentType.FRONTEND,
      status: WorkOrderStatus.DISPATCHED,
      priority: WorkOrderPriority.NORMAL,
      createdById: pmUser.id,
      dispatchedAt: new Date('2026-05-28T01:00:00.000Z'),
      completedAt: null,
      failedAt: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T01:00:00.000Z'),
      task: {
        id: 'task-1',
        title: 'Implement dashboard',
        assignedToId: devUser.id,
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
      createdBy: null,
    });

    await service.dispatchWorkOrder('project-1', 'work-order-1', pmUser);

    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'work-order-1', projectId: 'project-1', status: WorkOrderStatus.READY },
      data: {
        status: WorkOrderStatus.DISPATCHED,
        dispatchedAt: expect.any(Date),
      },
    });
    expect(prisma.projectTimelineEvent.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        actorId: pmUser.id,
        taskId: 'task-1',
        artifactId: 'artifact-1',
        type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Work order dispatched',
        body: 'Implement dashboard handoff',
        metadata: {
          workOrderId: 'work-order-1',
          agentType: WorkOrderAgentType.FRONTEND,
        },
      },
    });
    expect(orchestration.executeWorkOrder).toHaveBeenCalledWith(
      'project-1',
      'work-order-1',
      pmUser.id,
    );
    expect(prisma.projectTimelineEvent.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        actorId: pmUser.id,
        taskId: 'task-1',
        artifactId: 'artifact-generated-1',
        type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Work order execution completed',
        body: 'Implement dashboard handoff',
        metadata: {
          workOrderId: 'work-order-1',
          from: WorkOrderStatus.DISPATCHED,
          to: WorkOrderStatus.COMPLETED,
          executionRunId: 'work-order-run-1',
          artifactId: 'artifact-generated-1',
        },
      },
    });
    expect(notifications.notify).toHaveBeenCalledWith({
      recipientIds: [pmUser.id, devUser.id],
      actorId: pmUser.id,
      projectId: 'project-1',
      taskId: 'task-1',
      artifactId: expect.any(String),
      type: NotificationType.WORK_ORDER_DISPATCHED,
      title: 'Work order dispatched',
      body: 'Implement dashboard handoff',
      metadata: {
        workOrderId: 'work-order-1',
        status: WorkOrderStatus.DISPATCHED,
        agentType: WorkOrderAgentType.FRONTEND,
      },
    });
  });

  it('dispatchWorkOrder rejects non-ready work orders', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'project-1',
      title: 'Draft handoff',
      instructions: 'Still being scoped.',
      status: WorkOrderStatus.DRAFT,
      taskId: null,
      artifactId: null,
      task: null,
      artifact: null,
      createdBy: null,
    });

    await expect(
      service.dispatchWorkOrder('project-1', 'work-order-1', pmUser),
    ).rejects.toThrow('Only READY work orders can be dispatched');

    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(orchestration.executeWorkOrder).not.toHaveBeenCalled();
  });

  it('retryFailedWorkOrder queues and executes a failed work order', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.workOrder.findFirst
      .mockResolvedValueOnce({
        id: 'work-order-1',
        projectId: 'project-1',
        taskId: 'task-1',
        artifactId: 'artifact-1',
        title: 'Retry dashboard handoff',
        instructions: 'Retry the failed output.',
        agentType: WorkOrderAgentType.FRONTEND,
        status: WorkOrderStatus.FAILED,
        priority: WorkOrderPriority.HIGH,
        executionError: 'Mock failure',
        task: {
          id: 'task-1',
          title: 'Implement dashboard',
          assignedToId: devUser.id,
          status: ProjectTaskStatus.TODO,
        },
        artifact: null,
        createdBy: null,
      })
      .mockResolvedValueOnce({
        id: 'work-order-1',
        projectId: 'project-1',
        taskId: 'task-1',
        artifactId: 'artifact-generated-1',
        title: 'Retry dashboard handoff',
        instructions: 'Retry the failed output.',
        agentType: WorkOrderAgentType.FRONTEND,
        status: WorkOrderStatus.COMPLETED,
        priority: WorkOrderPriority.HIGH,
        executionRunId: 'work-order-run-1',
        executionAttempt: 2,
        executionError: null,
        task: {
          id: 'task-1',
          title: 'Implement dashboard',
          assignedToId: devUser.id,
          status: ProjectTaskStatus.IN_REVIEW,
        },
        artifact: {
          id: 'artifact-generated-1',
          filePath: 'work-orders/work-order-1/frontend-output.tsx',
          displayName: 'Retry dashboard handoff output',
          reviewStatus: ArtifactReviewStatus.PENDING,
          outputReviewStatus: ArtifactOutputReviewStatus.PENDING,
        },
        createdBy: null,
      });
    prisma.workOrder.update.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'project-1',
      status: WorkOrderStatus.READY,
    });

    const result = await service.retryFailedWorkOrder('project-1', 'work-order-1', pmUser);

    expect(result.status).toBe(WorkOrderStatus.COMPLETED);
    expect(prisma.workOrder.update).toHaveBeenCalledWith({
      where: { id: 'work-order-1' },
      data: {
        status: WorkOrderStatus.READY,
        executionError: null,
        failedAt: null,
      },
      include: expect.any(Object),
    });
    expect(orchestration.executeWorkOrder).toHaveBeenCalledWith(
      'project-1',
      'work-order-1',
      pmUser.id,
      expect.objectContaining({
        trigger: OrchestrationRunTrigger.RETRY_FAILED_WORK_ORDER,
      }),
    );
  });

  it('findOrchestrationRuns returns durable run history with executions', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.orchestrationRun.findMany.mockResolvedValue([
      {
        id: 'orchestration-run-1',
        projectId: 'project-1',
        runId: 'run-1',
        status: 'SUCCEEDED',
        trigger: 'START',
        executions: [
          {
            id: 'execution-1',
            executionRunId: 'work-order-run-1',
            status: 'SUCCEEDED',
            workOrder: { id: 'work-order-1', title: 'Build shell', status: WorkOrderStatus.COMPLETED, agentType: WorkOrderAgentType.FRONTEND },
            artifact: { id: 'artifact-1', filePath: 'work-orders/work-order-1/frontend-output.tsx', displayName: 'Build shell output' },
          },
        ],
      },
    ]);

    const runs = await service.findOrchestrationRuns('project-1', pmUser);

    expect(runs).toHaveLength(1);
    expect(prisma.orchestrationRun.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      include: expect.any(Object),
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });

  it('reviewArtifact rejects unshared artifacts', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.artifact.findFirst.mockResolvedValue(null);

    await expect(
      service.reviewArtifact('project-1', 'artifact-1', clientUser, {
        reviewStatus: ArtifactReviewStatus.APPROVED,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
