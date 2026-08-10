-- A conversation belongs to a project OR to a client, never both.
--
-- The project manager's conversation with a company was stored inside a project, so it lived in
-- whichever build happened to be open when someone started typing. The relationship outlives any
-- single build: when the same company commissions a second project, its history stayed behind in
-- the first project's tab and the new one started from nothing. Threads about a build stay on the
-- project — a developer discussing the code genuinely is talking about that project — but threads
-- with the client move up to the client.
--
-- Four steps, in this order and no other:
--   1. assert every CLIENT thread has somewhere to go
--   2. add the column, relax the old NOT NULLs
--   3. move the CLIENT threads
--   4. only then constrain, so the constraint describes data that already satisfies it
--
-- Adding the CHECK before the backfill would abort on the first pre-existing row, and relaxing
-- the NOT NULL after it would abort on the first UPDATE. Neither is recoverable mid-migration.

-- 1. Guard. `projects."Project"."clientId"` has been NOT NULL since
--    20260806000100_project_requires_client, so on any database that reached this migration in
--    order the count is zero and this is a no-op assertion. It is here for the database that did
--    not: a CLIENT thread hanging off a project with no client has no client to be moved to, and
--    the alternatives are inventing one or silently leaving the thread project-scoped where the
--    console will no longer show it. Both are worse than stopping.
DO $$
DECLARE
  unmovable bigint;
BEGIN
  SELECT count(*) INTO unmovable
  FROM collaboration.project_conversations c
  JOIN projects."Project" p ON p.id = c."projectId"
  WHERE c.visibility = 'CLIENT'
    AND p."clientId" IS NULL;

  IF unmovable > 0 THEN
    RAISE EXCEPTION
      'Cannot move % client conversation(s) to a client: their project has none. Link those '
      'projects to a client first (PM console > Projects > the project > Link a client), then '
      're-run this migration. No changes were made.', unmovable;
  END IF;
END $$;

-- 2. Widen. Both columns become nullable because from here on each row uses exactly one of them.
ALTER TABLE collaboration.project_conversations
  ADD COLUMN "clientId" TEXT;

ALTER TABLE collaboration.project_conversations
  ALTER COLUMN "projectId" DROP NOT NULL;

-- project_messages."projectId" is a denormalised mirror of its conversation's owner, kept for
-- project-scoped reporting. It goes null on a client thread for the same reason the conversation's
-- does. Read paths key on "conversationId" and never on this column.
ALTER TABLE collaboration.project_messages
  ALTER COLUMN "projectId" DROP NOT NULL;

ALTER TABLE collaboration.project_conversations
  ADD CONSTRAINT "project_conversations_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES projects."clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "project_conversations_clientId_visibility_lastMessageAt_idx"
  ON collaboration.project_conversations("clientId", "visibility", "lastMessageAt");

-- 3. Move the client threads up to their client. TEAM threads are untouched: those are the
--    developer-and-project-manager delivery threads, which stay where they are.
--
--    Messages first. Once step 3b nulls the conversation's "projectId" the join that finds these
--    rows is gone, and they would be left claiming a project their thread no longer belongs to.
UPDATE collaboration.project_messages m
SET "projectId" = NULL
WHERE EXISTS (
  SELECT 1
  FROM collaboration.project_conversations c
  WHERE c.id = m."conversationId"
    AND c.visibility = 'CLIENT'
    AND c."projectId" IS NOT NULL
);

-- 3b. The conversations themselves.
UPDATE collaboration.project_conversations c
SET "clientId" = p."clientId",
    "projectId" = NULL
FROM projects."Project" p
WHERE p.id = c."projectId"
  AND c.visibility = 'CLIENT';

-- 4. Constrain. Exactly one owner — Prisma cannot express this, so it is the database's job.
--    Without it "neither set" is reachable through any write path that forgets both, and the row
--    is then invisible to every read: it belongs to no project and no client, so nothing lists it.
ALTER TABLE collaboration.project_conversations
  ADD CONSTRAINT "project_conversations_single_owner"
  CHECK (("projectId" IS NULL) <> ("clientId" IS NULL));
