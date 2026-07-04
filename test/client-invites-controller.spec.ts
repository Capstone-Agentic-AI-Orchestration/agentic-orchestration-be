import { HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { ClientInvitesController } from '../src/client-invites/client-invites.controller';
import type { ClientInvitesService } from '../src/client-invites/client-invites.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

describe('ClientInvitesController idempotency', () => {
  let invites: {
    publicStatus: ReturnType<typeof vi.fn>;
    listMine: ReturnType<typeof vi.fn>;
    acceptMine: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: ClientInvitesController;

  beforeEach(() => {
    invites = {
      publicStatus: vi.fn().mockResolvedValue({ pending: 1, accepted: 0 }),
      listMine: vi.fn().mockResolvedValue([]),
      acceptMine: vi.fn().mockResolvedValue({ accepted: [{ id: 'invite-1' }] }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler }) => ({
        fromCache: false,
        responseStatus: HttpStatus.CREATED,
        body: await handler(),
      })),
    };
    controller = new ClientInvitesController(
      invites as unknown as ClientInvitesService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('runs invite acceptance through user-scoped idempotency when a key is provided', async () => {
    await expect(
      controller.acceptMine(clientUser, 'request-key-1'),
    ).resolves.toEqual({ accepted: [{ id: 'invite-1' }] });

    expect(idempotency.requestHash).toHaveBeenCalledWith({
      userId: clientUser.id,
      email: clientUser.email,
    });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${clientUser.id}:POST:/client-invites/accept`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(invites.acceptMine).toHaveBeenCalledWith(clientUser);
  });

  it('bypasses idempotency for invite acceptance when no key is provided', async () => {
    await expect(controller.acceptMine(clientUser)).resolves.toEqual({
      accepted: [{ id: 'invite-1' }],
    });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(invites.acceptMine).toHaveBeenCalledWith(clientUser);
  });

  it('passes invite list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'invite-1' };

    await expect(controller.listMine(clientUser, page)).resolves.toEqual([]);

    expect(invites.listMine).toHaveBeenCalledWith(clientUser, page);
  });
});
