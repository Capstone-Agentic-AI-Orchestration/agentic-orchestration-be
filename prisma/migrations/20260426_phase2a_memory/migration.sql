-- Initial DevFlow schema.
-- Creates project tracking, gate review, generated artifacts, agent memory,
-- event logs, and run budgets for the orchestration backend.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM (
    'PENDING',
    'PARSING_REQUIREMENTS',
    'NEGOTIATING_CONTRACT',
    'AWAITING_GATE_1',
    'GENERATING_CODE',
    'AWAITING_GATE_2',
    'COMMITTING',
    'DELIVERED',
    'FAILED'
);

-- CreateEnum
CREATE TYPE "GateType" AS ENUM ('ARCHITECTURE_REVIEW', 'CODE_REVIEW');

-- CreateEnum
CREATE TYPE "GateDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AgentMemoryType" AS ENUM ('SKILL', 'PATTERN', 'MISTAKE');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "stackKey" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PENDING',
    "runId" TEXT,
    "repoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "gateType" "GateType" NOT NULL,
    "decision" "GateDecision" NOT NULL,
    "notes" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memories" (
    "id" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "memoryType" "AgentMemoryType" NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "costMeta" JSONB NOT NULL DEFAULT '{}',
    "runTokens" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_budgets" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tokenBudget" INTEGER NOT NULL DEFAULT 200000,
    "tokensConsumed" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_runId_key" ON "Project"("runId");

-- CreateIndex
CREATE INDEX "agent_memories_agentType_memoryType_idx"
    ON "agent_memories"("agentType", "memoryType");

-- CreateIndex
CREATE INDEX "agent_memories_projectId_idx" ON "agent_memories"("projectId");

-- CreateIndex
CREATE INDEX "agent_memories_embedding_ivfflat_idx"
    ON "agent_memories"
    USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 10);

-- CreateIndex
CREATE INDEX "event_logs_projectId_occurredAt_idx"
    ON "event_logs"("projectId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "run_budgets_projectId_key" ON "run_budgets"("projectId");

-- AddForeignKey
ALTER TABLE "GateEvent"
    ADD CONSTRAINT "GateEvent_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact"
    ADD CONSTRAINT "Artifact_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logs"
    ADD CONSTRAINT "event_logs_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_budgets"
    ADD CONSTRAINT "run_budgets_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
