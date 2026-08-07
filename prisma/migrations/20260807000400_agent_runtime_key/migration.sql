-- Separate an agent's identity from the runtime that executes it.
--
-- `key` conflated two things. For the twelve built-ins they coincide — the agent named
-- "frontend" is dispatched to the Eve subagent directory named "frontend" — which is precisely
-- what hid the problem: a custom agent gets an identity with no directory behind it, so it can
-- be created and configured in the console and can never actually run.
--
-- `runtimeKey` names the deployed capability instead. Null means "same as key", so every
-- existing row keeps dispatching exactly as before and no backfill is required. Custom agents
-- point at a role-neutral runtime (generic-builder / generic-reviewer) once those are deployed.
--
-- No FOREIGN KEY: the referent is a directory in another repository, not a row. Validity is
-- checked against the live manifest at GET /eve/v1/info, which is the only thing that actually
-- knows what is deployed — a constraint here would only encode a guess.

ALTER TABLE "orchestration"."workspace_agents"
  ADD COLUMN IF NOT EXISTS "runtimeKey" TEXT;
