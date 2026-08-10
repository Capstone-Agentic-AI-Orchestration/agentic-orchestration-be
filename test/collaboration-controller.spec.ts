import { HttpStatus } from '@nestjs/common';
import { CollaborationDocumentStatus, UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { CollaborationController } from '../src/collaboration/collaboration.controller';
import { projectScope, type CollaborationService } from '../src/collaboration/collaboration.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

describe('CollaborationController idempotency', () => {
  let collaboration: {
    createConversation: ReturnType<typeof vi.fn>;
    addMessage: ReturnType<typeof vi.fn>;
    createDocument: ReturnType<typeof vi.fn>;
    updateDocument: ReturnType<typeof vi.fn>;
    reviewDocument: ReturnType<typeof vi.fn>;
    markConversationRead: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: CollaborationController;

  beforeEach(() => {
    collaboration = {
      createConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
      addMessage: vi.fn().mockResolvedValue({ id: 'message-1' }),
      createDocument: vi.fn().mockResolvedValue({ id: 'document-1' }),
      updateDocument: vi.fn().mockResolvedValue({ id: 'document-1', title: 'Updated' }),
      reviewDocument: vi.fn().mockResolvedValue({ id: 'document-1', status: 'APPROVED' }),
      markConversationRead: vi.fn().mockResolvedValue({
        read: true,
        lastReadAt: new Date('2026-06-15T00:00:00.000Z'),
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
    controller = new CollaborationController(
      collaboration as unknown as CollaborationService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('runs conversation creation through project-scoped idempotency when a key is provided', async () => {
    const dto = { title: 'Launch room' };

    await expect(
      controller.createConversation('project-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'conversation-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/projects/project-1/conversations`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(collaboration.createConversation).toHaveBeenCalledWith(projectScope('project-1'), pmUser, dto);
  });

  it('runs message creation through conversation-scoped idempotency when a key is provided', async () => {
    const dto = { body: 'Please review this thread.' };

    await expect(
      controller.addMessage('project-1', 'conversation-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'message-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/projects/project-1/conversations/conversation-1/messages`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(collaboration.addMessage).toHaveBeenCalledWith(
      projectScope('project-1'),
      'conversation-1',
      pmUser,
      dto,
    );
  });

  it('runs document creation through project-scoped idempotency when a key is provided', async () => {
    const dto = { title: 'Launch checklist', clientVisible: true };

    await expect(
      controller.createDocument('project-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'document-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/projects/project-1/documents`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(collaboration.createDocument).toHaveBeenCalledWith('project-1', pmUser, dto);
  });

  it('runs conversation read state through conversation-scoped idempotency when a key is provided', async () => {
    await expect(
      controller.markConversationRead('project-1', 'conversation-1', pmUser, 'request-key-1'),
    ).resolves.toEqual({
      read: true,
      lastReadAt: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(idempotency.requestHash).toHaveBeenCalledWith({
      projectId: 'project-1',
      conversationId: 'conversation-1',
    });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:PATCH:/projects/project-1/conversations/conversation-1/read`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(collaboration.markConversationRead).toHaveBeenCalledWith(
      projectScope('project-1'),
      'conversation-1',
      pmUser,
    );
  });

  it('runs document updates through document-scoped idempotency when a key is provided', async () => {
    const dto = { title: 'Updated launch checklist', version: 2 };

    await expect(
      controller.updateDocument('project-1', 'document-1', dto, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'document-1', title: 'Updated' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:PATCH:/projects/project-1/documents/document-1`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(collaboration.updateDocument).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      pmUser,
      dto,
    );
  });

  it('runs document reviews through document-scoped idempotency when a key is provided', async () => {
    const dto = {
      status: CollaborationDocumentStatus.APPROVED,
      reviewNote: 'Looks good.',
      version: 3,
    };

    await expect(
      controller.reviewDocument('project-1', 'document-1', dto, clientUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'document-1', status: 'APPROVED' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${clientUser.id}:POST:/projects/project-1/documents/document-1/review`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(collaboration.reviewDocument).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      clientUser,
      dto,
    );
  });

  it('bypasses idempotency when no key is provided', async () => {
    const dto = { body: 'Please review this thread.' };

    await expect(
      controller.addMessage('project-1', 'conversation-1', dto, pmUser),
    ).resolves.toEqual({ id: 'message-1' });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(collaboration.addMessage).toHaveBeenCalledWith(
      projectScope('project-1'),
      'conversation-1',
      pmUser,
      dto,
    );
  });
});
