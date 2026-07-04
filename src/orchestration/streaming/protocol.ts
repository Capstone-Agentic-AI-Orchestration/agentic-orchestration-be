/**
 * Canonical DevFlow orchestration streaming protocol.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the typed event contract sent
 * over the Socket.IO `/devflow` namespace on the `orchestration:event` channel.
 *
 * The frontend keeps a verbatim mirror at:
 *   devflow-frontend/src/shared/api/orchestration-events.ts
 *
 * The two packages are not a shared workspace, so the mirror is maintained by
 * hand. A parity test in each package (protocol.test.ts / orchestration-events.test.ts)
 * pins `ORCHESTRATION_EVENT_TYPES` to a literal list so drift fails CI. When you
 * change this file, update the mirror AND both tests.
 *
 * See docs/orchestration/ARCHITECTURE.md → "WebSocket event schema".
 */

/** Protocol version. Bump on any breaking change to an event shape. */
export const ORCHESTRATION_PROTOCOL_VERSION = 1;

/** Socket.IO event name carrying every typed orchestration event. */
export const ORCHESTRATION_EVENT_CHANNEL = 'orchestration:event';

// ─── Agent stream chunks (unchanged wire shape, kept for back-compat) ──────────

export type StreamChunkType = 'token' | 'tool-call' | 'decision' | 'error';

export interface StreamChunk {
  nodeId: string;
  runId: string;
  type: StreamChunkType;
  chunk: string;
  metadata?: Record<string, unknown>;
}

// ─── Error taxonomy (seeds mid-run control + inline error cards) ───────────────

export type NodePhase =
  | 'entering'
  | 'running'
  | 'exiting'
  | 'error'
  | 'skipped';

export type RunErrorSeverity = 'transient' | 'permanent';

export type OrchestrationErrorCode =
  | 'NODE_FAILED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  | 'VALIDATION_FAILED'
  | 'BUDGET_EXHAUSTED'
  | 'GITHUB_DELIVERY_FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export type RecoveryActionKind =
  | 'retry_node'
  | 'skip_node'
  | 'modify_params'
  | 'cancel';

export interface RecoveryAction {
  action: RecoveryActionKind;
  label: string;
  nodeId?: string;
}

// ─── Event union ───────────────────────────────────────────────────────────────

interface BaseEvent {
  /** Protocol version (=== ORCHESTRATION_PROTOCOL_VERSION). */
  v: number;
  projectId: string;
  runId: string;
  /** Emit timestamp (epoch ms). */
  ts: number;
}

/** Coarse run-level status transition (project/run status + active node). */
export interface RunStatusEvent extends BaseEvent {
  type: 'run.status';
  status: string;
  currentNode: string;
  error?: string | null;
}

/** Precise per-node lifecycle transition (emitted by the node instrumentation). */
export interface NodeLifecycleEvent extends BaseEvent {
  type: 'node.lifecycle';
  nodeId: string;
  phase: NodePhase;
}

/** Fine-grained progress within a node, e.g. "45% — creating auth module". */
export interface NodeProgressEvent extends BaseEvent {
  type: 'node.progress';
  nodeId: string;
  pct?: number;
  label?: string;
}

/** Timing / token / cost telemetry for a node. runId is optional because some
 *  cost sources (EventLogService) resolve it lazily. */
export interface NodeTelemetryEvent extends Omit<BaseEvent, 'runId'> {
  type: 'node.telemetry';
  runId?: string;
  nodeId: string;
  wallMs?: number;
  llmMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
}

/** Batched agent "thinking" stream (tokens, tool-calls, decisions, errors). */
export interface AgentStreamEvent extends BaseEvent {
  type: 'agent.stream';
  nodeId: string;
  chunks: StreamChunk[];
}

/** Structured, actionable run/node error. */
export interface RunErrorEvent extends BaseEvent {
  type: 'run.error';
  nodeId?: string;
  code: OrchestrationErrorCode;
  severity: RunErrorSeverity;
  message: string;
  recovery?: RecoveryAction[];
}

export type OrchestrationEvent =
  | RunStatusEvent
  | NodeLifecycleEvent
  | NodeProgressEvent
  | NodeTelemetryEvent
  | AgentStreamEvent
  | RunErrorEvent;

/** Discriminator literals. Pinned by the parity tests in both packages. */
export const ORCHESTRATION_EVENT_TYPES = [
  'run.status',
  'node.lifecycle',
  'node.progress',
  'node.telemetry',
  'agent.stream',
  'run.error',
] as const;

export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];
