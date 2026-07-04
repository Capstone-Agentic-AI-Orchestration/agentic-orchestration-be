import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScheduleEventType, UserRole } from '@prisma/client';
import { ScheduleService } from '../src/schedule/schedule.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/auth/auth.types';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

const devUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  fullName: 'Dana Developer',
  role: UserRole.DEV,
};

function makePrismaMock() {
  return {
    scheduleEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'event-1' }),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 'event-1' }),
      delete: vi.fn().mockResolvedValue({ id: 'event-1' }),
    },
    project: {
      findFirst: vi.fn().mockResolvedValue({ id: 'project-1' }),
    },
  };
}

function makeScheduleEvent(overrides = {}) {
  return {
    id: 'event-1',
    title: 'Client kickoff',
    startsAt: new Date('2026-06-15T01:00:00.000Z'),
    endsAt: null,
    createdAt: new Date('2026-06-14T01:00:00.000Z'),
    updatedAt: new Date('2026-06-14T01:00:00.000Z'),
    ...overrides,
  };
}

describe('ScheduleService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: ScheduleService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ScheduleService(prisma as unknown as PrismaService);
  });

  it('lists schedule events through role-scoped access', async () => {
    await service.list(devUser);

    expect(prisma.scheduleEvent.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: expect.any(Array) }),
      include: expect.any(Object),
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
      take: 250,
    });
  });

  it('returns a cursor page for schedule events when pagination is requested', async () => {
    prisma.scheduleEvent.findMany.mockResolvedValue([
      makeScheduleEvent({ id: 'event-2' }),
      makeScheduleEvent({ id: 'event-3' }),
      makeScheduleEvent({ id: 'event-4' }),
    ]);

    await expect(
      service.list(devUser, { limit: '2', cursor: 'event-1' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ id: 'event-2' }),
        expect.objectContaining({ id: 'event-3' }),
      ],
      nextCursor: 'event-4',
    });

    expect(prisma.scheduleEvent.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: expect.any(Array) }),
      include: expect.any(Object),
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'event-1' },
      skip: 1,
    });
  });

  it('creates a project schedule event after checking access', async () => {
    await service.create(pmUser, {
      title: 'Client kickoff',
      projectId: 'project-1',
      startsAt: '2026-06-15T01:00:00.000Z',
      endsAt: '2026-06-15T02:00:00.000Z',
      type: ScheduleEventType.MEETING,
    });

    expect(prisma.project.findFirst).toHaveBeenCalled();
    expect(prisma.scheduleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Client kickoff',
        ownerId: pmUser.id,
        projectId: 'project-1',
      }),
      include: expect.any(Object),
    });
  });

  it('rejects invalid date ranges', async () => {
    await expect(service.create(pmUser, {
      title: 'Bad range',
      startsAt: '2026-06-15T02:00:00.000Z',
      endsAt: '2026-06-15T01:00:00.000Z',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects edits to inaccessible events', async () => {
    prisma.scheduleEvent.findFirst.mockResolvedValue(null);

    await expect(service.delete('event-1', devUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});
