import { HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { ClientConversationsController } from '../src/collaboration/client-conversations.controller';
import { clientScope, type CollaborationService } from '../src/collaboration/collaboration.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

describe('ClientConversationsController', () => {
  let collaboration: {
    listConversations: ReturnType<typeof vi.fn>;
    createConversation: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
    addMessage: ReturnType<typeof vi.fn>;
    markConversationRead: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: ClientConversationsController;

  beforeEach(() => {
    collaboration = {
      listConversations: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
      listMessages: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn().mockResolvedValue({ id: 'message-1' }),
      markConversationRead: vi.fn().mockResolvedValue({
        read: true,
        lastReadAt: new Date('2026-08-11T00:00:00.000Z'),
      }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ responseStatus, handler }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new ClientConversationsController(
      collaboration as unknown as CollaborationService,
      idempotency as unknown as IdempotencyService,
    );
  });

  // Every route must pass a client scope. Handing the service a project scope from here would
  // serve one company's page from another owner's threads.
  it('reads threads under a client scope', async () => {
    await controller.listConversations('client-1', pmUser, undefined);

    expect(collaboration.listConversations).toHaveBeenCalledWith(
      clientScope('client-1'),
      pmUser,
      undefined,
    );
  });

  it('creates a thread under a client scope with a client-keyed idempotency scope', async () => {
    const dto = { title: 'Renewal terms' };

    await expect(
      controller.createConversation('client-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'conversation-1' });

    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/clients/client-1/conversations`,
      responseStatus: HttpStatus.CREATED,
    }));
    expect(collaboration.createConversation).toHaveBeenCalledWith(
      clientScope('client-1'),
      pmUser,
      dto,
    );
  });

  it('sends a message under a client scope', async () => {
    const dto = { body: 'Sending the revised quote.' };

    await expect(
      controller.addMessage('client-1', 'conversation-1', dto, pmUser, 'request-key-2'),
    ).resolves.toEqual({ id: 'message-1' });

    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      scope: `user:${pmUser.id}:POST:/clients/client-1/conversations/conversation-1/messages`,
    }));
    expect(collaboration.addMessage).toHaveBeenCalledWith(
      clientScope('client-1'),
      'conversation-1',
      pmUser,
      dto,
    );
  });

  it('marks a thread read under a client scope', async () => {
    await controller.markConversationRead('client-1', 'conversation-1', pmUser, 'request-key-3');

    expect(collaboration.markConversationRead).toHaveBeenCalledWith(
      clientScope('client-1'),
      'conversation-1',
      pmUser,
    );
  });

  it('bypasses idempotency when no key is provided', async () => {
    await controller.addMessage('client-1', 'conversation-1', { body: 'No key.' }, pmUser);

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(collaboration.addMessage).toHaveBeenCalled();
  });
});
