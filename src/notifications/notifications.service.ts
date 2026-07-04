import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { IntegrationEvents } from '../shared/events/integration-event';
import { OutboxService } from '../shared/events/outbox.service';
import {
  CursorPage,
  CursorPageInput,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';
import {
  NotificationsRepository,
  type NotificationWithActor,
} from './notifications.repository';

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const CACHE_TTL_MS = 10_000;

@Injectable()
export class NotificationsService {
  private readonly projectManagersCache = new Map<string, CacheEntry<string[]>>();
  private readonly projectClientsCache = new Map<string, CacheEntry<string[]>>();

  constructor(
    private readonly notificationsRepository: NotificationsRepository,
    private readonly outbox: OutboxService,
  ) {}

  private cached<T>(cache: Map<string, CacheEntry<T>>, key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expiry) {
      return Promise.resolve(entry.data);
    }
    return fetcher().then((data) => {
      cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
      return data;
    });
  }

  invalidateProjectCache(projectId?: string) {
    if (projectId) {
      this.projectManagersCache.delete(projectId);
      this.projectClientsCache.delete(projectId);
    } else {
      this.projectManagersCache.clear();
      this.projectClientsCache.clear();
    }
  }

  async list(
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<NotificationWithActor[] | CursorPage<NotificationWithActor>> {
    const notifications = await this.notificationsRepository.listForRecipient(user.id, page);

    return hasCursorPage(page) ? toCursorPage(notifications, page) : notifications;
  }

  async markRead(id: string, user: AuthUser): Promise<NotificationWithActor> {
    const result = await this.notificationsRepository.markReadForRecipient(id, user.id);

    if (result.count === 0) {
      throw new NotFoundException(`Notification ${id} not found`);
    }

    return this.notificationsRepository.findById(id);
  }

  async markAllRead(user: AuthUser): Promise<{ updated: number }> {
    const result = await this.notificationsRepository.markAllReadForRecipient(user.id);

    return { updated: result.count };
  }

  async notify(input: {
    recipientIds: string[];
    actorId?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    artifactId?: string | null;
    type: NotificationType;
    title: string;
    body?: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    const recipientIds = [...new Set(input.recipientIds)].filter(
      (id) => id && id !== input.actorId,
    );

    if (recipientIds.length === 0) return;

    await this.notificationsRepository.createMany({
      ...input,
      recipientIds,
    });

    if (input.projectId) {
      await this.notificationsRepository.createTimelineNotificationEvent({
        projectId: input.projectId,
        actorId: input.actorId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        title: input.title,
        recipientCount: recipientIds.length,
      });
    }

    await this.outbox.append({
      eventType: IntegrationEvents.notificationRequested,
      aggregateType: 'notification',
      aggregateId: input.projectId ?? input.taskId ?? input.artifactId ?? input.type,
      producer: 'notifications',
      payload: {
        type: input.type,
        recipientIds,
        actorId: input.actorId ?? null,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        title: input.title,
      },
    });
  }

  async projectManagers(projectId?: string): Promise<string[]> {
    const cacheKey = projectId ?? '__global';

    return this.cached(this.projectManagersCache, cacheKey, async () => {
      if (projectId) {
        return this.notificationsRepository.projectManagersForProject(projectId);
      }

      return this.notificationsRepository.globalProjectManagers();
    });
  }

  async projectClients(projectId: string): Promise<string[]> {
    return this.cached(this.projectClientsCache, projectId, async () => {
      return this.notificationsRepository.projectClients(projectId);
    });
  }
}
