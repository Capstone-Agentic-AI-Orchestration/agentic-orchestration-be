-- Lock the user's AI Gateway model choice to the orchestration run so retries and
-- resumed work cannot silently switch models.
ALTER TABLE "orchestration"."orchestration_runs"
ADD COLUMN IF NOT EXISTS "modelSelection" JSONB;
