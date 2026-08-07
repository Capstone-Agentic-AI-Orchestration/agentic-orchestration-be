-- Every client belongs to a workspace.
--
-- The follow-up promised by 20260807000100_client_workspace_scope. That migration added the
-- column and backfilled it by inference, deliberately leaving clients with no projects unset
-- rather than attaching a real company to an arbitrary team. Those have since been assigned by a
-- human, so the state can now be forbidden outright instead of handled everywhere.
--
-- Removing the null makes the invariant the database's job. Without it, "unassigned" is a state
-- every read path has to special-case: the list query carried an `OR groupId IS NULL` clause so
-- orphans stayed visible, the console needed a badge for it, and the Projects page needed a
-- fallback for projects reached through a client with no workspace. All of that exists only to
-- handle a row that should not be creatable.
--
-- Written to FAIL rather than damage data. Setting NOT NULL with orphans present would either
-- abort with a bare Postgres error or, if someone "fixed" it with a DEFAULT, silently attach
-- real companies to whichever workspace that default named. The guard aborts with an explanation
-- and changes nothing.

DO $$
DECLARE
  unassigned bigint;
BEGIN
  SELECT count(*) INTO unassigned FROM "projects"."clients" WHERE "groupId" IS NULL;

  IF unassigned > 0 THEN
    RAISE EXCEPTION
      'Cannot require a workspace on % client row(s) that have none. Assign each one first '
      '(PM console > Clients > the client > Workspace), then re-run this migration. No changes '
      'were made.', unassigned;
  END IF;
END $$;

ALTER TABLE "projects"."clients"
  ALTER COLUMN "groupId" SET NOT NULL;
