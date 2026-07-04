-- Align hand-written SQL migrations with the Prisma datamodel indexes while
-- preserving database-specific pgvector indexes that Prisma cannot represent.

CREATE INDEX IF NOT EXISTS "profiles_role_idx" ON "profiles"("role");

CREATE INDEX IF NOT EXISTS "profiles_status_idx" ON "profiles"("status");

CREATE INDEX IF NOT EXISTS "project_members_projectId_role_idx"
  ON "project_members"("projectId", "role");

ALTER INDEX IF EXISTS "integration_outbox_status_lockedUntil_nextAttemptAt_createdAt_i"
  RENAME TO "integration_outbox_status_lockedUntil_nextAttemptAt_created_idx";
