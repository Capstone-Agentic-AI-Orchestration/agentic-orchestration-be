import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RepositoryKind, RepositoryStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService, type GithubTreeEntry } from '../github/github.service';

/** How long a minted turn token stays valid. Long enough for a slow agent turn, short enough
 *  that a leaked token in a log is useless by the time anyone finds it. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** Hard ceiling on calls per token, so a looping agent cannot hammer the GitHub API. */
const MAX_USES_PER_SESSION = 400;

const MAX_WRITE_FILES = 60;
const MAX_WRITE_BYTES = 1_500_000;

export interface AgentRepoScope {
  sessionId: string;
  runId: string;
  projectId: string;
  branch: string;
  agentType: string;
  repositories: Array<{ id: string; name: string; kind: RepositoryKind; stack: string | null }>;
}

export interface MintedAgentRepoSession {
  token: string;
  branch: string;
  expiresAt: Date;
  repositories: Array<{ kind: RepositoryKind; name: string; stack: string | null }>;
}

/**
 * Issues and enforces the capability tokens that let the external agent service read and write
 * a project's repositories.
 *
 * The security property this service exists to guarantee: **repository scope is derived from the
 * database, never from the caller.** A token resolves to a projectId, and every read/write is
 * restricted to repositories belonging to that project. The agent picks a repo by `kind`
 * (backend/frontend/mobile), not by name, so it cannot address a repository outside its project
 * even if the model emits one.
 */
@Injectable()
export class AgentRepoService {
  private readonly logger = new Logger(AgentRepoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
  ) {}

  /** True when the agent service is allowed to call back at all. */
  isEnabled(): boolean {
    return Boolean(process.env.AGENT_REPO_SERVICE_TOKEN?.trim());
  }

  /**
   * Verifies the shared service secret presented by the agent service. This authenticates the
   * *service*; the per-turn token below authorizes the *project scope*. Both are required.
   */
  assertServiceAuthorized(header: string | undefined): void {
    const expected = process.env.AGENT_REPO_SERVICE_TOKEN?.trim();
    if (!expected) {
      throw new ForbiddenException('Agent repository access is not enabled');
    }
    const presented = (header ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!presented || presented !== expected) {
      throw new ForbiddenException('Invalid agent service credentials');
    }
  }

  /** Mints a turn-scoped token for one agent's turn on one run. */
  async mintSession(params: {
    runId: string;
    projectId: string;
    agentType: string;
    branch: string;
  }): Promise<MintedAgentRepoSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await this.prisma.agentRepoSession.create({
      data: {
        token,
        runId: params.runId,
        projectId: params.projectId,
        agentType: params.agentType,
        branch: params.branch,
        expiresAt,
      },
    });

    const repositories = await this.prisma.repository.findMany({
      where: { projectId: params.projectId },
      select: { kind: true, name: true, stack: true },
    });

    return { token, branch: params.branch, expiresAt, repositories };
  }

  /** Revokes every token issued for a run — called when the run ends. */
  async revokeForRun(runId: string): Promise<void> {
    await this.prisma.agentRepoSession
      .updateMany({
        where: { runId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined);
  }

  /**
   * Resolves a presented token to its project scope, rejecting expired, revoked, or
   * over-used tokens. Every request from the agent service passes through here.
   */
  async resolveScope(token: string | undefined): Promise<AgentRepoScope> {
    const value = (token ?? '').trim();
    if (!value) throw new ForbiddenException('Missing agent repository token');

    const session = await this.prisma.agentRepoSession.findUnique({
      where: { token: value },
      select: {
        id: true,
        runId: true,
        projectId: true,
        branch: true,
        agentType: true,
        expiresAt: true,
        revokedAt: true,
        useCount: true,
      },
    });

    if (!session) throw new ForbiddenException('Unknown agent repository token');
    if (session.revokedAt) throw new ForbiddenException('Agent repository token has been revoked');
    if (session.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException('Agent repository token has expired');
    }
    if (session.useCount >= MAX_USES_PER_SESSION) {
      throw new ForbiddenException('Agent repository token exceeded its call budget');
    }

    const repositories = await this.prisma.repository.findMany({
      where: { projectId: session.projectId },
      select: { id: true, name: true, kind: true, stack: true, status: true },
    });

    await this.prisma.agentRepoSession
      .update({
        where: { id: session.id },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      })
      .catch(() => undefined);

    return {
      sessionId: session.id,
      runId: session.runId,
      projectId: session.projectId,
      branch: session.branch,
      agentType: session.agentType,
      repositories: repositories
        .filter((repo) => repo.status === RepositoryStatus.ACTIVE)
        .map(({ id, name, kind, stack }) => ({ id, name, kind, stack })),
    };
  }

  /**
   * Maps a requested repository *kind* to a concrete repo inside the token's project.
   *
   * Taking a kind rather than a repository name is what makes cross-project access
   * unrepresentable: there is no input an agent could supply that names someone else's repo.
   */
  private repoFor(scope: AgentRepoScope, kind: string): { name: string; kind: RepositoryKind } {
    const wanted = String(kind ?? '').trim().toUpperCase();
    if (!(wanted in RepositoryKind)) {
      throw new BadRequestException(
        `Unknown repository kind "${kind}". Expected one of: ${Object.keys(RepositoryKind).join(', ')}`,
      );
    }
    const match = scope.repositories.find((repo) => repo.kind === wanted);
    if (!match) {
      throw new NotFoundException(
        `This project has no active ${wanted} repository. Available: ${
          scope.repositories.map((r) => r.kind).join(', ') || 'none'
        }`,
      );
    }
    return { name: match.name, kind: match.kind };
  }

  async listFiles(scope: AgentRepoScope, kind: string): Promise<{ repository: string; files: GithubTreeEntry[]; truncated: boolean }> {
    const repo = this.repoFor(scope, kind);
    // Read from the run branch when it exists so an agent sees its own earlier writes;
    // listFiles falls back to the default branch for the first read of a run.
    const { entries, truncated } = await this.github
      .listFiles(repo.name, scope.branch)
      .catch(() => this.github.listFiles(repo.name));
    return { repository: repo.name, files: entries, truncated };
  }

  async readFile(scope: AgentRepoScope, kind: string, filePath: string): Promise<{ repository: string; path: string; content: string | null }> {
    const repo = this.repoFor(scope, kind);
    const path = this.assertSafePath(filePath);
    const file = await this.github
      .readFile(repo.name, path, scope.branch)
      .catch(() => this.github.readFile(repo.name, path));
    return { repository: repo.name, path, content: file?.content ?? null };
  }

  /**
   * Writes files to the run's branch. Never the default branch — delivery is reviewed via the
   * pull request opened at the end of the run.
   */
  async writeFiles(
    scope: AgentRepoScope,
    kind: string,
    files: Array<{ filePath: string; content: string }>,
    message?: string,
  ): Promise<{ repository: string; branch: string; commitSha: string; written: string[] }> {
    const repo = this.repoFor(scope, kind);

    if (!Array.isArray(files) || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }
    if (files.length > MAX_WRITE_FILES) {
      throw new BadRequestException(`A single write may contain at most ${MAX_WRITE_FILES} files`);
    }

    let totalBytes = 0;
    const seen = new Set<string>();
    const prepared = files.map((file) => {
      const filePath = this.assertSafePath(file.filePath);
      if (seen.has(filePath)) throw new BadRequestException(`Duplicate file path: ${filePath}`);
      seen.add(filePath);
      const content = typeof file.content === 'string' ? file.content : '';
      totalBytes += Buffer.byteLength(content, 'utf8');
      return { filePath, content };
    });
    if (totalBytes > MAX_WRITE_BYTES) {
      throw new BadRequestException(`Write payload exceeds ${MAX_WRITE_BYTES} bytes`);
    }

    const commitMessage = (message ?? '').trim() ||
      `feat(${scope.agentType}): agent update [run:${scope.runId}]`;

    const { commitSha, branch } = await this.github.commitFilesToBranch(
      repo.name,
      scope.branch,
      prepared,
      commitMessage,
    );

    this.logger.log(
      `[${scope.projectId}] ${scope.agentType} wrote ${prepared.length} file(s) to ${repo.name}@${branch}`,
    );

    return { repository: repo.name, branch, commitSha, written: prepared.map((f) => f.filePath) };
  }

  /** Rejects absolute paths, drive letters, and traversal segments. */
  private assertSafePath(filePath: string): string {
    const value = String(filePath ?? '').trim().replace(/\\/g, '/');
    const segments = value.split('/');
    if (
      value.length === 0 ||
      value.startsWith('/') ||
      /^[A-Za-z]:/.test(value) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new BadRequestException(`Unsafe repository path: ${filePath}`);
    }
    return value;
  }
}
