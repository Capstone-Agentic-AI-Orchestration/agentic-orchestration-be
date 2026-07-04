import { Injectable, Logger, Optional } from '@nestjs/common';
import { DevFlowGateway } from '../../gateway/devflow.gateway';
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type NodePhase,
  type OrchestrationErrorCode,
  type OrchestrationEvent,
  type RecoveryAction,
  type RunErrorSeverity,
  type StreamChunk,
} from './protocol';

/**
 * OrchestrationEmitter — the single funnel for typed protocol events.
 *
 * Every event is stamped with the protocol version + timestamp and routed to
 * the gateway's `orchestration:event` channel. The gateway is @Optional() so
 * the orchestration engine runs identically in environments without a
 * WebSocket adapter (tests, CLI smoke runs) — events are simply dropped.
 *
 * `agent.stream` events are NOT sent here directly; they keep flowing through
 * StreamEmitter's 50ms batch path, which forwards an `agent.stream` event via
 * {@link emit} on flush.
 */
@Injectable()
export class OrchestrationEmitter {
  private readonly logger = new Logger(OrchestrationEmitter.name);

  constructor(@Optional() private readonly gateway: DevFlowGateway | null) {}

  /** Low-level: emit a fully-formed event (used by StreamEmitter for batches). */
  emit(projectId: string, event: OrchestrationEvent): void {
    if (!this.gateway) return;
    try {
      this.gateway.emitEvent(projectId, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to emit ${event.type} for ${projectId}: ${message}`);
    }
  }

  // ── Convenience emitters (stamp v + ts) ──────────────────────────────────────

  runStatus(
    projectId: string,
    runId: string,
    status: string,
    currentNode: string,
    error: string | null = null,
  ): void {
    this.emit(projectId, {
      v: ORCHESTRATION_PROTOCOL_VERSION,
      type: 'run.status',
      projectId,
      runId,
      status,
      currentNode,
      error,
      ts: Date.now(),
    });
  }

  nodeLifecycle(
    projectId: string,
    runId: string,
    nodeId: string,
    phase: NodePhase,
  ): void {
    this.emit(projectId, {
      v: ORCHESTRATION_PROTOCOL_VERSION,
      type: 'node.lifecycle',
      projectId,
      runId,
      nodeId,
      phase,
      ts: Date.now(),
    });
  }

  nodeProgress(
    projectId: string,
    runId: string,
    nodeId: string,
    pct?: number,
    label?: string,
  ): void {
    this.emit(projectId, {
      v: ORCHESTRATION_PROTOCOL_VERSION,
      type: 'node.progress',
      projectId,
      runId,
      nodeId,
      pct,
      label,
      ts: Date.now(),
    });
  }

  /**
   * Emit an agent "thinking" stream batch directly on the typed channel. Live
   * agent nodes stream through StreamEmitter's batch path; the simulation graph
   * uses this to push scripted chunks without the batching layer.
   */
  agentStream(
    projectId: string,
    runId: string,
    nodeId: string,
    chunks: StreamChunk[],
  ): void {
    this.emit(projectId, {
      v: ORCHESTRATION_PROTOCOL_VERSION,
      type: 'agent.stream',
      projectId,
      runId,
      nodeId,
      chunks,
      ts: Date.now(),
    });
  }

  nodeTelemetry(
    projectId: string,
    nodeId: string,
    telemetry: {
      runId?: string;
      wallMs?: number;
      llmMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      model?: string;
    },
  ): void {
    this.emit(projectId, {
      v: ORCHESTRATION_PROTOCOL_VERSION,
      type: 'node.telemetry',
      projectId,
      nodeId,
      ts: Date.now(),
      ...telemetry,
    });
  }

  runError(
    projectId: string,
    runId: string,
    params: {
      nodeId?: string;
      code: OrchestrationErrorCode;
      severity: RunErrorSeverity;
      message: string;
      recovery?: RecoveryAction[];
    },
  ): void {
    this.emit(projectId, {
      v: ORCHESTRATION_PROTOCOL_VERSION,
      type: 'run.error',
      projectId,
      runId,
      ts: Date.now(),
      ...params,
    });
  }
}
