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
  createdAt: Date;
}

export interface ContextMemorySearchResult {
  record: ContextMemoryRecord;
  score: number;
}

export interface ContextPackResult {
  projectId: string;
  runId: string | null;
  agentType: string;
  task: string;
  maxChars: number;
  text: string;
  included: Record<ContextMemoryType, string[]>;
}
