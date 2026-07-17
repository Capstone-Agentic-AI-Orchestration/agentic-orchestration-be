import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { GroupMemberStatus, Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

const DEV_SAFE_SOURCE_TYPES = ['project', 'work_order', 'artifact', 'project_task', 'project_task_activity', 'document'];

@Injectable()
export class RagAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertProjectAccess(projectId: string, user: AuthUser, requireAssignedDeveloper = false): Promise<string[] | undefined> {
    if (user.role === UserRole.CLIENT) throw new ForbiddenException('Client access to internal RAG context is disabled');
    const project = await this.prisma.project.findFirst({ where: this.projectAccessWhere(user, projectId), select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
    if (user.role === UserRole.DEV) {
      const assignment = await this.prisma.projectTask.findFirst({ where: { projectId, assignedToId: user.id }, select: { id: true } });
      if (!assignment && requireAssignedDeveloper) throw new ForbiddenException('Developer RAG access is limited to assigned projects');
      return DEV_SAFE_SOURCE_TYPES;
    }
    return undefined;
  }

  private projectAccessWhere(user: AuthUser, projectId: string): Prisma.ProjectWhereInput {
    if (user.role === UserRole.ADMIN) return { id: projectId };
    const groupAccess = user.role === UserRole.PM || user.role === UserRole.DEV
      ? [{ group: { members: { some: { userId: user.id, status: GroupMemberStatus.ACTIVE } } } }]
      : [];
    return { id: projectId, OR: [{ createdById: user.id }, { members: { some: { userId: user.id } } }, ...groupAccess] };
  }
}
