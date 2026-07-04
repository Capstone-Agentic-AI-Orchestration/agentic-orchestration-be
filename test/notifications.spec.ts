import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { NotificationType, UserRole } from '@prisma/client';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/auth/auth.types';
import { IntegrationEvents } from '../src/shared/events/integration-event';
import { OutboxService } from '../src/shared/events/outbox.service';

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

function makePrismaMock() {
  return {
    notification: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    profile: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    project: {
      findUnique: vi.fn(),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    projectTimelineEvent: {
      create: vi.fn().mockResolvedValue({ id: 'timeline-1' }),
    },
    integrationOutbox: {
      create: vi.fn().mockResolvedValue({ id: 'outbox-1' }),
    },
  };
}

describe('NotificationsService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: NotificationsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    const repository = new NotificationsRepository(prisma as unknown as PrismaService);
    service = new NotificationsService(
      repository,
      new OutboxService(prisma as unknown as PrismaService),
    );
  });

  it('list returns only notifications for the current user', async () => {
    await service.list(devUser);

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { recipientId: devUser.id },
      include: expect.any(Object),
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('list returns a cursor page when pagination is requested', async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: 'notification-2', recipientId: devUser.id },
      { id: 'notification-3', recipientId: devUser.id },
      { id: 'notification-4', recipientId: devUser.id },
    ]);

    await expect(
      service.list(devUser, { limit: '2', cursor: 'notification-1' }),
    ).resolves.toEqual({
      items: [
        { id: 'notification-2', recipientId: devUser.id },
        { id: 'notification-3', recipientId: devUser.id },
      ],
      nextCursor: 'notification-4',
    });

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { recipientId: devUser.id },
      include: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'notification-1' },
      skip: 1,
    });
  });

  it('markRead rejects notifications outside the current user', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.markRead('notification-1', devUser)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('notify deduplicates recipients and excludes the actor', async () => {
    await service.notify({
      recipientIds: [devUser.id, devUser.id, pmUser.id],
      actorId: pmUser.id,
      projectId: 'project-1',
      taskId: 'task-1',
      type: NotificationType.TASK_ASSIGNED,
      title: 'New task assigned',
      body: 'Fix the dashboard copy.',
    });

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        {
          recipientId: devUser.id,
          actorId: pmUser.id,
          projectId: 'project-1',
          taskId: 'task-1',
          artifactId: null,
          type: NotificationType.TASK_ASSIGNED,
          title: 'New task assigned',
          body: 'Fix the dashboard copy.',
          metadata: {},
        },
      ],
      skipDuplicates: false,
    });
    expect(prisma.integrationOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: IntegrationEvents.notificationRequested,
        aggregateType: 'notification',
        producer: 'notifications',
      }),
    }));
  });

  it('markAllRead marks unread notifications for the current user', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    await expect(service.markAllRead(devUser)).resolves.toEqual({ updated: 3 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: devUser.id, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});
