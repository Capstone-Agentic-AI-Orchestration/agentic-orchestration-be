-- Support separate backend / frontend / mobile repositories per project.
DO $$ BEGIN
  CREATE TYPE "projects"."RepositoryKind" AS ENUM ('BACKEND', 'FRONTEND', 'MOBILE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "projects"."repositories"
  ADD COLUMN IF NOT EXISTS "kind" "projects"."RepositoryKind" NOT NULL DEFAULT 'BACKEND';

-- Replace one-repo-per-project with one repository per (project, kind).
ALTER TABLE "projects"."repositories" DROP CONSTRAINT IF EXISTS "repositories_projectId_key";
DROP INDEX IF EXISTS "projects"."repositories_projectId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "repositories_projectId_kind_key" ON "projects"."repositories"("projectId", "kind");
