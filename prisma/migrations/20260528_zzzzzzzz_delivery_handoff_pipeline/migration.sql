CREATE TYPE "ArtifactOutputReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REWORK_REQUESTED', 'PUBLISHED');

ALTER TYPE "NotificationType" ADD VALUE 'ARTIFACT_PUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'ARTIFACT_REWORK_REQUESTED';

ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'ARTIFACT_OUTPUT_REVIEWED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'ARTIFACT_PUBLISHED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'ARTIFACT_REWORK_REQUESTED';

ALTER TABLE "Artifact"
  ADD COLUMN "outputReviewStatus" "ArtifactOutputReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "outputReviewNote" TEXT,
  ADD COLUMN "outputReviewedAt" TIMESTAMP(3),
  ADD COLUMN "outputReviewedById" UUID,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "publishedById" UUID;

CREATE INDEX "Artifact_projectId_outputReviewStatus_idx" ON "Artifact"("projectId", "outputReviewStatus");
