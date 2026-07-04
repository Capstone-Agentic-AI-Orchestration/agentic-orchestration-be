import { Injectable } from '@nestjs/common';
import { ProjectTaskStatus, UserRole, WorkOrderStatus } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async pmSummary(user: AuthUser) {
    const projectWhere = user.role === UserRole.ADMIN
      ? {}
      : { OR: [{ createdById: user.id }, { members: { some: { userId: user.id } } }] };

    const [projects, pendingInvites, openTasks, activeWorkOrders, recentInquiries] = await Promise.all([
      this.prisma.project.findMany({
        where: projectWhere,
        select: {
          id: true,
          companyName: true,
          status: true,
          updatedAt: true,
          _count: { select: { tasks: true, workOrders: true, artifacts: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.clientInvite.count({ where: { project: projectWhere, status: 'PENDING' } }),
      this.prisma.projectTask.count({
        where: { project: projectWhere, status: { not: ProjectTaskStatus.DONE } },
      }),
      this.prisma.workOrder.count({
        where: {
          project: projectWhere,
          status: { in: [WorkOrderStatus.READY, WorkOrderStatus.DISPATCHED, WorkOrderStatus.FAILED] },
        },
      }),
      this.prisma.clientInquiry.findMany({
        select: {
          id: true,
          companyName: true,
          contactName: true,
          email: true,
          status: true,
          createdAt: true,
          approvedProjectId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);

    const projectStatusCounts = projects.reduce<Record<string, number>>((acc, project) => {
      acc[project.status] = (acc[project.status] ?? 0) + 1;
      return acc;
    }, {});

    return {
      totals: {
        projects: projects.length,
        pendingInvites,
        openTasks,
        activeWorkOrders,
      },
      projectStatusCounts,
      projects,
      recentInquiries,
    };
  }
}
