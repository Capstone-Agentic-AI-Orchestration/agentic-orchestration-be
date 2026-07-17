export const RAG_SOURCE_TYPES = [
  'project',
  'work_order',
  'work_order_execution',
  'artifact',
  'event_log',
  'agent_memory',
  'agent_profile',
  'project_task',
  'project_task_activity',
  'project_timeline_event',
  'gate_event',
  'document',
  'architecture_decision',
  'error',
  'fix',
  'pattern',
  'handoff',
] as const;

export type RagSourceType = typeof RAG_SOURCE_TYPES[number];
export type RagRetrievalMode = 'keyword' | 'vector' | 'hybrid';

export interface RagRetrieveInput {
  projectId: string;
  runId?: string;
  workOrderId?: string;
  workOrderExecutionId?: string;
  agentName: string;
  query: string;
  currentTask?: string;
  memoryTypes?: string[];
  sourceTypes?: string[];
  tags?: string[];
  limit?: number;
  useVector?: boolean;
  useKeyword?: boolean;
  maxContextChars?: number;
}

export interface RetrievedContextItem {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  title?: string;
  content: string;
  summary?: string;
  agentName?: string;
  runId?: string;
  workOrderId?: string;
  workOrderExecutionId?: string;
  importance: number;
  isSuperseded: boolean;
  score: number;
  scoreBreakdown: {
    keywordScore?: number;
    vectorScore?: number;
    recencyScore?: number;
    importanceScore?: number;
    agentRelevanceScore?: number;
    workOrderRelevanceScore?: number;
    sourceTrustScore?: number;
    runRelevanceScore?: number;
    executionRelevanceScore?: number;
    artifactRelevanceScore?: number;
    errorFixRelevanceScore?: number;
  };
  createdAt?: string;
}

export interface RagContextPack {
  meta: {
    projectId: string;
    runId?: string;
    workOrderId?: string;
    workOrderExecutionId?: string;
    agentName: string;
    generatedAt: string;
    retrievalMode: RagRetrievalMode;
    contextVersion: string;
    freshness: 'fresh' | 'partial' | 'stale';
    chunksRetrieved: number;
    chunksUsed: number;
  };
  currentObjective: {
    title?: string;
    task?: string;
    workOrderType?: string;
    expectedOutput?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
  };
  retrievedRequirements: Array<{ id: string; content: string; sourceType: string; score: number }>;
  retrievedDecisions: Array<{ id: string; content: string; sourceType: string; score: number }>;
  retrievedArtifacts: Array<{ id: string; title?: string; summary: string; sourceId: string; score: number }>;
  retrievedErrorsAndFixes: Array<{ id: string; content: string; sourceType: string; score: number }>;
  retrievedAgentMemory: Array<{ id: string; content: string; score: number }>;
  retrievedEvents: Array<{ id: string; content: string; sourceType: string; score: number }>;
  doNotDo: string[];
  instructionsForThisAgent: string[];
}

export interface HybridSearchResult {
  items: RetrievedContextItem[];
  mode: RagRetrievalMode;
}

export interface RagIndexRecord {
  projectId: string;
  sourceType: RagSourceType;
  sourceId: string;
  title?: string | null;
  content: string;
  summary?: string | null;
  runId?: string | null;
  workOrderId?: string | null;
  workOrderExecutionId?: string | null;
  agentName?: string | null;
  tags?: string[];
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface CompressedContext {
  items: RetrievedContextItem[];
  usedChars: number;
  warnings: string[];
}
