CREATE TYPE "IntegrationOutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

CREATE TABLE "integration_outbox" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "producer" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "status" "IntegrationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockId" TEXT,
  "lockedAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "integration_outbox_status_lockedUntil_nextAttemptAt_createdAt_idx"
  ON "integration_outbox"("status", "lockedUntil", "nextAttemptAt", "createdAt");

CREATE INDEX "integration_outbox_aggregateType_aggregateId_createdAt_idx"
  ON "integration_outbox"("aggregateType", "aggregateId", "createdAt");

CREATE INDEX "integration_outbox_eventType_createdAt_idx"
  ON "integration_outbox"("eventType", "createdAt");
