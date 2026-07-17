import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  OrchestrationControlResult,
  OrchestrationService,
  OrchestrationStatus,
} from '../orchestration/orchestration.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ArtifactOutputReviewStatus, ArtifactReviewStatus, ArtifactValidationStatus, ClientInviteStatus, CollaborationDocumentStatus, NotificationType, OrchestrationRunTrigger, ProjectDeliveryReview, ProjectDeliveryReviewStatus, ProjectStatus, ProjectTimelineEvent, ProjectTimelineEventType, ProjectTimelineVisibility, ProjectTaskActivity, ProjectTaskActivityType, ProjectTaskStatus, Project, GateEvent, Artifact, EventLog, Prisma, ProjectKickoff, ProjectKickoffStatus, ProjectTask, RepositoryStatus, UserRole, WorkOrder, WorkOrderAgentType, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AddProjectMemberDto } from './dto/project-member.dto';
import { ShareArtifactDto } from './dto/share-artifact.dto';
import { ReviewArtifactDto } from './dto/review-artifact.dto';
import { HandleRevisionDto } from './dto/handle-revision.dto';
import { ProjectDeliveryReviewNoteDto } from './dto/project-delivery-review.dto';
import { PublishArtifactOutputDto, ReviewArtifactOutputDto } from './dto/output-review.dto';
import { CreateProjectTaskDto, UpdateProjectTaskDto } from './dto/project-task.dto';
import { AddTaskCommentDto } from './dto/task-comment.dto';
import { CreateWorkOrderDto, UpdateWorkOrderDto } from './dto/work-order.dto';
import { UpdateProjectKickoffDto } from './dto/project-kickoff.dto';
import { ControlOrchestrationDto } from './dto/control-orchestration.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { IntakeService } from '../intake/intake.service';
import { GroupsService } from '../groups/groups.service';
import { RepositoriesService } from '../repositories/repositories.service';
import {
  CursorPage,
  CursorPageInput,
  cursorQueryArgs,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';

type ProjectWithRelations = Project & {
  gates: GateEvent[];
  createdBy: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
  members: {
    id: string;
    projectId: string;
    userId: string;
    role: UserRole;
    createdAt: Date;
    user: { id: string; email: string | null; fullName: string | null; role: UserRole };
  }[];
  runBudget: {
    id: string;
    tokenBudget: number;
    tokensConsumed: number;
    retryCount: number;
    maxRetries: number;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  kickoff: ProjectKickoff | null;
  deliveryReview: ProjectDeliveryReview | null;
  clientInvites: {
    id: string;
    email: string;
    contactName: string;
    companyName: string;
    status: ClientInviteStatus;
    acceptedById: string | null;
    acceptedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
  lifecycle: ProjectLifecycleSummary;
  _count: { artifacts: number; eventLogs: number };
};

type ProjectLifecycleStage =
  | 'APPROVED'
  | 'CLIENT_ONBOARDING'
  | 'KICKOFF'
  | 'READY_FOR_ORCHESTRATION'
  | 'IN_ORCHESTRATION'
  | 'CLIENT_REVIEW'
  | 'REVISION'
  | 'DELIVERED'
  | 'FAILED';

type ProjectLifecycleSummary = {
  stage: ProjectLifecycleStage;
  label: string;
  nextAction: string;
  tone: 'gray' | 'blue' | 'purple' | 'yellow' | 'green' | 'red';
  progress: number;
  signals: {
    clientAccepted: boolean;
    kickoffReady: boolean;
    orchestrationStarted: boolean;
    clientReviewOpen: boolean;
    revisionOpen: boolean;
    deliveryAccepted: boolean;
    deliveryRevisionOpen: boolean;
    totalTasks: number;
    openTasks: number;
    totalWorkOrders: number;
    activeWorkOrders: number;
    clientVisibleArtifacts: number;
  };
};

type DeliveryReadinessBlocker = {
  code: string;
  message: string;
  severity: 'BLOCKER' | 'WARNING';
  count?: number;
};

type DeliveryReadinessSummary = {
  ready: boolean;
  projectId: string;
  blockers: DeliveryReadinessBlocker[];
  checks: {
    acceptedInvite: boolean;
    hasPublishedArtifacts: boolean;
    publishedArtifactsValidated: boolean;
    publishedArtifactsApproved: boolean;
    requiredAgentCoverage: boolean;
    documentsCleared: boolean;
    workOrdersCleared: boolean;
    revisionsCleared: boolean;
    deliveryRevisionCleared: boolean;
  };
  counts: {
    publishedArtifacts: number;
    invalidPublishedArtifacts: number;
    unapprovedPublishedArtifacts: number;
    activeWorkOrders: number;
    openDocuments: number;
    openArtifactRevisions: number;
    missingAgentTypes: number;
  };
};

type ProjectListItem = Pick<Project, 'id' | 'companyName' | 'status' | 'createdAt' | 'updatedAt' | 'groupId'> & {
  lifecycle: ProjectLifecycleSummary;
};

type ProjectLifecycleSource = Pick<Project, 'status' | 'runId'> & {
  kickoff?: Pick<ProjectKickoff, 'status'> | null;
  clientInvites?: { status: ClientInviteStatus }[];
  artifacts?: {
    clientVisible: boolean;
    reviewStatus: ArtifactReviewStatus;
    revisionHandledAt: Date | null;
  }[];
  tasks?: { status: ProjectTaskStatus }[];
  workOrders?: { status: WorkOrderStatus }[];
  deliveryReview?: Pick<ProjectDeliveryReview, 'status'> | null;
};

type ArtifactListItem =
  | Artifact
  | Pick<
      Artifact,
      | 'id'
      | 'projectId'
      | 'agentType'
      | 'filePath'
      | 'clientVisible'
      | 'displayName'
      | 'sharedAt'
      | 'reviewStatus'
      | 'reviewNote'
      | 'reviewedAt'
      | 'reviewedById'
      | 'outputReviewStatus'
      | 'outputReviewNote'
      | 'outputReviewedAt'
      | 'outputReviewedById'
      | 'validationStatus'
      | 'validationSummary'
      | 'validationErrors'
      | 'publishedAt'
      | 'publishedById'
      | 'revisionHandledAt'
      | 'revisionHandledById'
      | 'revisionResolutionNote'
      | 'createdAt'
    >;

type ProjectTaskWithRelations = ProjectTask & {
  assignedTo: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
  createdBy: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
  artifact: {
    id: string;
    filePath: string;
    displayName: string | null;
    reviewStatus: ArtifactReviewStatus;
    reviewNote: string | null;
    reviewedAt: Date | null;
    revisionHandledAt: Date | null;
  } | null;
};

type ProjectTaskActivityWithActor = ProjectTaskActivity & {
  actor: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

type ProjectTimelineEventWithActor = ProjectTimelineEvent & {
  actor: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

type WorkOrderWithRelations = WorkOrder & {
  task: { id: string; title: string; assignedToId: string | null; status: ProjectTaskStatus } | null;
  artifact: { id: string; filePath: string; displayName: string | null; reviewStatus: ArtifactReviewStatus; outputReviewStatus: ArtifactOutputReviewStatus; validationStatus: ArtifactValidationStatus } | null;
  createdBy: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

const taskInclude = {
  assignedTo: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
  createdBy: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
  artifact: {
    select: {
      id: true,
      filePath: true,
      displayName: true,
      reviewStatus: true,
      reviewNote: true,
      reviewedAt: true,
      revisionHandledAt: true,
    },
  },
} satisfies Prisma.ProjectTaskInclude;

const taskActivityInclude = {
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.ProjectTaskActivityInclude;

const timelineInclude = {
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.ProjectTimelineEventInclude;

const workOrderInclude = {
  task: {
    select: {
      id: true,
      title: true,
      assignedToId: true,
      status: true,
    },
  },
  artifact: {
    select: {
      id: true,
      filePath: true,
      displayName: true,
      reviewStatus: true,
      outputReviewStatus: true,
      validationStatus: true,
    },
  },
  createdBy: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.WorkOrderInclude;

const kickoffChecklistFields = [
  'scopeConfirmed',
  'milestonesConfirmed',
  'documentsConfirmed',
  'techStackConfirmed',
  'rolesConfirmed',
  'clientAccessConfirmed',
  'initialTasksCreated',
  'initialWorkOrdersCreated',
] as const;

type KickoffChecklistField = (typeof kickoffChecklistFields)[number];

const kickoffTextFields = [
  'scopeSummary',
  'milestones',
  'requiredDocuments',
  'techStackNotes',
  'deliveryRoles',
  'readinessNotes',
] as const;

type KickoffTextField = (typeof kickoffTextFields)[number];

type ProjectKickoffInput = Partial<
  Pick<
    ProjectKickoff,
    KickoffTextField | KickoffChecklistField
  >
>;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestration: OrchestrationService,
    private readonly notifications: NotificationsService,
    private readonly intake?: IntakeService,
    private readonly groups?: GroupsService,
    private readonly repositories?: RepositoriesService,
  ) {}

  async create(dto: CreateProjectDto, user: AuthUser): Promise<Project> {
    if (dto.groupId) {
      if (!this.groups) throw new BadRequestException('Group management is unavailable');
      await this.groups.assertManager(dto.groupId, user);
    }
    if (dto.repositoryName && !dto.groupId) {
      throw new BadRequestException('groupId is required when creating a repository');
    }
    const project = await this.prisma.project.create({
      data: {
        companyName: dto.companyName,
        brief: dto.brief,
        stackKey: dto.stackKey,
        createdById: user.id,
        groupId: dto.groupId,
      },
    });

    this.logger.log(`Created project ${project.id} for ${project.companyName}`);
    await this.recordTimelineEvent(project.id, user, {
      type: ProjectTimelineEventType.PROJECT_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project created',
      body: project.companyName,
      metadata: { status: project.status, stackKey: project.stackKey },
    });
    if (dto.groupId && dto.repositoryName) {
      if (!this.repositories) throw new BadRequestException('Repository provisioning is unavailable');
      await this.repositories.create({
        groupId: dto.groupId,
        projectId: project.id,
        name: dto.repositoryName,
        description: dto.repositoryDescription,
      }, user);
      return this.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    }
    return project;
  }

  async startOrchestration(
    id: string,
    user: AuthUser,
  ): Promise<{ accepted: boolean; runId: string }> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: {
        id: true,
        companyName: true,
        brief: true,
        stackKey: true,
        createdById: true,
        runId: true,
        kickoff: {
          select: {
            status: true,
          },
        },
        workOrders: {
          where: {
            status: WorkOrderStatus.READY,
          },
          select: {
            instructions: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    if (project.runId) {
      return { accepted: true, runId: project.runId };
    }

    if (project.kickoff?.status !== ProjectKickoffStatus.READY && project.kickoff?.status !== ProjectKickoffStatus.LOCKED) {
      throw new BadRequestException('Project kickoff must be complete before orchestration can start');
    }

    if (!project.workOrders.some((workOrder) => workOrder.instructions?.trim())) {
      throw new BadRequestException('At least one READY work order with instructions is required before orchestration can start');
    }

    const intakeContext = this.intake ? await this.intake.contextForStart(project, user.id) : undefined;
    const runId = intakeContext
      ? await this.orchestration.startRun(
        project.id,
        project.brief,
        project.stackKey,
        project.companyName,
        user.id,
        OrchestrationRunTrigger.START,
        intakeContext,
      )
      : await this.orchestration.startRun(project.id, project.brief, project.stackKey, project.companyName, user.id);

    return { accepted: true, runId };
  }

  /**
   * Developer-initiated orchestration start. Unlike {@link startOrchestration}
   * (which requires a completed PM kickoff + READY work orders), this only needs
   * the project's GitHub repository to be provisioned. The developer's prompt
   * becomes the run brief, so the AI agents build against that repo from it.
   */
  async startOrchestrationFromPrompt(
    id: string,
    prompt: string,
    user: AuthUser,
  ): Promise<{ accepted: boolean; runId: string }> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: {
        id: true,
        companyName: true,
        stackKey: true,
        runId: true,
        repository: { select: { status: true } },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    if (project.runId) {
      return { accepted: true, runId: project.runId };
    }
    if (!project.repository || project.repository.status !== RepositoryStatus.ACTIVE) {
      throw new BadRequestException(
        'The project repository must be fully provisioned before orchestration can start',
      );
    }

    const brief = (prompt ?? '').trim();
    if (brief.length < 10) {
      throw new BadRequestException('Describe what to build in at least 10 characters');
    }

    // Persist the prompt as the project brief so the run and its agents build from it.
    await this.prisma.project.update({ where: { id: project.id }, data: { brief } });

    const runId = await this.orchestration.startRun(
      project.id,
      brief,
      project.stackKey,
      project.companyName,
      user.id,
      OrchestrationRunTrigger.START,
    );

    return { accepted: true, runId };
  }

  async rerunReadyWorkOrders(
    id: string,
    user: AuthUser,
  ): Promise<{ accepted: boolean; runId: string }> {
    const project = await this.findRunnableProject(id, user);
    const intakeContext = this.intake ? await this.intake.contextForStart(project, user.id) : undefined;
    const runId = await this.orchestration.startRun(
      project.id,
      project.brief,
      project.stackKey,
      project.companyName,
      user.id,
      OrchestrationRunTrigger.RERUN_READY_WORK_ORDERS,
      intakeContext,
    );

    return { accepted: true, runId };
  }

  async controlOrchestration(
    id: string,
    user: AuthUser,
    dto: ControlOrchestrationDto,
  ): Promise<OrchestrationControlResult> {
    await this.assertAccessible(id, user);
    return this.orchestration.control(id, dto.action, {
      nodeId: dto.nodeId,
      params: dto.params,
      actorId: user.id,
    });
  }

  async findOrchestrationRuns(id: string, user: AuthUser) {
    await this.assertAccessible(id, user);

    return this.prisma.orchestrationRun.findMany({
      where: { projectId: id },
      include: {
        executions: {
          include: {
            workOrder: {
              select: {
                id: true,
                title: true,
                status: true,
                agentType: true,
              },
            },
            artifact: {
              select: {
                id: true,
                filePath: true,
                displayName: true,
                outputReviewStatus: true,
                reviewStatus: true,
                validationStatus: true,
              },
            },
          },
          orderBy: { startedAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async findOrchestrationRun(id: string, runId: string, user: AuthUser) {
    await this.assertAccessible(id, user);

    const run = await this.prisma.orchestrationRun.findFirst({
      where: { projectId: id, runId },
      include: {
        executions: {
          include: {
            workOrder: {
              select: {
                id: true,
                title: true,
                status: true,
                agentType: true,
                priority: true,
              },
            },
            artifact: {
              select: {
                id: true,
                filePath: true,
                displayName: true,
                outputReviewStatus: true,
                reviewStatus: true,
                validationStatus: true,
                createdAt: true,
              },
            },
          },
          orderBy: { startedAt: 'asc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(`Orchestration run ${runId} not found`);
    }

    const executionRunIds = run.executions.map((execution) => execution.executionRunId);
    const events = await this.prisma.eventLog.findMany({
      where: {
        projectId: id,
        OR: [
          { costMeta: { path: ['runId'], equals: run.runId } },
          ...(executionRunIds.length
            ? executionRunIds.map((executionRunId) => ({
                costMeta: { path: ['executionRunId'], equals: executionRunId },
              }))
            : []),
        ],
      },
      orderBy: { occurredAt: 'asc' },
    });

    return { ...run, events };
  }

  async findOrchestrationProviderStatus(id: string, user: AuthUser) {
    await this.assertAccessible(id, user);
    return this.orchestration.getProviderStatus();
  }

  async verifyOrchestrationGithubDelivery(id: string, user: AuthUser) {
    await this.assertAccessible(id, user);
    return this.orchestration.verifyGithubDeliveryAccess();
  }

  async verifyOrchestrationLlmProvider(id: string, user: AuthUser) {
    await this.assertAccessible(id, user);
    return this.orchestration.verifyLlmProviderAccess();
  }

  async autoAnalyzeBrief(
    user: AuthUser,
    input: { companyName: string; brief: string; stackKey: string },
  ) {
    if (user.role !== UserRole.PM && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only PMs and admins can use auto-analyze.');
    }
    if (!input.brief || input.brief.trim().length < 3) {
      throw new BadRequestException('Brief must be at least 3 characters to analyze.');
    }
    return this.orchestration.autoAnalyzeBrief({
      companyName: input.companyName || 'Unknown company',
      brief: input.brief.trim(),
      stackKey: input.stackKey || 'nextjs-nestjs-supabase',
    });
  }

  async findAll(
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<ProjectListItem[] | CursorPage<ProjectListItem>> {
    const paged = hasCursorPage(page);
    const projects = await this.prisma.project.findMany({
      where: this.projectAccessWhere(user),
      select: {
        id: true,
        companyName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        groupId: true,
        runId: true,
        kickoff: {
          select: {
            status: true,
          },
        },
        deliveryReview: {
          select: {
            status: true,
          },
        },
        clientInvites: {
          select: {
            status: true,
          },
        },
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: {
            status: true,
          },
        },
        workOrders: {
          select: {
            status: true,
          },
        },
      },
      orderBy: paged
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : { createdAt: 'desc' },
      ...(paged ? cursorQueryArgs(page) : {}),
    });

    const toProjectListItem = (project: (typeof projects)[number]) => ({
      id: project.id,
      companyName: project.companyName,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      groupId: project.groupId,
      lifecycle: this.deriveProjectLifecycle(project),
    });

    if (paged) {
      const result = toCursorPage(projects, page);
      return {
        items: result.items.map(toProjectListItem),
        nextCursor: result.nextCursor,
      };
    }

    return projects.map(toProjectListItem);
  }

  async findAllDetails(user: AuthUser): Promise<ProjectWithRelations[]> {
    const projects = await this.prisma.project.findMany({
      where: this.projectAccessWhere(user),
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
          },
        },
        members: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                fullName: true,
                role: true,
              },
            },
          },
        },
        gates: {
          orderBy: { decidedAt: 'desc' },
        },
        runBudget: {
          select: {
            id: true,
            tokenBudget: true,
            tokensConsumed: true,
            retryCount: true,
            maxRetries: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        kickoff: true,
        deliveryReview: true,
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: { status: true },
        },
        workOrders: {
          select: { status: true },
        },
        clientInvites: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            email: true,
            contactName: true,
            companyName: true,
            status: true,
            acceptedById: true,
            acceptedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        _count: {
          select: { artifacts: true, eventLogs: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((project) => {
      const {
        artifacts: _lifecycleArtifacts,
        tasks: _lifecycleTasks,
        workOrders: _lifecycleWorkOrders,
        ...projectDetail
      } = project;

      return {
        ...projectDetail,
        lifecycle: this.deriveProjectLifecycle(project),
      };
    });
  }

  async findOne(id: string, user: AuthUser): Promise<ProjectWithRelations> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
          },
        },
        members: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                fullName: true,
                role: true,
              },
            },
          },
        },
        gates: {
          orderBy: { decidedAt: 'desc' },
        },
        runBudget: {
          select: {
            id: true,
            tokenBudget: true,
            tokensConsumed: true,
            retryCount: true,
            maxRetries: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        kickoff: true,
        deliveryReview: true,
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: {
            status: true,
          },
        },
        workOrders: {
          select: {
            status: true,
          },
        },
        clientInvites: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            email: true,
            contactName: true,
            companyName: true,
            status: true,
            acceptedById: true,
            acceptedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        _count: {
          select: { artifacts: true, eventLogs: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    const {
      artifacts: _lifecycleArtifacts,
      tasks: _lifecycleTasks,
      workOrders: _lifecycleWorkOrders,
      ...projectDetail
    } = project;

    return {
      ...projectDetail,
      lifecycle: this.deriveProjectLifecycle(project),
    };
  }

  async update(
    id: string,
    user: AuthUser,
    dto: UpdateProjectDto,
  ): Promise<ProjectWithRelations> {
    await this.assertAccessible(id, user);

    const projectUpdateData = {
      companyName: dto.companyName,
      brief: dto.brief,
      stackKey: dto.stackKey,
      status: dto.status,
      repoUrl: dto.repoUrl,
      version: { increment: 1 },
    } satisfies Prisma.ProjectUncheckedUpdateManyInput;

    if (dto.version === undefined) {
      await this.prisma.project.update({
        where: { id },
        data: projectUpdateData,
      });
    } else {
      await this.updateProjectWithVersion(id, dto.version, projectUpdateData);
    }

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.PROJECT_UPDATED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project updated',
      body: dto.companyName || dto.status || dto.repoUrl || null,
      metadata: {
        companyName: dto.companyName,
        stackKey: dto.stackKey,
        status: dto.status,
        repoUrl: dto.repoUrl,
      },
    });

    return this.findOne(id, user);
  }

  private async updateProjectWithVersion(
    id: string,
    version: number,
    data: Prisma.ProjectUncheckedUpdateManyInput,
  ): Promise<void> {
    const result = await this.prisma.project.updateMany({
      where: { id, version },
      data,
    });

    if (result.count === 0) {
      throw new ConflictException(
        `Project ${id} was updated by another request; reload and retry`,
      );
    }
  }

  async findKickoff(id: string, user: AuthUser): Promise<ProjectKickoff> {
    await this.assertAccessible(id, user);

    return this.prisma.projectKickoff.upsert({
      where: { projectId: id },
      update: {},
      create: {
        projectId: id,
        updatedById: user.id,
      },
    });
  }

  async updateKickoff(
    id: string,
    user: AuthUser,
    dto: UpdateProjectKickoffDto,
  ): Promise<ProjectKickoff> {
    await this.assertAccessible(id, user);
    return this.updateKickoffRecord(id, user, dto);
  }

  async createKickoffTasks(
    id: string,
    user: AuthUser,
  ): Promise<{ tasks: ProjectTaskWithRelations[]; kickoff: ProjectKickoff }> {
    await this.assertAccessible(id, user);

    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true, companyName: true, brief: true, stackKey: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    const starterTasks = [
      {
        title: 'Finalize scope and acceptance criteria',
        description: `Confirm delivery boundaries, success criteria, and exclusions for ${project.companyName}.`,
      },
      {
        title: 'Prepare milestone plan',
        description: 'Break the kickoff brief into delivery checkpoints, review moments, and owner expectations.',
      },
      {
        title: 'Collect client documents and access',
        description: 'Confirm required files, credentials, brand assets, and environment access before implementation starts.',
      },
    ];
    const existing = await this.prisma.projectTask.findMany({
      where: {
        projectId: id,
        title: { in: starterTasks.map((task) => task.title) },
      },
      include: taskInclude,
    });
    const existingTitles = new Set(existing.map((task) => task.title));
    const created: ProjectTaskWithRelations[] = [];

    for (const task of starterTasks) {
      if (existingTitles.has(task.title)) continue;
      created.push(await this.createTask(id, user, task));
    }

    const kickoff = await this.updateKickoffRecord(id, user, {
      initialTasksCreated: true,
    });

    return { tasks: [...existing, ...created], kickoff };
  }

  async createKickoffWorkOrders(
    id: string,
    user: AuthUser,
  ): Promise<{ workOrders: WorkOrderWithRelations[]; kickoff: ProjectKickoff }> {
    await this.assertAccessible(id, user);

    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true, companyName: true, brief: true, stackKey: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    const starterWorkOrders = [
      {
        title: 'Architecture kickoff brief',
        instructions: `Review the client brief, stack key (${project.stackKey}), and kickoff checklist before generating architecture decisions.`,
        agentType: WorkOrderAgentType.ARCHITECTURE,
        priority: WorkOrderPriority.HIGH,
      },
      {
        title: 'Implementation discovery handoff',
        instructions: 'Identify frontend, backend, database, and integration questions that must be answered before orchestration starts.',
        agentType: WorkOrderAgentType.BACKEND,
        priority: WorkOrderPriority.NORMAL,
      },
    ];
    const existing = await this.prisma.workOrder.findMany({
      where: {
        projectId: id,
        title: { in: starterWorkOrders.map((workOrder) => workOrder.title) },
      },
      include: workOrderInclude,
    });
    const existingTitles = new Set(existing.map((workOrder) => workOrder.title));
    const created: WorkOrderWithRelations[] = [];

    for (const workOrder of starterWorkOrders) {
      if (existingTitles.has(workOrder.title)) continue;
      const createdWorkOrder = await this.prisma.workOrder.create({
        data: {
          projectId: id,
          title: workOrder.title,
          instructions: workOrder.instructions,
          agentType: workOrder.agentType,
          priority: workOrder.priority,
          status: WorkOrderStatus.READY,
          createdById: user.id,
        },
        include: workOrderInclude,
      });

      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.WORK_ORDER_CREATED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Work order created',
        body: createdWorkOrder.title,
        metadata: {
          workOrderId: createdWorkOrder.id,
          agentType: createdWorkOrder.agentType,
          priority: createdWorkOrder.priority,
          source: 'kickoff',
        },
      });

      created.push(createdWorkOrder);
    }

    const kickoff = await this.updateKickoffRecord(id, user, {
      initialWorkOrdersCreated: true,
    });

    return { workOrders: [...existing, ...created], kickoff };
  }

  async addMember(
    projectId: string,
    user: AuthUser,
    dto: AddProjectMemberDto,
  ): Promise<ProjectWithRelations> {
    await this.assertAccessible(projectId, user);
    this.assertManagerRole(user);

    if (!dto.userId && !dto.email) {
      throw new BadRequestException('Either userId or email is required');
    }

    const profile = await this.prisma.profile.findFirst({
      where: dto.userId ? { id: dto.userId } : { email: dto.email },
      select: { id: true, role: true },
    });

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    this.assertRoleCompatible(profile.role, dto.role);

    await this.prisma.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId,
          userId: profile.id,
        },
      },
      update: { role: dto.role },
      create: {
        projectId,
        userId: profile.id,
        role: dto.role,
      },
    });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.MEMBER_ADDED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project member added',
      body: `${dto.role} member added`,
      metadata: { userId: profile.id, role: dto.role },
    });

    return this.findOne(projectId, user);
  }

  async removeMember(
    projectId: string,
    userId: string,
    user: AuthUser,
  ): Promise<ProjectWithRelations> {
    await this.assertAccessible(projectId, user);
    this.assertManagerRole(user);
    await this.assertCanRemoveMember(projectId, userId);

    await this.prisma.projectMember
      .delete({
        where: {
          projectId_userId: {
            projectId,
            userId,
          },
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2025'
        ) {
          throw new NotFoundException('Project member not found');
        }
        throw error;
      });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.MEMBER_REMOVED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project member removed',
      metadata: { userId },
    });

    return this.findOne(projectId, user);
  }

  async findArtifacts(
    id: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<ArtifactListItem[] | CursorPage<ArtifactListItem>> {
    await this.assertAccessible(id, user);
    const paged = hasCursorPage(page);

    if (user.role === UserRole.CLIENT) {
      const artifacts = await this.prisma.artifact.findMany({
        where: { projectId: id, clientVisible: true },
        select: {
          id: true,
          projectId: true,
          agentType: true,
          filePath: true,
          clientVisible: true,
          displayName: true,
          sharedAt: true,
          reviewStatus: true,
          reviewNote: true,
          reviewedAt: true,
          reviewedById: true,
          outputReviewStatus: true,
          outputReviewNote: true,
          outputReviewedAt: true,
          outputReviewedById: true,
          validationStatus: true,
          validationSummary: true,
          validationErrors: true,
          publishedAt: true,
          publishedById: true,
          revisionHandledAt: true,
          revisionHandledById: true,
          revisionResolutionNote: true,
          createdAt: true,
        },
        orderBy: paged
          ? [{ createdAt: 'asc' }, { id: 'asc' }]
          : { createdAt: 'asc' },
        ...(paged ? cursorQueryArgs(page) : {}),
      });

      return paged ? toCursorPage(artifacts, page) : artifacts;
    }

    const artifacts = await this.prisma.artifact.findMany({
      where: { projectId: id },
      orderBy: paged
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : { createdAt: 'asc' },
      ...(paged ? cursorQueryArgs(page) : {}),
    });

    return paged ? toCursorPage(artifacts, page) : artifacts;
  }

  async findArtifact(
    id: string,
    artifactId: string,
    user: AuthUser,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);
    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
      },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    return artifact;
  }

  async downloadArtifact(
    id: string,
    artifactId: string,
    user: AuthUser,
  ): Promise<{ fileName: string; content: string; contentType: string }> {
    await this.assertAccessible(id, user);
    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
        ...(user.role === UserRole.CLIENT ? { clientVisible: true } : {}),
      },
      select: {
        filePath: true,
        displayName: true,
        content: true,
      },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    return {
      fileName: this.safeDownloadName(artifact.displayName || artifact.filePath),
      content: artifact.content,
      contentType: this.contentTypeFor(artifact.filePath),
    };
  }

  async updateArtifactSharing(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: ShareArtifactDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
      },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        clientVisible: dto.clientVisible,
        displayName: dto.displayName,
        sharedAt: dto.clientVisible ? new Date() : null,
        reviewStatus: dto.clientVisible ? undefined : ArtifactReviewStatus.PENDING,
        reviewNote: dto.clientVisible ? undefined : null,
        reviewedAt: dto.clientVisible ? undefined : null,
        reviewedById: dto.clientVisible ? undefined : null,
        revisionHandledAt: dto.clientVisible ? undefined : null,
        revisionHandledById: dto.clientVisible ? undefined : null,
        revisionResolutionNote: dto.clientVisible ? undefined : null,
      },
    });

    await this.recordTimelineEvent(id, user, {
      type: dto.clientVisible
        ? ProjectTimelineEventType.ARTIFACT_SHARED
        : ProjectTimelineEventType.ARTIFACT_UNSHARED,
      visibility: dto.clientVisible
        ? ProjectTimelineVisibility.CLIENT
        : ProjectTimelineVisibility.INTERNAL,
      artifactId,
      title: dto.clientVisible ? 'Artifact shared with client' : 'Artifact unshared',
      body: updated.displayName || updated.filePath,
      metadata: { clientVisible: updated.clientVisible },
    });

    return updated;
  }

  async reviewArtifactOutput(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: ReviewArtifactOutputDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    if (
      dto.status === ArtifactOutputReviewStatus.PENDING ||
      dto.status === ArtifactOutputReviewStatus.PUBLISHED
    ) {
      throw new BadRequestException('status must be APPROVED or REWORK_REQUESTED');
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, projectId: id },
      include: {
        workOrders: {
          include: {
            task: {
              select: {
                id: true,
                title: true,
                assignedToId: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    const note = dto.note?.trim() || null;
    const rework = dto.status === ArtifactOutputReviewStatus.REWORK_REQUESTED;

    if (rework) {
      const sourceWorkOrder = artifact.workOrders?.[0];
      const assignedToId = dto.assignedToId || sourceWorkOrder?.task?.assignedToId;

      if (!assignedToId) {
        throw new BadRequestException('A developer assignee is required for rework');
      }

      await this.assertTaskLinks(id, assignedToId, artifact.id);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        outputReviewStatus: dto.status,
        outputReviewNote: note,
        outputReviewedAt: new Date(),
        outputReviewedById: user.id,
      },
    });

    await this.recordTimelineEvent(id, user, {
      type: rework
        ? ProjectTimelineEventType.ARTIFACT_REWORK_REQUESTED
        : ProjectTimelineEventType.ARTIFACT_OUTPUT_REVIEWED,
      visibility: ProjectTimelineVisibility.TEAM,
      artifactId,
      title: rework ? 'Artifact rework requested' : 'Artifact output approved',
      body: note ?? updated.displayName ?? updated.filePath,
      metadata: { outputReviewStatus: updated.outputReviewStatus },
    });

    if (rework) {
      await this.createArtifactRework(id, artifact, user, note, dto.assignedToId);
    }

    return updated;
  }

  async publishArtifactOutput(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: PublishArtifactOutputDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, projectId: id },
      select: { id: true, filePath: true, displayName: true, outputReviewStatus: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    if (artifact.outputReviewStatus === ArtifactOutputReviewStatus.REWORK_REQUESTED) {
      throw new BadRequestException('Resolve rework before publishing this artifact');
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        clientVisible: true,
        displayName: dto.displayName?.trim() || artifact.displayName || artifact.filePath,
        sharedAt: new Date(),
        reviewStatus: ArtifactReviewStatus.PENDING,
        reviewNote: null,
        reviewedAt: null,
        reviewedById: null,
        revisionHandledAt: null,
        revisionHandledById: null,
        revisionResolutionNote: null,
        outputReviewStatus: ArtifactOutputReviewStatus.PUBLISHED,
        outputReviewedAt: new Date(),
        outputReviewedById: user.id,
        publishedAt: new Date(),
        publishedById: user.id,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(id),
      actorId: user.id,
      projectId: id,
      artifactId,
      type: NotificationType.ARTIFACT_PUBLISHED,
      title: 'New deliverable published',
      body: updated.displayName || updated.filePath,
      metadata: { outputReviewStatus: updated.outputReviewStatus },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.ARTIFACT_PUBLISHED,
      visibility: ProjectTimelineVisibility.CLIENT,
      artifactId,
      title: 'Deliverable published',
      body: updated.displayName || updated.filePath,
      metadata: { outputReviewStatus: updated.outputReviewStatus },
    });

    return updated;
  }

  async reviewArtifact(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: ReviewArtifactDto,
  ): Promise<ArtifactListItem> {
    await this.assertAccessible(id, user);

    if (dto.reviewStatus === ArtifactReviewStatus.PENDING) {
      throw new BadRequestException('reviewStatus must be APPROVED or REVISION_REQUESTED');
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
        clientVisible: true,
      },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Shared artifact ${artifactId} not found`);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        reviewStatus: dto.reviewStatus,
        reviewNote: dto.reviewNote?.trim() || null,
        reviewedAt: new Date(),
        reviewedById: user.id,
        revisionHandledAt: null,
        revisionHandledById: null,
        revisionResolutionNote: null,
      },
      select: {
        id: true,
        projectId: true,
        agentType: true,
        filePath: true,
        clientVisible: true,
        displayName: true,
        sharedAt: true,
        reviewStatus: true,
        reviewNote: true,
        reviewedAt: true,
        reviewedById: true,
        outputReviewStatus: true,
        outputReviewNote: true,
        outputReviewedAt: true,
        outputReviewedById: true,
        validationStatus: true,
        validationSummary: true,
        validationErrors: true,
        publishedAt: true,
        publishedById: true,
        revisionHandledAt: true,
        revisionHandledById: true,
        revisionResolutionNote: true,
        createdAt: true,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(id),
      actorId: user.id,
      projectId: id,
      artifactId,
      type: NotificationType.ARTIFACT_REVIEWED,
      title: dto.reviewStatus === ArtifactReviewStatus.APPROVED
        ? 'Client approved a deliverable'
        : 'Client requested revisions',
      body: updated.reviewNote,
      metadata: { reviewStatus: dto.reviewStatus },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.ARTIFACT_REVIEWED,
      visibility: ProjectTimelineVisibility.CLIENT,
      artifactId,
      title: dto.reviewStatus === ArtifactReviewStatus.APPROVED
        ? 'Client approved deliverable'
        : 'Client requested revisions',
      body: updated.reviewNote,
      metadata: { reviewStatus: dto.reviewStatus },
    });

    return updated;
  }

  async handleRevision(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: HandleRevisionDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
        reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
      },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Revision request ${artifactId} not found`);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        revisionHandledAt: new Date(),
        revisionHandledById: user.id,
        revisionResolutionNote: dto.resolutionNote?.trim() || null,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(id),
      actorId: user.id,
      projectId: id,
      artifactId,
      type: NotificationType.REVISION_HANDLED,
      title: 'Your revision request was acknowledged',
      body: updated.revisionResolutionNote,
      metadata: { reviewStatus: updated.reviewStatus },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.REVISION_HANDLED,
      visibility: ProjectTimelineVisibility.CLIENT,
      artifactId,
      title: 'Revision request acknowledged',
      body: updated.revisionResolutionNote,
      metadata: { reviewStatus: updated.reviewStatus },
    });

    return updated;
  }

  async findDeliveryReview(
    id: string,
    user: AuthUser,
  ): Promise<ProjectDeliveryReview | null> {
    await this.assertAccessible(id, user);

    return this.prisma.projectDeliveryReview.findUnique({
      where: { projectId: id },
    });
  }

  async findDeliveryReadiness(
    id: string,
    user: AuthUser,
  ): Promise<DeliveryReadinessSummary> {
    await this.assertAccessible(id, user);
    return this.buildDeliveryReadiness(id, user.role === UserRole.CLIENT ? user.id : undefined);
  }

  async acceptDelivery(
    id: string,
    user: AuthUser,
    dto: ProjectDeliveryReviewNoteDto,
  ): Promise<ProjectDeliveryReview> {
    await this.assertAccessible(id, user);
    const readiness = await this.buildDeliveryReadiness(id, user.id);
    if (!readiness.ready) {
      throw new BadRequestException(
        readiness.blockers[0]?.message ?? 'Project is not ready for final delivery acceptance',
      );
    }

    const note = dto.note?.trim() || null;
    const acceptedAt = new Date();
    const reviewUpdateData = {
      status: ProjectDeliveryReviewStatus.ACCEPTED,
      acceptanceNote: note,
      acceptedById: user.id,
      acceptedAt,
      version: { increment: 1 },
    } satisfies Prisma.ProjectDeliveryReviewUncheckedUpdateManyInput;

    const review =
      dto.version === undefined
        ? await this.prisma.projectDeliveryReview.upsert({
            where: { projectId: id },
            update: reviewUpdateData,
            create: {
              projectId: id,
              status: ProjectDeliveryReviewStatus.ACCEPTED,
              acceptanceNote: note,
              acceptedById: user.id,
              acceptedAt,
            },
          })
        : await this.updateDeliveryReviewWithVersion(id, dto.version, reviewUpdateData);

    await this.prisma.project.update({
      where: { id },
      data: { status: ProjectStatus.DELIVERED, version: { increment: 1 } },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(id),
      actorId: user.id,
      projectId: id,
      type: NotificationType.DELIVERY_ACCEPTED,
      title: 'Client accepted final delivery',
      body: review.acceptanceNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.DELIVERY_ACCEPTED,
      visibility: ProjectTimelineVisibility.CLIENT,
      title: 'Final delivery accepted',
      body: review.acceptanceNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    return review;
  }

  async requestDeliveryRevision(
    id: string,
    user: AuthUser,
    dto: ProjectDeliveryReviewNoteDto,
  ): Promise<ProjectDeliveryReview> {
    await this.assertAccessible(id, user);

    const note = dto.note?.trim() || null;
    if (!note) {
      throw new BadRequestException('A revision note is required');
    }

    const revisionRequestedAt = new Date();
    const reviewUpdateData = {
      status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
      revisionNote: note,
      revisionRequestedById: user.id,
      revisionRequestedAt,
      revisionResolvedById: null,
      revisionResolvedAt: null,
      resolutionNote: null,
      version: { increment: 1 },
    } satisfies Prisma.ProjectDeliveryReviewUncheckedUpdateManyInput;

    const review =
      dto.version === undefined
        ? await this.prisma.projectDeliveryReview.upsert({
            where: { projectId: id },
            update: reviewUpdateData,
            create: {
              projectId: id,
              status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
              revisionNote: note,
              revisionRequestedById: user.id,
              revisionRequestedAt,
            },
          })
        : await this.updateDeliveryReviewWithVersion(id, dto.version, reviewUpdateData);

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(id),
      actorId: user.id,
      projectId: id,
      type: NotificationType.DELIVERY_REVISION_REQUESTED,
      title: 'Client requested delivery revisions',
      body: review.revisionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.DELIVERY_REVISION_REQUESTED,
      visibility: ProjectTimelineVisibility.CLIENT,
      title: 'Delivery revision requested',
      body: review.revisionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    return review;
  }

  async resolveDeliveryRevision(
    id: string,
    user: AuthUser,
    dto: ProjectDeliveryReviewNoteDto,
  ): Promise<ProjectDeliveryReview> {
    await this.assertAccessible(id, user);

    const existing = await this.prisma.projectDeliveryReview.findUnique({
      where: { projectId: id },
    });
    if (!existing) {
      throw new NotFoundException(`Delivery review for project ${id} not found`);
    }
    if (existing.status !== ProjectDeliveryReviewStatus.REVISION_REQUESTED) {
      throw new BadRequestException('Delivery review does not have an active revision request');
    }

    const reviewUpdateData = {
      status: ProjectDeliveryReviewStatus.REVISION_RESOLVED,
      revisionResolvedById: user.id,
      revisionResolvedAt: new Date(),
      resolutionNote: dto.note?.trim() || null,
      version: { increment: 1 },
    } satisfies Prisma.ProjectDeliveryReviewUncheckedUpdateManyInput;

    const review =
      dto.version === undefined
        ? await this.prisma.projectDeliveryReview.update({
            where: { projectId: id },
            data: reviewUpdateData,
          })
        : await this.updateDeliveryReviewWithVersion(id, dto.version, reviewUpdateData);

    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(id),
      actorId: user.id,
      projectId: id,
      type: NotificationType.DELIVERY_REVISION_RESOLVED,
      title: 'Delivery revision was resolved',
      body: review.resolutionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.DELIVERY_REVISION_RESOLVED,
      visibility: ProjectTimelineVisibility.CLIENT,
      title: 'Delivery revision resolved',
      body: review.resolutionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    return review;
  }

  private async updateDeliveryReviewWithVersion(
    projectId: string,
    version: number,
    data: Prisma.ProjectDeliveryReviewUncheckedUpdateManyInput,
  ): Promise<ProjectDeliveryReview> {
    const result = await this.prisma.projectDeliveryReview.updateMany({
      where: { projectId, version },
      data,
    });

    if (result.count === 0) {
      throw new ConflictException(
        `Delivery review for project ${projectId} was updated by another request; reload and retry`,
      );
    }

    const updated = await this.prisma.projectDeliveryReview.findUnique({
      where: { projectId },
    });

    if (!updated) {
      throw new NotFoundException(`Delivery review for project ${projectId} not found`);
    }

    return updated;
  }

  async findTasks(
    id: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<ProjectTaskWithRelations[] | CursorPage<ProjectTaskWithRelations>> {
    await this.assertAccessible(id, user);

    const where: Prisma.ProjectTaskWhereInput = { projectId: id };
    if (user.role === UserRole.DEV) {
      where.assignedToId = user.id;
    }

    const tasks = await this.prisma.projectTask.findMany({
      where,
      include: taskInclude,
      orderBy: hasCursorPage(page)
        ? [{ updatedAt: 'desc' }, { id: 'desc' }]
        : { updatedAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : {}),
    });

    return hasCursorPage(page) ? toCursorPage(tasks, page) : tasks;
  }

  async createTask(
    id: string,
    user: AuthUser,
    dto: CreateProjectTaskDto,
  ): Promise<ProjectTaskWithRelations> {
    await this.assertAccessible(id, user);
    await this.assertTaskLinks(id, dto.assignedToId, dto.artifactId);

    const task = await this.prisma.projectTask.create({
      data: {
        projectId: id,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        status: dto.status ?? ProjectTaskStatus.TODO,
        assignedToId: dto.assignedToId || null,
        artifactId: dto.artifactId || null,
        createdById: user.id,
      },
      include: taskInclude,
    });

    await this.recordTaskActivity({
      projectId: id,
      taskId: task.id,
      actorId: user.id,
      type: ProjectTaskActivityType.TASK_CREATED,
      message: `Task created: ${task.title}`,
      metadata: {
        status: task.status,
        assignedToId: task.assignedToId,
        artifactId: task.artifactId,
      },
    });

    if (task.assignedToId) {
      await this.recordTaskActivity({
        projectId: id,
        taskId: task.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ASSIGNEE_CHANGED,
        message: 'Task assigned',
        metadata: { to: task.assignedToId },
      });

      await this.notifications.notify({
        recipientIds: [task.assignedToId],
        actorId: user.id,
        projectId: id,
        taskId: task.id,
        artifactId: task.artifactId,
        type: NotificationType.TASK_ASSIGNED,
        title: 'New task assigned',
        body: task.title,
        metadata: { status: task.status },
      });
    }

    if (task.artifactId) {
      await this.recordTaskActivity({
        projectId: id,
        taskId: task.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ARTIFACT_CHANGED,
        message: 'Artifact linked',
        metadata: { to: task.artifactId },
      });
    }

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.TASK_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: task.id,
      artifactId: task.artifactId,
      title: 'Task created',
      body: task.title,
      metadata: {
        status: task.status,
        assignedToId: task.assignedToId,
      },
    });

    if (task.assignedToId) {
      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.TASK_ASSIGNED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: task.id,
        artifactId: task.artifactId,
        title: 'Task assigned',
        body: task.title,
        metadata: { assignedToId: task.assignedToId },
      });
    }

    return task;
  }

  async updateTask(
    id: string,
    taskId: string,
    user: AuthUser,
    dto: UpdateProjectTaskDto,
  ): Promise<ProjectTaskWithRelations> {
    await this.assertAccessible(id, user);

    const task = await this.prisma.projectTask.findFirst({
      where: { id: taskId, projectId: id },
      select: {
        id: true,
        assignedToId: true,
        artifactId: true,
        status: true,
      },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    const canManage = this.canManageProjects(user.role);
    if (!canManage) {
      if (task.assignedToId !== user.id) {
        throw new NotFoundException(`Task ${taskId} not found`);
      }

      const hasManagerOnlyFields =
        dto.title !== undefined ||
        dto.description !== undefined ||
        dto.assignedToId !== undefined ||
        dto.artifactId !== undefined;

      if (hasManagerOnlyFields) {
        throw new BadRequestException('Developers can only update task status');
      }
    }

    if (canManage) {
      await this.assertTaskLinks(id, dto.assignedToId, dto.artifactId);
    }

    const taskUpdateData = {
      title: canManage ? dto.title?.trim() : undefined,
      description: canManage
        ? dto.description === undefined
          ? undefined
          : dto.description.trim() || null
        : undefined,
      status: dto.status,
      assignedToId: canManage
        ? dto.assignedToId === undefined
          ? undefined
          : dto.assignedToId || null
        : undefined,
      artifactId: canManage
        ? dto.artifactId === undefined
          ? undefined
          : dto.artifactId || null
        : undefined,
      version: { increment: 1 },
    } satisfies Prisma.ProjectTaskUncheckedUpdateManyInput;

    const updated =
      dto.version === undefined
        ? await this.prisma.projectTask.update({
            where: { id: taskId },
            data: taskUpdateData,
            include: taskInclude,
          })
        : await this.updateTaskWithVersion(id, taskId, dto.version, taskUpdateData);

    await this.recordTaskUpdateActivity(id, task, updated, user);

    if (task.status !== updated.status) {
      await this.notifications.notify({
        recipientIds: [
          ...(await this.notifications.projectManagers(id)),
          ...(updated.assignedToId ? [updated.assignedToId] : []),
        ],
        actorId: user.id,
        projectId: id,
        taskId: updated.id,
        artifactId: updated.artifactId,
        type: NotificationType.TASK_STATUS_CHANGED,
        title: 'Task status changed',
        body: `${updated.title} is now ${updated.status}`,
        metadata: { from: task.status, to: updated.status },
      });

      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.TASK_STATUS_CHANGED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: updated.id,
        artifactId: updated.artifactId,
        title: 'Task status changed',
        body: `${updated.title} is now ${updated.status}`,
        metadata: { from: task.status, to: updated.status },
      });
    }

    if (task.assignedToId !== updated.assignedToId && updated.assignedToId) {
      await this.notifications.notify({
        recipientIds: [updated.assignedToId],
        actorId: user.id,
        projectId: id,
        taskId: updated.id,
        artifactId: updated.artifactId,
        type: NotificationType.TASK_ASSIGNED,
        title: 'Task assigned to you',
        body: updated.title,
        metadata: { from: task.assignedToId, to: updated.assignedToId },
      });

      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.TASK_ASSIGNED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: updated.id,
        artifactId: updated.artifactId,
        title: 'Task reassigned',
        body: updated.title,
        metadata: { from: task.assignedToId, to: updated.assignedToId },
      });
    }

    return updated;
  }

  private async updateTaskWithVersion(
    projectId: string,
    taskId: string,
    version: number,
    data: Prisma.ProjectTaskUncheckedUpdateManyInput,
  ): Promise<ProjectTaskWithRelations> {
    const result = await this.prisma.projectTask.updateMany({
      where: { id: taskId, version },
      data,
    });

    if (result.count === 0) {
      throw new ConflictException(
        `Task ${taskId} was updated by another request; reload and retry`,
      );
    }

    const updated = await this.prisma.projectTask.findFirst({
      where: { id: taskId, projectId },
      include: taskInclude,
    });

    if (!updated) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    return updated;
  }

  async findTaskActivity(
    id: string,
    taskId: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<ProjectTaskActivityWithActor[] | CursorPage<ProjectTaskActivityWithActor>> {
    await this.assertTaskAccessible(id, taskId, user);
    const paged = hasCursorPage(page);

    const activity = await this.prisma.projectTaskActivity.findMany({
      where: {
        projectId: id,
        taskId,
      },
      include: taskActivityInclude,
      orderBy: paged
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : { createdAt: 'asc' },
      ...(paged ? cursorQueryArgs(page) : {}),
    });

    return paged ? toCursorPage(activity, page) : activity;
  }

  async addTaskComment(
    id: string,
    taskId: string,
    user: AuthUser,
    dto: AddTaskCommentDto,
  ): Promise<ProjectTaskActivityWithActor> {
    await this.assertTaskAccessible(id, taskId, user);

    const activity = await this.prisma.projectTaskActivity.create({
      data: {
        projectId: id,
        taskId,
        actorId: user.id,
        type: ProjectTaskActivityType.COMMENT,
        message: dto.message.trim(),
      },
      include: taskActivityInclude,
    });

    const task = await this.prisma.projectTask.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, assignedToId: true, artifactId: true },
    });

    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(id)),
        ...(task?.assignedToId ? [task.assignedToId] : []),
      ],
      actorId: user.id,
      projectId: id,
      taskId,
      artifactId: task?.artifactId,
      type: NotificationType.TASK_COMMENTED,
      title: 'New task comment',
      body: dto.message.trim(),
      metadata: { taskTitle: task?.title },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.TASK_COMMENTED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId,
      artifactId: task?.artifactId,
      title: 'Task comment added',
      body: dto.message.trim(),
      metadata: { taskTitle: task?.title },
    });

    return activity;
  }

  async findTimeline(
    id: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<ProjectTimelineEventWithActor[] | CursorPage<ProjectTimelineEventWithActor>> {
    await this.assertAccessible(id, user);

    const events = await this.prisma.projectTimelineEvent.findMany({
      where: {
        projectId: id,
        visibility: { in: this.timelineVisibilityFor(user.role) },
      },
      include: timelineInclude,
      orderBy: hasCursorPage(page)
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : { createdAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : { take: 100 }),
    });

    return hasCursorPage(page) ? toCursorPage(events, page) : events;
  }

  async findWorkOrders(
    id: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<WorkOrderWithRelations[] | CursorPage<WorkOrderWithRelations>> {
    await this.assertAccessible(id, user);

    const where: Prisma.WorkOrderWhereInput = { projectId: id };
    if (user.role === UserRole.DEV) {
      where.task = { assignedToId: user.id };
    }

    const workOrders = await this.prisma.workOrder.findMany({
      where,
      include: workOrderInclude,
      orderBy: hasCursorPage(page)
        ? [{ updatedAt: 'desc' }, { id: 'desc' }]
        : { updatedAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : {}),
    });

    return hasCursorPage(page) ? toCursorPage(workOrders, page) : workOrders;
  }

  async createWorkOrder(
    id: string,
    user: AuthUser,
    dto: CreateWorkOrderDto,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);
    this.assertWorkOrderActionable(dto.instructions, WorkOrderStatus.READY);
    await this.assertWorkOrderLinks(id, dto.taskId, dto.artifactId);

    const workOrder = await this.prisma.workOrder.create({
      data: {
        projectId: id,
        title: dto.title.trim(),
        instructions: dto.instructions?.trim() || null,
        agentType: dto.agentType,
        priority: dto.priority,
        taskId: dto.taskId || null,
        artifactId: dto.artifactId || null,
        createdById: user.id,
      },
      include: workOrderInclude,
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: workOrder.taskId,
      artifactId: workOrder.artifactId,
      title: 'Work order created',
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        agentType: workOrder.agentType,
        priority: workOrder.priority,
      },
    });

    if (workOrder.task?.assignedToId) {
      await this.notifications.notify({
        recipientIds: [workOrder.task.assignedToId],
        actorId: user.id,
        projectId: id,
        taskId: workOrder.taskId,
        artifactId: workOrder.artifactId,
        type: NotificationType.WORK_ORDER_CREATED,
        title: 'Work order created',
        body: workOrder.title,
        metadata: { workOrderId: workOrder.id, agentType: workOrder.agentType },
      });
    }

    return workOrder;
  }

  async updateWorkOrder(
    id: string,
    workOrderId: string,
    user: AuthUser,
    dto: UpdateWorkOrderDto,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);

    const current = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    this.assertWorkOrderMutable(current.status, dto);
    this.assertWorkOrderActionable(dto.instructions, dto.status ?? current.status, current.instructions);
    await this.assertWorkOrderLinks(id, dto.taskId, dto.artifactId);

    const workOrderUpdateData = {
      title: dto.title?.trim(),
      instructions: dto.instructions === undefined ? undefined : dto.instructions.trim() || null,
      agentType: dto.agentType,
      priority: dto.priority,
      status: dto.status,
      taskId: dto.taskId === undefined ? undefined : dto.taskId || null,
      artifactId: dto.artifactId === undefined ? undefined : dto.artifactId || null,
      completedAt: dto.status === WorkOrderStatus.COMPLETED ? new Date() : undefined,
      failedAt: dto.status === WorkOrderStatus.FAILED ? new Date() : undefined,
      version: { increment: 1 },
    } satisfies Prisma.WorkOrderUncheckedUpdateManyInput;

    const updated =
      dto.version === undefined
        ? await this.prisma.workOrder.update({
            where: { id: workOrderId },
            data: workOrderUpdateData,
            include: workOrderInclude,
          })
        : await this.updateWorkOrderWithVersion(id, workOrderId, dto.version, workOrderUpdateData);

    if (current.status !== updated.status) {
      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: updated.taskId,
        artifactId: updated.artifactId,
        title: 'Work order status changed',
        body: `${updated.title} is now ${updated.status}`,
        metadata: { workOrderId: updated.id, from: current.status, to: updated.status },
      });

      await this.notifyWorkOrderStakeholders(id, user, updated, NotificationType.WORK_ORDER_STATUS_CHANGED, 'Work order status changed');
    }

    return updated;
  }

  private async updateWorkOrderWithVersion(
    projectId: string,
    workOrderId: string,
    version: number,
    data: Prisma.WorkOrderUncheckedUpdateManyInput,
  ): Promise<WorkOrderWithRelations> {
    const result = await this.prisma.workOrder.updateMany({
      where: { id: workOrderId, version },
      data,
    });

    if (result.count === 0) {
      throw new ConflictException(
        `Work order ${workOrderId} was updated by another request; reload and retry`,
      );
    }

    const updated = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId },
      include: workOrderInclude,
    });

    if (!updated) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    return updated;
  }

  async dispatchWorkOrder(
    id: string,
    workOrderId: string,
    user: AuthUser,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);

    const current = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    if (current.status !== WorkOrderStatus.READY) {
      throw new BadRequestException('Only READY work orders can be dispatched');
    }

    if (!current.instructions?.trim()) {
      throw new BadRequestException('Work order instructions are required before dispatch');
    }

    const updated = await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: WorkOrderStatus.DISPATCHED,
        dispatchedAt: new Date(),
      },
      include: workOrderInclude,
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: updated.taskId,
      artifactId: updated.artifactId,
      title: 'Work order dispatched',
      body: updated.title,
      metadata: { workOrderId: updated.id, agentType: updated.agentType },
    });

    await this.notifyWorkOrderStakeholders(id, user, updated, NotificationType.WORK_ORDER_DISPATCHED, 'Work order dispatched');

    const execution = await this.orchestration.executeWorkOrder(id, workOrderId, user.id);
    const executed = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!executed) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: executed.taskId,
      artifactId: executed.artifactId,
      title: 'Work order execution completed',
      body: executed.title,
      metadata: {
        workOrderId: executed.id,
        from: WorkOrderStatus.DISPATCHED,
        to: executed.status,
        executionRunId: execution.executionRunId,
        artifactId: execution.artifactId,
      },
    });

    await this.notifyWorkOrderStakeholders(id, user, executed, NotificationType.WORK_ORDER_STATUS_CHANGED, 'Work order completed');

    return executed;
  }

  async retryFailedWorkOrder(
    id: string,
    workOrderId: string,
    user: AuthUser,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);

    const current = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    if (current.status !== WorkOrderStatus.FAILED) {
      throw new BadRequestException('Only FAILED work orders can be retried');
    }

    if (!current.instructions?.trim()) {
      throw new BadRequestException('Work order instructions are required before retry');
    }

    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: WorkOrderStatus.READY,
        executionError: null,
        failedAt: null,
      },
      include: workOrderInclude,
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: current.taskId,
      artifactId: current.artifactId,
      title: 'Work order retry queued',
      body: current.title,
      metadata: {
        workOrderId: current.id,
        from: WorkOrderStatus.FAILED,
        to: WorkOrderStatus.READY,
      },
    });

    const execution = await this.orchestration.executeWorkOrder(id, workOrderId, user.id, {
      trigger: OrchestrationRunTrigger.RETRY_FAILED_WORK_ORDER,
      allowFailedRetry: true,
    });
    const executed = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!executed) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: executed.taskId,
      artifactId: executed.artifactId,
      title: 'Work order retry completed',
      body: executed.title,
      metadata: {
        workOrderId: executed.id,
        from: WorkOrderStatus.READY,
        to: executed.status,
        executionRunId: execution.executionRunId,
        artifactId: execution.artifactId,
      },
    });

    await this.notifyWorkOrderStakeholders(id, user, executed, NotificationType.WORK_ORDER_STATUS_CHANGED, 'Work order retry completed');

    return executed;
  }

  async findEvents(
    id: string,
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<EventLog[] | CursorPage<EventLog>> {
    await this.assertAccessible(id, user);
    const events = await this.prisma.eventLog.findMany({
      where: { projectId: id },
      orderBy: hasCursorPage(page)
        ? [{ occurredAt: 'desc' }, { id: 'desc' }]
        : { occurredAt: 'desc' },
      ...(hasCursorPage(page) ? cursorQueryArgs(page) : { take: 50 }),
    });

    return hasCursorPage(page) ? toCursorPage(events, page) : events;
  }

  async approveGate1(
    id: string,
    user: AuthUser,
    approved: boolean,
    notes?: string,
    acceptOpenQuestions?: boolean,
  ): Promise<{ accepted: boolean }> {
    await this.assertAccessible(id, user);
    await this.orchestration.resumeGate1(id, approved, notes, acceptOpenQuestions);
    return { accepted: true };
  }

  async approveGate2(
    id: string,
    user: AuthUser,
    approved: boolean,
    notes?: string,
  ): Promise<{ accepted: boolean }> {
    await this.assertAccessible(id, user);
    await this.orchestration.resumeGate2(id, approved, notes);
    return { accepted: true };
  }

  async getStatus(
    id: string,
    user: AuthUser,
  ): Promise<OrchestrationStatus & Pick<Project, 'companyName' | 'brief' | 'stackKey' | 'createdAt'>> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true, companyName: true, brief: true, stackKey: true, createdAt: true },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const orchestrationStatus = await this.orchestration.getStatus(id);
    return { ...orchestrationStatus, ...project };
  }

  private async buildDeliveryReadiness(
    projectId: string,
    clientUserId?: string,
  ): Promise<DeliveryReadinessSummary> {
    const [acceptedInvite, publishedArtifacts, activeWorkOrders, openDocuments, deliveryReview] =
      await Promise.all([
        this.prisma.clientInvite.findFirst({
          where: {
            projectId,
            status: ClientInviteStatus.ACCEPTED,
            ...(clientUserId ? { acceptedById: clientUserId } : {}),
          },
          select: { id: true },
        }),
        this.prisma.artifact.findMany({
          where: {
            projectId,
            clientVisible: true,
            outputReviewStatus: ArtifactOutputReviewStatus.PUBLISHED,
          },
          select: {
            id: true,
            agentType: true,
            reviewStatus: true,
            revisionHandledAt: true,
            validationStatus: true,
          },
        }),
        this.prisma.workOrder.findMany({
          where: {
            projectId,
            status: {
              in: [
                WorkOrderStatus.READY,
                WorkOrderStatus.DISPATCHED,
                WorkOrderStatus.FAILED,
              ],
            },
          },
          select: { id: true },
        }),
        this.prisma.collaborationDocument.count({
          where: {
            projectId,
            clientVisible: true,
            status: {
              notIn: [
                CollaborationDocumentStatus.APPROVED,
                CollaborationDocumentStatus.ARCHIVED,
              ],
            },
          },
        }),
        this.prisma.projectDeliveryReview.findUnique({
          where: { projectId },
          select: { status: true },
        }),
      ]);

    const completedWorkOrders = await this.prisma.workOrder.findMany({
      where: {
        projectId,
        status: WorkOrderStatus.COMPLETED,
      },
      select: { agentType: true },
    });

    const publishedAgentTypes = new Set(
      publishedArtifacts.map((artifact) => this.agentTypeFromArtifact(artifact.agentType)),
    );
    const requiredAgentTypes = new Set(completedWorkOrders.map((workOrder) => workOrder.agentType));
    const missingAgentTypes = [...requiredAgentTypes].filter(
      (agentType) => !publishedAgentTypes.has(agentType),
    );
    const invalidPublishedArtifacts = publishedArtifacts.filter(
      (artifact) => artifact.validationStatus !== ArtifactValidationStatus.PASSED,
    );
    const unapprovedPublishedArtifacts = publishedArtifacts.filter(
      (artifact) => artifact.reviewStatus !== ArtifactReviewStatus.APPROVED,
    );
    const openArtifactRevisions = publishedArtifacts.filter(
      (artifact) =>
        artifact.reviewStatus === ArtifactReviewStatus.REVISION_REQUESTED &&
        !artifact.revisionHandledAt,
    );

    const checks = {
      acceptedInvite: Boolean(acceptedInvite),
      hasPublishedArtifacts: publishedArtifacts.length > 0,
      publishedArtifactsValidated: invalidPublishedArtifacts.length === 0,
      publishedArtifactsApproved: unapprovedPublishedArtifacts.length === 0,
      requiredAgentCoverage: missingAgentTypes.length === 0,
      documentsCleared: openDocuments === 0,
      workOrdersCleared: activeWorkOrders.length === 0,
      revisionsCleared: openArtifactRevisions.length === 0,
      deliveryRevisionCleared:
        deliveryReview?.status !== ProjectDeliveryReviewStatus.REVISION_REQUESTED,
    };
    const blockers: DeliveryReadinessBlocker[] = [];

    if (!checks.acceptedInvite) {
      blockers.push({
        code: 'CLIENT_INVITE_NOT_ACCEPTED',
        message: 'Client invite must be accepted before final delivery can be accepted',
        severity: 'BLOCKER',
      });
    }
    if (!checks.hasPublishedArtifacts) {
      blockers.push({
        code: 'NO_PUBLISHED_ARTIFACTS',
        message: 'Publish at least one client-visible artifact before accepting delivery',
        severity: 'BLOCKER',
      });
    }
    if (!checks.requiredAgentCoverage) {
      blockers.push({
        code: 'MISSING_REQUIRED_ARTIFACT_COVERAGE',
        message: 'Publish client-visible artifacts for every completed agent workstream before accepting delivery',
        severity: 'BLOCKER',
        count: missingAgentTypes.length,
      });
    }
    if (!checks.publishedArtifactsValidated) {
      blockers.push({
        code: 'PUBLISHED_ARTIFACTS_NOT_VALIDATED',
        message: 'All published artifacts must pass validation before accepting delivery',
        severity: 'BLOCKER',
        count: invalidPublishedArtifacts.length,
      });
    }
    if (!checks.publishedArtifactsApproved) {
      blockers.push({
        code: 'PUBLISHED_ARTIFACTS_NOT_APPROVED',
        message: 'All published artifacts must be approved by the client before accepting delivery',
        severity: 'BLOCKER',
        count: unapprovedPublishedArtifacts.length,
      });
    }
    if (!checks.revisionsCleared) {
      blockers.push({
        code: 'ARTIFACT_REVISIONS_OPEN',
        message: 'Resolve all open artifact revision requests before accepting delivery',
        severity: 'BLOCKER',
        count: openArtifactRevisions.length,
      });
    }
    if (!checks.documentsCleared) {
      blockers.push({
        code: 'DOCUMENT_REVIEWS_OPEN',
        message: 'Resolve all client-visible document reviews before accepting delivery',
        severity: 'BLOCKER',
        count: openDocuments,
      });
    }
    if (!checks.workOrdersCleared) {
      blockers.push({
        code: 'WORK_ORDERS_ACTIVE_OR_FAILED',
        message: 'Complete, retry, or cancel all active and failed work orders before accepting delivery',
        severity: 'BLOCKER',
        count: activeWorkOrders.length,
      });
    }
    if (!checks.deliveryRevisionCleared) {
      blockers.push({
        code: 'DELIVERY_REVISION_OPEN',
        message: 'Resolve the project-level delivery revision request before accepting delivery',
        severity: 'BLOCKER',
      });
    }

    return {
      ready: blockers.every((blocker) => blocker.severity !== 'BLOCKER'),
      projectId,
      blockers,
      checks,
      counts: {
        publishedArtifacts: publishedArtifacts.length,
        invalidPublishedArtifacts: invalidPublishedArtifacts.length,
        unapprovedPublishedArtifacts: unapprovedPublishedArtifacts.length,
        activeWorkOrders: activeWorkOrders.length,
        openDocuments,
        openArtifactRevisions: openArtifactRevisions.length,
        missingAgentTypes: missingAgentTypes.length,
      },
    };
  }

  private async findRunnableProject(id: string, user: AuthUser): Promise<{
    id: string;
    companyName: string;
    brief: string;
    stackKey: string;
    createdById: string | null;
  }> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: {
        id: true,
        companyName: true,
        brief: true,
        stackKey: true,
        createdById: true,
        kickoff: {
          select: { status: true },
        },
        workOrders: {
          where: { status: WorkOrderStatus.READY },
          select: { instructions: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    if (project.kickoff?.status !== ProjectKickoffStatus.READY && project.kickoff?.status !== ProjectKickoffStatus.LOCKED) {
      throw new BadRequestException('Project kickoff must be complete before orchestration can start');
    }

    if (!project.workOrders.some((workOrder) => workOrder.instructions?.trim())) {
      throw new BadRequestException('At least one READY work order with instructions is required before orchestration can start');
    }

    return project;
  }

  private deriveProjectLifecycle(project: ProjectLifecycleSource): ProjectLifecycleSummary {
    const artifacts = project.artifacts ?? [];
    const tasks = project.tasks ?? [];
    const workOrders = project.workOrders ?? [];
    const clientAccepted = (project.clientInvites ?? []).some(
      (invite) => invite.status === ClientInviteStatus.ACCEPTED,
    );
    const kickoffReady =
      project.kickoff?.status === ProjectKickoffStatus.READY ||
      project.kickoff?.status === ProjectKickoffStatus.LOCKED;
    const orchestrationStarted = Boolean(project.runId);
    const deliveryReviewStatus = project.deliveryReview?.status;
    const deliveryAccepted = deliveryReviewStatus === ProjectDeliveryReviewStatus.ACCEPTED;
    const deliveryRevisionOpen = deliveryReviewStatus === ProjectDeliveryReviewStatus.REVISION_REQUESTED;
    const deliveryReviewOpen = deliveryReviewStatus === ProjectDeliveryReviewStatus.REVISION_RESOLVED;
    const clientVisibleArtifacts = artifacts.filter((artifact) => artifact.clientVisible);
    const artifactRevisionOpen = clientVisibleArtifacts.some(
      (artifact) =>
        artifact.reviewStatus === ArtifactReviewStatus.REVISION_REQUESTED &&
        !artifact.revisionHandledAt,
    );
    const revisionOpen = artifactRevisionOpen || deliveryRevisionOpen;
    const clientReviewOpen =
      deliveryReviewOpen ||
      clientVisibleArtifacts.some((artifact) => artifact.reviewStatus === ArtifactReviewStatus.PENDING);
    const openTasks = tasks.filter((task) => task.status !== ProjectTaskStatus.DONE).length;
    const activeWorkOrderStatuses = new Set<WorkOrderStatus>([
      WorkOrderStatus.READY,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.FAILED,
    ]);
    const activeWorkOrders = workOrders.filter((workOrder) =>
      activeWorkOrderStatuses.has(workOrder.status),
    ).length;

    let stage: ProjectLifecycleStage = 'APPROVED';

    if (project.status === 'FAILED') {
      stage = 'FAILED';
    } else if (revisionOpen) {
      stage = 'REVISION';
    } else if (project.status === 'DELIVERED' || deliveryAccepted) {
      stage = 'DELIVERED';
    } else if (clientReviewOpen) {
      stage = 'CLIENT_REVIEW';
    } else if (orchestrationStarted) {
      stage = 'IN_ORCHESTRATION';
    } else if (kickoffReady) {
      stage = 'READY_FOR_ORCHESTRATION';
    } else if (clientAccepted || project.kickoff) {
      stage = 'KICKOFF';
    } else if ((project.clientInvites ?? []).length > 0 && !clientAccepted) {
      stage = 'CLIENT_ONBOARDING';
    }

    const stageView: Record<
      ProjectLifecycleStage,
      { label: string; nextAction: string; tone: ProjectLifecycleSummary['tone']; progress: number }
    > = {
      APPROVED: {
        label: 'Approved',
        nextAction: 'Create kickoff',
        tone: 'gray',
        progress: 10,
      },
      CLIENT_ONBOARDING: {
        label: 'Client onboarding',
        nextAction: 'Wait for client join',
        tone: 'yellow',
        progress: 20,
      },
      KICKOFF: {
        label: 'Kickoff',
        nextAction: 'Complete kickoff',
        tone: 'blue',
        progress: 35,
      },
      READY_FOR_ORCHESTRATION: {
        label: 'Ready for orchestration',
        nextAction: 'Start orchestration',
        tone: 'green',
        progress: 50,
      },
      IN_ORCHESTRATION: {
        label: 'In orchestration',
        nextAction: 'Monitor delivery',
        tone: 'purple',
        progress: 65,
      },
      CLIENT_REVIEW: {
        label: 'Client review',
        nextAction: 'Follow up review',
        tone: 'yellow',
        progress: 78,
      },
      REVISION: {
        label: 'Revision',
        nextAction: 'Resolve revision',
        tone: 'red',
        progress: 82,
      },
      DELIVERED: {
        label: 'Delivered',
        nextAction: 'Delivery accepted',
        tone: 'green',
        progress: 100,
      },
      FAILED: {
        label: 'Failed',
        nextAction: 'Review failure',
        tone: 'red',
        progress: 0,
      },
    };

    return {
      stage,
      ...stageView[stage],
      signals: {
        clientAccepted,
        kickoffReady,
        orchestrationStarted,
        clientReviewOpen,
        revisionOpen,
        deliveryAccepted,
        deliveryRevisionOpen,
        totalTasks: tasks.length,
        openTasks,
        totalWorkOrders: workOrders.length,
        activeWorkOrders,
        clientVisibleArtifacts: clientVisibleArtifacts.length,
      },
    };
  }

  private async updateKickoffRecord(
    projectId: string,
    user: AuthUser,
    dto: UpdateProjectKickoffDto,
  ): Promise<ProjectKickoff> {
    const existing = await this.prisma.projectKickoff.findUnique({
      where: { projectId },
    });
    const data = this.normalizeKickoffInput(dto);
    const merged = {
      ...Object.fromEntries(kickoffChecklistFields.map((field) => [field, false])),
      ...existing,
      ...data,
    } as Record<KickoffChecklistField, boolean> & {
      status?: ProjectKickoffStatus;
      completedAt?: Date | null;
      completedById?: string | null;
    };
    const allReady = kickoffChecklistFields.every((field) => Boolean(merged[field]));
    const nextStatus =
      existing?.status === ProjectKickoffStatus.LOCKED
        ? ProjectKickoffStatus.LOCKED
        : allReady
          ? ProjectKickoffStatus.READY
          : ProjectKickoffStatus.DRAFT;
    const completionData =
      nextStatus === ProjectKickoffStatus.READY || nextStatus === ProjectKickoffStatus.LOCKED
        ? {
            completedAt: existing?.completedAt ?? new Date(),
            completedById: existing?.completedById ?? user.id,
          }
        : {
            completedAt: null,
            completedById: null,
          };

    return this.prisma.projectKickoff.upsert({
      where: { projectId },
      update: {
        ...data,
        ...completionData,
        status: nextStatus,
        updatedById: user.id,
      },
      create: {
        projectId,
        ...data,
        ...completionData,
        status: nextStatus,
        updatedById: user.id,
      },
    });
  }

  private normalizeKickoffInput(
    dto: UpdateProjectKickoffDto,
  ): ProjectKickoffInput {
    const data: ProjectKickoffInput = {};

    for (const field of kickoffTextFields) {
      const value = dto[field];
      if (typeof value === 'string') {
        data[field] = value.trim() || null;
      }
    }

    for (const field of kickoffChecklistFields) {
      const value = dto[field];
      if (typeof value === 'boolean') {
        data[field] = value;
      }
    }

    return data;
  }

  private async assertAccessible(id: string, user: AuthUser): Promise<void> {
    const exists = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Project ${id} not found`);
    }
  }

  private async assertTaskAccessible(
    projectId: string,
    taskId: string,
    user: AuthUser,
  ): Promise<{ id: string; assignedToId: string | null }> {
    await this.assertAccessible(projectId, user);

    const task = await this.prisma.projectTask.findFirst({
      where: { id: taskId, projectId },
      select: { id: true, assignedToId: true },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    if (user.role === UserRole.DEV && task.assignedToId !== user.id) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    return task;
  }

  private async recordTaskUpdateActivity(
    projectId: string,
    previous: {
      id: string;
      assignedToId: string | null;
      artifactId: string | null;
      status: ProjectTaskStatus;
    },
    updated: ProjectTask,
    user: AuthUser,
  ): Promise<void> {
    if (previous.status !== updated.status) {
      await this.recordTaskActivity({
        projectId,
        taskId: previous.id,
        actorId: user.id,
        type: ProjectTaskActivityType.STATUS_CHANGED,
        message: `Status changed to ${updated.status}`,
        metadata: { from: previous.status, to: updated.status },
      });
    }

    if (previous.assignedToId !== updated.assignedToId) {
      await this.recordTaskActivity({
        projectId,
        taskId: previous.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ASSIGNEE_CHANGED,
        message: updated.assignedToId ? 'Task reassigned' : 'Task unassigned',
        metadata: { from: previous.assignedToId, to: updated.assignedToId },
      });
    }

    if (previous.artifactId !== updated.artifactId) {
      await this.recordTaskActivity({
        projectId,
        taskId: previous.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ARTIFACT_CHANGED,
        message: updated.artifactId ? 'Artifact linked' : 'Artifact unlinked',
        metadata: { from: previous.artifactId, to: updated.artifactId },
      });
    }
  }

  private async recordTaskActivity(input: {
    projectId: string;
    taskId: string;
    actorId: string | null;
    type: ProjectTaskActivityType;
    message?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.projectTaskActivity.create({
      data: {
        projectId: input.projectId,
        taskId: input.taskId,
        actorId: input.actorId,
        type: input.type,
        message: input.message,
        metadata: input.metadata ?? {},
      },
    });
  }

  private async notifyWorkOrderStakeholders(
    projectId: string,
    user: AuthUser,
    workOrder: WorkOrderWithRelations,
    type: NotificationType,
    title: string,
  ): Promise<void> {
    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(projectId)),
        ...(workOrder.task?.assignedToId ? [workOrder.task.assignedToId] : []),
      ],
      actorId: user.id,
      projectId,
      taskId: workOrder.taskId,
      artifactId: workOrder.artifactId,
      type,
      title,
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        status: workOrder.status,
        agentType: workOrder.agentType,
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
      taskId?: string | null;
      artifactId?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await this.prisma.projectTimelineEvent.create({
      data: {
        projectId,
        actorId: user.id,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        visibility: input.visibility,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }

  private timelineVisibilityFor(role: UserRole): ProjectTimelineVisibility[] {
    if (this.canManageProjects(role)) {
      return [
        ProjectTimelineVisibility.INTERNAL,
        ProjectTimelineVisibility.TEAM,
        ProjectTimelineVisibility.CLIENT,
      ];
    }

    if (role === UserRole.DEV) {
      return [ProjectTimelineVisibility.TEAM, ProjectTimelineVisibility.CLIENT];
    }

    return [ProjectTimelineVisibility.CLIENT];
  }

  private async assertTaskLinks(
    projectId: string,
    assignedToId?: string,
    artifactId?: string,
  ): Promise<void> {
    if (assignedToId) {
      const member = await this.prisma.projectMember.findFirst({
        where: {
          projectId,
          userId: assignedToId,
          role: UserRole.DEV,
        },
        select: { id: true },
      });

      if (!member) {
        throw new NotFoundException('Assigned developer is not a project member');
      }
    }

    if (artifactId) {
      const artifact = await this.prisma.artifact.findFirst({
        where: {
          id: artifactId,
          projectId,
        },
        select: { id: true },
      });

      if (!artifact) {
        throw new NotFoundException(`Artifact ${artifactId} not found`);
      }
    }
  }

  private assertManagerRole(user: AuthUser): void {
    if (!this.canManageProjects(user.role)) {
      throw new BadRequestException('Only PM or ADMIN users can manage this resource');
    }
  }

  private safeDownloadName(name: string): string {
    const fallback = 'artifact.txt';
    const base = name.split(/[\\/]/).pop()?.trim() || fallback;
    return base.replace(/[^a-zA-Z0-9._-]/g, '_') || fallback;
  }

  private contentTypeFor(filePath: string): string {
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.js') || filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'text/plain; charset=utf-8';
    if (filePath.endsWith('.md')) return 'text/markdown; charset=utf-8';
    return 'text/plain; charset=utf-8';
  }

  private assertRoleCompatible(profileRole: UserRole, projectRole: UserRole): void {
    if (profileRole !== projectRole) {
      throw new BadRequestException(`Cannot add ${profileRole} profile as ${projectRole}`);
    }
  }

  private async assertCanRemoveMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        createdById: true,
        members: {
          where: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
          select: { userId: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const managerIds = new Set([
      project.createdById,
      ...project.members.map((member) => member.userId),
    ].filter(Boolean) as string[]);

    if (managerIds.has(userId) && managerIds.size <= 1) {
      throw new BadRequestException('Cannot remove the last project manager');
    }
  }

  private assertWorkOrderActionable(
    instructions?: string | null,
    status?: WorkOrderStatus,
    currentInstructions?: string | null,
  ): void {
    const nextInstructions = instructions === undefined ? currentInstructions : instructions;
    const isActionableStatus =
      status === WorkOrderStatus.READY ||
      status === WorkOrderStatus.DISPATCHED ||
      status === WorkOrderStatus.COMPLETED;

    if (isActionableStatus && !nextInstructions?.trim()) {
      throw new BadRequestException('Work order instructions are required before it can be actioned');
    }
  }

  private assertWorkOrderMutable(
    currentStatus: WorkOrderStatus,
    dto: UpdateWorkOrderDto,
  ): void {
    if (
      (currentStatus === WorkOrderStatus.DISPATCHED ||
        currentStatus === WorkOrderStatus.COMPLETED) &&
      (
        dto.title !== undefined ||
        dto.instructions !== undefined ||
        dto.agentType !== undefined ||
        dto.priority !== undefined ||
        dto.taskId !== undefined ||
        dto.artifactId !== undefined
      )
    ) {
      throw new BadRequestException('Dispatched or completed work orders cannot be re-scoped');
    }
  }

  private async assertWorkOrderLinks(
    projectId: string,
    taskId?: string,
    artifactId?: string,
  ): Promise<void> {
    if (taskId) {
      const task = await this.prisma.projectTask.findFirst({
        where: {
          id: taskId,
          projectId,
        },
        select: { id: true },
      });

      if (!task) {
        throw new NotFoundException(`Task ${taskId} not found`);
      }
    }

    if (artifactId) {
      const artifact = await this.prisma.artifact.findFirst({
        where: {
          id: artifactId,
          projectId,
        },
        select: { id: true },
      });

      if (!artifact) {
        throw new NotFoundException(`Artifact ${artifactId} not found`);
      }
    }
  }

  private async createArtifactRework(
    projectId: string,
    artifact: Artifact & {
      workOrders?: {
        id: string;
        agentType: WorkOrderAgentType;
        taskId: string | null;
        task: { id: string; title: string; assignedToId: string | null } | null;
      }[];
    },
    user: AuthUser,
    note: string | null,
    requestedAssigneeId?: string,
  ): Promise<void> {
    const sourceWorkOrder = artifact.workOrders?.[0];
    const assignedToId = requestedAssigneeId || sourceWorkOrder?.task?.assignedToId;

    if (!assignedToId) {
      throw new BadRequestException('A developer assignee is required for rework');
    }

    await this.assertTaskLinks(projectId, assignedToId, artifact.id);

    const label = artifact.displayName || artifact.filePath;
    const task = await this.prisma.projectTask.create({
      data: {
        projectId,
        artifactId: artifact.id,
        title: `Rework: ${label}`,
        description: note || 'PM requested internal rework before client publishing.',
        status: ProjectTaskStatus.TODO,
        assignedToId,
        createdById: user.id,
      },
      include: taskInclude,
    });

    await this.recordTaskActivity({
      projectId,
      taskId: task.id,
      actorId: user.id,
      type: ProjectTaskActivityType.TASK_CREATED,
      message: 'Task created from PM output rework request',
      metadata: { artifactId: artifact.id, sourceWorkOrderId: sourceWorkOrder?.id },
    });

    const workOrder = await this.prisma.workOrder.create({
      data: {
        projectId,
        taskId: task.id,
        artifactId: artifact.id,
        title: `Rework handoff: ${label}`,
        instructions: note || 'Revise this artifact for PM review.',
        agentType: sourceWorkOrder?.agentType ?? this.agentTypeFromArtifact(artifact.agentType),
        priority: WorkOrderPriority.HIGH,
        status: WorkOrderStatus.READY,
        createdById: user.id,
      },
      include: workOrderInclude,
    });

    await this.notifications.notify({
      recipientIds: [assignedToId],
      actorId: user.id,
      projectId,
      taskId: task.id,
      artifactId: artifact.id,
      type: NotificationType.ARTIFACT_REWORK_REQUESTED,
      title: 'PM requested artifact rework',
      body: note || label,
      metadata: { workOrderId: workOrder.id, artifactId: artifact.id },
    });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.WORK_ORDER_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: task.id,
      artifactId: artifact.id,
      title: 'Rework work order created',
      body: workOrder.title,
      metadata: { workOrderId: workOrder.id, sourceWorkOrderId: sourceWorkOrder?.id },
    });
  }

  private agentTypeFromArtifact(agentType: string): WorkOrderAgentType {
    const normalized = agentType.toUpperCase();
    if (normalized in WorkOrderAgentType) {
      return WorkOrderAgentType[normalized as keyof typeof WorkOrderAgentType];
    }
    return WorkOrderAgentType.FRONTEND;
  }

  private projectAccessWhere(user: AuthUser, id?: string): Prisma.ProjectWhereInput {
    const where: Prisma.ProjectWhereInput = id ? { id } : {};

    if (user.role === UserRole.ADMIN) {
      return where;
    }

    const groupAccess: Prisma.ProjectWhereInput[] =
      user.role === UserRole.PM || user.role === UserRole.DEV
        ? [
            {
              group: {
                members: {
                  some: { userId: user.id, status: 'ACTIVE' },
                },
              },
            },
          ]
        : [];

    return {
      ...where,
      OR: [
        { createdById: user.id },
        { members: { some: { userId: user.id } } },
        ...groupAccess,
      ],
    };
  }

  private canManageProjects(role: UserRole): boolean {
    return role === UserRole.PM || role === UserRole.ADMIN;
  }
}
