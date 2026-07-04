import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStatus, UserRole } from '@prisma/client';
import { ReportsService } from '../src/reports/reports.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/auth/auth.types';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

function makePrismaMock() {
  return {
    project: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'project-1',
          companyName: 'Acme',
          status: ProjectStatus.PENDING,
          updatedAt: new Date('2026-06-14T00:00:00.000Z'),
          _count: { tasks: 2, workOrders: 1, artifacts: 0 },
        },
        {
          id: 'project-2',
          companyName: 'Beacon',
          status: ProjectStatus.DELIVERED,
          updatedAt: new Date('2026-06-13T00:00:00.000Z'),
          _count: { tasks: 5, workOrders: 3, artifacts: 2 },
        },
      ]),
    },
    clientInvite: { count: vi.fn().mockResolvedValue(1) },
    projectTask: { count: vi.fn().mockResolvedValue(4) },
    workOrder: { count: vi.fn().mockResolvedValue(2) },
    clientInquiry: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('ReportsService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: ReportsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ReportsService(prisma as unknown as PrismaService);
  });

  it('builds a PM summary from existing records', async () => {
    const summary = await service.pmSummary(pmUser);

    expect(summary.totals).toEqual({
      projects: 2,
      pendingInvites: 1,
      openTasks: 4,
      activeWorkOrders: 2,
    });
    expect(summary.projectStatusCounts).toEqual({
      PENDING: 1,
      DELIVERED: 1,
    });
    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { OR: [{ createdById: pmUser.id }, { members: { some: { userId: pmUser.id } } }] },
      select: expect.any(Object),
      orderBy: { updatedAt: 'desc' },
    });
  });
});
