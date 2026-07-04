import { HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { ProfilesController } from '../src/profiles/profiles.controller';
import type { ProfilesService } from '../src/profiles/profiles.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

describe('ProfilesController', () => {
  let profiles: {
    me: ReturnType<typeof vi.fn>;
    updateMe: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: ProfilesController;

  beforeEach(() => {
    profiles = {
      me: vi.fn().mockResolvedValue({ id: clientUser.id }),
      updateMe: vi.fn().mockResolvedValue({ id: clientUser.id, fullName: 'Updated Client' }),
      search: vi.fn().mockResolvedValue([]),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler, responseStatus }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new ProfilesController(
      profiles as unknown as ProfilesService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('bypasses idempotency for profile updates when no key is provided', async () => {
    const dto = { fullName: ' Updated Client ' };

    await expect(controller.updateMe(dto, clientUser)).resolves.toEqual({
      id: clientUser.id,
      fullName: 'Updated Client',
    });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(profiles.updateMe).toHaveBeenCalledWith(clientUser, dto);
  });

  it('runs profile updates through actor-scoped idempotency when a key is provided', async () => {
    const dto = {
      fullName: ' Updated Client ',
      preferences: { email: true },
    };

    await expect(
      controller.updateMe(dto, clientUser, 'request-key-1'),
    ).resolves.toEqual({
      id: clientUser.id,
      fullName: 'Updated Client',
    });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${clientUser.id}:PATCH:/profiles/me`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(profiles.updateMe).toHaveBeenCalledWith(clientUser, dto);
  });
});
