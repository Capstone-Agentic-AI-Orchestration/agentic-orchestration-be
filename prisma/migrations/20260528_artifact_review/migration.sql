CREATE TYPE "ArtifactReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REVISION_REQUESTED');

ALTER TABLE "Artifact"
  ADD COLUMN "reviewStatus" "ArtifactReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" UUID;
