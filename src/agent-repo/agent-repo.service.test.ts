import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RepositoryKind, RepositoryStatus } from '@prisma/client';
import { AgentRepoService } from './agent-repo.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GithubService } from '../github/github.service';

const FUTURE = new Date(Date.now() + 60_000);
const PAST = new Date(Date.now() - 60_000);

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    runId: 'run-1',
    projectId: 'project-1',
    branch: 'run/run-1',
    agentType: 'run',
    expiresAt: FUTURE,
    revokedAt: null,
    useCount: 0,
    ...overrides,
  };
}

function makeService(sessionRow: unknown, repositories: unknown[] = []) {
  const prisma = {
    agentRepoSession: {
      findUnique: vi.fn().mockResolvedValue(sessionRow),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repository: {
      findMany: vi.fn().mockResolvedValue(repositories),
    },
  };
  const github = {
    listFiles: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    readFile: vi.fn().mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's', size: 1 }),
    commitFilesToBranch: vi.fn().mockResolvedValue({ commitSha: 'abc1234', branch: 'run/run-1' }),
  };
  const service = new AgentRepoService(
    prisma as unknown as PrismaService,
    github as unknown as GithubService,
  );
  return { service, prisma, github };
}

const ACTIVE_BACKEND = {
  id: 'r1',
  name: 'acme-be',
  kind: RepositoryKind.BACKEND,
  stack: 'nest',
  status: RepositoryStatus.ACTIVE,
};
const ACTIVE_FRONTEND = {
  id: 'r2',
  name: 'acme-fe',
  kind: RepositoryKind.FRONTEND,
  stack: 'next',
  status: RepositoryStatus.ACTIVE,
};

describe('AgentRepoService', () => {
  const original = process.env.AGENT_REPO_SERVICE_TOKEN;
  beforeEach(() => {
    process.env.AGENT_REPO_SERVICE_TOKEN = 'service-secret';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_REPO_SERVICE_TOKEN;
    else process.env.AGENT_REPO_SERVICE_TOKEN = original;
  });

  describe('service authentication', () => {
    it('accepts the configured shared secret with or without a Bearer prefix', () => {
      const { service } = makeService(makeSession());
      expect(() => service.assertServiceAuthorized('Bearer service-secret')).not.toThrow();
      expect(() => service.assertServiceAuthorized('service-secret')).not.toThrow();
    });

    it('rejects a wrong or missing secret', () => {
      const { service } = makeService(makeSession());
      expect(() => service.assertServiceAuthorized('Bearer nope')).toThrow(/Invalid agent service/);
      expect(() => service.assertServiceAuthorized(undefined)).toThrow(/Invalid agent service/);
    });

    it('refuses every caller when the feature is not configured', () => {
      delete process.env.AGENT_REPO_SERVICE_TOKEN;
      const { service } = makeService(makeSession());
      expect(() => service.assertServiceAuthorized('Bearer service-secret')).toThrow(/not enabled/);
    });
  });

  describe('token scope resolution', () => {
    it('resolves a live token to its project and active repositories', async () => {
      const { service } = makeService(makeSession(), [ACTIVE_BACKEND, ACTIVE_FRONTEND]);
      const scope = await service.resolveScope('tok');
      expect(scope.projectId).toBe('project-1');
      expect(scope.branch).toBe('run/run-1');
      expect(scope.repositories.map((r) => r.kind)).toEqual([
        RepositoryKind.BACKEND,
        RepositoryKind.FRONTEND,
      ]);
    });

    it('omits repositories that are not ACTIVE', async () => {
      const { service } = makeService(makeSession(), [
        ACTIVE_BACKEND,
        { ...ACTIVE_FRONTEND, status: RepositoryStatus.PENDING },
      ]);
      const scope = await service.resolveScope('tok');
      expect(scope.repositories.map((r) => r.kind)).toEqual([RepositoryKind.BACKEND]);
    });

    it('rejects missing, unknown, expired, revoked, and over-budget tokens', async () => {
      const unknown = makeService(null);
      await expect(unknown.service.resolveScope('tok')).rejects.toThrow(/Unknown/);
      await expect(unknown.service.resolveScope('')).rejects.toThrow(/Missing/);

      const expired = makeService(makeSession({ expiresAt: PAST }));
      await expect(expired.service.resolveScope('tok')).rejects.toThrow(/expired/);

      const revoked = makeService(makeSession({ revokedAt: new Date() }));
      await expect(revoked.service.resolveScope('tok')).rejects.toThrow(/revoked/);

      const spent = makeService(makeSession({ useCount: 10_000 }));
      await expect(spent.service.resolveScope('tok')).rejects.toThrow(/call budget/);
    });

    it('counts each use so a looping agent exhausts its budget', async () => {
      const { service, prisma } = makeService(makeSession(), [ACTIVE_BACKEND]);
      await service.resolveScope('tok');
      expect(prisma.agentRepoSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ useCount: { increment: 1 } }) }),
      );
    });
  });

  describe('repository scoping', () => {
    // The core security property: an agent names a KIND, and the backend resolves it against
    // the token's own project. No input can address another project's repository.
    it('resolves a kind to the repository belonging to the token project', async () => {
      const { service, github } = makeService(makeSession(), [ACTIVE_BACKEND, ACTIVE_FRONTEND]);
      const scope = await service.resolveScope('tok');
      await service.listFiles(scope, 'frontend');
      expect(github.listFiles).toHaveBeenCalledWith('acme-fe', 'run/run-1');
    });

    it('refuses a kind the project does not have', async () => {
      const { service } = makeService(makeSession(), [ACTIVE_BACKEND]);
      const scope = await service.resolveScope('tok');
      await expect(service.listFiles(scope, 'mobile')).rejects.toThrow(/no active MOBILE repository/);
    });

    it('refuses an unknown kind rather than guessing', async () => {
      const { service } = makeService(makeSession(), [ACTIVE_BACKEND]);
      const scope = await service.resolveScope('tok');
      await expect(service.listFiles(scope, 'acme-secret-repo')).rejects.toThrow(/Unknown repository kind/);
    });
  });

  describe('writes', () => {
    it('commits to the run branch, never the default branch', async () => {
      const { service, github } = makeService(makeSession(), [ACTIVE_BACKEND]);
      const scope = await service.resolveScope('tok');
      const result = await service.writeFiles(scope, 'backend', [
        { filePath: 'src/app.service.ts', content: 'export class AppService {}' },
      ]);

      expect(github.commitFilesToBranch).toHaveBeenCalledWith(
        'acme-be',
        'run/run-1',
        [{ filePath: 'src/app.service.ts', content: 'export class AppService {}' }],
        expect.stringContaining('run:run-1'),
      );
      expect(result.branch).toBe('run/run-1');
    });

    it.each([
      ['absolute path', '/etc/passwd'],
      ['traversal', '../../secrets.env'],
      ['windows drive', 'C:/Windows/system32'],
    ])('rejects an unsafe %s', async (_label, filePath) => {
      const { service, github } = makeService(makeSession(), [ACTIVE_BACKEND]);
      const scope = await service.resolveScope('tok');
      await expect(
        service.writeFiles(scope, 'backend', [{ filePath, content: 'x' }]),
      ).rejects.toThrow(/Unsafe repository path/);
      expect(github.commitFilesToBranch).not.toHaveBeenCalled();
    });

    it('rejects duplicate paths and empty payloads', async () => {
      const { service } = makeService(makeSession(), [ACTIVE_BACKEND]);
      const scope = await service.resolveScope('tok');
      await expect(service.writeFiles(scope, 'backend', [])).rejects.toThrow(/At least one file/);
      await expect(
        service.writeFiles(scope, 'backend', [
          { filePath: 'a.ts', content: 'x' },
          { filePath: 'a.ts', content: 'y' },
        ]),
      ).rejects.toThrow(/Duplicate file path/);
    });
  });

  describe('reads', () => {
    it('reports a missing file as null rather than throwing', async () => {
      const { service, github } = makeService(makeSession(), [ACTIVE_BACKEND]);
      github.readFile.mockResolvedValue(null);
      const scope = await service.resolveScope('tok');
      const result = await service.readFile(scope, 'backend', 'src/new-file.ts');
      expect(result.content).toBeNull();
    });
  });
});
