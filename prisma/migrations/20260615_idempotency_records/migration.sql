CREATE TYPE "IdempotencyRecordStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "idempotency_records" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "IdempotencyRecordStatus" NOT NULL DEFAULT 'PROCESSING',
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "error" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_key_scope_key"
  ON "idempotency_records"("key", "scope");

CREATE INDEX "idempotency_records_scope_expiresAt_idx"
  ON "idempotency_records"("scope", "expiresAt");

CREATE INDEX "idempotency_records_status_lockedUntil_idx"
  ON "idempotency_records"("status", "lockedUntil");
