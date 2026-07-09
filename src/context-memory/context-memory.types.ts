export const CONTEXT_MEMORY_TYPES = [
  'project_memory',
  'agent_output',
  'decision',
  'handoff',
  'error',
  'artifact',
  'progress_event',
] as const;

export type ContextMemoryType = typeof CONTEXT_MEMORY_TYPES[number];

export interface ContextMemoryArtifact {
  path?: string | null;
  kind?: string | null;
  uri?: string | null;
  sha256?: string | null;
}

export interface ContextMemoryProgress {
  status?: string | null;
  node?: string | null;
  percent?: number | null;
}

export interface ContextMemoryRecord {
  id: string;
  projectId: string;
  runId: string | null;
  agentType: string | null;
  type: ContextMemoryType;
  title: string;
  content: string;
  importance: number;
  tags: string[];
  artifact: ContextMemoryArtifact | null;
  progress: ContextMemoryProgress | null;
  metadata: Record<string, unknown>;
  hash: string | null;
  status: 'active' | 'archived';
  pinned: boolean;
  expiresAt: Date | null;
  archivedAt: Date | null;
  lastAccessedAt: Date | null;
  accessCount: number;
  embedding: number[] | null;
  createdAt: Date;
}

export interface ContextMemorySearchReason {
  lexicalScore: number;
  semanticScore: number;
  tagScore: number;
  agentScore: number;
  importanceScore: number;
  recencyScore: number;
  lifecycleScore: number;
  typeWeight: number;
  matchedTags: string[];
  matchedTerms: string[];
}

export interface ContextMemorySearchResult {
  record: ContextMemoryRecord;
  score: number;
  reason: ContextMemorySearchReason;
}

export interface ContextPackFreshness {
  retrievalMode: 'cached' | 'hybrid' | 'lexical';
  generatedAt: string;
  lastMemoryEventAt: string | null;
  stalenessMs: number;
  sourceEventCount: number;
  includedEventCount: number;
}

export interface ContextPackResult {
  projectId: string;
  runId: string | null;
  agentType: string;
  task: string;
  maxChars: number;
  text: string;
  included: Record<ContextMemoryType, string[]>;
  cacheHit: boolean;
  snapshotId?: string;
  freshness: ContextPackFreshness;
}

export interface ContextMemoryHandoff {
  id: string;
  projectId: string;
  runId: string | null;
  fromAgent: string;
  toAgent: string;
  title: string;
  content: string;
  artifact: ContextMemoryArtifact | null;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextMemorySnapshot {
  id: string;
  projectId: string;
  runId: string | null;
  agentType: string;
  taskHash: string;
  task: string;
  text: string;
  includedEventIds: string[];
  sourceEventMaxCreatedAt: Date | null;
  sourceEventCount: number;
  retrievalMode: 'cached' | 'hybrid' | 'lexical';
  stalenessMs: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
