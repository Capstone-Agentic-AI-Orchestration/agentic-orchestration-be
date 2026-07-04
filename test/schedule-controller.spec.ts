import { HttpStatus } from '@nestjs/common';
import { ScheduleEventType, UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { ScheduleController } from '../src/schedule/schedule.controller';
import type { ScheduleService } from '../src/schedule/schedule.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

describe('ScheduleController', () => {
  let schedule: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: ScheduleController;

  beforeEach(() => {
    schedule = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'event-1' }),
      update: vi.fn().mockResolvedValue({ id: 'event-1' }),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler, responseStatus }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new ScheduleController(
      schedule as unknown as ScheduleService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('passes schedule list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'event-1' };

    await expect(controller.list(pmUser, page)).resolves.toEqual([]);

    expect(schedule.list).toHaveBeenCalledWith(pmUser, page);
  });

  it('bypasses idempotency for schedule creation when no key is provided', async () => {
    const dto = {
      title: 'Client kickoff',
      startsAt: '2026-06-15T01:00:00.000Z',
      type: ScheduleEventType.MEETING,
    };

    await expect(controller.create(dto, pmUser)).resolves.toEqual({ id: 'event-1' });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(schedule.create).toHaveBeenCalledWith(pmUser, dto);
  });

  it('runs schedule creation through actor-scoped idempotency when a key is provided', async () => {
    const dto = {
      title: 'Client kickoff',
      startsAt: '2026-06-15T01:00:00.000Z',
      type: ScheduleEventType.MEETING,
    };

    await expect(
      controller.create(dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'event-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/schedule/events`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(schedule.create).toHaveBeenCalledWith(pmUser, dto);
  });

  it('runs schedule updates through event-scoped idempotency when a key is provided', async () => {
    const dto = { title: 'Updated kickoff' };

    await expect(
      controller.update('event-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'event-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:PATCH:/schedule/events/event-1`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(schedule.update).toHaveBeenCalledWith('event-1', pmUser, dto);
  });

  it('runs schedule deletion through event-scoped idempotency when a key is provided', async () => {
    await expect(
      controller.delete('event-1', pmUser, 'request-key-1'),
    ).resolves.toEqual({ deleted: true });

    expect(idempotency.requestHash).toHaveBeenCalledWith({ eventId: 'event-1' });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:DELETE:/schedule/events/event-1`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(schedule.delete).toHaveBeenCalledWith('event-1', pmUser);
  });
});
