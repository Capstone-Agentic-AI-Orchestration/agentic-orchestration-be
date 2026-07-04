CREATE TYPE "NotificationType" AS ENUM (
  'ARTIFACT_REVIEWED',
  'REVISION_HANDLED',
  'TASK_ASSIGNED',
  'TASK_STATUS_CHANGED',
  'TASK_COMMENTED'
);

CREATE TABLE "notifications" (
  "id" TEXT NOT NULL,
  "recipientId" UUID NOT NULL,
  "actorId" UUID,
  "projectId" TEXT,
  "taskId" TEXT,
  "artifactId" TEXT,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_recipientId_readAt_createdAt_idx"
  ON "notifications"("recipientId", "readAt", "createdAt");
CREATE INDEX "notifications_projectId_idx" ON "notifications"("projectId");
CREATE INDEX "notifications_taskId_idx" ON "notifications"("taskId");
CREATE INDEX "notifications_artifactId_idx" ON "notifications"("artifactId");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
