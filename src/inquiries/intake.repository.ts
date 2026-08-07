import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ClientInquiry,
  ClientInvite,
  ClientInviteStatus,
  ClientStatus,
  CollaborationDocumentKind,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  InquiryStatus,
  Prisma,
  ProfileStatus,
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
import { isPlaceholderClientName, resolveClientNameForInquiry } from '../clients/client-name';

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
      /**
       * The client this lead belongs to. The PM picks an existing client when the console
       * suggests a match, so a repeat customer's second project lands under the client they
       * already have. Omitted means "resolve or create by company name".
       */
      clientId?: string | null;
      /** Name to create the client under when no existing client is chosen. */
      clientName?: string | null;
      /**
       * The workspace this lead becomes work in.
       *
       * Applied to both the client and the project. Before this, approval produced a client the
       * workspace switcher could not show and a project every workspace filtered out — the exact
       * pair of orphans that made Client.groupId nullable in the first place.
       */
      groupId: string;
    },
  ): Promise<{
    inquiry: InquiryWithReviewer;
    projectId: string;
    clientProfileId: string | null;
    clientId: string;
  }> {
    const { inquiry, actorId, reviewNote, reviewedAt } = input;
    const client = await this.resolveClientId(tx, {
      clientId: input.clientId ?? null,
      clientName: input.clientName ?? null,
      companyName: inquiry.companyName,
      contactName: inquiry.contactName,
      email: inquiry.email,
      actorId,
      groupId: input.groupId,
    });
    const clientId = client.id;
    // A lead from the marketing call-to-action carries a placeholder company; naming the project
    // after the resolved client keeps "TBD" out of every surface that reads companyName directly.
    const projectName = isPlaceholderClientName(inquiry.companyName)
      ? client.name
      : inquiry.companyName;

    const project = await tx.project.create({
      data: {
        companyName: projectName,
        clientId,
        brief: inquiry.brief,
        stackKey: inquiry.stackKey,
        // Accepted, but not delivery work yet. The PM talks to the client and collects
        // documents in this workspace first; promoting to PENDING is a separate, explicit act.
        status: ProjectStatus.DISCOVERY,
        // Same workspace as the client. A project reached through its client but grouped
        // elsewhere would be visible in one workspace and editable from another.
        groupId: input.groupId,
        createdById: actorId,
      },
    });

    const clientProfile = await tx.profile.findFirst({
      where: { email: inquiry.email, role: UserRole.CLIENT },
      select: { id: true, status: true },
    });

    if (clientProfile) {
      // If the client already signed in and is waiting on approval, this is that approval:
      // release them from PENDING so their next request reaches the client persona.
      if (clientProfile.status === ProfileStatus.PENDING) {
        await tx.profile.update({
          where: { id: clientProfile.id },
          data: { status: ProfileStatus.ACTIVE },
        });
      }

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
        title: 'Discovery opened from inquiry',
        body: inquiry.companyName,
        metadata: { inquiryId: inquiry.id, stackKey: inquiry.stackKey },
      },
    });

    const conversation = await tx.projectConversation.create({
      data: {
        projectId: project.id,
        title: 'Discovery',
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
        // Not APPROVED: that now means delivery has started. This lead is in conversation.
        status: InquiryStatus.IN_DISCOVERY,
        reviewNote,
        reviewedAt,
        reviewedById: actorId,
        approvedProjectId: project.id,
        clientId,
      },
      include: reviewerInclude,
    });

    // Record the signed-up client as a contact of the company, so the client page lists who it
    // is dealing with. This is directory data only — project access still comes from the
    // ProjectMember row created above.
    if (clientProfile) {
      await tx.clientContact.upsert({
        where: { clientId_profileId: { clientId, profileId: clientProfile.id } },
        update: {},
        create: { clientId, profileId: clientProfile.id, isPrimary: true },
      });
    }

    return {
      inquiry: approvedInquiry,
      projectId: project.id,
      clientProfileId: clientProfile?.id ?? null,
      clientId,
    };
  }

  /**
   * Picks the client a newly approved inquiry belongs to.
   *
   * An explicit id from the console always wins — that is the PM confirming a suggested match.
   * Otherwise a usable name is resolved case-insensitively, so "Acme" and "acme" converge on one
   * client instead of creating the duplicates this entity exists to prevent.
   *
   * Placeholder names are refused outright. The marketing call-to-action form collects only an
   * email and a brief, so it sends a stand-in company; accepting it would create a client
   * literally named "TBD" and then file every later placeholder lead under that same fake
   * company. Where the lead used a work email the name is derived from its domain instead, and
   * where even that is impossible the PM is asked to supply one.
   */
  private async resolveClientId(
    tx: Prisma.TransactionClient,
    input: {
      clientId: string | null;
      clientName: string | null;
      companyName: string;
      contactName: string;
      email: string;
      actorId: string;
      groupId: string;
    },
  ): Promise<{ id: string; name: string }> {
    if (input.clientId) {
      const chosen = await tx.client.findUnique({
        where: { id: input.clientId },
        select: { id: true, name: true },
      });
      if (!chosen) throw new NotFoundException(`Client ${input.clientId} not found`);
      return chosen;
    }

    const name = resolveClientNameForInquiry({
      explicitName: input.clientName,
      companyName: input.companyName,
      email: input.email,
    });

    if (!name) {
      throw new BadRequestException(
        `"${input.companyName}" is a placeholder, not a company name, and one cannot be derived ` +
          'from the contact email. Choose an existing client or supply clientName when approving ' +
          'this inquiry.',
      );
    }

    const existing = await tx.client.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (existing) return existing;

    return tx.client.create({
      data: {
        name,
        status: ClientStatus.ACTIVE,
        primaryContactName: input.contactName,
        primaryContactEmail: input.email.toLowerCase(),
        groupId: input.groupId,
        createdById: input.actorId,
      },
      select: { id: true, name: true },
    });
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
