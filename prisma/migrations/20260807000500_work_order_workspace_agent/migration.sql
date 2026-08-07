-- Assign a configured agent to a work order.
--
-- Work orders already execute against a model; what they could not do is target an agent a
-- workspace configured. `agentType` is an enum of six and describes the OUTPUT — required
-- extensions, language, and the signals the validator checks — so it cannot also carry identity.
--
-- This is the path by which a custom agent becomes dispatchable at all. Pipeline roles stay a
-- closed set (see docs/architecture/agent-platform.md): the Gate 1 to Gate 2 fan-out is
-- contractual and must remain verifiable, so an open-ended agent belongs on a work order rather
-- than in the graph.
--
-- Nullable, so every existing work order keeps behaving exactly as before: role text derived
-- from agentType, no agent attached. No backfill.
--
-- No FOREIGN KEY, matching every migration since relationMode = "prisma"; the index is what
-- Prisma cannot create for itself under that mode.

ALTER TABLE "orchestration"."work_orders"
  ADD COLUMN IF NOT EXISTS "workspaceAgentId" TEXT;

CREATE INDEX IF NOT EXISTS "work_orders_workspaceAgentId_idx"
  ON "orchestration"."work_orders"("workspaceAgentId");
