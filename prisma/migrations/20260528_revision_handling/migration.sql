ALTER TABLE "Artifact"
  ADD COLUMN "revisionHandledAt" TIMESTAMP(3),
  ADD COLUMN "revisionHandledById" UUID,
  ADD COLUMN "revisionResolutionNote" TEXT;
