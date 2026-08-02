import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  CollaborationDocumentKind,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  InquiryStatus,
  NotificationType,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../src/auth/auth.types';
import { IntakeRepository } from '../src/inquiries/intake.repository';
import { InquiriesService } from '../src/inquiries/inquiries.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntegrationEvents } from '../src/shared/events/integration-event';
import { OutboxService } from '../src/shared/events/outbox.service';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

function makeInquiry(overrides = {}) {
  return {
    id: 'inquiry-1',
    companyName: 'Acme Co',
    contactName: 'Casey Client',
    email: 'casey@example.com',
    phone: null,
    role: null,
    brief: 'Build a customer portal with payments and admin workflows.',
    stackKey: 'nextjs-nestjs-supabase',
    budgetRange: null,
    timeline: null,
    status: InquiryStatus.NEW,
    reviewNote: null,
    reviewedById: null,
    reviewedAt: null,
    approvedProjectId: null,
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    reviewedBy: null,
    clientInvite: null,
    ...overrides,
  };
}

function makePrismaMock() {
  const tx = {
    project: {
      create: vi.fn().mockResolvedValue({ id: 'project-1' }),
    },
    // Approval resolves the client company the lead belongs to. Defaults to "no existing match"
    // so the handoff exercises the create path; tests that need a match override findFirst.
    client: {
      findUnique: vi.fn().mockResolvedValue({ id: 'client-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'client-1' }),
    },
    clientContact: {
      upsert: vi.fn().mockResolvedValue({ id: 'contact-1' }),
    },
    profile: {
      findFirst: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' }),
    },
    projectMember: {
      upsert: vi.fn().mockResolvedValue({ id: 'member-1' }),
    },
    clientInvite: {
      create: vi.fn().mockResolvedValue({ id: 'invite-1' }),
    },
    projectTimelineEvent: {
      create: vi.fn().mockResolvedValue({ id: 'timeline-1' }),
    },
    projectConversation: {
      create: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
    },
    projectMessage: {
      create: vi.fn().mockResolvedValue({ id: 'message-1' }),
    },
    collaborationDocument: {
      create: vi.fn().mockResolvedValue({ id: 'document-1' }),
    },
    clientInquiry: {
      create: vi.fn().mockResolvedValue(makeInquiry()),
      update: vi.fn().mockResolvedValue(makeInquiry({
        status: InquiryStatus.APPROVED,
        reviewedById: pmUser.id,
        approvedProjectId: 'project-1',
      })),
    },
    integrationOutbox: {
      create: vi.fn().mockResolvedValue({ id: 'outbox-1' }),
    },
  };

  return {
    tx,
    clientInquiry: {
      create: vi.fn().mockResolvedValue(makeInquiry()),
      findMany: vi.fn().mockResolvedValue([makeInquiry()]),
      findUnique: vi.fn().mockResolvedValue(makeInquiry()),
      update: vi.fn().mockResolvedValue(makeInquiry({
        status: InquiryStatus.REJECTED,
        reviewedById: pmUser.id,
      })),
    },
    $transaction: vi.fn((callback) => callback(tx)),
  };
}

function makeNotificationsMock() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    projectManagers: vi.fn().mockResolvedValue([pmUser.id]),
  };
}

describe('InquiriesService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let notifications: ReturnType<typeof makeNotificationsMock>;
  let service: InquiriesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    notifications = makeNotificationsMock();
    const intakeRepository = new IntakeRepository(prisma as unknown as PrismaService);
    service = new InquiriesService(
      intakeRepository,
      notifications as unknown as NotificationsService,
      new OutboxService(prisma as unknown as PrismaService),
    );
  });

  it('creates public inquiries and notifies PM users', async () => {
    await service.create({
      companyName: ' Acme Co ',
      contactName: ' Casey Client ',
      email: 'CASEY@example.com',
      brief: 'Build a customer portal with payments and admin workflows.',
    });

    expect(prisma.tx.clientInquiry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyName: 'Acme Co',
        contactName: 'Casey Client',
        email: 'casey@example.com',
        stackKey: 'nextjs-nestjs-supabase',
      }),
    }));
    expect(prisma.tx.integrationOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: IntegrationEvents.inquirySubmitted,
        aggregateType: 'client_inquiry',
        aggregateId: 'inquiry-1',
        producer: 'intake',
      }),
    }));
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      type: NotificationType.INQUIRY_SUBMITTED,
      title: 'New client inquiry',
    }));
  });

  it('filters inquiry lists by status', async () => {
    await service.findAll(InquiryStatus.NEW);

    expect(prisma.clientInquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: InquiryStatus.NEW },
      orderBy: { createdAt: 'desc' },
    }));
  });

  it('returns a cursor page for filtered inquiry lists when pagination is requested', async () => {
    prisma.clientInquiry.findMany.mockResolvedValue([
      makeInquiry({ id: 'inquiry-2' }),
      makeInquiry({ id: 'inquiry-3' }),
      makeInquiry({ id: 'inquiry-4' }),
    ]);

    await expect(
      service.findAll(InquiryStatus.NEW, { limit: '2', cursor: 'inquiry-1' }),
    ).resolves.toEqual({
      items: [
        makeInquiry({ id: 'inquiry-2' }),
        makeInquiry({ id: 'inquiry-3' }),
      ],
      nextCursor: 'inquiry-4',
    });

    expect(prisma.clientInquiry.findMany).toHaveBeenCalledWith({
      where: { status: InquiryStatus.NEW },
      include: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      cursor: { id: 'inquiry-1' },
      skip: 1,
    });
  });

  it('approves an inquiry into a project with collaboration handoff records', async () => {
    await service.approve('inquiry-1', pmUser, { reviewNote: 'Approved for discovery.' });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.tx.project.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyName: 'Acme Co',
        createdById: pmUser.id,
      }),
    }));
    expect(prisma.tx.projectConversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        title: 'Client onboarding',
        category: ConversationCategory.SUPPORT,
        visibility: CollaborationVisibility.CLIENT,
      }),
    }));
    expect(prisma.tx.clientInvite.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        inquiryId: 'inquiry-1',
        projectId: 'project-1',
        email: 'casey@example.com',
        status: 'ACCEPTED',
      }),
    }));
    expect(prisma.tx.collaborationDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        title: 'Initial requirements brief',
        kind: CollaborationDocumentKind.REQUIREMENT,
        status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
        clientVisible: true,
      }),
    }));
    expect(prisma.tx.projectTimelineEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: ProjectTimelineEventType.PROJECT_CREATED,
        visibility: ProjectTimelineVisibility.TEAM,
      }),
    }));
    expect(prisma.tx.integrationOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: IntegrationEvents.inquiryApproved,
        aggregateId: 'inquiry-1',
        producer: 'intake',
      }),
    }));
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({
      type: NotificationType.INQUIRY_APPROVED,
      projectId: 'project-1',
    }));
  });

  it('rejects an inquiry with reviewer metadata', async () => {
    await service.reject('inquiry-1', pmUser, { reviewNote: 'Outside current scope.' });

    expect(prisma.tx.clientInquiry.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: InquiryStatus.REJECTED,
        reviewNote: 'Outside current scope.',
        reviewedById: pmUser.id,
      }),
    }));
    expect(prisma.tx.integrationOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: IntegrationEvents.inquiryRejected,
        aggregateId: 'inquiry-1',
        producer: 'intake',
      }),
    }));
  });

  it('prevents reviewing the same inquiry twice', async () => {
    prisma.clientInquiry.findUnique.mockResolvedValue(makeInquiry({ status: InquiryStatus.APPROVED }));

    await expect(service.approve('inquiry-1', pmUser, {})).rejects.toBeInstanceOf(BadRequestException);
  });
});
