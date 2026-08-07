-- Record which prompt produced a run.
--
-- Agent instructions became editable when workspace agents landed. That creates a gap nothing
-- else closes: the prompt that produced an artifact may since have been rewritten, so a run
-- cannot be explained after the fact. The model was already recorded; the prompt was not.
--
-- A hash rather than the text. The assembled system prompt carries the contract, retrieved
-- memory and prior feedback, so storing it per invocation would dwarf every other column. The
-- hash answers what is actually asked — did the prompt change between these two runs, which runs
-- shared one — and `promptChars` makes prompt bloat visible without storing anything sensitive.
--
-- Both nullable: existing rows predate the column and there is nothing to backfill from. A null
-- means "recorded before this existed", not "no prompt".

ALTER TABLE "orchestration"."provider_invocations"
  ADD COLUMN IF NOT EXISTS "promptHash" TEXT,
  ADD COLUMN IF NOT EXISTS "promptChars" INTEGER;
