CREATE TYPE "ArtifactValidationStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED');

ALTER TABLE "Artifact"
  ADD COLUMN "validationStatus" "ArtifactValidationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "validationSummary" TEXT,
  ADD COLUMN "validationErrors" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX "Artifact_projectId_validationStatus_idx" ON "Artifact"("projectId", "validationStatus");
