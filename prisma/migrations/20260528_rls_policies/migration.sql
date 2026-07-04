-- Enable RLS for all public tables exposed by Supabase APIs.
-- Do not FORCE RLS: the NestJS backend connects as the table owner (`postgres`)
-- through Prisma and must keep operating without PostgREST-style JWT context.

CREATE OR REPLACE FUNCTION public.current_user_role()
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

CREATE OR REPLACE FUNCTION public.is_platform_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.current_user_role() IN ('PM'::public."UserRole", 'ADMIN'::public."UserRole")
$$;

CREATE OR REPLACE FUNCTION public.can_access_project(project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."Project" p
    WHERE p.id = project_id
      AND (
        p."createdById" = auth.uid()
        OR public.is_platform_manager()
        OR EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm."projectId" = p.id
            AND pm."userId" = auth.uid()
        )
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_project(text) TO authenticated;

ALTER TABLE public."Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."GateEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Artifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public._prisma_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.checkpoint_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.checkpoint_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.checkpoint_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_self_or_manager" ON public.profiles;
CREATE POLICY "profiles_select_self_or_manager"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR public.is_platform_manager()
  );

DROP POLICY IF EXISTS "project_members_select_accessible_project" ON public.project_members;
CREATE POLICY "project_members_select_accessible_project"
  ON public.project_members
  FOR SELECT
  TO authenticated
  USING (
    "userId" = auth.uid()
    OR public.can_access_project("projectId")
  );

DROP POLICY IF EXISTS "projects_select_accessible" ON public."Project";
CREATE POLICY "projects_select_accessible"
  ON public."Project"
  FOR SELECT
  TO authenticated
  USING (public.can_access_project(id));

DROP POLICY IF EXISTS "gate_events_select_accessible_project" ON public."GateEvent";
CREATE POLICY "gate_events_select_accessible_project"
  ON public."GateEvent"
  FOR SELECT
  TO authenticated
  USING (public.can_access_project("projectId"));

DROP POLICY IF EXISTS "artifacts_select_accessible_project" ON public."Artifact";
CREATE POLICY "artifacts_select_accessible_project"
  ON public."Artifact"
  FOR SELECT
  TO authenticated
  USING (public.can_access_project("projectId"));

DROP POLICY IF EXISTS "event_logs_select_accessible_project" ON public.event_logs;
CREATE POLICY "event_logs_select_accessible_project"
  ON public.event_logs
  FOR SELECT
  TO authenticated
  USING (public.can_access_project("projectId"));

DROP POLICY IF EXISTS "run_budgets_select_accessible_project" ON public.run_budgets;
CREATE POLICY "run_budgets_select_accessible_project"
  ON public.run_budgets
  FOR SELECT
  TO authenticated
  USING (public.can_access_project("projectId"));
