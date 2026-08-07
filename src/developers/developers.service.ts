import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeveloperAvailabilityStatus, Prisma, ProjectStatus, ProjectTaskStatus, UserRole, WorkOrderStatus } from '@prisma/client';
import { isOpenProjectTask } from '../shared/domain/project-task-status';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  CursorPageInput,
  cursorQueryArgs,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';
import { UpdateDeveloperCapacityDto } from './dto/developer.dto';

type DeveloperRecord = {
  id: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  updatedAt: Date;
  developerProfile: {
    skills: Prisma.JsonValue;
    weeklyCapacityHours: number;
    availabilityStatus: DeveloperAvailabilityStatus;
    notes: string | null;
    updatedAt: Date;
  } | null;
  assignedTasks: { id: string; status: ProjectTaskStatus }[];
  memberships: {
    projectId: string;
    project: {
      id: string;
      companyName: string;
      status: ProjectStatus;
      updatedAt: Date;
      workOrders: { status: WorkOrderStatus }[];
    };
  }[];
};

@Injectable()
export class DevelopersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page?: CursorPageInput) {
    const paged = hasCursorPage(page);
    const developers = await this.prisma.profile.findMany({
      where: { role: UserRole.DEV },
      select: this.developerSelect(),
      orderBy: paged
        ? [{ fullName: 'asc' }, { email: 'asc' }, { id: 'asc' }]
        : [{ fullName: 'asc' }, { email: 'asc' }],
      ...(paged ? cursorQueryArgs(page) : { take: 200 }),
    });

    if (paged) {
      const result = toCursorPage(developers, page);
      return {
        items: result.items.map((developer) => this.toDeveloperView(developer)),
        nextCursor: result.nextCursor,
      };
    }

    return developers.map((developer) => this.toDeveloperView(developer));
  }

  async get(id: string, user: AuthUser) {
    if (user.role === UserRole.DEV && user.id !== id) {
      throw new NotFoundException(`Developer ${id} not found`);
    }

    const developer = await this.prisma.profile.findFirst({
      where: { id, role: UserRole.DEV },
      select: this.developerSelect(),
    });
    if (!developer) throw new NotFoundException(`Developer ${id} not found`);
    return this.toDeveloperView(developer);
  }

  async updateMe(user: AuthUser, dto: UpdateDeveloperCapacityDto) {
    if (user.role !== UserRole.DEV) {
      throw new BadRequestException('Only developer accounts can update developer capacity');
    }

    await this.prisma.developerProfile.upsert({
      where: { userId: user.id },
      update: {
        skills: dto.skills === undefined ? undefined : this.cleanSkills(dto.skills),
        weeklyCapacityHours: dto.weeklyCapacityHours,
        availabilityStatus: dto.availabilityStatus,
        notes: dto.notes === undefined ? undefined : dto.notes.trim() || null,
      },
      create: {
        userId: user.id,
        skills: this.cleanSkills(dto.skills ?? []),
        weeklyCapacityHours: dto.weeklyCapacityHours ?? 40,
        availabilityStatus: dto.availabilityStatus ?? DeveloperAvailabilityStatus.AVAILABLE,
        notes: dto.notes?.trim() || null,
      },
    });

    return this.get(user.id, user);
  }

  private toDeveloperView(developer: DeveloperRecord) {
    const profile = developer.developerProfile;
    const assignedProjects = new Set(developer.memberships.map((member) => member.projectId));
    const openTasks = developer.assignedTasks.filter((task) => isOpenProjectTask(task.status)).length;
    const activeStatuses: WorkOrderStatus[] = [
      WorkOrderStatus.READY,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.FAILED,
    ];
    const activeWorkOrders = developer.memberships.reduce((sum, member) => (
      sum + member.project.workOrders.filter((workOrder) => (
        activeStatuses.includes(workOrder.status)
      )).length
    ), 0);

    return {
      userId: developer.id,
      role: developer.role,
      displayName: developer.fullName || developer.email || developer.id,
      email: developer.email,
      skills: Array.isArray(profile?.skills) ? profile.skills.filter((skill): skill is string => typeof skill === 'string') : [],
      weeklyCapacityHours: profile?.weeklyCapacityHours ?? 40,
      availabilityStatus: profile?.availabilityStatus ?? DeveloperAvailabilityStatus.AVAILABLE,
      notes: profile?.notes ?? null,
      assignedProjectCount: assignedProjects.size,
      openTaskCount: openTasks,
      activeWorkOrderCount: activeWorkOrders,
      projects: developer.memberships.map((member) => ({
        id: member.project.id,
        companyName: member.project.companyName,
        status: member.project.status,
        updatedAt: member.project.updatedAt,
      })),
      updatedAt: profile?.updatedAt ?? developer.updatedAt,
    };
  }

  private cleanSkills(skills: string[]): Prisma.InputJsonValue {
    return skills.map((skill) => skill.trim()).filter(Boolean).slice(0, 20);
  }

  private developerSelect() {
    return {
      id: true,
      email: true,
      fullName: true,
      role: true,
      updatedAt: true,
      developerProfile: true,
      assignedTasks: {
        select: { id: true, status: true },
      },
      memberships: {
        where: { role: UserRole.DEV },
        select: {
          projectId: true,
          project: {
            select: {
              id: true,
              companyName: true,
              status: true,
              updatedAt: true,
              workOrders: { select: { status: true } },
            },
          },
        },
      },
    } satisfies Prisma.ProfileSelect;
  }
}
