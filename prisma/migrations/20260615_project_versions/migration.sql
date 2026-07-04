ALTER TABLE "Project"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "Project_id_version_idx" ON "Project"("id", "version");
