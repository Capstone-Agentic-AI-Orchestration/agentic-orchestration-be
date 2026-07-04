ALTER TABLE "Artifact"
  ADD COLUMN "clientVisible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "sharedAt" TIMESTAMP(3);

CREATE INDEX "Artifact_projectId_clientVisible_idx" ON "Artifact"("projectId", "clientVisible");
