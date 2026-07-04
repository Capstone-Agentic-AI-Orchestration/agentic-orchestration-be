CREATE TYPE "ProfileStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "profiles"
  ADD COLUMN "status" "ProfileStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE TYPE "AdminDomainStatus" AS ENUM ('PLANNED', 'PENDING_VERIFICATION', 'VERIFIED', 'FAILED', 'DISABLED');

CREATE TABLE "admin_domains" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "owner" TEXT,
  "target" TEXT,
  "environment" TEXT NOT NULL DEFAULT 'production',
  "status" "AdminDomainStatus" NOT NULL DEFAULT 'PLANNED',
  "verifiedAt" TIMESTAMP(3),
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_domains_name_key" ON "admin_domains"("name");
CREATE INDEX "admin_domains_status_idx" ON "admin_domains"("status");
CREATE INDEX "admin_domains_environment_idx" ON "admin_domains"("environment");

CREATE TABLE "admin_audit_logs" (
  "id" TEXT NOT NULL,
  "actorId" UUID,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "summary" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_actorId_createdAt_idx" ON "admin_audit_logs"("actorId", "createdAt");
CREATE INDEX "admin_audit_logs_targetType_targetId_idx" ON "admin_audit_logs"("targetType", "targetId");
CREATE INDEX "admin_audit_logs_action_createdAt_idx" ON "admin_audit_logs"("action", "createdAt");

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "platform_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL DEFAULT '{}',
  "updatedById" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);
