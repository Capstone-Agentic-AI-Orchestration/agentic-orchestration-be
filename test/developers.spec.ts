import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { DeveloperAvailabilityStatus, ProjectStatus, ProjectTaskStatus, UserRole, WorkOrderStatus } from '@prisma/client';
import { DevelopersService } from '../src/developers/developers.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/auth/auth.types';

const devUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  fullName: 'Dana Developer',
  role: UserRole.DEV,
};

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

function developerRecord(overrides = {}) {
  return {
    id: devUser.id,
    email: devUser.email,
    fullName: devUser.fullName,
    role: UserRole.DEV,
    updatedAt: new Date('2026-06-14T00:00:00.000Z'),
    developerProfile: {
      skills: ['frontend', 'qa'],
      weeklyCapacityHours: 32,
      availabilityStatus: DeveloperAvailabilityStatus.LIMITED,
      notes: 'Capstone week',
      updatedAt: new Date('2026-06-14T00:00:00.000Z'),
    },
    assignedTasks: [
      { id: 'task-1', status: ProjectTaskStatus.TODO },
      { id: 'task-2', status: ProjectTaskStatus.DONE },
    ],
    memberships: [
      {
        projectId: 'project-1',
        project: {
          id: 'project-1',
          companyName: 'Acme',
          status: ProjectStatus.PENDING,
          updatedAt: new Date('2026-06-14T00:00:00.000Z'),
          workOrders: [{ status: WorkOrderStatus.READY }],
        },
      },
    ],
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    profile: {
      findMany: vi.fn().mockResolvedValue([developerRecord()]),
      findFirst: vi.fn().mockResolvedValue(developerRecord()),
    },
    developerProfile: {
      upsert: vi.fn().mockResolvedValue({ userId: devUser.id }),
    },
  };
}

describe('DevelopersService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: DevelopersService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new DevelopersService(prisma as unknown as PrismaService);
  });

  it('lists developers with capacity and workload summary', async () => {
    const developers = await service.list();

    expect(developers[0]).toMatchObject({
      userId: devUser.id,
      displayName: 'Dana Developer',
      weeklyCapacityHours: 32,
      availabilityStatus: DeveloperAvailabilityStatus.LIMITED,
      assignedProjectCount: 1,
      openTaskCount: 1,
      activeWorkOrderCount: 1,
    });
    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: { role: UserRole.DEV },
      select: expect.any(Object),
      orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
      take: 200,
    });
  });

  it('returns a cursor page when pagination is requested', async () => {
    prisma.profile.findMany.mockResolvedValue([
      developerRecord({ id: 'developer-2', email: 'b@example.com' }),
      developerRecord({ id: 'developer-3', email: 'c@example.com', memberships: [] }),
      developerRecord({ id: 'developer-4', email: 'd@example.com', assignedTasks: [] }),
    ]);

    await expect(
      service.list({ limit: '2', cursor: 'developer-1' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ userId: 'developer-2', assignedProjectCount: 1 }),
        expect.objectContaining({ userId: 'developer-3', assignedProjectCount: 0 }),
      ],
      nextCursor: 'developer-4',
    });

    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: { role: UserRole.DEV },
      select: expect.any(Object),
      orderBy: [{ fullName: 'asc' }, { email: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'developer-1' },
      skip: 1,
    });
  });

  it('updates the current developer capacity', async () => {
    await service.updateMe(devUser, {
      skills: [' backend ', ''],
      weeklyCapacityHours: 24,
      availabilityStatus: DeveloperAvailabilityStatus.AVAILABLE,
      notes: ' Available mornings ',
    });

    expect(prisma.developerProfile.upsert).toHaveBeenCalledWith({
      where: { userId: devUser.id },
      update: expect.objectContaining({
        skills: ['backend'],
        weeklyCapacityHours: 24,
        notes: 'Available mornings',
      }),
      create: expect.objectContaining({
        userId: devUser.id,
        skills: ['backend'],
      }),
    });
  });

  it('rejects capacity updates from non-developer accounts', async () => {
    await expect(service.updateMe(pmUser, { weeklyCapacityHours: 12 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
