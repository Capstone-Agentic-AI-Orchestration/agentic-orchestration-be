CREATE TYPE "AgentMemoryScope" AS ENUM (
  'AGENT_PRIVATE',
  'PROJECT_CORE',
  'PROJECT_AGENT',
  'GLOBAL_PATTERN'
);

CREATE TABLE "agent_profiles" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "agentType" TEXT NOT NULL,
  "modelHint" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_profiles_slug_key" ON "agent_profiles"("slug");
CREATE INDEX "agent_profiles_agentType_active_idx" ON "agent_profiles"("agentType", "active");

ALTER TABLE "agent_memories"
  ADD COLUMN "agentProfileId" TEXT,
  ADD COLUMN "scope" "AgentMemoryScope" NOT NULL DEFAULT 'AGENT_PRIVATE',
  ADD COLUMN "sourceType" TEXT,
  ADD COLUMN "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "lastUsedAt" TIMESTAMP(3),
  ADD COLUMN "usageCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvalSource" TEXT;

UPDATE "agent_memories"
SET "scope" = CASE
  WHEN "memoryType" = 'PATTERN' THEN 'GLOBAL_PATTERN'::"AgentMemoryScope"
  WHEN "projectId" IS NOT NULL THEN 'PROJECT_AGENT'::"AgentMemoryScope"
  ELSE 'AGENT_PRIVATE'::"AgentMemoryScope"
END,
"approvedAt" = CASE
  WHEN "memoryType" = 'PATTERN' THEN "createdAt"
  ELSE NULL
END,
"approvalSource" = CASE
  WHEN "memoryType" = 'PATTERN' THEN 'GATE_2_LEGACY'
  ELSE NULL
END;

ALTER TABLE "agent_memories"
  ADD CONSTRAINT "agent_memories_agentProfileId_fkey"
  FOREIGN KEY ("agentProfileId") REFERENCES "agent_profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "agent_memories_scope_projectId_idx" ON "agent_memories"("scope", "projectId");
CREATE INDEX "agent_memories_agentType_scope_memoryType_idx" ON "agent_memories"("agentType", "scope", "memoryType");
CREATE INDEX "agent_memories_agentType_projectId_scope_idx" ON "agent_memories"("agentType", "projectId", "scope");
CREATE INDEX "agent_memories_agentProfileId_idx" ON "agent_memories"("agentProfileId");
CREATE INDEX "agent_memories_approvedAt_idx" ON "agent_memories"("approvedAt");
