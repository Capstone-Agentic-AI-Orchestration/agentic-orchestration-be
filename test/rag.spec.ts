import { describe, expect, it, vi } from 'vitest';
import { ContextCompressorService } from '../src/rag/context-compressor.service';
import { ContextRankerService } from '../src/rag/context-ranker.service';
import { HybridSearchService } from '../src/rag/hybrid-search.service';
import { RagAuditService } from '../src/rag/rag-audit.service';
import { RagContextPackBuilderService } from '../src/rag/rag-context-pack-builder.service';
import { RagIndexingService } from '../src/rag/rag-indexing.service';
import type { RetrievedContextItem } from '../src/rag/rag.types';

function item(overrides: Partial<RetrievedContextItem> = {}): RetrievedContextItem {
  return {
    id: 'chunk-1', projectId: 'project-a', sourceType: 'project', sourceId: 'source-1',
    content: 'Project requirement: build a secure dashboard.', importance: 8, isSuperseded: false,
    score: 0, scoreBreakdown: { keywordScore: 0.8 }, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('project-scoped RAG', () => {
  it('filters other projects and prioritizes the current run and work order', () => {
    const ranker = new ContextRankerService();
    const ranked = ranker.rank([
      item({ id: 'other', projectId: 'project-b', runId: 'run-a' }),
      item({ id: 'old', runId: 'run-old', workOrderId: 'order-old' }),
      item({ id: 'current', runId: 'run-a', workOrderId: 'order-a', workOrderExecutionId: 'execution-a' }),
      item({ id: 'stale', isSuperseded: true }),
    ], {
      projectId: 'project-a', runId: 'run-a', workOrderId: 'order-a', workOrderExecutionId: 'execution-a',
      agentName: 'backend', query: 'secure dashboard',
    });

    expect(ranked.map((result) => result.id)).toEqual(['current', 'old']);
    expect(ranked[0].scoreBreakdown.runRelevanceScore).toBe(30);
    expect(ranked[0].scoreBreakdown.workOrderRelevanceScore).toBe(25);
  });

  it('uses keyword search when embeddings are disabled and hybrid search when available', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{
      id: 'chunk-1', projectId: 'project-a', runId: null, workOrderId: null, workOrderExecutionId: null,
      agentName: 'backend', sourceType: 'artifact', sourceId: 'artifact-1', title: 'service.ts',
      content: 'NestJS dashboard service', summary: null, importance: 8, isSuperseded: false,
      createdAt: new Date(), score: 0.9,
    }]) };
    const disabled = new HybridSearchService(prisma as never, { tryEmbed: vi.fn().mockResolvedValue(null) } as never);
    const keyword = await disabled.search({ projectId: 'project-a', agentName: 'backend', query: 'dashboard' });
    expect(keyword.mode).toBe('keyword');
    expect(keyword.items).toHaveLength(1);

    const enabled = new HybridSearchService(prisma as never, { tryEmbed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)) } as never);
    const hybrid = await enabled.search({ projectId: 'project-a', agentName: 'backend', query: 'dashboard' });
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.items).toHaveLength(1);
  });

  it('indexes project, work-order, artifact, and memory records into chunks', async () => {
    const prisma = {
      ragChunk: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), upsert: vi.fn().mockResolvedValue({ id: 'chunk-1' }) },
      $executeRaw: vi.fn(),
    };
    const audit = { memoryUpdated: vi.fn().mockResolvedValue(undefined) };
    const service = new RagIndexingService(prisma as never, { tryEmbed: vi.fn().mockResolvedValue(null) } as never, audit as never);
    for (const sourceType of ['project', 'work_order', 'artifact', 'agent_memory'] as const) {
      await service.indexRecord({ projectId: 'project-a', sourceType, sourceId: sourceType, content: `${sourceType} relevant project context`, importance: 7 });
    }
    expect(prisma.ragChunk.upsert).toHaveBeenCalledTimes(4);
    expect(audit.memoryUpdated).toHaveBeenCalledTimes(4);
  });

  it('builds a compact context pack containing the active work order and prior fixes', async () => {
    const retrieval = { retrieve: vi.fn().mockResolvedValue({
      mode: 'keyword',
      items: [
        item({ id: 'requirement', sourceType: 'project', content: 'The client requires accessible project dashboards.' }),
        item({ id: 'error', sourceType: 'error', content: 'Previous fix: validate Supabase input before persistence.' }),
        item({ id: 'artifact', sourceType: 'artifact', title: 'projects.service.ts', content: 'Existing project service artifact.' }),
      ],
    }) };
    const prisma = { workOrder: { findFirst: vi.fn().mockResolvedValue({
      title: 'Add project search', instructions: 'Return a typed NestJS search endpoint.', agentType: 'BACKEND',
      task: { description: 'Implement project-scoped search.' },
    }) } };
    const audit = { contextPackCreated: vi.fn().mockResolvedValue(undefined) };
    const builder = new RagContextPackBuilderService(prisma as never, retrieval as never, new ContextCompressorService(), audit as never);
    const pack = await builder.build({ projectId: 'project-a', workOrderId: 'order-a', agentName: 'backend', query: 'project search', maxContextChars: 900 });

    expect(pack.currentObjective.title).toBe('Add project search');
    expect(pack.retrievedErrorsAndFixes).toHaveLength(1);
    expect(pack.retrievedArtifacts).toHaveLength(1);
    expect(pack.meta.chunksUsed).toBeLessThanOrEqual(pack.meta.chunksRetrieved);
    expect(audit.contextPackCreated).toHaveBeenCalledOnce();
  });

  it('enforces the context budget while retaining high-value work-order content', () => {
    const result = new ContextCompressorService().compress([
      item({ sourceType: 'work_order', content: 'Required objective '.repeat(100) }),
      item({ id: 'event', sourceType: 'event_log', content: 'Noisy event '.repeat(100) }),
    ], 500);
    expect(result.usedChars).toBeLessThanOrEqual(550);
    expect(result.items[0]?.sourceType).toBe('work_order');
  });

  it('writes safe lifecycle audit events and emits only RAG telemetry', async () => {
    const prisma = { eventLog: { create: vi.fn().mockResolvedValue({}) } };
    const gateway = { emitRagContextCreated: vi.fn(), emitRagMemoryUpdated: vi.fn() };
    const audit = new RagAuditService(prisma as never, gateway as never);
    await audit.contextPackCreated('project-a', {
      agentName: 'backend', mode: 'keyword', chunksRetrieved: 3, chunksUsed: 2, contextChars: 800, chunkIds: ['a', 'b'],
    });
    await audit.memoryUpdated('project-a', { sourceType: 'artifact', chunks: 1 });
    expect(prisma.eventLog.create).toHaveBeenCalledTimes(2);
    expect(gateway.emitRagContextCreated).toHaveBeenCalledWith('project-a', expect.objectContaining({ chunksUsed: 2 }));
    expect(gateway.emitRagMemoryUpdated).toHaveBeenCalledWith('project-a', expect.objectContaining({ sourceType: 'artifact' }));
  });
});
