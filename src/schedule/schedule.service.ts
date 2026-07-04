import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ScheduleVisibility, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  CursorPageInput,
  cursorQueryArgs,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';
import { CreateScheduleEventDto, UpdateScheduleEventDto } from './dto/schedule.dto';

@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, page?: CursorPageInput) {
    const paged = hasCursorPage(page);
    const events = await this.prisma.scheduleEvent.findMany({
      where: this.accessWhere(user),
      include: {
        project: { select: { id: true, companyName: true, status: true } },
        owner: { select: { id: true, email: true, fullName: true, role: true } },
      },
      orderBy: paged
        ? [{ startsAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
        : [{ startsAt: 'asc' }, { createdAt: 'asc' }],
      ...(paged ? cursorQueryArgs(page) : { take: 250 }),
    });

    if (paged) {
      return toCursorPage(events, page);
    }

    return events;
  }

  async create(user: AuthUser, dto: CreateScheduleEventDto) {
    this.assertDateRange(dto.startsAt, dto.endsAt);
    if (dto.projectId) await this.assertProjectAccessible(dto.projectId, user);

    return this.prisma.scheduleEvent.create({
      data: {
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        startsAt: new Date(dto.startsAt),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        type: dto.type,
        visibility: dto.visibility,
        projectId: dto.projectId || null,
        ownerId: user.id,
      },
      include: {
        project: { select: { id: true, companyName: true, status: true } },
        owner: { select: { id: true, email: true, fullName: true, role: true } },
      },
    });
  }

  async update(id: string, user: AuthUser, dto: UpdateScheduleEventDto) {
    const event = await this.findEditable(id, user);
    const startsAt = dto.startsAt ?? event.startsAt.toISOString();
    const endsAt = dto.endsAt === undefined ? event.endsAt?.toISOString() : dto.endsAt;
    this.assertDateRange(startsAt, endsAt ?? undefined);

    if (dto.projectId) await this.assertProjectAccessible(dto.projectId, user);

    return this.prisma.scheduleEvent.update({
      where: { id },
      data: {
        title: dto.title?.trim(),
        description: dto.description === undefined ? undefined : dto.description.trim() || null,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt === undefined ? undefined : dto.endsAt ? new Date(dto.endsAt) : null,
        type: dto.type,
        visibility: dto.visibility,
        projectId: dto.projectId === undefined ? undefined : dto.projectId || null,
      },
      include: {
        project: { select: { id: true, companyName: true, status: true } },
        owner: { select: { id: true, email: true, fullName: true, role: true } },
      },
    });
  }

  async delete(id: string, user: AuthUser) {
    await this.findEditable(id, user);
    await this.prisma.scheduleEvent.delete({ where: { id } });
    return { deleted: true };
  }

  private async findEditable(id: string, user: AuthUser) {
    const event = await this.prisma.scheduleEvent.findFirst({
      where: { id, AND: [this.accessWhere(user)] },
      select: { id: true, ownerId: true, projectId: true, startsAt: true, endsAt: true },
    });

    if (!event) throw new NotFoundException(`Schedule event ${id} not found`);
    if (event.ownerId !== user.id && !this.canManage(user.role)) {
      throw new BadRequestException('Only the owner, PM, or ADMIN can edit this event');
    }
    return event;
  }

  private async assertProjectAccessible(projectId: string, user: AuthUser) {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, projectId),
      select: { id: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  private accessWhere(user: AuthUser): Prisma.ScheduleEventWhereInput {
    if (user.role === UserRole.ADMIN) return {};
    const projectWhere = this.projectAccessWhere(user);
    const visibleProjectEvents: Prisma.ScheduleEventWhereInput = {
      project: projectWhere,
      visibility: user.role === UserRole.CLIENT ? ScheduleVisibility.CLIENT : { in: [ScheduleVisibility.TEAM, ScheduleVisibility.CLIENT] },
    };

    if (this.canManage(user.role)) {
      return { OR: [{ ownerId: user.id }, { project: projectWhere }] };
    }

    return { OR: [{ ownerId: user.id }, visibleProjectEvents] };
  }

  private projectAccessWhere(user: AuthUser, projectId?: string): Prisma.ProjectWhereInput {
    const id = projectId ? { id: projectId } : {};
    if (user.role === UserRole.ADMIN) return id;
    if (this.canManage(user.role)) {
      return {
        ...id,
        OR: [{ createdById: user.id }, { members: { some: { userId: user.id } } }],
      };
    }
    return { ...id, members: { some: { userId: user.id } } };
  }

  private canManage(role: UserRole) {
    return role === UserRole.PM || role === UserRole.ADMIN;
  }

  private assertDateRange(startsAt: string, endsAt?: string) {
    if (!endsAt) return;
    if (new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
  }
}
