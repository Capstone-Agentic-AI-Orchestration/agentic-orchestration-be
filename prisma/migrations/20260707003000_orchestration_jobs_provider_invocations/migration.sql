-- Durable orchestration jobs, run heartbeats, and provider invocation observability.

ALTER TYPE "orchestration"."OrchestrationRunStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

DO $$ BEGIN
  CREATE TYPE "orchestration"."OrchestrationJobKind" AS ENUM (
    'START_RUN',
    'RESUME_GATE_1',
    'RESUME_GATE_2',
    'CONTROL',
    'SUPERVISOR_RECOVERY',
    'MOCK_WORK_ORDERS'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "orchestration"."OrchestrationJobStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "orchestration"."ProviderInvocationStatus" AS ENUM (
    'STARTED',
    'SUCCEEDED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "orchestration"."orchestration_runs"
  ADD COLUMN IF NOT EXISTS "lastHeartbeatAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "orchestration"."orchestration_jobs" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "orchestrationRunId" TEXT,
  "runId" TEXT NOT NULL,
  "kind" "orchestration"."OrchestrationJobKind" NOT NULL,
  "status" "orchestration"."OrchestrationJobStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedBy" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orchestration_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "orchestration"."provider_invocations" (
  "id" TEXT NOT NULL,
  "projectId" TEXT,
  "orchestrationRunId" TEXT,
  "runId" TEXT,
  "workOrderId" TEXT,
  "nodeId" TEXT,
  "agent" TEXT NOT NULL,
  "attempt" INTEGER,
  "engine" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "requestId" TEXT NOT NULL,
  "eveSessionId" TEXT,
  "continuationToken" TEXT,
  "status" "orchestration"."ProviderInvocationStatus" NOT NULL DEFAULT 'STARTED',
  "error" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "provider_invocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_invocations_requestId_key"
  ON "orchestration"."provider_invocations"("requestId");

CREATE INDEX IF NOT EXISTS "orchestration_runs_lastHeartbeatAt_idx"
  ON "orchestration"."orchestration_runs"("lastHeartbeatAt");

CREATE INDEX IF NOT EXISTS "orchestration_jobs_projectId_createdAt_idx"
  ON "orchestration"."orchestration_jobs"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "orchestration_jobs_runId_idx"
  ON "orchestration"."orchestration_jobs"("runId");
CREATE INDEX IF NOT EXISTS "orchestration_jobs_status_availableAt_idx"
  ON "orchestration"."orchestration_jobs"("status", "availableAt");
CREATE INDEX IF NOT EXISTS "orchestration_jobs_lockedUntil_idx"
  ON "orchestration"."orchestration_jobs"("lockedUntil");

CREATE INDEX IF NOT EXISTS "provider_invocations_projectId_startedAt_idx"
  ON "orchestration"."provider_invocations"("projectId", "startedAt");
CREATE INDEX IF NOT EXISTS "provider_invocations_runId_idx"
  ON "orchestration"."provider_invocations"("runId");
CREATE INDEX IF NOT EXISTS "provider_invocations_agent_startedAt_idx"
  ON "orchestration"."provider_invocations"("agent", "startedAt");
CREATE INDEX IF NOT EXISTS "provider_invocations_engine_status_idx"
  ON "orchestration"."provider_invocations"("engine", "status");

ALTER TABLE "orchestration"."orchestration_jobs"
  ADD CONSTRAINT "orchestration_jobs_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "orchestration"."orchestration_jobs"
  ADD CONSTRAINT "orchestration_jobs_orchestrationRunId_fkey"
  FOREIGN KEY ("orchestrationRunId") REFERENCES "orchestration"."orchestration_runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orchestration"."provider_invocations"
  ADD CONSTRAINT "provider_invocations_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orchestration"."provider_invocations"
  ADD CONSTRAINT "provider_invocations_orchestrationRunId_fkey"
  FOREIGN KEY ("orchestrationRunId") REFERENCES "orchestration"."orchestration_runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
