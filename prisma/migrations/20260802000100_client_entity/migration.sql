-- Introduce the Client entity.
--
-- A client used to exist only as the free-text "companyName" column on a project, so two
-- projects for the same company had no way to know they were related and there was nothing
-- stable to hang a client page off. Client is an external company; it is deliberately separate
-- from Group, which is an internal delivery team.
--
-- "Project"."clientId" is nullable on purpose: an unlinked project is surfaced as "unassigned"
-- in the console rather than being blocked at creation. "companyName" is left in place and
-- unchanged, so the ~280 existing references keep working; display resolves as
-- client.name ?? project.companyName, which cannot drift when a client is renamed.

DO $$
BEGIN
  CREATE TYPE "projects"."ClientStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "projects"."clients" (
  "id"                  TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "status"              "projects"."ClientStatus" NOT NULL DEFAULT 'ACTIVE',
  "primaryContactName"  TEXT,
  "primaryContactEmail" TEXT,
  "notes"               TEXT,
  "createdById"         UUID,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "clients_status_name_idx" ON "projects"."clients"("status", "name");
CREATE INDEX IF NOT EXISTS "clients_createdById_idx" ON "projects"."clients"("createdById");

-- Directory relationship only. Project access remains governed solely by project_members, so a
-- contact listed here may still be unable to open any project.
CREATE TABLE IF NOT EXISTS "projects"."client_contacts" (
  "id"        TEXT NOT NULL,
  "clientId"  TEXT NOT NULL,
  "profileId" UUID NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_contacts_clientId_profileId_key"
  ON "projects"."client_contacts"("clientId", "profileId");
CREATE INDEX IF NOT EXISTS "client_contacts_profileId_idx"
  ON "projects"."client_contacts"("profileId");

ALTER TABLE "projects"."Project"
  ADD COLUMN IF NOT EXISTS "clientId" TEXT;
CREATE INDEX IF NOT EXISTS "Project_clientId_idx" ON "projects"."Project"("clientId");

-- Lets a second inquiry from the same company attach to the client the first one resolved to,
-- instead of silently creating a duplicate.
ALTER TABLE "intake"."client_inquiries"
  ADD COLUMN IF NOT EXISTS "clientId" TEXT;
CREATE INDEX IF NOT EXISTS "client_inquiries_clientId_idx"
  ON "intake"."client_inquiries"("clientId");
