ALTER TABLE "collaboration_documents"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "collaboration_documents_id_version_idx" ON "collaboration_documents"("id", "version");
