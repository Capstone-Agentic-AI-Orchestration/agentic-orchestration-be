CREATE INDEX IF NOT EXISTS "GateEvent_projectId_idx"
  ON public."GateEvent"("projectId");

CREATE INDEX IF NOT EXISTS "Artifact_projectId_idx"
  ON public."Artifact"("projectId");

DROP POLICY IF EXISTS "profiles_select_self_or_manager" ON public.profiles;
CREATE POLICY "profiles_select_self_or_manager"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR private.is_platform_manager()
  );

DROP POLICY IF EXISTS "project_members_select_accessible_project" ON public.project_members;
CREATE POLICY "project_members_select_accessible_project"
  ON public.project_members
  FOR SELECT
  TO authenticated
  USING (
    "userId" = (SELECT auth.uid())
    OR private.can_access_project("projectId")
  );
