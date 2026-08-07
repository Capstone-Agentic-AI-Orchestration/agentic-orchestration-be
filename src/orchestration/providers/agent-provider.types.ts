import { Prisma, WorkOrderAgentType, WorkOrderPriority } from '@prisma/client';

/**
 * `companion` runs the work order on a user's own machine through an AI CLI they already have
 * installed, instead of calling a metered model API.
 */
export type AgentProviderMode = 'mock' | 'llm' | 'simulation' | 'companion';
export type AgentLlmEngine = 'eve' | 'direct';

export interface WorkOrderAgentContext {
  project: {
    id: string;
    companyName: string;
    brief: string;
    stackKey: string;
  };
  workOrder: {
    id: string;
    title: string;
    instructions: string | null;
    agentType: WorkOrderAgentType;
    priority: WorkOrderPriority;
  };
  /**
   * The configured agent assigned to this work order, when there is one.
   *
   * `instructions` is already resolved: the workspace's own text plus its attached skills, or
   * the built-in fallback. Absent means no agent was assigned and the role is derived from
   * `agentType` as before.
   *
   * `runtimeKey` is which deployed Eve subagent should execute it — identity and capability are
   * separate, and only coincide for built-ins.
   */
  agentProfile?: {
    key: string;
    runtimeKey: string;
    name: string;
    instructions: string;
  };
  task: {
    title: string;
    description: string | null;
  } | null;
  sourceArtifact: {
    filePath: string;
    displayName: string | null;
    content: string;
  } | null;
  executionRunId: string;
  onToken?: (delta: string) => void;
}

export interface GeneratedWorkOrderOutput {
  filePath: string;
  displayName: string;
  content: string;
  language: string;
  metadata?: Prisma.InputJsonObject;
}

export interface WorkOrderAgentProvider {
  readonly mode: AgentProviderMode;
  generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): GeneratedWorkOrderOutput | Promise<GeneratedWorkOrderOutput>;
}

export interface AgentProviderCapability {
  mode: AgentProviderMode;
  displayName: string;
  active: boolean;
  available: boolean;
  implemented: boolean;
  missingRequirements: string[];
  reason: string | null;
  provider?: string;
  model?: string;
  fallbackModel?: string | null;
  requestTimeoutMs?: number;
  concurrencyLimit?: number;
}

export interface AgentProviderStatus {
  requestedMode: AgentProviderMode;
  activeMode: AgentProviderMode;
  available: boolean;
  fallbackMode: AgentProviderMode | null;
  missingRequirements: string[];
  reason: string | null;
  provider?: string;
  model?: string;
  fallbackModel?: string | null;
  requestTimeoutMs?: number;
  concurrencyLimit?: number;
  providers: AgentProviderCapability[];
}

export interface AgentLlmEngineStatus {
  requestedEngine: AgentLlmEngine;
  activeEngine: AgentLlmEngine;
  fallbackReason: string | null;
  eveServiceConfigured: boolean;
  model: string;
}
