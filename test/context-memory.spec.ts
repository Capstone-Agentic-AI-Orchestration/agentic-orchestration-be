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
  status: 'active',
  pinned: false,
  expiresAt: null,
  archivedAt: null,
  lastAccessedAt: null,
  accessCount: 0,
  embedding: null,
  createdAt: now,
  ...overrides,
});

const handoffRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'handoff-1',
  projectId: 'project-1',
  runId: 'run-1',
  fromAgent: 'frontend',
  toAgent: 'backend',
  title: 'Frontend needs artifact language',
  content: 'Frontend expects artifact responses to include language and source fields.',
  artifact: { path: 'src/shared/api/devflow-api.ts', kind: 'api-contract' },
  status: 'open',
  acknowledgedAt: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'snapshot-1',
  projectId: 'project-1',
  runId: 'run-1',
  agentType: 'backend',
  taskHash: 'hash-task',
  task: 'Implement artifact API with Supabase project authorization guards',
  text: '# MEMORY CONTEXT PACK',
  includedEventIds: ['mem-1'],
  sourceEventMaxCreatedAt: now,
  sourceEventCount: 1,
  retrievalMode: 'hybrid',
  stalenessMs: 0,
  metadata: {},
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
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([snapshotRow()]);

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
    expect(pack.freshness.retrievalMode).toBe('hybrid');
    expect(pack.snapshotId).toBe('snapshot-1');
    expect(pack.included.error).toContain('mem-3');
  });

  it('uses a fresh cached snapshot when no newer memory exists', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      snapshotRow({
        sourceEventCount: 7,
        sourceEventMaxCreatedAt: now,
        stalenessMs: 10,
      }),
    ]);

    const pack = await service.buildContextPack({
      projectId: 'project-1',
      runId: 'run-1',
      agentType: 'backend',
      task: 'Implement artifact API with Supabase project authorization guards',
      maxChars: 2000,
      allowCached: true,
    });

    expect(pack.cacheHit).toBe(true);
    expect(pack.snapshotId).toBe('snapshot-1');
    expect(pack.freshness.includedEventCount).toBe(7);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('filters archived and expired memory out of retrieval', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      row({ id: 'active-memory', title: 'Active guard decision' }),
    ]);

    const results = await service.search({
      projectId: 'project-1',
      query: 'guard decision',
      limit: 5,
    });

    expect(results.map((result) => result.record.id)).toEqual(['active-memory']);
  });

  it('injects open handoffs addressed to the current agent into the context pack', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ id: 'mem-1' })])
      .mockResolvedValueOnce([handoffRow()])
      .mockResolvedValueOnce([snapshotRow({
        includedEventIds: ['mem-1', 'handoff:handoff-1'],
      })]);

    const pack = await service.buildContextPack({
      projectId: 'project-1',
      runId: 'run-1',
      agentType: 'backend',
      task: 'Implement artifact API',
      maxChars: 2000,
    });

    expect(pack.text).toContain('Frontend needs artifact language');
    expect(pack.included.handoff).toContain('handoff:handoff-1');
  });

  it('ranks semantically similar records with local free embeddings', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      row({
        id: 'semantic-match',
        title: 'Protect project files',
        content: 'Every artifact endpoint must verify project membership before returning source files.',
        tags: [],
      }),
      row({
        id: 'weak-match',
        title: 'Dashboard spacing',
        content: 'Adjust visual spacing in dashboard cards.',
        tags: [],
      }),
    ]);

    const results = await service.search({
      projectId: 'project-1',
      agentType: 'backend',
      query: 'authorization guard for artifacts',
      limit: 2,
    });

    expect(results[0].record.id).toBe('semantic-match');
    expect(results[0].reason.semanticScore).toBeGreaterThan(0);
  });

  it('creates, acknowledges, and resolves handoffs', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([handoffRow()])
      .mockResolvedValueOnce([handoffRow({ status: 'acknowledged', acknowledgedAt: now })])
      .mockResolvedValueOnce([handoffRow({ status: 'resolved', acknowledgedAt: now, resolvedAt: now })]);

    await expect(service.createHandoff({
      projectId: 'project-1',
      runId: 'run-1',
      fromAgent: 'frontend',
      toAgent: 'backend',
      title: 'Frontend needs artifact language',
      content: 'Frontend expects artifact responses to include language and source fields.',
      artifact: { path: 'src/shared/api/devflow-api.ts', kind: 'api-contract' },
    })).resolves.toMatchObject({ id: 'handoff-1', status: 'open' });

    await expect(service.acknowledgeHandoff('handoff-1')).resolves.toMatchObject({ status: 'acknowledged' });
    await expect(service.resolveHandoff('handoff-1')).resolves.toMatchObject({ status: 'resolved' });
  });

  it('compacts old run memory into a project summary event', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([
        row({ id: 'mem-1', type: 'decision', title: 'Decision A', content: 'Use Supabase auth.' }),
        row({ id: 'mem-2', type: 'error', title: 'Error B', content: 'Avoid missing membership checks.' }),
      ])
      .mockResolvedValueOnce([row({
        id: 'summary-1',
        type: 'project_memory',
        title: 'Run memory summary',
        content: 'Compacted summary',
      })]);

    const result = await service.compactProjectMemory({
      projectId: 'project-1',
      runId: 'run-1',
      maxEvents: 20,
    });

    expect(result.summary.type).toBe('project_memory');
    expect(result.compactedEventCount).toBe(2);
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
      createHandoff: vi.fn().mockResolvedValue(handoffRow()),
      acknowledgeHandoff: vi.fn().mockResolvedValue(handoffRow({ status: 'acknowledged' })),
      resolveHandoff: vi.fn().mockResolvedValue(handoffRow({ status: 'resolved' })),
      listHandoffs: vi.fn().mockResolvedValue([]),
      listSnapshots: vi.fn().mockResolvedValue([]),
      compactProjectMemory: vi.fn().mockResolvedValue({ compactedEventCount: 0 }),
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
    await controller.createHandoff({
      projectId: 'project-1',
      fromAgent: 'frontend',
      toAgent: 'backend',
      title: 'Need API contract',
      content: 'Return artifact source.',
    });
    await controller.acknowledgeHandoff('handoff-1');
    await controller.resolveHandoff('handoff-1');
    await controller.listProjectHandoffs('project-1', {});
    await controller.listProjectSnapshots('project-1', {});
    await controller.compactProjectMemory({
      projectId: 'project-1',
      runId: 'run-1',
    });

    expect(service.record).toHaveBeenCalledTimes(1);
    expect(service.buildContextPack).toHaveBeenCalledTimes(1);
    expect(service.search).toHaveBeenCalledTimes(1);
    expect(service.list).toHaveBeenCalledWith({ projectId: 'project-1', limit: 10 });
    expect(service.createHandoff).toHaveBeenCalledTimes(1);
    expect(service.acknowledgeHandoff).toHaveBeenCalledWith('handoff-1');
    expect(service.resolveHandoff).toHaveBeenCalledWith('handoff-1');
    expect(service.listHandoffs).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(service.listSnapshots).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(service.compactProjectMemory).toHaveBeenCalledTimes(1);
  });
});
