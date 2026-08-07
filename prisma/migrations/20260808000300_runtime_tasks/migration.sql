-- Local agent execution: one row per unit of work handed to a companion machine.
--
-- This is what lets a configured agent run through a person's own installed CLI instead of a paid
-- cloud call. The work order remains the unit of record; a runtime task is the off-box attempt.
--
-- Leased rather than assigned. A laptop sleeps, loses network, or gets killed mid-run, and the
-- companion drops any failure report it cannot deliver. An expiring lease is the only thing that
-- lets a reaper notice and requeue such a task instead of leaving it taken forever.

CREATE TYPE "orchestration"."RuntimeTaskStatus" AS ENUM ('QUEUED', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS "orchestration"."runtime_tasks" (
  "id" TEXT NOT NULL,
  "workOrderId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "adapterKind" TEXT NOT NULL,
  "resourceOpaqueId" TEXT NOT NULL,
  "status" "orchestration"."RuntimeTaskStatus" NOT NULL DEFAULT 'QUEUED',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "plan" JSONB NOT NULL DEFAULT '{}',
  -- SHA-256 of the lease token; the token itself is only ever held by the companion.
  "leaseTokenHash" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "output" TEXT,
  "usage" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_tasks_pkey" PRIMARY KEY ("id")
);

-- Claiming filters on (machine, status); reaping scans (status, leaseExpiresAt).
CREATE INDEX IF NOT EXISTS "runtime_tasks_machineId_status_idx" ON "orchestration"."runtime_tasks"("machineId", "status");
CREATE INDEX IF NOT EXISTS "runtime_tasks_status_leaseExpiresAt_idx" ON "orchestration"."runtime_tasks"("status", "leaseExpiresAt");
CREATE INDEX IF NOT EXISTS "runtime_tasks_workOrderId_idx" ON "orchestration"."runtime_tasks"("workOrderId");
