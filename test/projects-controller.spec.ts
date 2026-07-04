import { HttpStatus } from '@nestjs/common';
import { ArtifactReviewStatus, ArtifactValidationStatus, UserRole, WorkOrderAgentType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { ProjectsController } from '../src/projects/projects.controller';
import type { ProjectsService } from '../src/projects/projects.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

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

describe('ProjectsController idempotency', () => {
  let projects: {
    findAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createTask: ReturnType<typeof vi.fn>;
    findArtifacts: ReturnType<typeof vi.fn>;
    findTaskActivity: ReturnType<typeof vi.fn>;
    createWorkOrder: ReturnType<typeof vi.fn>;
    acceptDelivery: ReturnType<typeof vi.fn>;
    requestDeliveryRevision: ReturnType<typeof vi.fn>;
    addMember: ReturnType<typeof vi.fn>;
    updateArtifactSharing: ReturnType<typeof vi.fn>;
    reviewArtifact: ReturnType<typeof vi.fn>;
    handleRevision: ReturnType<typeof vi.fn>;
    publishArtifactOutput: ReturnType<typeof vi.fn>;
    createKickoffTasks: ReturnType<typeof vi.fn>;
    createKickoffWorkOrders: ReturnType<typeof vi.fn>;
    addTaskComment: ReturnType<typeof vi.fn>;
    dispatchWorkOrder: ReturnType<typeof vi.fn>;
    retryFailedWorkOrder: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    removeMember: ReturnType<typeof vi.fn>;
    reviewArtifactOutput: ReturnType<typeof vi.fn>;
    resolveDeliveryRevision: ReturnType<typeof vi.fn>;
    updateKickoff: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    updateWorkOrder: ReturnType<typeof vi.fn>;
    approveGate1: ReturnType<typeof vi.fn>;
    approveGate2: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: ProjectsController;

  beforeEach(() => {
    projects = {
      findAll: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'project-1', companyName: 'Acme Logistics' }),
      createTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
      findArtifacts: vi.fn().mockResolvedValue([]),
      findTaskActivity: vi.fn().mockResolvedValue([]),
      createWorkOrder: vi.fn().mockResolvedValue({ id: 'work-order-1' }),
      acceptDelivery: vi.fn().mockResolvedValue({ id: 'review-1', status: 'ACCEPTED' }),
      requestDeliveryRevision: vi.fn().mockResolvedValue({ id: 'review-1', status: 'REVISION_REQUESTED' }),
      addMember: vi.fn().mockResolvedValue({ id: 'project-1', members: [] }),
      updateArtifactSharing: vi.fn().mockResolvedValue({ id: 'artifact-1', clientVisible: true }),
      reviewArtifact: vi.fn().mockResolvedValue({ id: 'artifact-1', reviewStatus: 'APPROVED' }),
      handleRevision: vi.fn().mockResolvedValue({ id: 'artifact-1', revisionHandledAt: new Date('2026-05-28T00:00:00.000Z') }),
      publishArtifactOutput: vi.fn().mockResolvedValue({ id: 'artifact-1', clientVisible: true }),
      createKickoffTasks: vi.fn().mockResolvedValue({ tasks: [], kickoff: { id: 'kickoff-1' } }),
      createKickoffWorkOrders: vi.fn().mockResolvedValue({ workOrders: [], kickoff: { id: 'kickoff-1' } }),
      addTaskComment: vi.fn().mockResolvedValue({ id: 'activity-1' }),
      dispatchWorkOrder: vi.fn().mockResolvedValue({ id: 'work-order-1', status: 'DISPATCHED' }),
      retryFailedWorkOrder: vi.fn().mockResolvedValue({ id: 'work-order-1', status: 'DISPATCHED' }),
      update: vi.fn().mockResolvedValue({ id: 'project-1', companyName: 'New Co' }),
      removeMember: vi.fn().mockResolvedValue({ id: 'project-1', members: [] }),
      reviewArtifactOutput: vi.fn().mockResolvedValue({ id: 'artifact-1', outputReviewStatus: 'APPROVED' }),
      resolveDeliveryRevision: vi.fn().mockResolvedValue({ id: 'review-1', status: 'REVISION_RESOLVED' }),
      updateKickoff: vi.fn().mockResolvedValue({ id: 'kickoff-1' }),
      updateTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'IN_PROGRESS' }),
      updateWorkOrder: vi.fn().mockResolvedValue({ id: 'work-order-1', status: 'READY' }),
      approveGate1: vi.fn().mockResolvedValue({ id: 'project-1', architectureApproved: true }),
      approveGate2: vi.fn().mockResolvedValue({ id: 'project-1', codeApproved: true }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ responseStatus, handler }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new ProjectsController(
      projects as unknown as ProjectsService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('bypasses idempotency for project creation when no key is provided', async () => {
    const dto = {
      companyName: 'Acme Logistics',
      brief: 'Build a partner portal.',
      stackKey: 'nextjs-supabase',
    };

    await expect(controller.create(dto, pmUser)).resolves.toEqual({
      id: 'project-1',
      companyName: 'Acme Logistics',
    });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(projects.create).toHaveBeenCalledWith(dto, pmUser);
  });

  it('runs project creation through actor-scoped idempotency when a key is provided', async () => {
    const dto = {
      companyName: 'Acme Logistics',
      brief: 'Build a partner portal.',
      stackKey: 'nextjs-supabase',
    };

    await expect(
      controller.create(dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({
      id: 'project-1',
      companyName: 'Acme Logistics',
    });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/projects`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(projects.create).toHaveBeenCalledWith(dto, pmUser);
  });

  it('runs task creation through project-scoped idempotency when a key is provided', async () => {
    const dto = { title: 'Review API contract' };

    await expect(
      controller.createTask('project-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'task-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/projects/project-1/tasks`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(projects.createTask).toHaveBeenCalledWith('project-1', pmUser, dto);
  });

  it('passes project list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'project-1' };

    await expect(controller.findAll(pmUser, page)).resolves.toEqual([]);

    expect(projects.findAll).toHaveBeenCalledWith(pmUser, page);
  });

  it('passes artifact list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'artifact-1' };

    await expect(controller.findArtifacts('project-1', clientUser, page)).resolves.toEqual([]);

    expect(projects.findArtifacts).toHaveBeenCalledWith('project-1', clientUser, page);
  });

  it('passes task activity pagination to the service', async () => {
    const page = { limit: '2', cursor: 'activity-1' };

    await expect(
      controller.findTaskActivity('project-1', 'task-1', pmUser, page),
    ).resolves.toEqual([]);

    expect(projects.findTaskActivity).toHaveBeenCalledWith(
      'project-1',
      'task-1',
      pmUser,
      page,
    );
  });

  it('runs work-order creation through project-scoped idempotency when a key is provided', async () => {
    const dto = {
      title: 'Build dashboard API',
      agentType: WorkOrderAgentType.BACKEND,
    };

    await expect(
      controller.createWorkOrder('project-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'work-order-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/projects/project-1/work-orders`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(projects.createWorkOrder).toHaveBeenCalledWith('project-1', pmUser, dto);
  });

  it('runs delivery acceptance through client-scoped idempotency when a key is provided', async () => {
    const dto = { note: 'Accepted.' };

    await expect(
      controller.acceptDelivery('project-1', dto, clientUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'review-1', status: 'ACCEPTED' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${clientUser.id}:POST:/projects/project-1/delivery-review/accept`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(projects.acceptDelivery).toHaveBeenCalledWith('project-1', clientUser, dto);
  });

  it('runs delivery revision requests through client-scoped idempotency when a key is provided', async () => {
    const dto = { note: 'Please revise the API copy.' };

    await expect(
      controller.requestDeliveryRevision('project-1', dto, clientUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'review-1', status: 'REVISION_REQUESTED' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${clientUser.id}:POST:/projects/project-1/delivery-review/revision`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(projects.requestDeliveryRevision).toHaveBeenCalledWith(
      'project-1',
      clientUser,
      dto,
    );
  });

  it.each([
    {
      name: 'member additions',
      invoke: () => {
        const dto = { email: 'dev@example.com', role: UserRole.DEV };
        return {
          dto,
          call: controller.addMember('project-1', dto, pmUser, 'request-key-1'),
          service: projects.addMember,
          expectedArgs: ['project-1', pmUser, dto],
          scope: `user:${pmUser.id}:POST:/projects/project-1/members`,
          responseStatus: HttpStatus.CREATED,
        };
      },
    },
    {
      name: 'artifact sharing updates',
      invoke: () => {
        const dto = { clientVisible: true };
        return {
          dto,
          call: controller.shareArtifact('project-1', 'artifact-1', dto, pmUser, 'request-key-1'),
          service: projects.updateArtifactSharing,
          expectedArgs: ['project-1', 'artifact-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/artifacts/artifact-1/share`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'artifact reviews',
      invoke: () => {
        const dto = { status: ArtifactReviewStatus.APPROVED, reviewNote: 'Looks good.' };
        return {
          dto,
          call: controller.reviewArtifact('project-1', 'artifact-1', dto, clientUser, 'request-key-1'),
          service: projects.reviewArtifact,
          expectedArgs: ['project-1', 'artifact-1', clientUser, dto],
          scope: `user:${clientUser.id}:POST:/projects/project-1/artifacts/artifact-1/review`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'artifact revision handling',
      invoke: () => {
        const dto = { resolutionNote: 'Queued for the frontend developer.' };
        return {
          dto,
          call: controller.handleRevision('project-1', 'artifact-1', dto, pmUser, 'request-key-1'),
          service: projects.handleRevision,
          expectedArgs: ['project-1', 'artifact-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/artifacts/artifact-1/revision`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'artifact output publishing',
      invoke: () => {
        const dto = { validationStatus: ArtifactValidationStatus.PASSED };
        return {
          dto,
          call: controller.publishArtifactOutput('project-1', 'artifact-1', dto, pmUser, 'request-key-1'),
          service: projects.publishArtifactOutput,
          expectedArgs: ['project-1', 'artifact-1', pmUser, dto],
          scope: `user:${pmUser.id}:POST:/projects/project-1/artifacts/artifact-1/publish`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'kickoff task creation',
      invoke: () => ({
        dto: {},
        call: controller.createKickoffTasks('project-1', pmUser, 'request-key-1'),
        service: projects.createKickoffTasks,
        expectedArgs: ['project-1', pmUser],
        scope: `user:${pmUser.id}:POST:/projects/project-1/kickoff/tasks`,
        responseStatus: HttpStatus.CREATED,
      }),
    },
    {
      name: 'kickoff work-order creation',
      invoke: () => ({
        dto: {},
        call: controller.createKickoffWorkOrders('project-1', pmUser, 'request-key-1'),
        service: projects.createKickoffWorkOrders,
        expectedArgs: ['project-1', pmUser],
        scope: `user:${pmUser.id}:POST:/projects/project-1/kickoff/work-orders`,
        responseStatus: HttpStatus.CREATED,
      }),
    },
    {
      name: 'task comments',
      invoke: () => {
        const dto = { message: 'Please attach the handover note.' };
        return {
          dto,
          call: controller.addTaskComment('project-1', 'task-1', dto, pmUser, 'request-key-1'),
          service: projects.addTaskComment,
          expectedArgs: ['project-1', 'task-1', pmUser, dto],
          scope: `user:${pmUser.id}:POST:/projects/project-1/tasks/task-1/comments`,
          responseStatus: HttpStatus.CREATED,
        };
      },
    },
    {
      name: 'work-order dispatch',
      invoke: () => ({
        dto: {},
        call: controller.dispatchWorkOrder('project-1', 'work-order-1', pmUser, 'request-key-1'),
        service: projects.dispatchWorkOrder,
        expectedArgs: ['project-1', 'work-order-1', pmUser],
        scope: `user:${pmUser.id}:POST:/projects/project-1/work-orders/work-order-1/dispatch`,
        responseStatus: HttpStatus.ACCEPTED,
      }),
    },
    {
      name: 'work-order retry',
      invoke: () => ({
        dto: {},
        call: controller.retryWorkOrder('project-1', 'work-order-1', pmUser, 'request-key-1'),
        service: projects.retryFailedWorkOrder,
        expectedArgs: ['project-1', 'work-order-1', pmUser],
        scope: `user:${pmUser.id}:POST:/projects/project-1/work-orders/work-order-1/retry`,
        responseStatus: HttpStatus.ACCEPTED,
      }),
    },
    {
      name: 'architecture gate approvals',
      invoke: () => {
        const dto = { approved: true, notes: 'Architecture is ready.' };
        return {
          dto,
          call: (controller.approveGate1 as any)('project-1', dto, pmUser, 'request-key-1'),
          service: projects.approveGate1,
          expectedArgs: ['project-1', pmUser, true, 'Architecture is ready.'],
          scope: `user:${pmUser.id}:POST:/projects/project-1/gates/architecture`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'code gate approvals',
      invoke: () => {
        const dto = { approved: true, notes: 'Code is ready.' };
        return {
          dto,
          call: (controller.approveGate2 as any)('project-1', dto, pmUser, 'request-key-1'),
          service: projects.approveGate2,
          expectedArgs: ['project-1', pmUser, true, 'Code is ready.'],
          scope: `user:${pmUser.id}:POST:/projects/project-1/gates/code`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
  ])('runs $name through idempotency when a key is provided', async ({ invoke }) => {
    const { dto, call, service, expectedArgs, scope, responseStatus } = invoke();

    await call;

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope,
      requestHash: 'hash-1',
      responseStatus,
      handler: expect.any(Function),
    }));
    expect(service).toHaveBeenCalledWith(...expectedArgs);
  });

  it.each([
    {
      name: 'project updates',
      invoke: () => {
        const dto = { companyName: 'New Co', version: 2 };
        return {
          dto,
          call: controller.update('project-1', dto, pmUser, 'request-key-1'),
          service: projects.update,
          expectedArgs: ['project-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'member removals',
      invoke: () => ({
        dto: { userId: clientUser.id },
        call: controller.removeMember('project-1', clientUser.id, pmUser, 'request-key-1'),
        service: projects.removeMember,
        expectedArgs: ['project-1', clientUser.id, pmUser],
        scope: `user:${pmUser.id}:DELETE:/projects/project-1/members/${clientUser.id}`,
        responseStatus: HttpStatus.OK,
      }),
    },
    {
      name: 'artifact output reviews',
      invoke: () => {
        const dto = { status: ArtifactReviewStatus.APPROVED, note: 'Ship it.' };
        return {
          dto,
          call: controller.reviewArtifactOutput('project-1', 'artifact-1', dto, pmUser, 'request-key-1'),
          service: projects.reviewArtifactOutput,
          expectedArgs: ['project-1', 'artifact-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/artifacts/artifact-1/output-review`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'delivery revision resolution',
      invoke: () => {
        const dto = { note: 'Resolved.', version: 2 };
        return {
          dto,
          call: controller.resolveDeliveryRevision('project-1', dto, pmUser, 'request-key-1'),
          service: projects.resolveDeliveryRevision,
          expectedArgs: ['project-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/delivery-review/resolve`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'kickoff updates',
      invoke: () => {
        const dto = { goals: 'Finalize scope.' };
        return {
          dto,
          call: controller.updateKickoff('project-1', dto, pmUser, 'request-key-1'),
          service: projects.updateKickoff,
          expectedArgs: ['project-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/kickoff`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'task updates',
      invoke: () => {
        const dto = { status: 'IN_PROGRESS', version: 2 };
        return {
          dto,
          call: controller.updateTask('project-1', 'task-1', dto, pmUser, 'request-key-1'),
          service: projects.updateTask,
          expectedArgs: ['project-1', 'task-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/tasks/task-1`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
    {
      name: 'work-order updates',
      invoke: () => {
        const dto = { status: 'READY', version: 2 };
        return {
          dto,
          call: controller.updateWorkOrder('project-1', 'work-order-1', dto, pmUser, 'request-key-1'),
          service: projects.updateWorkOrder,
          expectedArgs: ['project-1', 'work-order-1', pmUser, dto],
          scope: `user:${pmUser.id}:PATCH:/projects/project-1/work-orders/work-order-1`,
          responseStatus: HttpStatus.OK,
        };
      },
    },
  ])('runs $name through idempotency when a key is provided', async ({ invoke }) => {
    const { dto, call, service, expectedArgs, scope, responseStatus } = invoke();

    await call;

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope,
      requestHash: 'hash-1',
      responseStatus,
      handler: expect.any(Function),
    }));
    expect(service).toHaveBeenCalledWith(...expectedArgs);
  });

  it('bypasses idempotency when no key is provided', async () => {
    const dto = { title: 'Review API contract' };

    await expect(controller.createTask('project-1', dto, pmUser)).resolves.toEqual({
      id: 'task-1',
    });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(projects.createTask).toHaveBeenCalledWith('project-1', pmUser, dto);
  });
});
