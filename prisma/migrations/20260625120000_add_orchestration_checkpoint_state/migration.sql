-- Eve migration: durable run-state snapshot for the OrchestrationSequencer.
-- Replaces the LangGraph PostgresSaver checkpointer — the serialized DevFlowState is persisted
-- here after each node so a run can resume after a gate pause or a restart.
ALTER TABLE "orchestration"."orchestration_runs" ADD COLUMN IF NOT EXISTS "checkpointState" JSONB;
