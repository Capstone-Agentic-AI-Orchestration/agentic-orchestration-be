ALTER TABLE "project_delivery_reviews"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "project_delivery_reviews_projectId_version_idx" ON "project_delivery_reviews"("projectId", "version");
