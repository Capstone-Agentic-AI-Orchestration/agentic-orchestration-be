import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  NotificationType,
  UserRole,
} from '@prisma/client';
import { CollaborationService } from '../src/collaboration/collaboration.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/auth/auth.types';

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

const devUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  fullName: 'Dana Developer',
  role: UserRole.DEV,
};

function makeConversation(overrides = {}) {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    title: 'Client launch notes',
    category: ConversationCategory.GENERAL,
    visibility: CollaborationVisibility.CLIENT,
    createdById: pmUser.id,
    lastMessageAt: null,
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    createdBy: null,
    messages: [],
    reads: [],
    _count: { messages: 0 },
    ...overrides,
  };
}

function makeDocument(overrides = {}) {
  return {
    id: 'document-1',
    projectId: 'project-1',
    artifactId: null,
    title: 'Launch checklist',
    description: null,
    fileName: null,
    externalUrl: null,
    kind: 'GENERAL',
    status: CollaborationDocumentStatus.UPLOADED,
    clientVisible: true,
    uploadedById: pmUser.id,
    reviewedById: null,
    reviewNote: null,
    reviewedAt: null,
    version: 1,
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    uploadedBy: null,
    reviewedBy: null,
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    authorId: pmUser.id,
    body: 'Please review the launch notes.',
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    author: null,
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    project: {
      findFirst: vi.fn().mockResolvedValue({ id: 'project-1' }),
    },
    projectConversation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    projectMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    conversationRead: {
      upsert: vi.fn().mockResolvedValue({ id: 'read-1' }),
    },
    collaborationDocument: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    artifact: {
      findFirst: vi.fn(),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([{ userId: devUser.id }]),
    },
    projectTimelineEvent: {
      create: vi.fn().mockResolvedValue({ id: 'timeline-1' }),
    },
  };
}

function makeNotificationsMock() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    projectManagers: vi.fn().mockResolvedValue([pmUser.id]),
    projectClients: vi.fn().mockResolvedValue([clientUser.id]),
  };
}

describe('CollaborationService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let notifications: ReturnType<typeof makeNotificationsMock>;
  let service: CollaborationService;

  beforeEach(() => {
    prisma = makePrismaMock();
    notifications = makeNotificationsMock();
    service = new CollaborationService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  it('scopes client conversations to client-visible threads', async () => {
    await service.listConversations('project-1', clientUser);

    expect(prisma.projectConversation.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        visibility: { in: [CollaborationVisibility.CLIENT] },
      },
      include: expect.any(Object),
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('scopes developer conversations to shared team threads', async () => {
    await service.listConversations('project-1', devUser);

    expect(prisma.projectConversation.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        visibility: { in: [CollaborationVisibility.TEAM] },
      },
      include: expect.any(Object),
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('counts only messages newer than the current user read timestamp', async () => {
    const lastReadAt = new Date('2026-05-28T02:00:00.000Z');
    prisma.projectConversation.findMany.mockResolvedValue([
      makeConversation({
        visibility: CollaborationVisibility.TEAM,
        reads: [{ lastReadAt }],
      }),
    ]);
    prisma.projectMessage.findMany.mockResolvedValue([
      { conversationId: 'conversation-1', createdAt: new Date('2026-05-28T01:00:00.000Z') },
      { conversationId: 'conversation-1', createdAt: new Date('2026-05-28T03:00:00.000Z') },
    ]);

    await expect(service.listConversations('project-1', devUser)).resolves.toEqual([
      expect.objectContaining({ id: 'conversation-1', unreadCount: 1 }),
    ]);
  });

  it('returns a cursor page for conversations when pagination is requested', async () => {
    prisma.projectConversation.findMany.mockResolvedValue([
      makeConversation({ id: 'conversation-1', updatedAt: new Date('2026-05-28T03:00:00.000Z') }),
      makeConversation({ id: 'conversation-2', updatedAt: new Date('2026-05-28T02:00:00.000Z') }),
      makeConversation({ id: 'conversation-3', updatedAt: new Date('2026-05-28T01:00:00.000Z') }),
    ]);

    const page = await service.listConversations('project-1', clientUser, {
      limit: 2,
      cursor: 'conversation-cursor',
    });

    expect(prisma.projectConversation.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        visibility: { in: [CollaborationVisibility.CLIENT] },
      },
      include: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'conversation-cursor' },
      skip: 1,
    });
    expect(page).toEqual({
      items: [
        expect.objectContaining({ id: 'conversation-1' }),
        expect.objectContaining({ id: 'conversation-2' }),
      ],
      nextCursor: 'conversation-3',
    });
  });

  it('prevents developers from creating client-visible conversations', async () => {
    await expect(
      service.createConversation('project-1', devUser, {
        title: 'Client topic',
        visibility: CollaborationVisibility.CLIENT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a message and notifies conversation recipients', async () => {
    prisma.projectConversation.findFirst.mockResolvedValue(makeConversation());
    prisma.projectMessage.create.mockResolvedValue({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      authorId: pmUser.id,
      body: 'Please review the launch notes.',
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      author: null,
    });

    await service.addMessage('project-1', 'conversation-1', pmUser, {
      body: 'Please review the launch notes.',
    });

    expect(prisma.projectMessage.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        conversationId: 'conversation-1',
        authorId: pmUser.id,
        body: 'Please review the launch notes.',
      },
      include: expect.any(Object),
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: [pmUser.id, clientUser.id],
      actorId: pmUser.id,
      type: NotificationType.COLLAB_MESSAGE_SENT,
    }));
  });

  it('returns a cursor page for messages when pagination is requested', async () => {
    prisma.projectConversation.findFirst.mockResolvedValue(makeConversation());
    prisma.projectMessage.findMany.mockResolvedValue([
      makeMessage({ id: 'message-1', createdAt: new Date('2026-05-28T00:00:00.000Z') }),
      makeMessage({ id: 'message-2', createdAt: new Date('2026-05-28T00:01:00.000Z') }),
      makeMessage({ id: 'message-3', createdAt: new Date('2026-05-28T00:02:00.000Z') }),
    ]);

    const page = await service.listMessages('project-1', 'conversation-1', pmUser, {
      limit: 2,
      cursor: 'message-cursor',
    });

    expect(prisma.projectMessage.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', conversationId: 'conversation-1' },
      include: expect.any(Object),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 3,
      cursor: { id: 'message-cursor' },
      skip: 1,
    });
    expect(page).toEqual({
      items: [
        expect.objectContaining({ id: 'message-1' }),
        expect.objectContaining({ id: 'message-2' }),
      ],
      nextCursor: 'message-3',
    });
  });

  it('returns a cursor page for documents when pagination is requested', async () => {
    prisma.collaborationDocument.findMany.mockResolvedValue([
      makeDocument({ id: 'document-1', updatedAt: new Date('2026-05-28T03:00:00.000Z') }),
      makeDocument({ id: 'document-2', updatedAt: new Date('2026-05-28T02:00:00.000Z') }),
      makeDocument({ id: 'document-3', updatedAt: new Date('2026-05-28T01:00:00.000Z') }),
    ]);

    const page = await service.listDocuments('project-1', clientUser, {
      limit: 2,
      cursor: 'document-cursor',
    });

    expect(prisma.collaborationDocument.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        clientVisible: true,
      },
      include: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'document-cursor' },
      skip: 1,
    });
    expect(page).toEqual({
      items: [
        expect.objectContaining({ id: 'document-1' }),
        expect.objectContaining({ id: 'document-2' }),
      ],
      nextCursor: 'document-3',
    });
  });

  it('forces client uploaded documents to be client-visible approval requests', async () => {
    prisma.collaborationDocument.create.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      artifactId: null,
      title: 'Brand assets',
      description: null,
      fileName: 'brand.zip',
      externalUrl: null,
      kind: 'GENERAL',
      status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
      clientVisible: true,
      uploadedById: clientUser.id,
      reviewedById: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      uploadedBy: null,
      reviewedBy: null,
    });

    await service.createDocument('project-1', clientUser, {
      title: 'Brand assets',
      fileName: 'brand.zip',
      clientVisible: false,
      status: CollaborationDocumentStatus.UPLOADED,
    });

    expect(prisma.collaborationDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        clientVisible: true,
        status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
        uploadedById: clientUser.id,
      }),
    }));
  });

  it('forces PM-created client-visible documents into approval review', async () => {
    prisma.collaborationDocument.create.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      artifactId: null,
      title: 'Launch checklist',
      description: null,
      fileName: null,
      externalUrl: null,
      kind: 'GENERAL',
      status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
      clientVisible: true,
      uploadedById: pmUser.id,
      reviewedById: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      uploadedBy: null,
      reviewedBy: null,
    });

    await service.createDocument('project-1', pmUser, {
      title: 'Launch checklist',
      clientVisible: true,
      status: CollaborationDocumentStatus.APPROVED,
    });

    expect(prisma.collaborationDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        clientVisible: true,
        status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
      }),
    }));
  });

  it('resets review state when PM exposes an uploaded document to the client', async () => {
    prisma.collaborationDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      artifactId: null,
      title: 'Internal notes',
      description: null,
      fileName: null,
      externalUrl: null,
      kind: 'GENERAL',
      status: CollaborationDocumentStatus.UPLOADED,
      clientVisible: false,
      uploadedById: pmUser.id,
      reviewedById: pmUser.id,
      reviewNote: 'Internal pass.',
      reviewedAt: new Date('2026-05-28T00:00:00.000Z'),
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    });
    prisma.collaborationDocument.update.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
      clientVisible: true,
      uploadedBy: null,
      reviewedBy: null,
    });

    await service.updateDocument('project-1', 'document-1', pmUser, {
      clientVisible: true,
    });

    expect(prisma.collaborationDocument.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        clientVisible: true,
        status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
        reviewNote: null,
        reviewedAt: null,
        reviewedById: null,
        version: { increment: 1 },
      }),
    }));
  });

  it('rejects stale document metadata updates without writing the document', async () => {
    prisma.collaborationDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      status: CollaborationDocumentStatus.UPLOADED,
      clientVisible: false,
    });
    prisma.collaborationDocument.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateDocument('project-1', 'document-1', pmUser, {
        title: 'Updated notes',
        version: 4,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.collaborationDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'document-1', version: 4 },
      data: expect.objectContaining({
        title: 'Updated notes',
        version: { increment: 1 },
      }),
    });
    expect(prisma.collaborationDocument.update).not.toHaveBeenCalled();
  });

  it('rejects stale document reviews without notifications or timeline entries', async () => {
    prisma.collaborationDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
      clientVisible: true,
    });
    prisma.collaborationDocument.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.reviewDocument('project-1', 'document-1', clientUser, {
        status: CollaborationDocumentStatus.APPROVED,
        reviewNote: 'Looks good.',
        version: 9,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.collaborationDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'document-1', version: 9 },
      data: {
        status: CollaborationDocumentStatus.APPROVED,
        reviewNote: 'Looks good.',
        reviewedAt: expect.any(Date),
        reviewedById: clientUser.id,
        version: { increment: 1 },
      },
    });
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(prisma.projectTimelineEvent.create).not.toHaveBeenCalled();
  });

  it('rejects review attempts for archived documents', async () => {
    prisma.collaborationDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      projectId: 'project-1',
      status: CollaborationDocumentStatus.ARCHIVED,
      clientVisible: true,
    });

    await expect(
      service.reviewDocument('project-1', 'document-1', clientUser, {
        status: CollaborationDocumentStatus.APPROVED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects missing project access', async () => {
    prisma.project.findFirst.mockResolvedValue(null);

    await expect(service.listDocuments('missing-project', clientUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});
