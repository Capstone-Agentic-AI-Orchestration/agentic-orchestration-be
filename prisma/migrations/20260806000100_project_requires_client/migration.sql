-- Every project must belong to a client. Client first, then project.
--
-- "Project"."clientId" was nullable, so a project could exist with nobody to deliver it to.
-- That state cost more than it bought: an "unassigned projects" mop-up screen existed only to
-- resolve it, and every surface reading through to the client had to treat absence as normal.
--
-- This migration is written to FAIL rather than damage data. Making the column NOT NULL when
-- orphaned rows exist would either abort with a bare Postgres error or, if someone "fixed" it
-- with a DEFAULT, silently attach real projects to an arbitrary client. The guard below aborts
-- with an explanation and leaves everything untouched.
--
-- At the time of writing all rows were already linked, so this is a no-op assertion here. It
-- matters for any other environment that reaches this migration with older data.
DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned FROM projects."Project" WHERE "clientId" IS NULL;

  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Cannot require a client on % project row(s) that have none. Link each project to a client '
      'first (PM console > Clients > Unassigned projects), then re-run this migration. No changes '
      'were made.', orphaned;
  END IF;
END $$;

ALTER TABLE projects."Project"
  ALTER COLUMN "clientId" SET NOT NULL;
