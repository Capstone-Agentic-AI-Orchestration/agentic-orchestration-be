import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamEmitter } from '../src/orchestration/streaming/stream-emitter.service';
import type { DevFlowGateway } from '../src/gateway/devflow.gateway';
import type { OrchestrationEmitter } from '../src/orchestration/streaming/orchestration-emitter.service';
import { ORCHESTRATION_PROTOCOL_VERSION } from '../src/orchestration/streaming/protocol';

describe('StreamEmitter', () => {
  const mockGateway = {
    emitAgentStream: vi.fn(),
  } as unknown as DevFlowGateway;
  const mockTypedEmitter = {
    emit: vi.fn(),
    nodeProgress: vi.fn(),
  };

  let emitter: StreamEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    emitter = new StreamEmitter(mockGateway);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('emit', () => {
    it('queues a chunk and flushes after the batch window', () => {
      emitter.emit('proj-1', 'frontend_agent', 'run-1', 'token', 'Hello');

      expect(mockGateway.emitAgentStream).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(1);
      expect(mockGateway.emitAgentStream).toHaveBeenCalledWith('proj-1', 'frontend_agent', [
        { nodeId: 'frontend_agent', runId: 'run-1', type: 'token', chunk: 'Hello' },
      ]);
    });

    it('batches multiple chunks within the same window', () => {
      emitter.emit('proj-1', 'frontend_agent', 'run-1', 'token', 'Hello ');
      emitter.emit('proj-1', 'frontend_agent', 'run-1', 'token', 'World');

      vi.advanceTimersByTime(50);

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(1);
      const call = mockGateway.emitAgentStream.mock.calls[0];
      expect(call[0]).toBe('proj-1');
      expect(call[1]).toBe('frontend_agent');
      expect(call[2]).toHaveLength(2);
      expect(call[2][0].chunk).toBe('Hello ');
      expect(call[2][1].chunk).toBe('World');
    });

    it('separates batches by projectId and nodeId', () => {
      emitter.emit('proj-1', 'frontend_agent', 'run-1', 'token', 'Frontend code');
      emitter.emit('proj-1', 'backend_agent', 'run-1', 'token', 'Backend code');

      vi.advanceTimersByTime(50);

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(2);
    });

    it('handles different chunk types', () => {
      emitter.emit('proj-1', 'agent', 'run-1', 'tool-call', 'writeFile', { filename: 'test.ts' });
      emitter.emit('proj-1', 'agent', 'run-1', 'decision', 'Routing to approval gate');

      vi.advanceTimersByTime(50);

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(1);
      const chunks = mockGateway.emitAgentStream.mock.calls[0][2];
      expect(chunks[0].type).toBe('tool-call');
      expect(chunks[0].metadata).toEqual({ filename: 'test.ts' });
      expect(chunks[1].type).toBe('decision');
    });

    it('emits typed agent.stream events for the canonical frontend channel', () => {
      const typedEmitter = new StreamEmitter(null, mockTypedEmitter as unknown as OrchestrationEmitter);

      typedEmitter.emit('proj-1', 'frontend_agent', 'run-1', 'token', 'Hello');
      typedEmitter.emit('proj-1', 'frontend_agent', 'run-1', 'token', ' world');

      vi.advanceTimersByTime(50);

      expect(mockTypedEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockTypedEmitter.emit).toHaveBeenCalledWith('proj-1', {
        v: ORCHESTRATION_PROTOCOL_VERSION,
        type: 'agent.stream',
        projectId: 'proj-1',
        runId: 'run-1',
        nodeId: 'frontend_agent',
        chunks: [
          { nodeId: 'frontend_agent', runId: 'run-1', type: 'token', chunk: 'Hello' },
          { nodeId: 'frontend_agent', runId: 'run-1', type: 'token', chunk: ' world' },
        ],
        ts: expect.any(Number),
      });
    });

    it('does not reset timer when new chunks arrive', () => {
      emitter.emit('proj-1', 'agent', 'run-1', 'token', 'A');

      vi.advanceTimersByTime(30);

      emitter.emit('proj-1', 'agent', 'run-1', 'token', 'B');

      vi.advanceTimersByTime(20);

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(1);
      const chunks = mockGateway.emitAgentStream.mock.calls[0][2];
      expect(chunks).toHaveLength(2);
      expect(chunks[0].chunk).toBe('A');
      expect(chunks[1].chunk).toBe('B');
    });
  });

  describe('flushAll', () => {
    it('flushes all batches for a given project', () => {
      emitter.emit('proj-1', 'frontend', 'run-1', 'token', 'X');
      emitter.emit('proj-1', 'backend', 'run-1', 'token', 'Y');
      emitter.emit('proj-2', 'frontend', 'run-2', 'token', 'Z');

      emitter.flushAll('proj-1');

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(2);
    });

    it('does not flush other projects', () => {
      emitter.emit('proj-2', 'frontend', 'run-2', 'token', 'Z');

      emitter.flushAll('proj-1');

      expect(mockGateway.emitAgentStream).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);

      expect(mockGateway.emitAgentStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('graceful null gateway', () => {
    it('does not throw when gateway is null', () => {
      const nullEmitter = new StreamEmitter(null);

      expect(() => {
        nullEmitter.emit('proj-1', 'agent', 'run-1', 'token', 'data');
        vi.advanceTimersByTime(50);
      }).not.toThrow();
    });
  });

  describe('context memory progress', () => {
    it('records progress checkpoints when context memory is wired', () => {
      const contextMemory = {
        record: vi.fn().mockResolvedValue({ id: 'mem-1' }),
      };
      const memoryEmitter = new StreamEmitter(mockGateway, null, contextMemory as never);

      memoryEmitter.progress('proj-1', 'backend_agent', 'run-1', 55, 'Generating service methods');

      expect(contextMemory.record).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-1',
        runId: 'run-1',
        agentType: 'backend_agent',
        type: 'progress_event',
        title: 'backend_agent progress',
        content: 'Generating service methods',
        progress: { status: 'running', node: 'backend_agent', percent: 55 },
      }));
    });
  });
});
