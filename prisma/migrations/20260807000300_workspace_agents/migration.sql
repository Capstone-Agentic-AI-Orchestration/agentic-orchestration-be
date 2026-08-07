-- Configurable orchestration agents.
--
-- The console rendered its agent roster from a hand-maintained TypeScript constant mirroring
-- `agentic-orchestration-ag/agent/subagents`. It could drift from the package without anything
-- failing, and nothing on the page could be changed. These tables make the roster real: the
-- twelve built-ins are seeded per workspace, and an agent's `instructions` override the
-- compiled-in system prompt at dispatch, so an edit changes what the agent is told on its next
-- run rather than only what the page says about it.
--
-- Scoped by group, matching clients and projects: two teams can each tune their own frontend
-- agent without colliding, which is what `(groupId, key)` being unique enforces.
--
-- No FOREIGN KEY, matching every migration since the datasource moved to
-- relationMode = "prisma"; referential actions are emulated in application code and the indexes
-- below are what Prisma cannot create for itself under that mode.

DO $$
BEGIN
  CREATE TYPE "orchestration"."AgentAccessScope" AS ENUM ('WORKSPACE', 'PERSONAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "orchestration"."WorkspaceAgentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "orchestration"."workspace_agents" (
  "id"           TEXT NOT NULL,
  "key"          TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "avatarEmoji"  TEXT,
  -- Null means "use the built-in prompt". Seeding a copy would freeze each prompt at seed time
  -- and silently diverge from the package every time a built-in is improved.
  "instructions" TEXT,
  "model"        TEXT,
  "concurrency"  INTEGER NOT NULL DEFAULT 1,
  "accessScope"  "orchestration"."AgentAccessScope" NOT NULL DEFAULT 'WORKSPACE',
  "status"       "orchestration"."WorkspaceAgentStatus" NOT NULL DEFAULT 'ACTIVE',
  "isBuiltIn"    BOOLEAN NOT NULL DEFAULT false,
  "groupId"      TEXT NOT NULL,
  "ownerId"      UUID,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workspace_agents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_agents_groupId_key_key"
  ON "orchestration"."workspace_agents"("groupId", "key");
CREATE INDEX IF NOT EXISTS "workspace_agents_groupId_status_name_idx"
  ON "orchestration"."workspace_agents"("groupId", "status", "name");
CREATE INDEX IF NOT EXISTS "workspace_agents_ownerId_idx"
  ON "orchestration"."workspace_agents"("ownerId");

-- Skills are workspace-global Markdown, authored once and attached to many agents. A convention
-- worth teaching one agent is usually worth teaching its neighbours, and a per-agent copy of the
-- text is a guarantee that the copies drift.
CREATE TABLE IF NOT EXISTS "orchestration"."agent_skills" (
  "id"          TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "body"        TEXT NOT NULL,
  "groupId"     TEXT NOT NULL,
  "createdById" UUID,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_groupId_slug_key"
  ON "orchestration"."agent_skills"("groupId", "slug");
CREATE INDEX IF NOT EXISTS "agent_skills_groupId_name_idx"
  ON "orchestration"."agent_skills"("groupId", "name");
CREATE INDEX IF NOT EXISTS "agent_skills_createdById_idx"
  ON "orchestration"."agent_skills"("createdById");

CREATE TABLE IF NOT EXISTS "orchestration"."agent_skill_on_agent" (
  "id"        TEXT NOT NULL,
  "agentId"   TEXT NOT NULL,
  "skillId"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_skill_on_agent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_skill_on_agent_agentId_skillId_key"
  ON "orchestration"."agent_skill_on_agent"("agentId", "skillId");
CREATE INDEX IF NOT EXISTS "agent_skill_on_agent_skillId_idx"
  ON "orchestration"."agent_skill_on_agent"("skillId");
