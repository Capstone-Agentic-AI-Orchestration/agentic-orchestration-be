import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProfilesService } from '../src/profiles/profiles.service';

function makePrismaMock() {
  return {
    profile: {
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe('ProfilesService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: ProfilesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ProfilesService(prisma as unknown as PrismaService);
  });

  it('search filters profiles by query and roles', async () => {
    await service.search({
      q: 'jaye',
      roles: [UserRole.DEV, UserRole.CLIENT],
      limit: 10,
    });

    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: {
        role: { in: [UserRole.DEV, UserRole.CLIENT] },
        OR: [
          { email: { contains: 'jaye', mode: 'insensitive' } },
          { fullName: { contains: 'jaye', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
      },
      orderBy: [
        { role: 'asc' },
        { email: 'asc' },
      ],
      take: 10,
    });
  });

  it('search defaults to 20 results without filters', async () => {
    await service.search({});

    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: {},
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
      },
      orderBy: [
        { role: 'asc' },
        { email: 'asc' },
      ],
      take: 20,
    });
  });

  it('me returns the current backend profile', async () => {
    prisma.profile.findUniqueOrThrow.mockResolvedValue({ id: 'user-1' });

    await service.me({
      id: 'user-1',
      email: 'user@example.com',
      fullName: 'User One',
      role: UserRole.CLIENT,
    });

    expect(prisma.profile.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: expect.objectContaining({
        id: true,
        email: true,
        fullName: true,
        preferences: true,
      }),
    });
  });

  it('updateMe trims fullName and stores preferences', async () => {
    prisma.profile.update.mockResolvedValue({ id: 'user-1' });

    await service.updateMe(
      {
        id: 'user-1',
        email: 'user@example.com',
        fullName: 'User One',
        role: UserRole.CLIENT,
      },
      { fullName: ' Updated User ', preferences: { email: true } },
    );

    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        fullName: 'Updated User',
        preferences: { email: true },
      },
      select: expect.any(Object),
    });
  });
});
