import { HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { NotificationsController } from '../src/notifications/notifications.controller';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const devUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  fullName: 'Dana Developer',
  role: UserRole.DEV,
};

describe('NotificationsController', () => {
  let notifications: {
    list: ReturnType<typeof vi.fn>;
    markAllRead: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: NotificationsController;

  beforeEach(() => {
    notifications = {
      list: vi.fn().mockResolvedValue([]),
      markAllRead: vi.fn().mockResolvedValue({ updated: 3 }),
      markRead: vi.fn().mockResolvedValue({ id: 'notification-1', readAt: new Date('2026-06-15T00:00:00.000Z') }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler, responseStatus }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new NotificationsController(
      notifications as unknown as NotificationsService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('passes notification list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'notification-1' };

    await expect(controller.list(devUser, page)).resolves.toEqual([]);

    expect(notifications.list).toHaveBeenCalledWith(devUser, page);
  });

  it('bypasses idempotency for mark-all-read when no key is provided', async () => {
    await expect(controller.markAllRead(devUser)).resolves.toEqual({ updated: 3 });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(notifications.markAllRead).toHaveBeenCalledWith(devUser);
  });

  it('runs mark-all-read through actor-scoped idempotency when a key is provided', async () => {
    await expect(
      controller.markAllRead(devUser, 'request-key-1'),
    ).resolves.toEqual({ updated: 3 });

    expect(idempotency.requestHash).toHaveBeenCalledWith({ userId: devUser.id });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${devUser.id}:PATCH:/notifications/read-all`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(notifications.markAllRead).toHaveBeenCalledWith(devUser);
  });

  it('runs single notification reads through notification-scoped idempotency when a key is provided', async () => {
    await expect(
      controller.markRead('notification-1', devUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'notification-1', readAt: new Date('2026-06-15T00:00:00.000Z') });

    expect(idempotency.requestHash).toHaveBeenCalledWith({ notificationId: 'notification-1' });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${devUser.id}:PATCH:/notifications/notification-1/read`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(notifications.markRead).toHaveBeenCalledWith('notification-1', devUser);
  });
});
