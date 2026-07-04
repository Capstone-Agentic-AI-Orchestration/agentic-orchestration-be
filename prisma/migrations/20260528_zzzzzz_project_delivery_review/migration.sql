CREATE TYPE "ProjectDeliveryReviewStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVISION_REQUESTED', 'REVISION_RESOLVED');

ALTER TYPE "NotificationType" ADD VALUE 'DELIVERY_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'DELIVERY_REVISION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'DELIVERY_REVISION_RESOLVED';

ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'DELIVERY_ACCEPTED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'DELIVERY_REVISION_REQUESTED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'DELIVERY_REVISION_RESOLVED';

CREATE TABLE "project_delivery_reviews" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "status" "ProjectDeliveryReviewStatus" NOT NULL DEFAULT 'PENDING',
  "acceptanceNote" TEXT,
  "acceptedById" UUID,
  "acceptedAt" TIMESTAMP(3),
  "revisionNote" TEXT,
  "revisionRequestedById" UUID,
  "revisionRequestedAt" TIMESTAMP(3),
  "revisionResolvedById" UUID,
  "revisionResolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_delivery_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_delivery_reviews_projectId_key" ON "project_delivery_reviews"("projectId");
CREATE INDEX "project_delivery_reviews_status_idx" ON "project_delivery_reviews"("status");
CREATE INDEX "project_delivery_reviews_acceptedById_idx" ON "project_delivery_reviews"("acceptedById");
CREATE INDEX "project_delivery_reviews_revisionRequestedById_idx" ON "project_delivery_reviews"("revisionRequestedById");
CREATE INDEX "project_delivery_reviews_revisionResolvedById_idx" ON "project_delivery_reviews"("revisionResolvedById");

ALTER TABLE "project_delivery_reviews"
  ADD CONSTRAINT "project_delivery_reviews_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_delivery_reviews"
  ADD CONSTRAINT "project_delivery_reviews_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_delivery_reviews"
  ADD CONSTRAINT "project_delivery_reviews_revisionRequestedById_fkey"
  FOREIGN KEY ("revisionRequestedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_delivery_reviews"
  ADD CONSTRAINT "project_delivery_reviews_revisionResolvedById_fkey"
  FOREIGN KEY ("revisionResolvedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
