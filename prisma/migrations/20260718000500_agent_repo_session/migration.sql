-- Short-lived, project-scoped capabilities for agent repository access.
-- The agent service holds no GitHub credentials; it presents one of these tokens and the
-- backend resolves repository scope from projectId server-side.
CREATE TABLE IF NOT EXISTS "orchestration"."agent_repo_sessions" (
    "id"         TEXT NOT NULL,
    "token"      TEXT NOT NULL,
    "runId"      TEXT NOT NULL,
    "projectId"  TEXT NOT NULL,
    "branch"     TEXT NOT NULL,
    "agentType"  TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "revokedAt"  TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "useCount"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_repo_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_repo_sessions_token_key" ON "orchestration"."agent_repo_sessions"("token");
CREATE INDEX IF NOT EXISTS "agent_repo_sessions_projectId_idx" ON "orchestration"."agent_repo_sessions"("projectId");
CREATE INDEX IF NOT EXISTS "agent_repo_sessions_runId_idx" ON "orchestration"."agent_repo_sessions"("runId");
CREATE INDEX IF NOT EXISTS "agent_repo_sessions_expiresAt_idx" ON "orchestration"."agent_repo_sessions"("expiresAt");
