import { Injectable } from '@nestjs/common';
import {
  ClientInquiry,
  ClientInvite,
  ClientInviteStatus,
  CollaborationDocumentKind,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  InquiryStatus,
  Prisma,
  ProjectStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CursorPageInput,
  cursorQueryArgs,
  hasCursorPage,
} from '../shared/pagination/cursor-pagination';
import { CreateInquiryDto } from './dto/create-inquiry.dto';

export type InquiryWithReviewer = ClientInquiry & {
  reviewedBy: {
    id: string;
    email: string | null;
    fullName: string | null;
    role: UserRole;
  } | null;
  clientInvite: Pick<ClientInvite, 'id' | 'status' | 'projectId' | 'email' | 'acceptedAt'> | null;
};

export type InviteView = ClientInvite & {
  project: {
    id: string;
    companyName: string;
    status: string;
    createdAt: Date;
  };
};

const reviewerInclude = {
  reviewedBy: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
  clientInvite: {
    select: {
      id: true,
      status: true,
      projectId: true,
      email: true,
      acceptedAt: true,
    },
  },
} satisfies Prisma.ClientInquiryInclude;

const inviteInclude = {
  project: {
    select: {
      id: true,
      companyName: true,
      status: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ClientInviteInclude;

@Injectable()
export class IntakeRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(callback);
  }

  createInquiry(tx: Prisma.TransactionClient, dto: CreateInquiryDto): Promise<InquiryWithReviewer> {
    return tx.clientInquiry.create({
      data: {
        companyName: dto.companyName.trim(),
        contactName: dto.contactName.trim(),
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone?.trim() || null,
        role: dto.role?.trim() || null,
        brief: dto.brief.trim(),
        stackKey: dto.stackKey?.trim() || 'nextjs-nestjs-supabase',
        budgetRange: dto.budgetRange?.trim() || null,
        timeline: dto.timeline?.trim() || null,
      },
      include: reviewerInclude,
    });
  }

  findInquiries(status?: InquiryStatus, page?: CursorPageInput): Promise<InquiryWithReviewer[]> {
    return this.prisma.clientInquiry.findMany({
      where: status ? { status } : undefined,
      include: reviewerInclude,
      orderBy: hasCursorPage(page)
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : { createdAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : {}),
    });
  }

  findInquiry(id: string): Promise<InquiryWithReviewer | null> {
    return this.prisma.clientInquiry.findUnique({
      where: { id },
      include: reviewerInclude,
    });
  }

  async createApprovedInquiryHandoff(
    tx: Prisma.TransactionClient,
    input: {
      inquiry: InquiryWithReviewer;
      actorId: string;
      reviewNote: string | null;
      reviewedAt: Date;
    },
  ): Promise<{ inquiry: InquiryWithReviewer; projectId: string; clientProfileId: string | null }> {
    const { inquiry, actorId, reviewNote, reviewedAt } = input;
    const project = await tx.project.create({
      data: {
        companyName: inquiry.companyName,
        brief: inquiry.brief,
        stackKey: inquiry.stackKey,
        status: ProjectStatus.PENDING,
        createdById: actorId,
      },
    });

    const clientProfile = await tx.profile.findFirst({
      where: { email: inquiry.email, role: UserRole.CLIENT },
      select: { id: true },
    });

    if (clientProfile) {
      await tx.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId: clientProfile.id,
          },
        },
        update: { role: UserRole.CLIENT },
        create: {
          projectId: project.id,
          userId: clientProfile.id,
          role: UserRole.CLIENT,
        },
      });
    }

    await tx.clientInvite.create({
      data: {
        inquiryId: inquiry.id,
        projectId: project.id,
        email: inquiry.email,
        contactName: inquiry.contactName,
        companyName: inquiry.companyName,
        status: clientProfile ? ClientInviteStatus.ACCEPTED : ClientInviteStatus.PENDING,
        createdById: actorId,
        acceptedById: clientProfile?.id ?? null,
        acceptedAt: clientProfile ? reviewedAt : null,
      },
    });

    await tx.projectTimelineEvent.create({
      data: {
        projectId: project.id,
        actorId,
        type: ProjectTimelineEventType.PROJECT_CREATED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Project created from inquiry',
        body: inquiry.companyName,
        metadata: { inquiryId: inquiry.id, stackKey: inquiry.stackKey },
      },
    });

    const conversation = await tx.projectConversation.create({
      data: {
        projectId: project.id,
        title: 'Client onboarding',
        category: ConversationCategory.SUPPORT,
        visibility: CollaborationVisibility.CLIENT,
        createdById: actorId,
        lastMessageAt: reviewedAt,
      },
    });

    await tx.projectMessage.create({
      data: {
        projectId: project.id,
        conversationId: conversation.id,
        authorId: actorId,
        body: [
          `Initial inquiry from ${inquiry.contactName} (${inquiry.email}).`,
          '',
          inquiry.brief,
        ].join('\n'),
        createdAt: reviewedAt,
      },
    });

    await tx.collaborationDocument.create({
      data: {
        projectId: project.id,
        title: 'Initial requirements brief',
        description: inquiry.brief,
        kind: CollaborationDocumentKind.REQUIREMENT,
        status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
        clientVisible: true,
        uploadedById: actorId,
      },
    });

    const approvedInquiry = await tx.clientInquiry.update({
      where: { id: inquiry.id },
      data: {
        status: InquiryStatus.APPROVED,
        reviewNote,
        reviewedAt,
        reviewedById: actorId,
        approvedProjectId: project.id,
      },
      include: reviewerInclude,
    });

    return {
      inquiry: approvedInquiry,
      projectId: project.id,
      clientProfileId: clientProfile?.id ?? null,
    };
  }

  rejectInquiry(
    tx: Prisma.TransactionClient,
    input: { id: string; actorId: string; reviewNote: string | null; reviewedAt: Date },
  ): Promise<InquiryWithReviewer> {
    return tx.clientInquiry.update({
      where: { id: input.id },
      data: {
        status: InquiryStatus.REJECTED,
        reviewNote: input.reviewNote,
        reviewedAt: input.reviewedAt,
        reviewedById: input.actorId,
      },
      include: reviewerInclude,
    });
  }

  findInvitesForStatus(email: string): Promise<ClientInvite[]> {
    return this.prisma.clientInvite.findMany({
      where: { email, status: { in: [ClientInviteStatus.PENDING, ClientInviteStatus.ACCEPTED] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  findInvitesForUser(user: { id: string; email?: string | null }, page?: CursorPageInput): Promise<InviteView[]> {
    return this.prisma.clientInvite.findMany({
      where: {
        OR: [
          { email: user.email?.toLowerCase() ?? '' },
          { acceptedById: user.id },
        ],
        status: { in: [ClientInviteStatus.PENDING, ClientInviteStatus.ACCEPTED] },
      },
      include: inviteInclude,
      orderBy: hasCursorPage(page)
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : { createdAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : {}),
    });
  }

  async acceptPendingInvites(
    tx: Prisma.TransactionClient,
    input: { profileId: string; email: string },
    onAccepted: (invite: InviteView) => Promise<void>,
  ): Promise<InviteView[]> {
    const pending = await tx.clientInvite.findMany({
      where: {
        email: input.email,
        status: ClientInviteStatus.PENDING,
      },
      include: inviteInclude,
      orderBy: { createdAt: 'asc' },
    });

    for (const invite of pending) {
      await tx.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: invite.projectId,
            userId: input.profileId,
          },
        },
        update: { role: UserRole.CLIENT },
        create: {
          projectId: invite.projectId,
          userId: input.profileId,
          role: UserRole.CLIENT,
        },
      });

      await tx.clientInvite.update({
        where: { id: invite.id },
        data: {
          status: ClientInviteStatus.ACCEPTED,
          acceptedById: input.profileId,
          acceptedAt: new Date(),
        },
      });

      await tx.projectTimelineEvent.create({
        data: {
          projectId: invite.projectId,
          actorId: input.profileId,
          type: ProjectTimelineEventType.CLIENT_INVITE_ACCEPTED,
          visibility: ProjectTimelineVisibility.CLIENT,
          title: 'Client invite accepted',
          body: invite.companyName,
          metadata: { inviteId: invite.id, email: input.email },
        },
      });

      await onAccepted(invite);
    }

    if (pending.length === 0) {
      return [];
    }

    return tx.clientInvite.findMany({
      where: { id: { in: pending.map((invite) => invite.id) } },
      include: inviteInclude,
      orderBy: { createdAt: 'desc' },
    });
  }
}
