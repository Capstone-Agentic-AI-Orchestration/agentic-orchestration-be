import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CollaborationDocument,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  GroupMemberStatus,
  NotificationType,
  Prisma,
  ProjectConversation,
  ProjectMessage,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CursorPage,
  CursorPageInput,
  cursorQueryArgs,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';
import {
  CreateCollaborationDocumentDto,
  CreateConversationDto,
  CreateMessageDto,
  ReviewCollaborationDocumentDto,
  UpdateCollaborationDocumentDto,
} from './dto/collaboration.dto';

type ProfileView = { id: string; email: string | null; fullName: string | null; role: UserRole };

/**
 * Owner columns for a thread. Doubles as the `where` fragment and the `data` fragment, so a read
 * and a write cannot disagree about who owns a row.
 *
 * Always a client. Threads were briefly scoped to either a project or a client, because a project
 * carried two kinds at once: the company conversation, and a developer-to-project-manager channel.
 * The company conversation moved to the client that owns the relationship, and the developer
 * channel was removed rather than moved, so `projectId` is null on everything written here now. The
 * column and its CHECK constraint remain for the rows written before that.
 */
const clientOwnerColumns = (clientId: string) => ({ projectId: null, clientId });

type ConversationWithRelations = ProjectConversation & {
  createdBy: ProfileView | null;
  messages: (ProjectMessage & { author: ProfileView | null })[];
  reads: { lastReadAt: Date }[];
  _count: { messages: number };
  unreadCount?: number;
};

type MessageWithAuthor = ProjectMessage & { author: ProfileView | null };

type DocumentWithRelations = CollaborationDocument & {
  uploadedBy: ProfileView | null;
  reviewedBy: ProfileView | null;
};

const profileSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
} satisfies Prisma.ProfileSelect;

const conversationInclude = (userId: string) => ({
  createdBy: { select: profileSelect },
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: { author: { select: profileSelect } },
  },
  reads: {
    where: { userId },
    select: { lastReadAt: true },
  },
  _count: { select: { messages: true } },
}) satisfies Prisma.ProjectConversationInclude;

const messageInclude = {
  author: { select: profileSelect },
} satisfies Prisma.ProjectMessageInclude;

const documentInclude = {
  uploadedBy: { select: profileSelect },
  reviewedBy: { select: profileSelect },
  // Extraction state decides whether a document's text can reach the agents at all. Without it
  // every consumer has to guess, and the UI ends up presenting an unreadable file as usable
  // evidence. Exposed here (rather than only on the PM-and-client intake route) so developers,
  // who are deliberately excluded from intake, can still see what the agents will actually read.
  extraction: {
    select: { status: true, error: true, attempts: true, updatedAt: true },
  },
} satisfies Prisma.CollaborationDocumentInclude;

@Injectable()
export class CollaborationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async listConversations(
    clientId: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<ConversationWithRelations[] | CursorPage<ConversationWithRelations>> {
    await this.assertClientAccessible(clientId, user);
    const paged = hasCursorPage(page);

    const conversations = await this.prisma.projectConversation.findMany({
      where: {
        ...clientOwnerColumns(clientId),
        visibility: { in: this.conversationVisibilityFor(user.role) },
      },
      include: conversationInclude(user.id),
      orderBy: paged
        ? [{ updatedAt: 'desc' }, { id: 'desc' }]
        : [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      ...(paged ? cursorQueryArgs(page) : {}),
    });

    const visibleConversations = paged ? toCursorPage(conversations, page).items : conversations;
    const conversationIds = visibleConversations.map((c) => c.id);
    const unreadCounts = conversationIds.length
      ? await this.prisma.projectMessage.groupBy({
          by: ['conversationId'],
          where: {
            conversationId: { in: conversationIds },
            authorId: { not: user.id },
          },
          _count: { conversationId: true },
        })
      : [];

    const unreadMap = new Map(unreadCounts.map((u) => [u.conversationId, u._count.conversationId]));

    const items = visibleConversations.map((conversation) => {
      const lastReadAt = conversation.reads[0]?.lastReadAt;
      const totalUnread = unreadMap.get(conversation.id) ?? 0;
      return {
        ...conversation,
        unreadCount: lastReadAt ? Math.max(0, totalUnread) : totalUnread,
      };
    });

    return paged
      ? { items, nextCursor: toCursorPage(conversations, page).nextCursor }
      : items;
  }

  async createConversation(
    clientId: string,
    user: AuthUser,
    dto: CreateConversationDto,
  ): Promise<ConversationWithRelations> {
    await this.assertClientAccessible(clientId, user);
    const visibility = this.resolveRequestedVisibility(user.role, dto.visibility);

    const conversation = await this.prisma.projectConversation.create({
      data: {
        ...clientOwnerColumns(clientId),
        title: dto.title.trim(),
        category: dto.category ?? ConversationCategory.GENERAL,
        visibility,
        createdById: user.id,
      },
      include: conversationInclude(user.id),
    });

    // No timeline entry. The timeline records what happened to one build, and this thread belongs
    // to a company across all of them.
    if (dto.message?.trim()) {
      await this.addMessage(clientId, conversation.id, user, { body: dto.message });
      return this.findConversation(clientId, conversation.id, user);
    }

    return conversation;
  }

  async listMessages(
    clientId: string,
    conversationId: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<MessageWithAuthor[] | CursorPage<MessageWithAuthor>> {
    await this.assertConversationAccessible(clientId, conversationId, user);
    const paged = hasCursorPage(page);

    // Keyed on conversationId alone. The conversation owns the client and has already been checked
    // against this caller; adding the owner columns here would match nothing, because a message on
    // a client thread carries no projectId.
    const messages = await this.prisma.projectMessage.findMany({
      where: { conversationId },
      include: messageInclude,
      orderBy: paged ? [{ createdAt: 'asc' }, { id: 'asc' }] : { createdAt: 'asc' },
      ...(paged ? cursorQueryArgs(page) : { take: 200 }),
    });

    await this.markConversationRead(clientId, conversationId, user);
    return paged ? toCursorPage(messages, page) : messages;
  }

  async addMessage(
    clientId: string,
    conversationId: string,
    user: AuthUser,
    dto: CreateMessageDto,
  ): Promise<MessageWithAuthor> {
    const conversation = await this.assertConversationAccessible(clientId, conversationId, user);
    const body = dto.body.trim();

    const message = await this.prisma.projectMessage.create({
      data: {
        // Mirrors the conversation's owner, which is always a client now.
        projectId: null,
        conversationId,
        authorId: user.id,
        body,
      },
      include: messageInclude,
    });

    await this.prisma.projectConversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });

    await this.markConversationRead(clientId, conversationId, user);

    await this.notifications.notify({
      recipientIds: await this.clientRecipientIds(clientId, conversation.visibility),
      actorId: user.id,
      // No project, which is also what suppresses the project timeline entry inside notify().
      projectId: null,
      type: NotificationType.COLLAB_MESSAGE_SENT,
      title: `New message: ${conversation.title}`,
      body,
      metadata: { conversationId, visibility: conversation.visibility, clientId },
    });

    return message;
  }

  async markConversationRead(
    clientId: string,
    conversationId: string,
    user: AuthUser,
  ): Promise<{ read: true; lastReadAt: Date }> {
    await this.assertConversationAccessible(clientId, conversationId, user);
    const now = new Date();

    await this.prisma.conversationRead.upsert({
      where: {
        conversationId_userId: {
          conversationId,
          userId: user.id,
        },
      },
      update: { lastReadAt: now },
      create: {
        conversationId,
        userId: user.id,
        lastReadAt: now,
      },
    });

    return { read: true, lastReadAt: now };
  }

  async listDocuments(
    projectId: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<DocumentWithRelations[] | CursorPage<DocumentWithRelations>> {
    await this.assertProjectAccessible(projectId, user);
    const paged = hasCursorPage(page);

    const documents = await this.prisma.collaborationDocument.findMany({
      where: this.documentAccessWhere(projectId, user),
      include: documentInclude,
      orderBy: paged ? [{ updatedAt: 'desc' }, { id: 'desc' }] : { updatedAt: 'desc' },
      ...(paged ? cursorQueryArgs(page) : {}),
    });

    return paged ? toCursorPage(documents, page) : documents;
  }

  async createDocument(
    projectId: string,
    user: AuthUser,
    dto: CreateCollaborationDocumentDto,
  ): Promise<DocumentWithRelations> {
    await this.assertProjectAccessible(projectId, user);
    await this.assertArtifactBelongsToProject(projectId, dto.artifactId);

    const clientVisible = user.role === UserRole.CLIENT ? true : Boolean(dto.clientVisible);
    const status = clientVisible
      ? CollaborationDocumentStatus.APPROVAL_REQUESTED
      : dto.status ?? CollaborationDocumentStatus.UPLOADED;

    const document = await this.prisma.collaborationDocument.create({
      data: {
        projectId,
        artifactId: dto.artifactId || null,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        fileName: dto.fileName?.trim() || null,
        externalUrl: dto.externalUrl?.trim() || null,
        kind: dto.kind,
        status,
        clientVisible,
        uploadedById: user.id,
      },
      include: documentInclude,
    });

    await this.notifications.notify({
      recipientIds: clientVisible
        ? [...(await this.notifications.projectManagers(projectId)), ...(await this.notifications.projectClients(projectId))]
        : await this.teamRecipientIds(projectId),
      actorId: user.id,
      projectId,
      type: NotificationType.COLLAB_DOCUMENT_UPLOADED,
      title: 'Document uploaded',
      body: document.title,
      metadata: { documentId: document.id, status: document.status, clientVisible },
    });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.COLLAB_DOCUMENT_UPLOADED,
      visibility: clientVisible ? ProjectTimelineVisibility.CLIENT : ProjectTimelineVisibility.TEAM,
      title: 'Document uploaded',
      body: document.title,
      metadata: { documentId: document.id, status: document.status, kind: document.kind },
    });

    return document;
  }

  async updateDocument(
    projectId: string,
    documentId: string,
    user: AuthUser,
    dto: UpdateCollaborationDocumentDto,
  ): Promise<DocumentWithRelations> {
    await this.assertProjectManageable(projectId, user);
    const current = await this.assertDocumentExists(projectId, documentId);
    await this.assertArtifactBelongsToProject(projectId, dto.artifactId);

    const nextClientVisible = dto.clientVisible ?? current.clientVisible;
    const nextStatus = this.normalizeUpdatedDocumentStatus(nextClientVisible, dto.status);

    const documentUpdateData = {
      artifactId: dto.artifactId === undefined ? undefined : dto.artifactId || null,
      title: dto.title?.trim(),
      description: dto.description === undefined ? undefined : dto.description.trim() || null,
      fileName: dto.fileName === undefined ? undefined : dto.fileName.trim() || null,
      externalUrl: dto.externalUrl === undefined ? undefined : dto.externalUrl.trim() || null,
      kind: dto.kind,
      status: nextStatus,
      clientVisible: dto.clientVisible,
      reviewNote: nextStatus === CollaborationDocumentStatus.APPROVAL_REQUESTED ? null : undefined,
      reviewedAt: nextStatus === CollaborationDocumentStatus.APPROVAL_REQUESTED ? null : undefined,
      reviewedById: nextStatus === CollaborationDocumentStatus.APPROVAL_REQUESTED ? null : undefined,
      version: { increment: 1 },
    } satisfies Prisma.CollaborationDocumentUncheckedUpdateManyInput;

    return dto.version === undefined
      ? this.prisma.collaborationDocument.update({
          where: { id: documentId },
          data: documentUpdateData,
          include: documentInclude,
        })
      : this.updateDocumentWithVersion(projectId, documentId, dto.version, documentUpdateData);
  }

  async reviewDocument(
    projectId: string,
    documentId: string,
    user: AuthUser,
    dto: ReviewCollaborationDocumentDto,
  ): Promise<DocumentWithRelations> {
    const current = await this.assertDocumentReviewable(projectId, documentId, user);

    if (
      dto.status !== CollaborationDocumentStatus.APPROVED &&
      dto.status !== CollaborationDocumentStatus.REVISION_REQUESTED
    ) {
      throw new BadRequestException('status must be APPROVED or REVISION_REQUESTED');
    }

    if (current.status === CollaborationDocumentStatus.ARCHIVED) {
      throw new BadRequestException('Archived documents cannot be reviewed');
    }

    const documentReviewData = {
      status: dto.status,
      reviewNote: dto.reviewNote?.trim() || null,
      reviewedAt: new Date(),
      reviewedById: user.id,
      version: { increment: 1 },
    } satisfies Prisma.CollaborationDocumentUncheckedUpdateManyInput;

    const document =
      dto.version === undefined
        ? await this.prisma.collaborationDocument.update({
            where: { id: documentId },
            data: documentReviewData,
            include: documentInclude,
          })
        : await this.updateDocumentWithVersion(projectId, documentId, dto.version, documentReviewData);

    await this.notifications.notify({
      recipientIds: current.clientVisible
        ? [...(await this.notifications.projectManagers(projectId)), ...(await this.notifications.projectClients(projectId))]
        : await this.teamRecipientIds(projectId),
      actorId: user.id,
      projectId,
      type: NotificationType.COLLAB_DOCUMENT_REVIEWED,
      title: dto.status === CollaborationDocumentStatus.APPROVED
        ? 'Document approved'
        : 'Document needs revision',
      body: dto.reviewNote?.trim() || document.title,
      metadata: { documentId, status: dto.status },
    });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.COLLAB_DOCUMENT_REVIEWED,
      visibility: current.clientVisible ? ProjectTimelineVisibility.CLIENT : ProjectTimelineVisibility.TEAM,
      title: dto.status === CollaborationDocumentStatus.APPROVED
        ? 'Document approved'
        : 'Document revision requested',
      body: dto.reviewNote?.trim() || document.title,
      metadata: { documentId, status: dto.status },
    });

    return document;
  }

  private async updateDocumentWithVersion(
    projectId: string,
    documentId: string,
    version: number,
    data: Prisma.CollaborationDocumentUncheckedUpdateManyInput,
  ): Promise<DocumentWithRelations> {
    const result = await this.prisma.collaborationDocument.updateMany({
      where: { id: documentId, version },
      data,
    });

    if (result.count === 0) {
      throw new ConflictException(
        `Document ${documentId} was updated by another request; reload and retry`,
      );
    }

    const updated = await this.prisma.collaborationDocument.findFirst({
      where: { id: documentId, projectId },
      include: documentInclude,
    });

    if (!updated) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    return updated;
  }

  private async findConversation(
    clientId: string,
    conversationId: string,
    user: AuthUser,
  ): Promise<ConversationWithRelations> {
    const conversation = await this.prisma.projectConversation.findFirst({
      where: {
        id: conversationId,
        ...clientOwnerColumns(clientId),
        visibility: { in: this.conversationVisibilityFor(user.role) },
      },
      include: conversationInclude(user.id),
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    return {
      ...conversation,
      unreadCount: await this.unreadCount(conversation.id, user.id, conversation.reads[0]?.lastReadAt),
    };
  }

  /**
   * Can this caller reach the relationship threads of this company?
   *
   * The rule is not project membership. That is the whole point of moving these threads: a client
   * contact who has not been added to any project is still the person the project manager is
   * talking to, and under the project rule they could reach nothing. So for a CLIENT the test is
   * being a contact of this company — and only this company, which is what stops one client
   * reading another's thread by editing the id in the URL.
   *
   * PM and ADMIN pass on role alone, matching ClientsController, which is a staff surface where
   * the whole directory is readable. If workspace gating is ever added there, add it here too;
   * gating one and not the other would mean a PM could open a client but not its messages.
   */
  private async assertClientAccessible(clientId: string, user: AuthUser): Promise<void> {
    const exists = await this.prisma.client.findFirst({
      where: this.clientAccessWhere(clientId, user),
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }
  }

  private clientAccessWhere(clientId: string, user: AuthUser): Prisma.ClientWhereInput {
    if (user.role === UserRole.CLIENT) {
      return { id: clientId, contacts: { some: { profileId: user.id } } };
    }

    return { id: clientId };
  }

  private async assertProjectAccessible(projectId: string, user: AuthUser): Promise<void> {
    const exists = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, projectId),
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  private async assertProjectManageable(projectId: string, user: AuthUser): Promise<void> {
    if (!this.canManageProjects(user.role)) {
      throw new BadRequestException('Only PM or ADMIN users can manage this resource');
    }

    await this.assertProjectAccessible(projectId, user);
  }

  private async assertConversationAccessible(
    clientId: string,
    conversationId: string,
    user: AuthUser,
  ): Promise<ProjectConversation> {
    await this.assertClientAccessible(clientId, user);

    // The owner columns are matched as well as the id, so a conversation belonging to another
    // company is a 404 here rather than a thread served under the wrong owner.
    const conversation = await this.prisma.projectConversation.findFirst({
      where: {
        id: conversationId,
        ...clientOwnerColumns(clientId),
        visibility: { in: this.conversationVisibilityFor(user.role) },
      },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    return conversation;
  }

  private async assertDocumentExists(projectId: string, documentId: string): Promise<CollaborationDocument> {
    const document = await this.prisma.collaborationDocument.findFirst({
      where: { id: documentId, projectId },
    });

    if (!document) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    return document;
  }

  private async assertDocumentReviewable(
    projectId: string,
    documentId: string,
    user: AuthUser,
  ): Promise<CollaborationDocument> {
    await this.assertProjectAccessible(projectId, user);

    const document = await this.prisma.collaborationDocument.findFirst({
      where: this.documentAccessWhere(projectId, user, documentId),
    });

    if (!document) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    return document;
  }

  private async assertArtifactBelongsToProject(projectId: string, artifactId?: string): Promise<void> {
    if (!artifactId) return;

    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, projectId },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }
  }

  private projectAccessWhere(user: AuthUser, id?: string): Prisma.ProjectWhereInput {
    const where: Prisma.ProjectWhereInput = id ? { id } : {};

    if (user.role === UserRole.ADMIN) {
      return where;
    }

    return {
      ...where,
      OR: [
        { createdById: user.id },
        { members: { some: { userId: user.id } } },
      ],
    };
  }

  /**
   * Which threads a role may see. Staff see their own TEAM notes about a company as well as the
   * conversation itself; everyone else sees only the conversation.
   *
   * DEV had a branch here returning TEAM, for the developer-to-project-manager channel. That channel
   * is gone and developers are not on the client conversation routes at all, so the branch could
   * only ever have handed a developer the staff's private notes about a company.
   */
  private conversationVisibilityFor(role: UserRole): CollaborationVisibility[] {
    return this.canManageProjects(role)
      ? [CollaborationVisibility.TEAM, CollaborationVisibility.CLIENT]
      : [CollaborationVisibility.CLIENT];
  }

  private resolveRequestedVisibility(
    role: UserRole,
    requested?: CollaborationVisibility,
  ): CollaborationVisibility {
    // CLIENT by default whoever starts it: every thread belongs to a company now, and the reason it
    // lives there rather than on a project is that the company is in it. A staff-only TEAM thread
    // about a client is still possible, but it has to be asked for explicitly.
    const visibility = requested ?? CollaborationVisibility.CLIENT;

    if (!this.conversationVisibilityFor(role).includes(visibility)) {
      throw new BadRequestException(`${role} users cannot create ${visibility} conversations`);
    }

    return visibility;
  }

  private documentAccessWhere(
    projectId: string,
    user: AuthUser,
    id?: string,
  ): Prisma.CollaborationDocumentWhereInput {
    const where: Prisma.CollaborationDocumentWhereInput = { projectId };
    if (id) where.id = id;

    if (user.role === UserRole.CLIENT) {
      where.clientVisible = true;
    }

    return where;
  }

  private canManageProjects(role: UserRole): boolean {
    return role === UserRole.PM || role === UserRole.ADMIN;
  }

  private normalizeUpdatedDocumentStatus(
    clientVisible: boolean,
    status?: CollaborationDocumentStatus,
  ): CollaborationDocumentStatus | undefined {
    if (!clientVisible) return status;
    if (
      !status ||
      status === CollaborationDocumentStatus.DRAFT ||
      status === CollaborationDocumentStatus.UPLOADED
    ) {
      return CollaborationDocumentStatus.APPROVAL_REQUESTED;
    }

    return status;
  }

  /**
   * Who hears about a message on a company's relationship thread.
   *
   * Staff side is the PMs and admins in the workspace that owns the client, not every PM in the
   * system: a relationship thread is one team's to answer. Client side is the company's contacts —
   * the same list the console shows on the Contacts tab — because on a client thread they are the
   * counterparty, whether or not anyone remembered to add them to a project.
   */
  private async clientRecipientIds(
    clientId: string,
    visibility: CollaborationVisibility,
  ): Promise<string[]> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { groupId: true, contacts: { select: { profileId: true } } },
    });

    // Bail rather than fall through. A findMany filtered on an undefined groupId matches every
    // row, which would broadcast one company's message to every workspace member there is.
    if (!client) return [];

    const staff = await this.prisma.groupMember.findMany({
      where: {
        groupId: client.groupId,
        status: GroupMemberStatus.ACTIVE,
        user: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
      },
      select: { userId: true },
    });

    const staffIds = staff.map((member) => member.userId);

    // A TEAM thread on a client is the staff's own notes about the company. Contacts are not on it.
    return visibility === CollaborationVisibility.CLIENT
      ? [...staffIds, ...client.contacts.map((contact) => contact.profileId)]
      : staffIds;
  }

  private async teamRecipientIds(projectId: string): Promise<string[]> {
    const developers = await this.prisma.projectMember.findMany({
      where: { projectId, role: UserRole.DEV },
      select: { userId: true },
    });

    return [
      ...(await this.notifications.projectManagers(projectId)),
      ...developers.map((developer) => developer.userId),
    ];
  }

  private async unreadCount(
    conversationId: string,
    userId: string,
    lastReadAt?: Date,
  ): Promise<number> {
    return this.prisma.projectMessage.count({
      where: {
        conversationId,
        authorId: { not: userId },
        ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
      },
    });
  }

  private async recordTimelineEvent(
    projectId: string,
    user: AuthUser,
    input: {
      type: ProjectTimelineEventType;
      visibility: ProjectTimelineVisibility;
      title: string;
      body?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await this.prisma.projectTimelineEvent.create({
      data: {
        projectId,
        actorId: user.id,
        type: input.type,
        visibility: input.visibility,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }
}
