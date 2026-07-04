import { HttpStatus } from '@nestjs/common';
import { DeveloperAvailabilityStatus, UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { DevelopersController } from '../src/developers/developers.controller';
import type { DevelopersService } from '../src/developers/developers.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const devUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  fullName: 'Dana Developer',
  role: UserRole.DEV,
};

describe('DevelopersController', () => {
  let developers: {
    list: ReturnType<typeof vi.fn>;
    updateMe: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: DevelopersController;

  beforeEach(() => {
    developers = {
      list: vi.fn().mockResolvedValue([]),
      updateMe: vi.fn().mockResolvedValue({ userId: devUser.id }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler, responseStatus }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new DevelopersController(
      developers as unknown as DevelopersService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('passes developer list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'developer-1' };

    await expect(controller.list(page)).resolves.toEqual([]);

    expect(developers.list).toHaveBeenCalledWith(page);
  });

  it('bypasses idempotency for capacity updates when no key is provided', async () => {
    const dto = { weeklyCapacityHours: 24 };

    await expect(controller.updateMe(dto, devUser)).resolves.toEqual({ userId: devUser.id });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(developers.updateMe).toHaveBeenCalledWith(devUser, dto);
  });

  it('runs capacity updates through actor-scoped idempotency when a key is provided', async () => {
    const dto = {
      skills: ['backend'],
      weeklyCapacityHours: 24,
      availabilityStatus: DeveloperAvailabilityStatus.AVAILABLE,
    };

    await expect(
      controller.updateMe(dto, devUser, 'request-key-1'),
    ).resolves.toEqual({ userId: devUser.id });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${devUser.id}:PATCH:/developers/me/capacity`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(developers.updateMe).toHaveBeenCalledWith(devUser, dto);
  });
});
