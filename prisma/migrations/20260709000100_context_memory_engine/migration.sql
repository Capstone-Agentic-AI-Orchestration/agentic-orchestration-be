CREATE TABLE IF NOT EXISTS public.memory_context_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "agentType" TEXT,
  type TEXT NOT NULL CHECK (
    type IN (
      'project_memory',
      'agent_output',
      'decision',
      'handoff',
      'error',
      'artifact',
      'progress_event'
    )
  ),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance NUMERIC NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  tags TEXT[] NOT NULL DEFAULT '{}',
  artifact JSONB,
  progress JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  hash TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_project_created
  ON public.memory_context_events ("projectId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_project_agent_created
  ON public.memory_context_events ("projectId", "agentType", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_project_run_created
  ON public.memory_context_events ("projectId", "runId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_type_created
  ON public.memory_context_events (type, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_tags
  ON public.memory_context_events USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_metadata
  ON public.memory_context_events USING GIN (metadata);
