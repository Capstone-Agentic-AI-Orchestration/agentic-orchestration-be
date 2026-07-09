import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMemoryController } from '../src/context-memory/context-memory.controller';
import { ContextMemoryService } from '../src/context-memory/context-memory.service';

const now = new Date('2026-07-09T08:00:00.000Z');

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  projectId: 'project-1',
  runId: 'run-1',
  agentType: 'backend',
  type: 'decision',
  title: 'Approved stack',
  content: 'Use NestJS, Supabase, and project membership guards for artifact APIs.',
  importance: 1,
  tags: ['auth', 'backend'],
  artifact: null,
  progress: null,
  metadata: {},
  hash: 'hash-1',
  createdAt: now,
  ...overrides,
});

describe('ContextMemoryService', () => {
  let prisma: {
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let service: ContextMemoryService;

  beforeEach(() => {
    prisma = {
      $queryRaw: vi.fn(),
    };
    service = new ContextMemoryService(prisma as never);
  });

  it('records a typed memory event and returns the normalized row', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      row({
        type: 'error',
        title: 'Missing guard',
        content: 'Backend missed Supabase membership checks.',
        importance: 0.95,
        tags: ['auth'],
      }),
    ]);

    const result = await service.record({
      projectId: 'project-1',
      runId: 'run-1',
      agentType: 'backend',
      type: 'error',
      title: 'Missing guard',
      content: 'Backend missed Supabase membership checks.',
      importance: 0.95,
      tags: ['auth'],
    });

    expect(result.type).toBe('error');
    expect(result.title).toBe('Missing guard');
    expect(result.tags).toEqual(['auth']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('builds a budgeted context pack with decisions, handoffs, errors, artifacts, and progress', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      row(),
      row({
        id: 'mem-2',
        type: 'handoff',
        title: 'Frontend needs artifact language',
        content: 'Frontend expects artifact responses to include language and source fields.',
        agentType: 'frontend',
        importance: 0.8,
        tags: ['api'],
      }),
      row({
        id: 'mem-3',
        type: 'error',
        title: 'Avoid missing guards',
        content: 'Previous backend output missed project membership checks.',
        importance: 0.95,
        tags: ['auth', 'backend'],
      }),
      row({
        id: 'mem-4',
        type: 'artifact',
        title: 'Artifact route draft',
        content: 'Draft route is GET /projects/:id/artifacts.',
        artifact: { path: 'src/projects/projects.controller.ts', kind: 'route' },
      }),
      row({
        id: 'mem-5',
        type: 'progress_event',
        title: 'Backend running',
        content: 'Backend agent is generating service methods.',
        progress: { status: 'running', node: 'backend_agent', percent: 45 },
      }),
    ]);

    const pack = await service.buildContextPack({
      projectId: 'project-1',
      runId: 'run-1',
      agentType: 'backend',
      task: 'Implement artifact API with Supabase project authorization guards',
      maxChars: 2000,
    });

    expect(pack.text.length).toBeLessThanOrEqual(2000);
    expect(pack.text).toContain('MEMORY CONTEXT PACK');
    expect(pack.text).toContain('Critical Decisions');
    expect(pack.text).toContain('Handoffs');
    expect(pack.text).toContain('Errors To Avoid');
    expect(pack.text).toContain('Artifacts');
    expect(pack.text).toContain('Live Progress');
    expect(pack.included.error).toContain('mem-3');
  });

  it('searches project memory using deterministic ranking', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      row({
        id: 'mem-auth',
        type: 'error',
        title: 'Auth guard failure',
        content: 'Backend generated artifact routes without Supabase authorization guards.',
        importance: 0.9,
        tags: ['auth', 'backend'],
      }),
      row({
        id: 'mem-ui',
        agentType: 'frontend',
        type: 'artifact',
        title: 'Dashboard UI',
        content: 'Frontend adjusted responsive cards.',
        importance: 0.4,
        tags: ['ui'],
      }),
    ]);

    const results = await service.search({
      projectId: 'project-1',
      agentType: 'backend',
      query: 'Supabase authorization guard artifact API',
      tags: ['auth'],
      limit: 5,
    });

    expect(results[0].record.id).toBe('mem-auth');
    expect(results[0].score).toBeGreaterThan(0);
  });
});

describe('ContextMemoryController', () => {
  it('delegates HTTP-shaped requests to the service', async () => {
    const service = {
      record: vi.fn().mockResolvedValue(row()),
      buildContextPack: vi.fn().mockResolvedValue({ text: '# MEMORY CONTEXT PACK' }),
      search: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    };
    const idempotency = {
      requestHash: vi.fn(),
      run: vi.fn(),
    };
    const controller = new ContextMemoryController(service as never, idempotency as never);

    await expect(controller.record({
      projectId: 'project-1',
      type: 'decision',
      title: 'Approved stack',
      content: 'Use NestJS.',
    })).resolves.toMatchObject({ id: 'mem-1' });

    await controller.buildContextPack({
      projectId: 'project-1',
      agentType: 'backend',
      task: 'Build API',
    });

    await controller.search({
      projectId: 'project-1',
      query: 'auth',
    });

    await controller.listProjectEvents('project-1', { limit: 10 });

    expect(service.record).toHaveBeenCalledTimes(1);
    expect(service.buildContextPack).toHaveBeenCalledTimes(1);
    expect(service.search).toHaveBeenCalledTimes(1);
    expect(service.list).toHaveBeenCalledWith({ projectId: 'project-1', limit: 10 });
  });
});
