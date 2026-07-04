import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestrationRunStatus,
  ProjectStatus,
  WorkOrderExecutionStatus,
  WorkOrderStatus,
} from '@prisma/client';
import { RunSupervisorService } from '../src/supervisor/run-supervisor.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventLogService } from '../src/supervisor/event-log.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';

function makePrismaMock() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    project: {
      update: vi.fn().mockResolvedValue({}),
    },
    runBudget: {
      findUnique: vi.fn().mockResolvedValue({
        tokensConsumed: 100,
        tokenBudget: 1000,
        retryCount: 0,
        maxRetries: 3,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    eventLog: {
      findFirst: vi.fn().mockResolvedValue({
        nodeName: 'work_order_frontend',
        eventType: 'STARTED',
        occurredAt: new Date('2026-05-29T00:00:00.000Z'),
      }),
    },
    orchestrationRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workOrderExecution: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workOrder: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeEventLogMock() {
  return {
    logEscalated: vi.fn().mockResolvedValue(undefined),
    logStuck: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOrchestrationMock() {
  return {
    // Phase 2: supervisor checks this to give manual intervention precedence.
    isManuallyHalted: vi.fn().mockReturnValue(false),
    recoverStaleProject: vi.fn().mockResolvedValue({
      runId: 'recovery-run-1',
      readyWorkOrders: 1,
      completedWorkOrders: 1,
      failedWorkOrders: 0,
      status: OrchestrationRunStatus.SUCCEEDED,
      error: null,
    }),
  };
}

describe('RunSupervisorService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let eventLog: ReturnType<typeof makeEventLogMock>;
  let orchestration: ReturnType<typeof makeOrchestrationMock>;
  let service: RunSupervisorService;

  beforeEach(() => {
    prisma = makePrismaMock();
    eventLog = makeEventLogMock();
    orchestration = makeOrchestrationMock();
    service = new RunSupervisorService(
      prisma as unknown as PrismaService,
      eventLog as unknown as EventLogService,
      orchestration as unknown as OrchestrationService,
    );
  });

  it('casts supervised project statuses and treats missing event logs as stale', async () => {
    await service.supervisorTick();

    const [
      strings,
      parsingRequirements,
      negotiatingContract,
      generatingCode,
      committing,
      threshold,
    ] = prisma.$queryRaw.mock.calls[0];
    const sql = strings.join(' ');

    expect(sql).toContain('CAST(');
    expect(sql).toContain('AS projects."ProjectStatus"');
    expect(sql).toContain('p.status IN');
    expect(sql).toContain('last_event."lastEventAt" IS NULL');
    expect(sql).toContain('last_event."lastEventAt" <');
    expect(parsingRequirements).toBe(ProjectStatus.PARSING_REQUIREMENTS);
    expect(negotiatingContract).toBe(ProjectStatus.NEGOTIATING_CONTRACT);
    expect(generatingCode).toBe(ProjectStatus.GENERATING_CODE);
    expect(committing).toBe(ProjectStatus.COMMITTING);
    expect(threshold).toBeInstanceOf(Date);
  });

  it('skips auto-recovery for a manually paused (halted) project', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-paused',
        status: ProjectStatus.GENERATING_CODE,
        retryCount: 0,
        maxRetries: 3,
        tokensConsumed: 100,
        tokenBudget: 1000,
      },
    ]);
    orchestration.isManuallyHalted.mockReturnValue(true);

    await service.supervisorTick();

    expect(orchestration.isManuallyHalted).toHaveBeenCalledWith('project-paused');
    // Manual intervention wins: no retry bump, no STUCK log, no recovery run.
    expect(prisma.runBudget.update).not.toHaveBeenCalled();
    expect(eventLog.logStuck).not.toHaveBeenCalled();
    expect(orchestration.recoverStaleProject).not.toHaveBeenCalled();
  });

  it('requeues stale dispatched work orders and fails running runtime rows while retry budget remains', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-1',
        status: ProjectStatus.GENERATING_CODE,
        retryCount: 1,
        maxRetries: 3,
        tokensConsumed: 100,
        tokenBudget: 1000,
      },
    ]);

    await service.supervisorTick();

    expect(prisma.runBudget.update).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      data: { retryCount: { increment: 1 } },
    });
    expect(eventLog.logStuck).toHaveBeenCalledWith('project-1', 'supervisor');
    expect(prisma.orchestrationRun.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        status: OrchestrationRunStatus.RUNNING,
      },
      data: expect.objectContaining({
        status: OrchestrationRunStatus.FAILED,
        currentNode: 'supervisor',
        error: expect.stringContaining('queued retry 2/3'),
        completedAt: expect.any(Date),
      }),
    });
    expect(prisma.workOrderExecution.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        status: WorkOrderExecutionStatus.RUNNING,
      },
      data: expect.objectContaining({
        status: WorkOrderExecutionStatus.FAILED,
        error: expect.stringContaining('queued retry 2/3'),
        completedAt: expect.any(Date),
        metadata: expect.objectContaining({
          recoveredBy: 'supervisor',
          reason: expect.stringContaining('queued retry 2/3'),
        }),
      }),
    });
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        status: WorkOrderStatus.DISPATCHED,
      },
      data: expect.objectContaining({
        status: WorkOrderStatus.READY,
        executionRunId: null,
        executionStartedAt: null,
        executionCompletedAt: expect.any(Date),
        executionError: expect.stringContaining('queued retry 2/3'),
        lastEventAt: expect.any(Date),
      }),
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { status: ProjectStatus.GENERATING_CODE },
    });
    expect(orchestration.recoverStaleProject).toHaveBeenCalledWith(
      'project-1',
      {
        reason: expect.stringContaining('queued retry 2/3'),
        retryAttempt: 2,
        maxRetries: 3,
      },
    );
  });

  it('escalates and fails dispatched work when retry budget is exhausted', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-1',
        status: ProjectStatus.GENERATING_CODE,
        retryCount: 3,
        maxRetries: 3,
        tokensConsumed: 100,
        tokenBudget: 1000,
      },
    ]);

    await service.supervisorTick();

    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { status: ProjectStatus.FAILED },
    });
    expect(eventLog.logEscalated).toHaveBeenCalledWith(
      'project-1',
      'supervisor',
      'Max retries reached (3/3)',
    );
    expect(prisma.orchestrationRun.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        status: OrchestrationRunStatus.RUNNING,
      },
      data: expect.objectContaining({
        status: OrchestrationRunStatus.FAILED,
        currentNode: 'supervisor',
        error: 'Max retries reached (3/3)',
        completedAt: expect.any(Date),
      }),
    });
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        status: WorkOrderStatus.DISPATCHED,
      },
      data: expect.objectContaining({
        status: WorkOrderStatus.FAILED,
        executionCompletedAt: expect.any(Date),
        executionError: 'Max retries reached (3/3)',
        lastEventAt: expect.any(Date),
        failedAt: expect.any(Date),
      }),
    });
    expect(orchestration.recoverStaleProject).not.toHaveBeenCalled();
  });

  it('keeps the supervisor tick from throwing when the scan fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('database unavailable'));

    await expect(service.supervisorTick()).resolves.toBeUndefined();
  });

  it('does nothing when no stuck projects are found', async () => {
    // $queryRaw already returns [] by default from makePrismaMock
    await service.supervisorTick();

    expect(orchestration.recoverStaleProject).not.toHaveBeenCalled();
    expect(eventLog.logEscalated).not.toHaveBeenCalled();
    expect(eventLog.logStuck).not.toHaveBeenCalled();
  });

  it('escalates when token budget is exhausted even when retries remain', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-budget-exhausted',
        status: ProjectStatus.GENERATING_CODE,
        retryCount: 1,
        maxRetries: 5,
        tokensConsumed: 1000,
        tokenBudget: 1000,
      },
    ]);

    await service.supervisorTick();

    expect(eventLog.logEscalated).toHaveBeenCalledWith(
      'project-budget-exhausted',
      'supervisor',
      expect.stringContaining('Token budget exhausted'),
    );
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-budget-exhausted' },
      data: { status: ProjectStatus.FAILED },
    });
    expect(orchestration.recoverStaleProject).not.toHaveBeenCalled();
  });

  it('falls back gracefully when budget info is unavailable during escalation', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-no-budget',
        status: ProjectStatus.COMMITTING,
        retryCount: 3,
        maxRetries: 3,
        tokensConsumed: 0,
        tokenBudget: 0,
      },
    ]);

    await service.supervisorTick();

    expect(eventLog.logEscalated).toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalled();
  });

  it('handles recovery run failure without throwing', async () => {
    orchestration.recoverStaleProject.mockRejectedValue(new Error('recovery crashed'));
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-recovery-fail',
        status: ProjectStatus.GENERATING_CODE,
        retryCount: 0,
        maxRetries: 3,
        tokensConsumed: 100,
        tokenBudget: 1000,
      },
    ]);

    await expect(service.supervisorTick()).resolves.toBeUndefined();
    expect(eventLog.logStuck).toHaveBeenCalled();
  });

  it('converts raw bigint rows from the database query', async () => {
    // Simulate PostgreSQL returning bigint types for numeric columns
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'project-bigint',
        status: ProjectStatus.PARSING_REQUIREMENTS,
        retryCount: BigInt(0),
        maxRetries: BigInt(3),
        tokensConsumed: BigInt(50),
        tokenBudget: BigInt(500),
      },
    ]);

    await service.supervisorTick();

    expect(prisma.runBudget.update).toHaveBeenCalled();
    expect(eventLog.logStuck).toHaveBeenCalled();
    expect(orchestration.recoverStaleProject).toHaveBeenCalledWith(
      'project-bigint',
      expect.objectContaining({ retryAttempt: 1, maxRetries: 3 }),
    );
  });
});
