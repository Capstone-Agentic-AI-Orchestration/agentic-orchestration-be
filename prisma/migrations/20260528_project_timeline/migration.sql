CREATE TYPE "ProjectTimelineEventType" AS ENUM (
  'PROJECT_CREATED',
  'PROJECT_UPDATED',
  'MEMBER_ADDED',
  'MEMBER_REMOVED',
  'ARTIFACT_SHARED',
  'ARTIFACT_UNSHARED',
  'ARTIFACT_REVIEWED',
  'REVISION_HANDLED',
  'TASK_CREATED',
  'TASK_ASSIGNED',
  'TASK_STATUS_CHANGED',
  'TASK_COMMENTED',
  'NOTIFICATION_SENT'
);

CREATE TYPE "ProjectTimelineVisibility" AS ENUM (
  'INTERNAL',
  'TEAM',
  'CLIENT'
);

CREATE TABLE "project_timeline_events" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "actorId" UUID,
  "taskId" TEXT,
  "artifactId" TEXT,
  "type" "ProjectTimelineEventType" NOT NULL,
  "visibility" "ProjectTimelineVisibility" NOT NULL DEFAULT 'TEAM',
  "title" TEXT NOT NULL,
  "body" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_timeline_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_timeline_events_projectId_visibility_createdAt_idx"
  ON "project_timeline_events"("projectId", "visibility", "createdAt");
CREATE INDEX "project_timeline_events_actorId_idx" ON "project_timeline_events"("actorId");
CREATE INDEX "project_timeline_events_taskId_idx" ON "project_timeline_events"("taskId");
CREATE INDEX "project_timeline_events_artifactId_idx" ON "project_timeline_events"("artifactId");

ALTER TABLE "project_timeline_events"
  ADD CONSTRAINT "project_timeline_events_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_timeline_events"
  ADD CONSTRAINT "project_timeline_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
