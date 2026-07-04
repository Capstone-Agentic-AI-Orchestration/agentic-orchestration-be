CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.current_user_role()
RETURNS public."UserRole"
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION private.is_platform_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, auth
AS $$
  SELECT private.current_user_role() IN ('PM'::public."UserRole", 'ADMIN'::public."UserRole")
$$;

CREATE OR REPLACE FUNCTION private.can_access_project(project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."Project" p
    WHERE p.id = project_id
      AND (
        p."createdById" = auth.uid()
        OR private.is_platform_manager()
        OR EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm."projectId" = p.id
            AND pm."userId" = auth.uid()
        )
      )
  )
$$;

REVOKE ALL ON FUNCTION private.current_user_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_platform_manager() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.can_access_project(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_platform_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_access_project(text) TO authenticated;

DROP POLICY IF EXISTS "profiles_select_self_or_manager" ON public.profiles;
CREATE POLICY "profiles_select_self_or_manager"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR private.is_platform_manager()
  );

DROP POLICY IF EXISTS "project_members_select_accessible_project" ON public.project_members;
CREATE POLICY "project_members_select_accessible_project"
  ON public.project_members
  FOR SELECT
  TO authenticated
  USING (
    "userId" = auth.uid()
    OR private.can_access_project("projectId")
  );

DROP POLICY IF EXISTS "projects_select_accessible" ON public."Project";
CREATE POLICY "projects_select_accessible"
  ON public."Project"
  FOR SELECT
  TO authenticated
  USING (private.can_access_project(id));

DROP POLICY IF EXISTS "gate_events_select_accessible_project" ON public."GateEvent";
CREATE POLICY "gate_events_select_accessible_project"
  ON public."GateEvent"
  FOR SELECT
  TO authenticated
  USING (private.can_access_project("projectId"));

DROP POLICY IF EXISTS "artifacts_select_accessible_project" ON public."Artifact";
CREATE POLICY "artifacts_select_accessible_project"
  ON public."Artifact"
  FOR SELECT
  TO authenticated
  USING (private.can_access_project("projectId"));

DROP POLICY IF EXISTS "event_logs_select_accessible_project" ON public.event_logs;
CREATE POLICY "event_logs_select_accessible_project"
  ON public.event_logs
  FOR SELECT
  TO authenticated
  USING (private.can_access_project("projectId"));

DROP POLICY IF EXISTS "run_budgets_select_accessible_project" ON public.run_budgets;
CREATE POLICY "run_budgets_select_accessible_project"
  ON public.run_budgets
  FOR SELECT
  TO authenticated
  USING (private.can_access_project("projectId"));

DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DROP POLICY IF EXISTS "deny_client_access" ON public._prisma_migrations;
    CREATE POLICY "deny_client_access"
      ON public._prisma_migrations
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;

  IF to_regclass('public.agent_memories') IS NOT NULL THEN
    DROP POLICY IF EXISTS "deny_client_access" ON public.agent_memories;
    CREATE POLICY "deny_client_access"
      ON public.agent_memories
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;

  IF to_regclass('public.checkpoint_migrations') IS NOT NULL THEN
    DROP POLICY IF EXISTS "deny_client_access" ON public.checkpoint_migrations;
    CREATE POLICY "deny_client_access"
      ON public.checkpoint_migrations
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;

  IF to_regclass('public.checkpoints') IS NOT NULL THEN
    DROP POLICY IF EXISTS "deny_client_access" ON public.checkpoints;
    CREATE POLICY "deny_client_access"
      ON public.checkpoints
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;

  IF to_regclass('public.checkpoint_blobs') IS NOT NULL THEN
    DROP POLICY IF EXISTS "deny_client_access" ON public.checkpoint_blobs;
    CREATE POLICY "deny_client_access"
      ON public.checkpoint_blobs
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;

  IF to_regclass('public.checkpoint_writes') IS NOT NULL THEN
    DROP POLICY IF EXISTS "deny_client_access" ON public.checkpoint_writes;
    CREATE POLICY "deny_client_access"
      ON public.checkpoint_writes
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.can_access_project(text);
DROP FUNCTION IF EXISTS public.is_platform_manager();
DROP FUNCTION IF EXISTS public.current_user_role();
