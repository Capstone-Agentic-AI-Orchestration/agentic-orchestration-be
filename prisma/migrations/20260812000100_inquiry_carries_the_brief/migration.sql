-- A lead carries its own requirements, before anyone approves it.
--
-- The order used to be: client sends a sentence, a project manager approves, a project appears, and
-- only then can the client describe what they actually want. The client waited on us twice before
-- saying anything substantial, and the project manager approved a scope they had not read.
--
-- This column lets the guided conversation happen first. Its shape is ClientIntakePayload — the same
-- structure project_intakes.payload already holds — so approval copies it across rather than
-- converting between two formats that would inevitably drift.
--
-- Nullable, and no backfill. A lead from the marketing form legitimately has nothing here, and the
-- rows already in this table pre-date the conversation entirely; inventing an empty payload for them
-- would make "never asked" indistinguishable from "asked and answered nothing".
ALTER TABLE intake.client_inquiries
  ADD COLUMN "payload" JSONB;
