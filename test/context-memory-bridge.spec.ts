import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryService } from '../src/memory/memory.service';

const mockPrisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
};

const mockEmbedding = {
  embed: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0.1)),
};

describe('MemoryService context memory bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends the free context pack to existing layered memory context', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const contextMemory = {
      buildContextPack: vi.fn().mockResolvedValue({
        text: '# MEMORY CONTEXT PACK\n\n## Critical Decisions\n- Use Supabase.',
        included: { decision: ['ctx-1'] },
      }),
      record: vi.fn(),
    };
    const service = new MemoryService(
      mockPrisma as never,
      mockEmbedding as never,
      contextMemory as never,
    );

    const result = await service.buildContextForAgent({
      agentType: 'backend',
      projectId: 'project-1',
      query: 'Supabase auth guards',
    });

    expect(result.context).toContain('MEMORY CONTEXT PACK');
    expect(result.total).toBe(1);
    expect(contextMemory.buildContextPack).toHaveBeenCalledWith({
      projectId: 'project-1',
      agentType: 'backend',
      task: 'Supabase auth guards',
      maxChars: 8000,
    });
  });

  it('mirrors mistakes into context memory without making old memory writes fail', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(1);
    const contextMemory = {
      buildContextPack: vi.fn(),
      record: vi.fn().mockResolvedValue({ id: 'ctx-1' }),
    };
    const service = new MemoryService(
      mockPrisma as never,
      mockEmbedding as never,
      contextMemory as never,
    );

    await service.writeMistake({
      agentType: 'backend',
      rejectedContent: 'bad code',
      rejectionNotes: 'Missing project membership checks',
      projectId: 'project-1',
      gateType: 'GATE_2',
      stackKey: 'next-nest-pg',
    });

    expect(contextMemory.record).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      agentType: 'backend',
      type: 'error',
      title: 'backend GATE_2 rejection',
    }));
  });
});
