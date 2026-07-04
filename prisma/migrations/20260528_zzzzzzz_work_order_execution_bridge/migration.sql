ALTER TABLE "work_orders"
  ADD COLUMN "executionRunId" TEXT,
  ADD COLUMN "executionAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "executionStartedAt" TIMESTAMP(3),
  ADD COLUMN "executionCompletedAt" TIMESTAMP(3),
  ADD COLUMN "executionError" TEXT,
  ADD COLUMN "lastEventAt" TIMESTAMP(3);

CREATE INDEX "work_orders_executionRunId_idx" ON "work_orders"("executionRunId");
CREATE INDEX "work_orders_status_lastEventAt_idx" ON "work_orders"("status", "lastEventAt");
