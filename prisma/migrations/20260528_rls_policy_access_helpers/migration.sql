-- The following performance migration rewrites policies to use private helper
-- functions. Create those helpers before the rewrite; the later private helper
-- hardening migration remains idempotent and reapplies grants/policies.

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
