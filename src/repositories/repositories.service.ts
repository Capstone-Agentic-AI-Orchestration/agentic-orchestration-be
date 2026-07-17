import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupMemberStatus,
  Prisma,
  RepositoryAssignmentDesiredState,
  RepositoryAssignmentEffectiveState,
  RepositoryKind,
  RepositoryStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { GithubService } from '../github/github.service';
import { GroupsService } from '../groups/groups.service';
import { PrismaService } from '../prisma/prisma.service';
import { scaffoldFilesFor } from './scaffold/repo-scaffold';
import { CreateRepositoryDto } from './dto/repositories.dto';

const repositoryInclude = {
  group: { select: { id: true, name: true, status: true } },
  project: { select: { id: true, companyName: true, stackKey: true, status: true, repoUrl: true } },
  createdBy: { select: { id: true, email: true, fullName: true } },
  assignments: {
    include: {
      user: {
        select: { id: true, email: true, fullName: true, role: true, githubLogin: true, avatarUrl: true },
      },
      assignedBy: { select: { id: true, email: true, fullName: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.RepositoryInclude;

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly groups: GroupsService,
  ) {}

  async create(dto: CreateRepositoryDto, user: AuthUser) {
    if (user.role !== UserRole.PM && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only project managers and admins can create repositories');
    }
    await this.groups.assertManager(dto.groupId, user);
    const kind = dto.kind ?? RepositoryKind.BACKEND;
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: {
        id: true,
        companyName: true,
        stackKey: true,
        groupId: true,
        repositories: { select: { id: true, status: true, kind: true } },
      },
    });
    if (!project) throw new NotFoundException(`Project ${dto.projectId} not found`);
    if (project.groupId && project.groupId !== dto.groupId) {
      throw new BadRequestException('Project belongs to a different group');
    }
    if (project.repositories.some((repo) => repo.kind === kind)) {
      throw new ConflictException(`This project already has a ${kind} repository`);
    }

    const name = this.normalizeRepositoryName(dto.name);
    const record = await this.prisma.repository.create({
      data: {
        groupId: dto.groupId,
        projectId: project.id,
        kind,
        name,
        createdById: user.id,
      },
    });

    await this.prisma.project.update({
      where: { id: project.id },
      data: { groupId: dto.groupId },
    });

    return this.provision(record.id, dto.description, user);
  }

  async list(user: AuthUser) {
    this.assertPersona(user);
    const where: Prisma.RepositoryWhereInput = user.role === UserRole.ADMIN
      ? {}
      : user.role === UserRole.DEV
        ? {
            assignments: {
              some: {
                userId: user.id,
                desiredState: RepositoryAssignmentDesiredState.ASSIGNED,
              },
            },
          }
        : {
            group: {
              members: { some: { userId: user.id, status: GroupMemberStatus.ACTIVE } },
            },
          };
    return this.prisma.repository.findMany({
      where,
      include: repositoryInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async get(repositoryId: string, user: AuthUser) {
    const repository = await this.findAccessible(repositoryId, user);
    return this.prisma.repository.findUniqueOrThrow({
      where: { id: repository.id },
      include: repositoryInclude,
    });
  }

  async retryProvisioning(repositoryId: string, user: AuthUser) {
    const repository = await this.findAccessible(repositoryId, user, true);
    if (repository.status === RepositoryStatus.ACTIVE) return this.get(repositoryId, user);
    return this.provision(repositoryId, undefined, user);
  }

  async archive(repositoryId: string, user: AuthUser) {
    const repository = await this.findAccessible(repositoryId, user, true);
    await this.prisma.repository.update({
      where: { id: repository.id },
      data: { status: RepositoryStatus.ARCHIVED },
    });
    await this.activity(repository.groupId, user, 'devflow.repository.archived', repository.id, `Archived repository ${repository.name}`);
    return this.get(repository.id, user);
  }

  async listAssignments(repositoryId: string, user: AuthUser) {
    await this.findAccessible(repositoryId, user);
    return this.prisma.repositoryAssignment.findMany({
      where: { repositoryId },
      include: {
        user: { select: { id: true, email: true, fullName: true, role: true, githubLogin: true, avatarUrl: true } },
        assignedBy: { select: { id: true, email: true, fullName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async assign(repositoryId: string, userId: string, user: AuthUser) {
    const repository = await this.findAccessible(repositoryId, user, true);
    if (repository.status !== RepositoryStatus.ACTIVE) {
      throw new BadRequestException('Repository must be active before developers can be assigned');
    }
    const member = await this.prisma.groupMember.findFirst({
      where: {
        groupId: repository.groupId,
        userId,
        status: GroupMemberStatus.ACTIVE,
        user: { role: UserRole.DEV },
      },
      include: { user: { select: { id: true, fullName: true, email: true, githubLogin: true } } },
    });
    if (!member) throw new BadRequestException('Repository assignments require an active developer group member');

    const assignment = await this.prisma.repositoryAssignment.upsert({
      where: { repositoryId_userId: { repositoryId, userId } },
      update: {
        assignedById: user.id,
        desiredState: RepositoryAssignmentDesiredState.ASSIGNED,
        effectiveState: RepositoryAssignmentEffectiveState.PENDING,
        lastError: null,
      },
      create: { repositoryId, userId, assignedById: user.id },
    });

    const synced = await this.syncAssignment(assignment.id);
    await this.activity(
      repository.groupId,
      user,
      'devflow.repository.assignment_requested',
      repository.id,
      `Assigned ${member.user.fullName ?? member.user.email ?? userId} to ${repository.name}`,
      { assignmentId: assignment.id, effectiveState: synced.effectiveState },
    );
    return synced;
  }

  async revoke(repositoryId: string, userId: string, user: AuthUser) {
    const repository = await this.findAccessible(repositoryId, user, true);
    const assignment = await this.prisma.repositoryAssignment.findUnique({
      where: { repositoryId_userId: { repositoryId, userId } },
    });
    if (!assignment) throw new NotFoundException('Repository assignment not found');
    await this.prisma.repositoryAssignment.update({
      where: { id: assignment.id },
      data: {
        assignedById: user.id,
        desiredState: RepositoryAssignmentDesiredState.UNASSIGNED,
        effectiveState: RepositoryAssignmentEffectiveState.REVOKING,
        lastError: null,
      },
    });
    const synced = await this.syncAssignment(assignment.id);
    await this.activity(
      repository.groupId,
      user,
      'devflow.repository.assignment_revoked',
      repository.id,
      `Removed developer access from ${repository.name}`,
      { assignmentId: assignment.id, effectiveState: synced.effectiveState },
    );
    return synced;
  }

  async reconcile(repositoryId: string, userId: string, user: AuthUser) {
    await this.findAccessible(repositoryId, user, true);
    const assignment = await this.prisma.repositoryAssignment.findUnique({
      where: { repositoryId_userId: { repositoryId, userId } },
    });
    if (!assignment) throw new NotFoundException('Repository assignment not found');
    return this.syncAssignment(assignment.id);
  }

  private async provision(repositoryId: string, description: string | undefined, user: AuthUser) {
    const record = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      include: { project: { select: { companyName: true, stackKey: true } } },
    });
    if (!record) throw new NotFoundException(`Repository ${repositoryId} not found`);

    await this.prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.PENDING, lastError: null },
    });

    try {
      const remote = record.fullName
        ? {
            name: record.name,
            fullName: record.fullName,
            htmlUrl: record.htmlUrl ?? record.cloneUrl ?? '',
            cloneUrl: record.cloneUrl ?? record.htmlUrl ?? '',
            defaultBranch: record.defaultBranch,
            visibility: record.visibility,
          }
        : await this.github.createPlainRepository(
            record.name,
            description?.trim() || `${record.project.companyName} workspace created by DevFlow`,
          );

      await this.prisma.repository.update({
        where: { id: repositoryId },
        data: {
          fullName: remote.fullName,
          htmlUrl: remote.htmlUrl,
          cloneUrl: remote.cloneUrl,
          defaultBranch: remote.defaultBranch,
          visibility: remote.visibility,
        },
      });

      const slug =
        record.project.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
        'app';
      await this.github.commitFiles(
        remote.name,
        scaffoldFilesFor(record.kind, { slug, companyName: record.project.companyName }),
        `chore: initialize ${record.kind.toLowerCase()} repository (DevFlow scaffold)`,
      );

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: record.projectId },
          data: { repoUrl: remote.htmlUrl, groupId: record.groupId },
        });
        return tx.repository.update({
          where: { id: repositoryId },
          data: {
            status: RepositoryStatus.ACTIVE,
            lastError: null,
            provisionedAt: new Date(),
          },
          include: repositoryInclude,
        });
      });
      await this.activity(record.groupId, user, 'devflow.repository.created', record.id, `Created plain repository ${remote.fullName}`, {
        projectId: record.projectId,
        repositoryUrl: remote.htmlUrl,
        ciCdConfigured: false,
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED, lastError: message },
      });
      throw new BadRequestException(`Plain repository provisioning failed: ${message}`);
    }
  }

  private async syncAssignment(assignmentId: string) {
    const assignment = await this.prisma.repositoryAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        repository: { select: { name: true } },
        user: { select: { githubLogin: true } },
      },
    });
    if (!assignment) throw new NotFoundException('Repository assignment not found');
    if (!assignment.user.githubLogin) {
      return this.prisma.repositoryAssignment.update({
        where: { id: assignment.id },
        data: {
          effectiveState: RepositoryAssignmentEffectiveState.FAILED,
          lastError: 'Developer profile has no GitHub login. Sign in with GitHub and try again.',
          lastSyncedAt: new Date(),
        },
      });
    }

    try {
      if (assignment.desiredState === RepositoryAssignmentDesiredState.ASSIGNED) {
        await this.github.addRepositoryCollaborator(assignment.repository.name, assignment.user.githubLogin);
      } else {
        await this.github.removeRepositoryCollaborator(assignment.repository.name, assignment.user.githubLogin);
      }
      return this.prisma.repositoryAssignment.update({
        where: { id: assignment.id },
        data: {
          effectiveState: assignment.desiredState === RepositoryAssignmentDesiredState.ASSIGNED
            ? RepositoryAssignmentEffectiveState.ACTIVE
            : RepositoryAssignmentEffectiveState.REVOKED,
          lastError: null,
          lastSyncedAt: new Date(),
        },
      });
    } catch (error) {
      return this.prisma.repositoryAssignment.update({
        where: { id: assignment.id },
        data: {
          effectiveState: RepositoryAssignmentEffectiveState.FAILED,
          lastError: error instanceof Error ? error.message : String(error),
          lastSyncedAt: new Date(),
        },
      });
    }
  }

  private async findAccessible(repositoryId: string, user: AuthUser, manager = false) {
    this.assertPersona(user);
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        groupId: true,
        name: true,
        status: true,
        assignments: { where: { userId: user.id, desiredState: RepositoryAssignmentDesiredState.ASSIGNED }, select: { id: true } },
      },
    });
    if (!repository) throw new NotFoundException(`Repository ${repositoryId} not found`);
    if (manager) {
      await this.groups.assertManager(repository.groupId, user);
      return repository;
    }
    if (user.role === UserRole.ADMIN) return repository;
    if (user.role === UserRole.DEV) {
      if (!repository.assignments.length) throw new NotFoundException(`Repository ${repositoryId} not found`);
      return repository;
    }
    await this.groups.assertMember(repository.groupId, user);
    return repository;
  }

  private plainStructure(companyName: string, stackKey: string) {
    const files = [
      {
        filePath: 'README.md',
        content: `# ${companyName}\n\nThis repository was initialized by DevFlow. It starts with project folders only; CI/CD is intentionally not configured.\n`,
      },
      {
        filePath: 'docs/README.md',
        content: '# Project documentation\n\nArchitecture, requirements, and delivery notes belong here.\n',
      },
    ];
    const normalized = stackKey.toLowerCase();
    if (normalized.includes('next') || normalized.includes('react') || normalized.includes('frontend')) {
      files.push({ filePath: 'frontend/README.md', content: '# Frontend\n\nFrontend source will be generated here.\n' });
    }
    if (normalized.includes('nest') || normalized.includes('node') || normalized.includes('backend')) {
      files.push({ filePath: 'backend/README.md', content: '# Backend\n\nBackend source will be generated here.\n' });
    }
    if (normalized.includes('supabase') || normalized.includes('postgres') || normalized.includes('database')) {
      files.push({ filePath: 'database/README.md', content: '# Database\n\nSchema and migration assets will be generated here.\n' });
    }
    return files;
  }

  private normalizeRepositoryName(name: string) {
    const normalized = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!normalized) throw new BadRequestException('Repository name is invalid');
    return normalized;
  }

  private assertPersona(user: AuthUser) {
    if (user.role !== UserRole.PM && user.role !== UserRole.DEV && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Repositories are only available to project managers and developers');
    }
  }

  private async activity(
    groupId: string,
    user: AuthUser,
    eventCode: string,
    targetId: string,
    message: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    await this.prisma.groupActivityEvent.create({
      data: { groupId, actorId: user.id, eventCode, targetType: 'repository', targetId, message, metadata },
    });
  }
}
