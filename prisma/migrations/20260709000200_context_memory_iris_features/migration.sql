CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE public.memory_context_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "lastAccessedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "accessCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embedding vector(64);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_project_status_created
  ON public.memory_context_events ("projectId", status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_events_project_expires
  ON public.memory_context_events ("projectId", "expiresAt");

CREATE INDEX IF NOT EXISTS idx_memory_context_events_embedding
  ON public.memory_context_events USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 32);

CREATE TABLE IF NOT EXISTS public.memory_context_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "fromAgent" TEXT NOT NULL,
  "toAgent" TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  artifact JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  "acknowledgedAt" TIMESTAMPTZ,
  "resolvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_context_handoffs_project_to_status_updated
  ON public.memory_context_handoffs ("projectId", "toAgent", status, "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_handoffs_project_run_updated
  ON public.memory_context_handoffs ("projectId", "runId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS public.memory_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "agentType" TEXT NOT NULL,
  "taskHash" TEXT NOT NULL,
  task TEXT NOT NULL,
  text TEXT NOT NULL,
  "includedEventIds" TEXT[] NOT NULL DEFAULT '{}',
  "sourceEventMaxCreatedAt" TIMESTAMPTZ,
  "sourceEventCount" INTEGER NOT NULL DEFAULT 0,
  "retrievalMode" TEXT NOT NULL DEFAULT 'hybrid' CHECK ("retrievalMode" IN ('hybrid', 'lexical')),
  "stalenessMs" INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_context_snapshots_lookup
  ON public.memory_context_snapshots ("projectId", "runId", "agentType", "taskHash", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_memory_context_snapshots_project_created
  ON public.memory_context_snapshots ("projectId", "createdAt" DESC);
