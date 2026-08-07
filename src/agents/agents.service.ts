import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AgentAccessScope,
  Prisma,
  Profile,
  ProviderInvocationStatus,
  UserRole,
  WorkspaceAgent,
  WorkspaceAgentStatus,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { EveRuntimeCatalogService } from './eve-runtime-catalog.service';
import { GroupsService } from '../groups/groups.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BUILT_IN_AGENTS,
  BUILT_IN_AGENTS_BY_KEY,
  GENERIC_RUNTIMES,
  builtInPromptFor,
  resolveRuntimeKey,
} from './built-in-agents';
import {
  CreateAgentDto,
  CreateAgentSkillDto,
  UpdateAgentDto,
  UpdateAgentSkillDto,
} from './dto/agent.dto';

/** How far back the detail page's activity summary looks. */
const ACTIVITY_WINDOW_DAYS = 30;

export type AgentListScope = 'mine' | 'all' | 'archived';

interface AgentActivity {
  runs: number;
  lastActiveAt: Date | null;
  running: number;
  completedInWindow: number;
}

/**
 * Workspace agents.
 *
 * Two things make this more than a settings table. `resolveSystemPrompt` is read by the
 * orchestration at dispatch, so an edited instruction changes what the agent is actually told;
 * and every status column is derived from `ProviderInvocation`, the same telemetry the runs
 * themselves write, rather than from fields a UI could set independently of reality.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService,
    private readonly eveRuntimes: EveRuntimeCatalogService,
  ) {}

  /**
   * Every entry point that names a workspace has to prove the caller belongs to it.
   *
   * The role guard on the controller decides who may use this feature at all; it says nothing
   * about *which* workspace, and groupId arrives from the query string or request body. Without
   * this, any authenticated PM or DEV could read and rewrite another team's agents — including
   * their system prompts, which the orchestration then runs — by passing a different id.
   *
   * Delegates to GroupsService so there is one definition of membership in the codebase.
   * It throws NotFound rather than Forbidden on purpose: a workspace you are not in should not
   * be distinguishable from one that does not exist.
   */
  private assertWorkspaceMember(user: AuthUser, groupId: string) {
    return this.groups.assertMember(groupId, user);
  }

  /**
   * Creates any built-in agent this workspace does not have yet.
   *
   * Idempotent and safe to call on every read: `createMany({ skipDuplicates })` against the
   * `(groupId, key)` unique index means a concurrent second call inserts nothing rather than
   * racing. Seeding lazily rather than in a migration keeps workspaces created later correct
   * without a backfill, and keeps `instructions` null so an unedited agent tracks the package.
   */
  async ensureBuiltInAgents(groupId: string): Promise<void> {
    const existing = await this.prisma.workspaceAgent.findMany({
      where: { groupId },
      select: { key: true },
    });
    const have = new Set(existing.map((agent) => agent.key));

    // Seed from what Eve reports it can run, falling back to the compiled-in list when Eve is
    // unreachable. Seeding from the package list alone is what allowed the roster to claim
    // twelve agents while only eight had a deployed runtime.
    const deployed = await this.eveRuntimes.listDeployedAgents();
    const seedable = deployed
      ? deployed.map((runtime) => ({
          key: runtime.name,
          name: BUILT_IN_AGENTS_BY_KEY.get(runtime.name)?.name ?? runtime.name,
          description: runtime.description ?? BUILT_IN_AGENTS_BY_KEY.get(runtime.name)?.description ?? null,
          avatarEmoji: BUILT_IN_AGENTS_BY_KEY.get(runtime.name)?.avatarEmoji ?? '🤖',
        }))
      : BUILT_IN_AGENTS.map((agent) => ({
          key: agent.key,
          name: agent.name,
          description: agent.description,
          avatarEmoji: agent.avatarEmoji,
        }));

    const missing = seedable.filter((agent) => !have.has(agent.key));
    if (missing.length === 0) return;

    await this.prisma.workspaceAgent.createMany({
      data: missing.map((agent) => ({
        ...agent,
        isBuiltIn: true,
        groupId,
        accessScope: AgentAccessScope.WORKSPACE,
      })),
      skipDuplicates: true,
    });
    this.logger.log(`Seeded ${missing.length} built-in agent(s) for group ${groupId}`);
  }

  /**
   * Keys with a deployed runtime, or null when Eve could not be reached.
   *
   * Null is not an empty set: "we do not know what is deployed" must not render every agent as
   * broken. Callers treat null as "do not annotate".
   */
  private async deployedRuntimeKeys(): Promise<Set<string> | null> {
    const deployed = await this.eveRuntimes.listDeployedAgents();
    return deployed ? new Set(deployed.map((runtime) => runtime.name)) : null;
  }

  async list(user: AuthUser, groupId: string, scope: AgentListScope = 'all', search?: string) {
    if (!groupId) throw new BadRequestException('groupId is required');
    // Before ensureBuiltInAgents, which writes: an unauthorised caller must not be able to
    // seed rows into a workspace they cannot see.
    await this.assertWorkspaceMember(user, groupId);
    await this.ensureBuiltInAgents(groupId);

    const filters: Prisma.WorkspaceAgentWhereInput[] = [{ groupId }];
    filters.push(
      scope === 'archived'
        ? { status: WorkspaceAgentStatus.ARCHIVED }
        : { status: WorkspaceAgentStatus.ACTIVE },
    );
    if (scope === 'mine') filters.push({ ownerId: user.id });
    if (search?.trim()) {
      filters.push({ name: { contains: search.trim(), mode: 'insensitive' } });
    }
    // A personal agent is nobody else's business, whatever scope was asked for.
    filters.push({
      OR: [{ accessScope: AgentAccessScope.WORKSPACE }, { ownerId: user.id }],
    });

    const agents = await this.prisma.workspaceAgent.findMany({
      where: { AND: filters },
      orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
      include: {
        owner: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        _count: { select: { skills: true } },
      },
    });

    const [activity, runtimeKeys] = await Promise.all([
      this.activityByKey(groupId, agents.map((agent) => agent.key)),
      this.deployedRuntimeKeys(),
    ]);

    return {
      agents: agents.map((agent) => ({
        ...this.toListItem(agent, activity.get(agent.key)),
        // A built-in whose subagent is not deployed will fail at dispatch with an opaque empty
        // response. Surfacing it here turns that into something a human can act on.
        runtimeMissing: runtimeKeys ? !runtimeKeys.has(resolveRuntimeKey(agent)) : false,
      })),
      counts: await this.counts(user, groupId),
    };
  }

  private async counts(user: AuthUser, groupId: string) {
    const mineWhere = { groupId, status: WorkspaceAgentStatus.ACTIVE, ownerId: user.id };
    const visible: Prisma.WorkspaceAgentWhereInput = {
      groupId,
      status: WorkspaceAgentStatus.ACTIVE,
      OR: [{ accessScope: AgentAccessScope.WORKSPACE }, { ownerId: user.id }],
    };
    const [mine, all, archived] = await Promise.all([
      this.prisma.workspaceAgent.count({ where: mineWhere }),
      this.prisma.workspaceAgent.count({ where: visible }),
      this.prisma.workspaceAgent.count({
        where: { groupId, status: WorkspaceAgentStatus.ARCHIVED },
      }),
    ]);
    return { mine, all, archived };
  }

  /**
   * Status, runs and last-active, read from the invocations the runs themselves wrote.
   *
   * Nothing here is a field the console can set: an agent is "working" because it has an
   * invocation that started and has not finished, not because something marked it so.
   */
  private async activityByKey(groupId: string, keys: string[]): Promise<Map<string, AgentActivity>> {
    const result = new Map<string, AgentActivity>();
    if (keys.length === 0) return result;

    const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const scope: Prisma.ProviderInvocationWhereInput = {
      agent: { in: keys },
      project: { groupId },
    };

    const [totals, running, completed, latest] = await Promise.all([
      this.prisma.providerInvocation.groupBy({ by: ['agent'], where: scope, _count: { _all: true } }),
      this.prisma.providerInvocation.groupBy({
        by: ['agent'],
        where: { ...scope, status: ProviderInvocationStatus.STARTED, completedAt: null },
        _count: { _all: true },
      }),
      this.prisma.providerInvocation.groupBy({
        by: ['agent'],
        where: { ...scope, status: ProviderInvocationStatus.SUCCEEDED, completedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.providerInvocation.groupBy({
        by: ['agent'],
        where: scope,
        _max: { startedAt: true },
      }),
    ]);

    for (const key of keys) {
      result.set(key, {
        runs: totals.find((row) => row.agent === key)?._count._all ?? 0,
        running: running.find((row) => row.agent === key)?._count._all ?? 0,
        completedInWindow: completed.find((row) => row.agent === key)?._count._all ?? 0,
        lastActiveAt: latest.find((row) => row.agent === key)?._max.startedAt ?? null,
      });
    }
    return result;
  }

  /**
   * Written out rather than derived with GetPayload: the queries select a handful of owner
   * columns, and GetPayload<{ include: { owner: true } }> insists on the whole Profile.
   */
  private toListItem(
    agent: WorkspaceAgent & {
      owner: Pick<Profile, 'id' | 'fullName' | 'email' | 'avatarUrl'> | null;
      _count: { skills: number };
    },
    activity?: AgentActivity,
  ) {
    return {
      id: agent.id,
      key: agent.key,
      name: agent.name,
      description: agent.description,
      avatarEmoji: agent.avatarEmoji,
      status: agent.status,
      accessScope: agent.accessScope,
      isBuiltIn: agent.isBuiltIn,
      runtimeKey: resolveRuntimeKey(agent),
      model: agent.model,
      concurrency: agent.concurrency,
      skillCount: agent._count.skills,
      owner: agent.owner
        ? {
            id: agent.owner.id,
            fullName: agent.owner.fullName,
            email: agent.owner.email,
            avatarUrl: agent.owner.avatarUrl,
          }
        : null,
      runs: activity?.runs ?? 0,
      running: activity?.running ?? 0,
      lastActiveAt: activity?.lastActiveAt ?? null,
      updatedAt: agent.updatedAt,
    };
  }

  async findOne(user: AuthUser, id: string) {
    const agent = await this.prisma.workspaceAgent.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        _count: { select: { skills: true } },
        skills: {
          include: { skill: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    await this.assertWorkspaceMember(user, agent.groupId);
    this.assertVisible(user, agent);

    const activity = await this.activityByKey(agent.groupId, [agent.key]);
    const builtIn = BUILT_IN_AGENTS_BY_KEY.get(agent.key);

    const [recent, active] = await Promise.all([
      this.prisma.providerInvocation.findMany({
        where: { agent: agent.key, project: { groupId: agent.groupId }, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        take: 8,
        select: {
          id: true, nodeId: true, model: true, engine: true, status: true,
          startedAt: true, completedAt: true, inputTokens: true, outputTokens: true,
          project: { select: { id: true, companyName: true } },
        },
      }),
      this.prisma.providerInvocation.findMany({
        where: {
          agent: agent.key,
          project: { groupId: agent.groupId },
          status: ProviderInvocationStatus.STARTED,
          completedAt: null,
        },
        orderBy: { startedAt: 'desc' },
        take: 8,
        select: {
          id: true, nodeId: true, model: true, engine: true, startedAt: true,
          project: { select: { id: true, companyName: true } },
        },
      }),
    ]);

    const runtimeKeys = await this.deployedRuntimeKeys();

    return {
      ...this.toListItem(agent, activity.get(agent.key)),
      runtimeMissing: runtimeKeys ? !runtimeKeys.has(resolveRuntimeKey(agent)) : false,
      groupId: agent.groupId,
      instructions: agent.instructions,
      /** What the agent runs with today when `instructions` is null. Read-only context. */
      builtInPrompt: builtInPromptFor(agent.key) ?? null,
      usesBuiltInPrompt: !agent.instructions,
      builtIn: builtIn
        ? {
            stage: builtIn.stage,
            node: builtIn.node ?? null,
            dispatchedBy: builtIn.dispatchedBy ?? null,
            plannedAs: builtIn.plannedAs ?? null,
            tools: builtIn.tools,
            condition: builtIn.condition ?? null,
          }
        : null,
      skills: agent.skills.map((link) => ({
        id: link.skill.id,
        slug: link.skill.slug,
        name: link.skill.name,
        description: link.skill.description,
        body: link.skill.body,
      })),
      activity: {
        completedInWindow: activity.get(agent.key)?.completedInWindow ?? 0,
        windowDays: ACTIVITY_WINDOW_DAYS,
        active,
        recent,
      },
      createdAt: agent.createdAt,
    };
  }

  async create(user: AuthUser, dto: CreateAgentDto) {
    await this.assertWorkspaceMember(user, dto.groupId);
    const name = dto.name.trim();
    const key = await this.uniqueKey(dto.groupId, name);

    const agent = await this.prisma.workspaceAgent.create({
      data: {
        key,
        name,
        description: dto.description?.trim() || null,
        avatarEmoji: dto.avatarEmoji?.trim() || '🤖',
        instructions: dto.instructions?.trim() || null,
        model: dto.model?.trim() || null,
        // A custom agent borrows a deployed capability; it cannot invent one, because tools are
        // code. Defaults to the reviewer runtime, which has no repository access — the safer of
        // the two to get by accident.
        runtimeKey: dto.runtimeKey ?? GENERIC_RUNTIMES[1].key,
        concurrency: dto.concurrency ?? 1,
        accessScope: dto.accessScope ?? AgentAccessScope.WORKSPACE,
        groupId: dto.groupId,
        ownerId: user.id,
        isBuiltIn: false,
      },
    });
    this.logger.log(`Created agent ${agent.id} (${agent.key}) in group ${dto.groupId}`);
    return this.findOne(user, agent.id);
  }

  /** Slug of the name, suffixed only when it would collide inside the workspace. */
  private async uniqueKey(groupId: string, name: string): Promise<string> {
    const base =
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';
    const taken = await this.prisma.workspaceAgent.findMany({
      where: { groupId, key: { startsWith: base } },
      select: { key: true },
    });
    if (!taken.some((agent) => agent.key === base)) return base;
    for (let suffix = 2; suffix < 500; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.some((agent) => agent.key === candidate)) return candidate;
    }
    throw new BadRequestException('Could not derive a unique agent key from that name');
  }

  async update(user: AuthUser, id: string, dto: UpdateAgentDto) {
    const existing = await this.prisma.workspaceAgent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Agent ${id} not found`);
    await this.assertWorkspaceMember(user, existing.groupId);
    this.assertVisible(user, existing);
    this.assertWritable(user, existing);

    await this.prisma.workspaceAgent.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.avatarEmoji !== undefined ? { avatarEmoji: dto.avatarEmoji.trim() || null } : {}),
        // An empty string is "go back to the built-in prompt", which is why it maps to null
        // rather than being ignored as a no-op.
        ...(dto.instructions !== undefined ? { instructions: dto.instructions.trim() || null } : {}),
        ...(dto.model !== undefined ? { model: dto.model.trim() || null } : {}),
        // Built-ins are dispatched by key by the pipeline nodes; repointing one at another
        // runtime would silently change what executes a contractual role.
        ...(dto.runtimeKey !== undefined && !existing.isBuiltIn
          ? { runtimeKey: dto.runtimeKey.trim() || null }
          : {}),
        ...(dto.concurrency !== undefined ? { concurrency: dto.concurrency } : {}),
        ...(dto.accessScope !== undefined ? { accessScope: dto.accessScope } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });
    return this.findOne(user, id);
  }

  /**
   * Custom agents are deleted; built-ins are archived.
   *
   * The pipeline dispatches built-ins by key, so removing the row would not tidy the roster, it
   * would leave a run resolving a prompt for an agent that no longer exists. Archiving keeps the
   * key resolvable and takes it off the active list, which is what "delete" means here.
   */
  async remove(user: AuthUser, id: string) {
    const existing = await this.prisma.workspaceAgent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Agent ${id} not found`);
    await this.assertWorkspaceMember(user, existing.groupId);
    this.assertVisible(user, existing);
    this.assertWritable(user, existing);

    if (existing.isBuiltIn) {
      await this.prisma.workspaceAgent.update({
        where: { id },
        data: { status: WorkspaceAgentStatus.ARCHIVED },
      });
      return { id, archived: true, deleted: false };
    }

    await this.prisma.workspaceAgent.delete({ where: { id } });
    return { id, archived: false, deleted: true };
  }

  private assertVisible(user: AuthUser, agent: { accessScope: AgentAccessScope; ownerId: string | null }) {
    if (agent.accessScope === AgentAccessScope.WORKSPACE) return;
    if (agent.ownerId === user.id || user.role === UserRole.ADMIN) return;
    throw new NotFoundException('Agent not found');
  }

  private assertWritable(user: AuthUser, agent: { ownerId: string | null; accessScope: AgentAccessScope }) {
    if (user.role === UserRole.ADMIN) return;
    // A personal agent is only its owner's to change. Workspace agents are the workspace's.
    if (agent.accessScope === AgentAccessScope.PERSONAL && agent.ownerId !== user.id) {
      throw new ForbiddenException('This agent belongs to another member');
    }
  }

  /**
   * The capability profiles a custom agent can be pointed at.
   *
   * Annotated with `deployed` so the console can show an option that will not work yet rather
   * than hiding it and leaving the absence unexplained.
   */
  async listRuntimes() {
    const deployed = await this.deployedRuntimeKeys();
    return {
      runtimes: GENERIC_RUNTIMES.map((runtime) => ({
        ...runtime,
        deployed: deployed ? deployed.has(runtime.key) : null,
      })),
    };
  }

  // ---------------------------------------------------------------- skills

  async listSkills(user: AuthUser, groupId: string, search?: string) {
    if (!groupId) throw new BadRequestException('groupId is required');
    await this.assertWorkspaceMember(user, groupId);
    const where: Prisma.AgentSkillWhereInput = {
      groupId,
      ...(search?.trim() ? { name: { contains: search.trim(), mode: 'insensitive' } } : {}),
    };
    const skills = await this.prisma.agentSkill.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { agents: true } } },
    });
    return {
      skills: skills.map((skill) => ({
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        agentCount: skill._count.agents,
        updatedAt: skill.updatedAt,
      })),
    };
  }

  async createSkill(user: AuthUser, dto: CreateAgentSkillDto) {
    await this.assertWorkspaceMember(user, dto.groupId);
    const name = dto.name.trim();
    const slug = await this.uniqueSkillSlug(dto.groupId, name);
    return this.prisma.agentSkill.create({
      data: {
        slug,
        name,
        description: dto.description?.trim() || null,
        body: dto.body,
        groupId: dto.groupId,
        createdById: user.id,
      },
    });
  }

  private async uniqueSkillSlug(groupId: string, name: string): Promise<string> {
    const base =
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
    const taken = await this.prisma.agentSkill.findMany({
      where: { groupId, slug: { startsWith: base } },
      select: { slug: true },
    });
    if (!taken.some((skill) => skill.slug === base)) return base;
    for (let suffix = 2; suffix < 500; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.some((skill) => skill.slug === candidate)) return candidate;
    }
    throw new BadRequestException('Could not derive a unique skill slug from that name');
  }

  async updateSkill(user: AuthUser, id: string, dto: UpdateAgentSkillDto) {
    const existing = await this.prisma.agentSkill.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Skill ${id} not found`);
    await this.assertWorkspaceMember(user, existing.groupId);
    return this.prisma.agentSkill.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.body !== undefined ? { body: dto.body } : {}),
      },
    });
  }

  async removeSkill(user: AuthUser, id: string) {
    const existing = await this.prisma.agentSkill.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Skill ${id} not found`);
    await this.assertWorkspaceMember(user, existing.groupId);
    // Assignments cascade, so detaching from every agent is implicit.
    await this.prisma.agentSkill.delete({ where: { id } });
    return { id, deleted: true };
  }

  async attachSkill(user: AuthUser, agentId: string, skillId: string) {
    const [agent, skill] = await Promise.all([
      this.prisma.workspaceAgent.findUnique({ where: { id: agentId } }),
      this.prisma.agentSkill.findUnique({ where: { id: skillId } }),
    ]);
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    if (!skill) throw new NotFoundException(`Skill ${skillId} not found`);
    if (skill.groupId !== agent.groupId) {
      throw new BadRequestException('That skill belongs to a different workspace');
    }
    await this.assertWorkspaceMember(user, agent.groupId);
    this.assertWritable(user, agent);

    await this.prisma.agentSkillOnAgent.createMany({
      data: [{ agentId, skillId }],
      skipDuplicates: true,
    });
    return this.findOne(user, agentId);
  }

  async detachSkill(user: AuthUser, agentId: string, skillId: string) {
    const agent = await this.prisma.workspaceAgent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    await this.assertWorkspaceMember(user, agent.groupId);
    this.assertWritable(user, agent);

    await this.prisma.agentSkillOnAgent.deleteMany({ where: { agentId, skillId } });
    return this.findOne(user, agentId);
  }

  // ------------------------------------------------- dispatch-time resolution

  /**
   * The system prompt the orchestration should actually send.
   *
   * Called by the agent nodes instead of reading their compiled-in constant directly, which is
   * what makes the Instructions field real rather than decorative. Falls back to the built-in
   * whenever the workspace has no row, no override, or the lookup fails — a database problem
   * must degrade a run to default behaviour, never stop it.
   */
  async resolveSystemPrompt(groupId: string | null | undefined, key: string, fallback: string): Promise<string> {
    if (!groupId) return fallback;

    try {
      const agent = await this.prisma.workspaceAgent.findUnique({
        where: { groupId_key: { groupId, key } },
        include: { skills: { include: { skill: true }, orderBy: { createdAt: 'asc' } } },
      });
      if (!agent) return fallback;

      const base = agent.instructions?.trim() || fallback;
      if (agent.skills.length === 0) return base;

      // Skills are appended, never substituted: they teach conventions on top of the role, and
      // a skill that could silently replace the role would be a foot-gun with no warning.
      const skillBlock = agent.skills
        .map((link) => `### ${link.skill.name}\n${link.skill.body.trim()}`)
        .join('\n\n');
      return `${base}\n\n## Skills\n${skillBlock}`;
    } catch (error) {
      this.logger.warn(
        `Falling back to the built-in prompt for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }
}
