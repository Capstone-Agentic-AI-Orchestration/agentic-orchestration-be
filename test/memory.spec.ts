import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryService } from '../src/memory/memory.service';
import { EmbeddingService } from '../src/memory/embedding.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
};

const MOCK_VECTOR = Array.from({ length: 1536 }, (_, i) => i / 1536);

let mockEmbeddingService: EmbeddingService;

function freshEmbeddingMock(): EmbeddingService {
  return { embed: vi.fn().mockResolvedValue(MOCK_VECTOR) } as unknown as EmbeddingService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryService', () => {
  let service: MemoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingService = freshEmbeddingMock();
    service = new MemoryService(mockPrisma as never, mockEmbeddingService);
  });

  describe('readRelevant', () => {
    it('returns formatted memory records on success', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-1',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'FILE: src/users/users.service.ts\n...',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.95,
        },
      ]);

      const results = await service.readRelevant('backend', 'NestJS CRUD users');

      expect(results).toHaveLength(1);
      expect(results[0].memoryType).toBe('SKILL');
      expect(results[0].similarity).toBeCloseTo(0.95);
      expect(mockEmbeddingService.embed).toHaveBeenCalledWith('NestJS CRUD users');
    });

    it('returns empty array and does not throw on DB error', async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('DB connection lost'));

      const results = await service.readRelevant('backend', 'some query');

      expect(results).toEqual([]);
    });
  });

  describe('readForAgent', () => {
    it('queries layered memory buckets for one agent and project', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.readForAgent({
        agentType: 'backend',
        projectId: 'project-1',
        query: 'NestJS Supabase dashboard',
      });

      expect(result.projectCore).toEqual([]);
      expect(result.projectAgent).toEqual([]);
      expect(result.agentPrivate).toEqual([]);
      expect(result.mistakes).toEqual([]);
      expect(result.globalPatterns).toEqual([]);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(5);
      expect(mockEmbeddingService.embed).toHaveBeenCalledTimes(1);
    });
  });

  describe('formatAsContext', () => {
    it('returns empty string for empty memories array', () => {
      expect(service.formatAsContext([])).toBe('');
    });

    it('formats SKILL memory as REFERENCE', () => {
      const memories = [
        {
          id: 'mem-1',
          agentType: 'backend',
          agentProfileId: null,
          scope: 'PROJECT_AGENT' as const,
          memoryType: 'SKILL' as const,
          content: 'FILE: src/users.service.ts\nsome content',
          metadata: {},
          projectId: null,
          sourceType: null,
          importance: 0.5,
          lastUsedAt: null,
          usageCount: 0,
          expiresAt: null,
          approvedAt: null,
          approvalSource: null,
          createdAt: new Date(),
          similarity: 0.9,
        },
      ];
      const context = service.formatAsContext(memories);
      expect(context).toContain('[REFERENCE 1]');
      expect(context).toContain('AGENT MEMORY CONTEXT');
    });

    it('formats MISTAKE memory as AVOID', () => {
      const memories = [
        {
          id: 'mem-2',
          agentType: 'backend',
          agentProfileId: null,
          scope: 'PROJECT_AGENT' as const,
          memoryType: 'MISTAKE' as const,
          content: 'Missing auth guards',
          metadata: {},
          projectId: null,
          sourceType: null,
          importance: 0.5,
          lastUsedAt: null,
          usageCount: 0,
          expiresAt: null,
          approvedAt: null,
          approvalSource: null,
          createdAt: new Date(),
          similarity: 0.85,
        },
      ];
      const context = service.formatAsContext(memories);
      expect(context).toContain('[AVOID 1]');
    });

    it('formats layered memory with project core separated from private memory', () => {
      const context = service.formatLayeredContext({
        projectCore: [
          {
            id: 'core-1',
            agentType: 'project_core',
            agentProfileId: null,
            scope: 'PROJECT_CORE',
            memoryType: 'PATTERN',
            content: 'APPROVED ARCHITECTURE CONTRACT',
            metadata: {},
            projectId: 'project-1',
            sourceType: 'gate_1_approved_contract',
            importance: 1,
            lastUsedAt: null,
            usageCount: 0,
            expiresAt: null,
            approvedAt: new Date(),
            approvalSource: 'GATE_1',
            createdAt: new Date(),
            similarity: 0.91,
          },
        ],
        projectAgent: [],
        agentPrivate: [],
        mistakes: [],
        globalPatterns: [],
      });

      expect(context).toContain('SHARED PROJECT TRUTH');
      expect(context).toContain('APPROVED ARCHITECTURE CONTRACT');
    });
  });

  describe('writeMistake', () => {
    it('calls writeMemory with MISTAKE type', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      await service.writeMistake({
        agentType: 'backend',
        rejectedContent: 'bad code',
        rejectionNotes: 'Missing auth guards',
        projectId: 'proj-1',
        gateType: 'GATE_2',
        stackKey: 'nestjs-next',
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.embed).toHaveBeenCalledTimes(1);
    });

    it('does not throw if DB insert fails', async () => {
      mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('insert failed'));

      await expect(
        service.writeMistake({
          agentType: 'frontend',
          rejectedContent: 'content',
          rejectionNotes: 'reason',
          projectId: 'proj-1',
          gateType: 'GATE_1',
          stackKey: 'nextjs',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('writeProjectCoreMemory', () => {
    it('requires a human approval source before writing project core memory', async () => {
      await expect(
        service.writeProjectCoreMemory({
          projectId: 'project-1',
          content: 'unapproved shared truth',
          sourceType: 'test',
          approvalSource: 'SYSTEM' as never,
        }),
      ).rejects.toThrow('Project core memory requires human approval');

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('writes project core memory when approved by a gate', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      await service.writeProjectCoreMemory({
        projectId: 'project-1',
        content: 'approved shared truth',
        sourceType: 'gate_1_approved_contract',
        approvalSource: 'GATE_1',
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.embed).toHaveBeenCalledWith('approved shared truth');
    });
  });

  describe('findSkipCandidate', () => {
    it('returns memory when similarity exceeds threshold and stackKey matches', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-3',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'FILE: src/users.service.ts\n...',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.95,
        },
      ]);

      const candidate = await service.findSkipCandidate(
        'backend',
        'src/users.service.ts nestjs-next',
        'nestjs-next',
      );

      expect(candidate).not.toBeNull();
      expect(candidate?.id).toBe('mem-3');
    });

    it('returns null when similarity is below threshold', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-4',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'some content',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.88, // below 0.92 threshold
        },
      ]);

      const candidate = await service.findSkipCandidate('backend', 'query', 'nestjs-next');
      expect(candidate).toBeNull();
    });
  });

  describe('writeSkill', () => {
    it('writes a SKILL memory with expected content', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      await service.writeSkill({
        agentType: 'backend',
        systemPrompt: '',
        artifactContent: 'export class UsersService {}',
        filePath: 'src/users.service.ts',
        projectId: 'proj-1',
        stackKey: 'nestjs-next',
        projectType: 'SaaS API',
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.embed).toHaveBeenCalled();
    });

    it('handles batch writeSkills across multiple artifacts', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);

      await service.writeSkills(
        [
          { agentType: 'frontend', filePath: 'src/page.tsx', content: 'export default function Page() {}', language: 'tsx', source: 'llm' },
          { agentType: 'backend', filePath: 'src/app.service.ts', content: 'export class AppService {}', language: 'ts', source: 'llm' },
        ],
        [
          { projectId: 'proj-1', stackKey: 'next-nest-pg', projectType: 'web app' },
          { projectId: 'proj-1', stackKey: 'next-nest-pg', projectType: 'web app' },
        ],
      );

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('writePattern', () => {
    it('writes a PATTERN memory with contract details', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      await service.writePattern({
        contract: {
          projectId: 'proj-1',
          projectName: 'Test',
          description: 'A test project',
          requirements: {
            projectType: 'web app',
            features: ['auth'],
            techStack: { frontend: 'Next.js', backend: 'NestJS', database: 'PostgreSQL', styling: 'Tailwind' },
            complexity: 'simple',
            estimatedFiles: 3,
          },
          fileManifest: ['src/main.ts'],
          acceptanceCriteria: ['frontend: login page'],
          lockedAt: new Date().toISOString(),
        },
        projectId: 'proj-1',
        stackKey: 'next-nest-pg',
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.embed).toHaveBeenCalled();
    });
  });

  describe('buildContextForAgent', () => {
    it('returns empty context when all layers are empty', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.buildContextForAgent({
        agentType: 'frontend',
        projectId: 'proj-1',
        query: 'some query',
      });

      expect(result.total).toBe(0);
      expect(result.context).toBe('');
      expect(result.layers.projectCore).toEqual([]);
    });

    it('returns layered context with memory from all buckets', async () => {
      const makeRow = (overrides: Record<string, unknown>) => ({
        id: 'mem-x',
        agentType: 'frontend',
        memoryType: 'SKILL',
        content: 'some skill content',
        metadata: {},
        projectId: 'proj-1',
        scope: 'PROJECT_CORE',
        createdAt: new Date(),
        similarity: 0.91,
        importance: 0.5,
        usageCount: 0,
        lastUsedAt: null,
        expiresAt: null,
        approvedAt: null,
        approvalSource: null,
        sourceType: 'agent_skill',
        agentProfileId: null,
        ...overrides,
      });

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([makeRow({ scope: 'PROJECT_CORE', memoryType: 'PATTERN', content: 'approved project truth', similarity: 0.95 })])
        .mockResolvedValueOnce([makeRow({ scope: 'PROJECT_AGENT', content: 'past agent work' })])
        .mockResolvedValueOnce([makeRow({ scope: 'AGENT_PRIVATE', content: 'private skill' })])
        .mockResolvedValueOnce([makeRow({ memoryType: 'MISTAKE', content: 'past mistake', similarity: 0.88 })])
        .mockResolvedValueOnce([makeRow({ scope: 'GLOBAL_PATTERN', content: 'global pattern', similarity: 0.90 })]);

      const result = await service.buildContextForAgent({
        agentType: 'frontend',
        projectId: 'proj-1',
        query: 'Next.js component auth',
      });

      expect(result.total).toBe(5);
      expect(result.context).toContain('SHARED PROJECT TRUTH');
      expect(result.context).toContain('MISTAKES TO AVOID');
      expect(result.context).toContain('GLOBAL APPROVED PATTERNS');
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(5);
    });

    it('gracefully handles embedding failure', async () => {
      mockEmbeddingService.embed.mockRejectedValueOnce(new Error('API error'));
      mockPrisma.$queryRaw.mockRejectedValue(new Error('DB error'));

      const result = await service.buildContextForAgent({
        agentType: 'frontend',
        projectId: 'proj-1',
        query: 'broken query',
      });

      expect(result.total).toBe(0);
      expect(result.context).toBe('');
    });
  });

  describe('validateSkipCandidate', () => {
    const baseCandidate = {
      id: 'cand-1',
      agentType: 'frontend',
      agentProfileId: null,
      scope: 'AGENT_PRIVATE' as const,
      memoryType: 'SKILL' as const,
      content: 'FILE: src/component.tsx\nSTACK: next-nest-pg\nTYPE: web app\n\nexport function LoginPage() { return <form><input /></form>; }',
      metadata: {},
      projectId: null,
      sourceType: 'agent_skill',
      importance: 0.6,
      lastUsedAt: null,
      usageCount: 0,
      expiresAt: null,
      approvedAt: new Date(),
      approvalSource: 'GATE_2',
      createdAt: new Date(),
      similarity: 0.95,
    };

    it('returns true when acceptance criteria is empty', () => {
      expect(service.validateSkipCandidate(baseCandidate, [])).toBe(true);
    });

    it('returns true when candidate content matches criteria keywords', () => {
      const criteria = ['frontend: login form must have email input', 'frontend: form must submit via POST'];
      expect(service.validateSkipCandidate(baseCandidate, criteria)).toBe(true);
    });

    it('returns false when candidate content does not match criteria', () => {
      const criteria = ['backend: stripe payment processing', 'database: audit logging schema'];
      expect(service.validateSkipCandidate(baseCandidate, criteria)).toBe(false);
    });
  });

  describe('pruneExpiredMemories', () => {
    it('returns count of pruned rows', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(5);
      const count = await service.pruneExpiredMemories();
      expect(count).toBe(5);
    });

    it('returns 0 when DB operation fails', async () => {
      mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('DB error'));
      const count = await service.pruneExpiredMemories();
      expect(count).toBe(0);
    });
  });

  describe('bumpUsageStats', () => {
    it('increments usageCount and updates lastUsedAt', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);
      await expect(service.bumpUsageStats('mem-1')).resolves.not.toThrow();
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('does not throw on DB failure', async () => {
      mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.bumpUsageStats('mem-1')).resolves.not.toThrow();
    });
  });

  describe('findSkipCandidate edge cases', () => {
    it('returns null when no results returned', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);
      const candidate = await service.findSkipCandidate('backend', 'some query', 'nestjs-next', 'proj-1');
      expect(candidate).toBeNull();
    });

    it('returns null when stackKey does not match', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-5',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'file content',
          metadata: { stackKey: 'other-stack' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.97,
        },
      ]);
      const candidate = await service.findSkipCandidate('backend', 'query', 'nestjs-next', 'proj-1');
      expect(candidate).toBeNull();
    });

    it('returns the best candidate when multiple match with progressive scoring', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-high-sim',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'high similarity low usage',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.93,
          usageCount: 0,
          lastUsedAt: new Date(Date.now() - 80 * 24 * 60 * 60 * 1000),
        },
        {
          id: 'mem-medium',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'medium similarity high usage',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.92,
          usageCount: 10,
          lastUsedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        },
      ]);
      const candidate = await service.findSkipCandidate('backend', 'query', 'nestjs-next', 'proj-1');
      expect(candidate).not.toBeNull();
      expect(candidate?.id).toBe('mem-medium');
    });
  });
});

describe('EmbeddingService', () => {
  describe('toSql', () => {
    it('serialises a vector to Postgres wire format', () => {
      const vector = [0.1, 0.2, 0.3];
      expect(EmbeddingService.toSql(vector)).toBe('[0.1,0.2,0.3]');
    });
  });
});
