import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminDomainStatus,
  ProjectDeliveryReviewStatus,
  ProjectStatus,
  UserRole,
  WorkOrderStatus,
} from '@prisma/client';
import { AdminService } from '../src/admin/admin.service';
import { GithubService } from '../src/github/github.service';
import { PrismaService } from '../src/prisma/prisma.service';

function makeProfile(overrides = {}) {
  return {
    id: 'user-1',
    email: 'admin@example.com',
    fullName: 'Ada Admin',
    role: UserRole.ADMIN,
    status: 'ACTIVE',
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    memberships: [{ projectId: 'project-1', role: UserRole.PM }],
    createdProjects: [{ id: 'project-2' }],
    ...overrides,
  };
}

function makeDomain(overrides = {}) {
  return {
    id: 'domain-1',
    name: 'app.example.com',
    type: 'frontend',
    owner: null,
    target: null,
    environment: 'production',
    status: AdminDomainStatus.PLANNED,
    verifiedAt: null,
    createdById: 'user-1',
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: 'project-1',
    companyName: 'Acme Co',
    status: ProjectStatus.ACTIVE,
    repoUrl: null,
    runId: null,
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    deliveryReview: { status: ProjectDeliveryReviewStatus.PENDING },
    artifacts: [],
    workOrders: [],
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    profile: {
      findMany: vi.fn().mockResolvedValue([makeProfile()]),
    },
    adminDomain: {
      findMany: vi.fn().mockResolvedValue([makeDomain()]),
    },
    project: {
      findMany: vi.fn().mockResolvedValue([makeProject()]),
    },
  };
}

describe('AdminService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AdminService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as unknown as GithubService,
    );
  });

  it('listUsers keeps the existing bounded array response by default', async () => {
    await expect(service.listUsers({ q: 'admin', role: UserRole.ADMIN })).resolves.toEqual([
      expect.objectContaining({
        id: 'user-1',
        projectCount: 2,
      }),
    ]);

    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: {
        role: UserRole.ADMIN,
        OR: [
          { email: { contains: 'admin', mode: 'insensitive' } },
          { fullName: { contains: 'admin', mode: 'insensitive' } },
        ],
      },
      select: expect.any(Object),
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      take: 200,
    });
  });

  it('listUsers returns a cursor page when pagination is requested', async () => {
    prisma.profile.findMany.mockResolvedValue([
      makeProfile({ id: 'user-2', email: 'a@example.com' }),
      makeProfile({ id: 'user-3', email: 'b@example.com', createdProjects: [] }),
      makeProfile({ id: 'user-4', email: 'c@example.com', memberships: [] }),
    ]);

    await expect(
      service.listUsers({
        role: UserRole.PM,
        page: { limit: '2', cursor: 'user-1' },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ id: 'user-2', projectCount: 2 }),
        expect.objectContaining({ id: 'user-3', projectCount: 1 }),
      ],
      nextCursor: 'user-4',
    });

    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: { role: UserRole.PM },
      select: expect.any(Object),
      orderBy: [{ role: 'asc' }, { email: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'user-1' },
      skip: 1,
    });
  });

  it('listDomains keeps the existing array response by default', async () => {
    await expect(service.listDomains()).resolves.toEqual([
      expect.objectContaining({ id: 'domain-1', name: 'app.example.com' }),
    ]);

    expect(prisma.adminDomain.findMany).toHaveBeenCalledWith({
      orderBy: [{ environment: 'asc' }, { name: 'asc' }],
    });
  });

  it('listDomains returns a cursor page when pagination is requested', async () => {
    prisma.adminDomain.findMany.mockResolvedValue([
      makeDomain({ id: 'domain-2', name: 'a.example.com' }),
      makeDomain({ id: 'domain-3', name: 'b.example.com' }),
      makeDomain({ id: 'domain-4', name: 'c.example.com' }),
    ]);

    await expect(
      service.listDomains({ limit: '2', cursor: 'domain-1' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ id: 'domain-2' }),
        expect.objectContaining({ id: 'domain-3' }),
      ],
      nextCursor: 'domain-4',
    });

    expect(prisma.adminDomain.findMany).toHaveBeenCalledWith({
      orderBy: [{ environment: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'domain-1' },
      skip: 1,
    });
  });

  it('listRepositories returns a cursor page when pagination is requested', async () => {
    prisma.project.findMany.mockResolvedValue([
      makeProject({ id: 'project-2', repoUrl: 'https://github.com/acme/a' }),
      makeProject({ id: 'project-3' }),
      makeProject({ id: 'project-4' }),
    ]);

    await expect(
      service.listRepositories({ limit: '2', cursor: 'project-1' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ projectId: 'project-2', linked: true }),
        expect.objectContaining({ projectId: 'project-3', linked: false }),
      ],
      nextCursor: 'project-4',
    });

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      select: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'project-1' },
      skip: 1,
    });
  });

  it('listHandoffs returns a cursor page when pagination is requested', async () => {
    prisma.project.findMany.mockResolvedValue([
      makeProject({
        id: 'project-2',
        artifacts: [
          { clientVisible: true, outputReviewStatus: 'PUBLISHED', reviewStatus: 'APPROVED' },
        ],
        workOrders: [{ status: WorkOrderStatus.READY }],
      }),
      makeProject({ id: 'project-3' }),
      makeProject({ id: 'project-4' }),
    ]);

    await expect(
      service.listHandoffs({ limit: '2', cursor: 'project-1' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          projectId: 'project-2',
          clientVisibleArtifacts: 1,
          publishedArtifacts: 1,
          activeWorkOrders: 1,
        }),
        expect.objectContaining({ projectId: 'project-3' }),
      ],
      nextCursor: 'project-4',
    });

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      select: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'project-1' },
      skip: 1,
    });
  });
});
