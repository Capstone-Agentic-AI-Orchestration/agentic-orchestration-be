-- Durable dispatch metadata for OrchestrationRun.
-- The dispatcher uses these nullable fields as a compare-and-swap lease so a run is driven
-- by at most one API/supervisor worker at a time.
ALTER TABLE "orchestration"."orchestration_runs"
  ADD COLUMN IF NOT EXISTS "dispatchLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "dispatchQueuedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseAcquiredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "orchestration_runs_status_dispatchQueuedAt_idx"
  ON "orchestration"."orchestration_runs"("status", "dispatchQueuedAt");

CREATE INDEX IF NOT EXISTS "orchestration_runs_leaseExpiresAt_idx"
  ON "orchestration"."orchestration_runs"("leaseExpiresAt");
