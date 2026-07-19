-- Client intake workflow, document extraction metadata, and immutable orchestration handoff.

CREATE TYPE intake."ProjectIntakeStatus" AS ENUM (
  'DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'READY', 'LOCKED', 'SUPERSEDED'
);

CREATE TYPE intake."DocumentExtractionStatus" AS ENUM (
  'PENDING', 'EXTRACTING', 'READY', 'FAILED'
);

ALTER TYPE notifications."NotificationType" ADD VALUE IF NOT EXISTS 'INTAKE_SUBMITTED';
ALTER TYPE notifications."NotificationType" ADD VALUE IF NOT EXISTS 'INTAKE_CHANGES_REQUESTED';
ALTER TYPE notifications."NotificationType" ADD VALUE IF NOT EXISTS 'INTAKE_READY';
ALTER TYPE notifications."NotificationType" ADD VALUE IF NOT EXISTS 'INTAKE_LOCKED';

ALTER TYPE projects."ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'INTAKE_SUBMITTED';
ALTER TYPE projects."ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'INTAKE_CHANGES_REQUESTED';
ALTER TYPE projects."ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'INTAKE_READY';
ALTER TYPE projects."ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'INTAKE_LOCKED';

ALTER TABLE collaboration.collaboration_documents
  ADD COLUMN IF NOT EXISTS "storageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "mimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "sizeBytes" INTEGER,
  ADD COLUMN IF NOT EXISTS "sha256" TEXT;

CREATE INDEX IF NOT EXISTS collaboration_documents_project_sha256_idx
  ON collaboration.collaboration_documents ("projectId", "sha256");

CREATE TABLE intake.project_intakes (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}',
  status intake."ProjectIntakeStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById" UUID,
  "submittedById" UUID,
  "submittedAt" TIMESTAMPTZ,
  "reviewedById" UUID,
  "reviewNote" TEXT,
  "reviewedAt" TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX project_intakes_status_updated_idx ON intake.project_intakes (status, "updatedAt");
CREATE INDEX project_intakes_created_by_idx ON intake.project_intakes ("createdById");
CREATE INDEX project_intakes_submitted_by_idx ON intake.project_intakes ("submittedById");
CREATE INDEX project_intakes_reviewed_by_idx ON intake.project_intakes ("reviewedById");

CREATE TABLE intake.project_intake_comments (
  id TEXT PRIMARY KEY,
  "intakeId" TEXT NOT NULL,
  section TEXT NOT NULL,
  message TEXT NOT NULL,
  "resolvedAt" TIMESTAMPTZ,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX project_intake_comments_intake_created_idx ON intake.project_intake_comments ("intakeId", "createdAt");
CREATE INDEX project_intake_comments_created_by_idx ON intake.project_intake_comments ("createdById");

CREATE TABLE intake.project_intake_snapshots (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "intakeId" TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  "contextPackage" JSONB NOT NULL,
  "pmNotes" TEXT,
  "lockedById" UUID,
  "lockedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("projectId", version)
);

CREATE INDEX project_intake_snapshots_intake_created_idx ON intake.project_intake_snapshots ("intakeId", "createdAt");
CREATE INDEX project_intake_snapshots_locked_by_idx ON intake.project_intake_snapshots ("lockedById");

CREATE TABLE intake.document_extractions (
  id TEXT PRIMARY KEY,
  "documentId" TEXT NOT NULL UNIQUE,
  status intake."DocumentExtractionStatus" NOT NULL DEFAULT 'PENDING',
  "extractedText" TEXT,
  "sourceLocations" JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  "extractedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX document_extractions_status_updated_idx ON intake.document_extractions (status, "updatedAt");

ALTER TABLE orchestration.orchestration_runs
  ADD COLUMN IF NOT EXISTS "intakeSnapshotId" TEXT;
CREATE INDEX IF NOT EXISTS orchestration_runs_intake_snapshot_idx
  ON orchestration.orchestration_runs ("intakeSnapshotId");
