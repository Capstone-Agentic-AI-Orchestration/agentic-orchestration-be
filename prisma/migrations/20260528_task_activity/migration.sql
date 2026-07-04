CREATE TYPE "ProjectTaskActivityType" AS ENUM (
  'TASK_CREATED',
  'STATUS_CHANGED',
  'ASSIGNEE_CHANGED',
  'ARTIFACT_CHANGED',
  'COMMENT'
);

CREATE TABLE "project_task_activities" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "actorId" UUID,
  "type" "ProjectTaskActivityType" NOT NULL,
  "message" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_task_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_task_activities_projectId_taskId_createdAt_idx"
  ON "project_task_activities"("projectId", "taskId", "createdAt");

CREATE INDEX "project_task_activities_actorId_idx"
  ON "project_task_activities"("actorId");

ALTER TABLE "project_task_activities"
  ADD CONSTRAINT "project_task_activities_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_task_activities"
  ADD CONSTRAINT "project_task_activities_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
