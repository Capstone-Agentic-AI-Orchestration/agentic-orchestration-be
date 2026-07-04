CREATE TYPE "ProjectKickoffStatus" AS ENUM ('DRAFT', 'READY', 'LOCKED');

CREATE TABLE "project_kickoffs" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "scopeSummary" TEXT,
  "milestones" TEXT,
  "requiredDocuments" TEXT,
  "techStackNotes" TEXT,
  "deliveryRoles" TEXT,
  "readinessNotes" TEXT,
  "scopeConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "milestonesConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "documentsConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "techStackConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "rolesConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "clientAccessConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "initialTasksCreated" BOOLEAN NOT NULL DEFAULT false,
  "initialWorkOrdersCreated" BOOLEAN NOT NULL DEFAULT false,
  "status" "ProjectKickoffStatus" NOT NULL DEFAULT 'DRAFT',
  "completedById" UUID,
  "completedAt" TIMESTAMP(3),
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_kickoffs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_kickoffs_projectId_key" ON "project_kickoffs"("projectId");
CREATE INDEX "project_kickoffs_status_idx" ON "project_kickoffs"("status");
CREATE INDEX "project_kickoffs_completedById_idx" ON "project_kickoffs"("completedById");
CREATE INDEX "project_kickoffs_updatedById_idx" ON "project_kickoffs"("updatedById");

ALTER TABLE "project_kickoffs"
  ADD CONSTRAINT "project_kickoffs_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_kickoffs"
  ADD CONSTRAINT "project_kickoffs_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_kickoffs"
  ADD CONSTRAINT "project_kickoffs_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
