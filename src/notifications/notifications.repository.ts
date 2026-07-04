import { Injectable } from '@nestjs/common';
import {
  Notification,
  NotificationType,
  Prisma,
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

export type NotificationWithActor = Notification & {
  actor: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

const notificationInclude = {
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.NotificationInclude;

@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForRecipient(userId: string, page?: CursorPageInput): Promise<NotificationWithActor[]> {
    return this.prisma.notification.findMany({
      where: { recipientId: userId },
      include: notificationInclude,
      orderBy: hasCursorPage(page)
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : { createdAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : { take: 50 }),
    });
  }

  markReadForRecipient(id: string, userId: string): Promise<{ count: number }> {
    return this.prisma.notification.updateMany({
      where: { id, recipientId: userId },
      data: { readAt: new Date() },
    });
  }

  findById(id: string): Promise<NotificationWithActor> {
    return this.prisma.notification.findUniqueOrThrow({
      where: { id },
      include: notificationInclude,
    });
  }

  markAllReadForRecipient(userId: string): Promise<{ count: number }> {
    return this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  createMany(input: {
    recipientIds: string[];
    actorId?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    artifactId?: string | null;
    type: NotificationType;
    title: string;
    body?: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<Prisma.BatchPayload> {
    return this.prisma.notification.createMany({
      data: input.recipientIds.map((recipientId) => ({
        recipientId,
        actorId: input.actorId ?? null,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      })),
      skipDuplicates: false,
    });
  }

  createTimelineNotificationEvent(input: {
    projectId: string;
    actorId?: string | null;
    taskId?: string | null;
    artifactId?: string | null;
    type: NotificationType;
    title: string;
    recipientCount: number;
  }) {
    return this.prisma.projectTimelineEvent.create({
      data: {
        projectId: input.projectId,
        actorId: input.actorId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: ProjectTimelineEventType.NOTIFICATION_SENT,
        visibility: ProjectTimelineVisibility.INTERNAL,
        title: 'Notification sent',
        body: input.title,
        metadata: {
          notificationType: input.type,
          recipientCount: input.recipientCount,
        },
      },
    });
  }

  async projectManagersForProject(projectId: string): Promise<string[]> {
    const [project, adminProfiles] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: {
          createdById: true,
          members: {
            where: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
            select: { userId: true },
          },
        },
      }),
      this.prisma.profile.findMany({
        where: { role: UserRole.ADMIN },
        select: { id: true },
      }),
    ]);

    return [
      ...new Set([
        project?.createdById,
        ...(project?.members.map((member) => member.userId) ?? []),
        ...adminProfiles.map((profile) => profile.id),
      ].filter(Boolean) as string[]),
    ];
  }

  async globalProjectManagers(): Promise<string[]> {
    const profiles = await this.prisma.profile.findMany({
      where: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
      select: { id: true },
    });

    return profiles.map((profile) => profile.id);
  }

  async projectClients(projectId: string): Promise<string[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId, role: UserRole.CLIENT },
      select: { userId: true },
    });

    return members.map((member) => member.userId);
  }
}
