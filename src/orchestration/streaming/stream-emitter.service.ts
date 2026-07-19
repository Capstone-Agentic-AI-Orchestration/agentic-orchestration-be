import { Injectable, Logger, Optional } from '@nestjs/common';
import { ContextMemoryService } from '../../context-memory/context-memory.service';
import { DevFlowGateway } from '../../gateway/devflow.gateway';
import { OrchestrationEmitter } from './orchestration-emitter.service';
import { ORCHESTRATION_PROTOCOL_VERSION } from './protocol';

export interface StreamChunk {
  nodeId: string;
  runId: string;
  type: 'token' | 'tool-call' | 'decision' | 'error';
  chunk: string;
  metadata?: Record<string, unknown>;
}

interface BatchEntry {
  projectId: string;
  nodeId: string;
  chunks: StreamChunk[];
  timer: ReturnType<typeof setTimeout> | null;
}

@Injectable()
export class StreamEmitter {
  private readonly logger = new Logger(StreamEmitter.name);
  private readonly batches = new Map<string, BatchEntry>();
  private readonly BATCH_WINDOW_MS = 50;

  constructor(
    @Optional() private readonly gateway: DevFlowGateway | null = null,
    @Optional() private readonly emitter: OrchestrationEmitter | null = null,
    @Optional() private readonly contextMemory: ContextMemoryService | null = null,
  ) {}

  /**
   * Emit a fine-grained progress checkpoint for a node (e.g. "40% — calling
   * LLM"). Routed straight to the typed `node.progress` channel — not batched,
   * since checkpoints are coarse and order matters. No-op when no typed emitter
   * is wired (tests / CLI), mirroring the agent-stream path.
   */
  progress(projectId: string, nodeId: string, runId: string, pct?: number, label?: string): void {
    this.emitter?.nodeProgress(projectId, runId ?? '', nodeId, pct, label);
    this.writeProgressMemory(projectId, nodeId, runId, pct, label);
  }

  emit(projectId: string, nodeId: string, runId: string, type: StreamChunk['type'], chunk: string, metadata?: Record<string, unknown>): void {
    const key = `${projectId}:${nodeId}`;
    const entry: StreamChunk = { nodeId, runId, type, chunk, metadata };

    let batch = this.batches.get(key);
    if (!batch) {
      batch = { projectId, nodeId, chunks: [], timer: null };
      this.batches.set(key, batch);
    }

    batch.chunks.push(entry);

    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(key), this.BATCH_WINDOW_MS);
    }
  }

  private flush(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;

    batch.timer = null;
    this.batches.delete(key);

    const { projectId, nodeId, chunks } = batch;

    // New typed protocol channel (Phase 1).
    if (this.emitter && chunks.length > 0) {
      this.emitter.emit(projectId, {
        v: ORCHESTRATION_PROTOCOL_VERSION,
        type: 'agent.stream',
        projectId,
        runId: chunks[0].runId,
        nodeId,
        chunks,
        ts: Date.now(),
      });
    }

    // Legacy channel — kept until the frontend cutover (Phase 4).
    if (!this.gateway) return;

    try {
      this.gateway.emitAgentStream(projectId, nodeId, chunks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to emit agent stream for ${key}: ${message}`);
    }
  }

  flushAll(projectId: string): void {
    for (const [key, batch] of this.batches.entries()) {
      if (batch.projectId === projectId) {
        if (batch.timer) {
          clearTimeout(batch.timer);
        }
        this.flush(key);
      }
    }
  }

  private writeProgressMemory(
    projectId: string,
    nodeId: string,
    runId: string,
    pct?: number,
    label?: string,
  ): void {
    if (!this.contextMemory) return;
    const percent = typeof pct === 'number'
      ? Math.max(0, Math.min(100, Math.round(pct)))
      : undefined;
    const content = label?.trim() || `${nodeId} progress checkpoint`;
    void this.contextMemory.record({
      projectId,
      runId,
      agentType: nodeId,
      type: 'progress_event',
      title: `${nodeId} progress`,
      content,
      importance: 0.45,
      tags: ['progress', nodeId],
      progress: {
        status: 'running',
        node: nodeId,
        percent,
      },
      metadata: {
        source: 'stream-emitter',
      },
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to persist progress memory for ${projectId}:${nodeId}: ${message}`);
    });
  }
}
