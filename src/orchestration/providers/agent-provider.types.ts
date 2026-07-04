import { Prisma, WorkOrderAgentType, WorkOrderPriority } from '@prisma/client';

export type AgentProviderMode = 'mock' | 'llm' | 'simulation';

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
  providers: AgentProviderCapability[];
}
