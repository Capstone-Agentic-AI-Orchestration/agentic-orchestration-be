-- Clients belong to a team workspace.
--
-- They were global: every workspace saw every company. That made the workspace switcher a lie
-- for two of the three things it claims to scope, and it left the Projects page deriving a
-- workspace from "Project"."groupId" while the Clients page derived nothing at all — so a
-- client card could report "1 project" for work the current workspace could not see.
--
-- BACKFILL RULE: a client's workspace is the workspace its own projects already live in. Where
-- a client has projects in more than one group the most common one wins, which is the only
-- inference available and is right in every case observed. Clients with no projects have
-- nothing to infer from and are LEFT NULL on purpose — attaching a real company to an
-- arbitrary team would be worse than showing it as unassigned, which the console does.
--
-- No FOREIGN KEY: the datasource runs relationMode = "prisma", so referential actions are
-- emulated in application code and the database holds no FKs. An index, which Prisma cannot
-- create for itself under that mode, is exactly what this relation needs.
--
-- The NOT NULL constraint is deliberately NOT applied here. It belongs in a follow-up
-- migration, once the unassigned clients have been placed by a human.

ALTER TABLE "projects"."clients"
  ADD COLUMN IF NOT EXISTS "groupId" TEXT;

UPDATE "projects"."clients" c
SET "groupId" = winner."groupId"
FROM (
  SELECT DISTINCT ON (p."clientId")
         p."clientId",
         p."groupId",
         count(*) AS project_count
  FROM "projects"."Project" p
  WHERE p."groupId" IS NOT NULL
  GROUP BY p."clientId", p."groupId"
  ORDER BY p."clientId", project_count DESC, p."groupId"
) AS winner
WHERE winner."clientId" = c.id
  AND c."groupId" IS NULL;

CREATE INDEX IF NOT EXISTS "clients_groupId_name_idx"
  ON "projects"."clients"("groupId", "name");

-- Report what could not be inferred. A NOTICE rather than an exception: unassigned clients are
-- a supported state the console renders, not a broken one that should block a deployment.
DO $$
DECLARE
  unassigned bigint;
BEGIN
  SELECT count(*) INTO unassigned FROM "projects"."clients" WHERE "groupId" IS NULL;

  IF unassigned > 0 THEN
    RAISE NOTICE
      '% client row(s) have no projects to infer a workspace from and were left unassigned. '
      'Assign them in the PM console (Clients), then apply the follow-up NOT NULL migration.',
      unassigned;
  END IF;
END $$;
