-- RAG is additive to the existing layered AgentMemory implementation.  The
-- embedding column is intentionally nullable: deployments without an embedding
-- provider continue to retrieve with the generated full-text vector.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory.rag_chunks (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "workOrderId" TEXT,
  "workOrderExecutionId" TEXT,
  "agentName" TEXT,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  "chunkIndex" INTEGER NOT NULL DEFAULT 0,
  tags TEXT[] NOT NULL DEFAULT '{}',
  importance INTEGER NOT NULL DEFAULT 3,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
  "isSuperseded" BOOLEAN NOT NULL DEFAULT false,
  embedding vector(1536),
  "searchVector" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || content || ' ' || coalesce(summary, ''))
  ) STORED,
  "contentHash" TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAccessedAt" TIMESTAMP(3),
  CONSTRAINT rag_chunks_pkey PRIMARY KEY (id),
  CONSTRAINT rag_chunks_project_fkey
    FOREIGN KEY ("projectId") REFERENCES projects."Project"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_chunks_project_source_chunk_key
  ON memory.rag_chunks ("projectId", "sourceType", "sourceId", "chunkIndex");
CREATE INDEX IF NOT EXISTS rag_chunks_project_run_idx
  ON memory.rag_chunks ("projectId", "runId");
CREATE INDEX IF NOT EXISTS rag_chunks_project_work_order_idx
  ON memory.rag_chunks ("projectId", "workOrderId");
CREATE INDEX IF NOT EXISTS rag_chunks_project_work_order_execution_idx
  ON memory.rag_chunks ("projectId", "workOrderExecutionId");
CREATE INDEX IF NOT EXISTS rag_chunks_project_source_idx
  ON memory.rag_chunks ("projectId", "sourceType");
CREATE INDEX IF NOT EXISTS rag_chunks_project_agent_idx
  ON memory.rag_chunks ("projectId", "agentName");
CREATE INDEX IF NOT EXISTS rag_chunks_project_created_idx
  ON memory.rag_chunks ("projectId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS rag_chunks_project_active_created_idx
  ON memory.rag_chunks ("projectId", "isSuperseded", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS rag_chunks_search_idx
  ON memory.rag_chunks USING GIN ("searchVector");

-- IVFFlat is used only when vector retrieval is enabled.  Keyword retrieval is
-- always available and avoids querying this index when embeddings are absent.
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_ivfflat_idx
  ON memory.rag_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 32)
  WHERE embedding IS NOT NULL;

-- Nest/Prisma connects as the table owner; direct Supabase anon/authenticated
-- access is denied so RAG is only exposed through the guarded backend routes.
ALTER TABLE memory.rag_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deny_client_access" ON memory.rag_chunks;
CREATE POLICY "deny_client_access"
  ON memory.rag_chunks
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);
