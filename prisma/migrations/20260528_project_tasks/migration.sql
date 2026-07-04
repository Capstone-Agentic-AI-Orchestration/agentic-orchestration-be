CREATE TYPE "ProjectTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE');

CREATE TABLE "project_tasks" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "artifactId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "ProjectTaskStatus" NOT NULL DEFAULT 'TODO',
  "assignedToId" UUID,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_tasks_projectId_status_idx" ON "project_tasks"("projectId", "status");
CREATE INDEX "project_tasks_assignedToId_status_idx" ON "project_tasks"("assignedToId", "status");
CREATE INDEX "project_tasks_artifactId_idx" ON "project_tasks"("artifactId");

ALTER TABLE "project_tasks"
  ADD CONSTRAINT "project_tasks_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_tasks"
  ADD CONSTRAINT "project_tasks_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_tasks"
  ADD CONSTRAINT "project_tasks_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_tasks"
  ADD CONSTRAINT "project_tasks_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
