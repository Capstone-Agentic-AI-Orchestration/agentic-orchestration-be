-- Add AI runtime providers table for managing local CLI detection and cloud provider API keys.
--
-- Stores metadata about AI providers (cloud LLM APIs, detected local CLI tools) with references to
-- Supabase Vault secrets for API keys (never raw keys in the DB). Status tracks whether each provider
-- is reachable (updated by async health checks).

CREATE TABLE IF NOT EXISTS "orchestration"."ai_runtime_providers" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "baseUrl" TEXT,
  "model" TEXT,
  "vaultSecretId" UUID,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_runtime_providers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_runtime_providers_provider_idx" ON "orchestration"."ai_runtime_providers"("provider");
CREATE INDEX "ai_runtime_providers_status_idx" ON "orchestration"."ai_runtime_providers"("status");
CREATE INDEX "ai_runtime_providers_createdById_idx" ON "orchestration"."ai_runtime_providers"("createdById");
