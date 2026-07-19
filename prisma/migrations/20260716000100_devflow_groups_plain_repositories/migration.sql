-- DevFlow group ownership, membership, invitations, plain GitHub repositories,
-- and developer repository assignments. Repository provisioning intentionally
-- does not create GitHub Actions workflows or any other CI/CD configuration.

CREATE TYPE projects."GroupRole" AS ENUM (
  'LEAD', 'DELEGATED_LEAD', 'MEMBER', 'VIEWER'
);

CREATE TYPE projects."GroupLifecycleStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE projects."GroupMemberStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE projects."GroupInvitationStatus" AS ENUM (
  'PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'
);
CREATE TYPE projects."RepositoryStatus" AS ENUM (
  'PENDING', 'ACTIVE', 'FAILED', 'ARCHIVED'
);
CREATE TYPE projects."RepositoryAssignmentDesiredState" AS ENUM (
  'ASSIGNED', 'UNASSIGNED'
);
CREATE TYPE projects."RepositoryAssignmentEffectiveState" AS ENUM (
  'PENDING', 'ACTIVE', 'REVOKING', 'REVOKED', 'FAILED'
);

ALTER TABLE identity.profiles
  ADD COLUMN IF NOT EXISTS "githubLogin" TEXT,
  ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_github_login_key
  ON identity.profiles ("githubLogin");

CREATE TABLE projects.groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  "businessUnit" TEXT,
  status projects."GroupLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
  "ownerId" UUID NOT NULL,
  "githubInstallationId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX groups_owner_status_idx ON projects.groups ("ownerId", status);
CREATE INDEX groups_github_installation_idx ON projects.groups ("githubInstallationId");

ALTER TABLE projects."Project"
  ADD COLUMN IF NOT EXISTS "groupId" TEXT;

CREATE INDEX IF NOT EXISTS project_group_idx ON projects."Project" ("groupId");

CREATE TABLE projects.group_members (
  id TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  role projects."GroupRole" NOT NULL DEFAULT 'MEMBER',
  status projects."GroupMemberStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("groupId", "userId")
);

CREATE INDEX group_members_user_status_idx ON projects.group_members ("userId", status);
CREATE INDEX group_members_group_role_status_idx ON projects.group_members ("groupId", role, status);

CREATE TABLE projects.group_invitations (
  id TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "invitedUserId" UUID NOT NULL,
  "invitedById" UUID NOT NULL,
  role projects."GroupRole" NOT NULL DEFAULT 'MEMBER',
  status projects."GroupInvitationStatus" NOT NULL DEFAULT 'PENDING',
  "respondedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("groupId", "invitedUserId")
);

CREATE INDEX group_invitations_recipient_status_created_idx
  ON projects.group_invitations ("invitedUserId", status, "createdAt");
CREATE INDEX group_invitations_invited_by_idx
  ON projects.group_invitations ("invitedById");
CREATE INDEX group_invitations_group_status_idx
  ON projects.group_invitations ("groupId", status);

CREATE TABLE projects.repositories (
  id TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  "fullName" TEXT UNIQUE,
  "htmlUrl" TEXT,
  "cloneUrl" TEXT,
  "defaultBranch" TEXT NOT NULL DEFAULT 'main',
  visibility TEXT NOT NULL DEFAULT 'private',
  status projects."RepositoryStatus" NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "createdById" UUID NOT NULL,
  "provisionedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX repositories_group_status_idx ON projects.repositories ("groupId", status);
CREATE INDEX repositories_created_by_idx ON projects.repositories ("createdById");

CREATE TABLE projects.repository_assignments (
  id TEXT PRIMARY KEY,
  "repositoryId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "assignedById" UUID NOT NULL,
  "desiredState" projects."RepositoryAssignmentDesiredState" NOT NULL DEFAULT 'ASSIGNED',
  "effectiveState" projects."RepositoryAssignmentEffectiveState" NOT NULL DEFAULT 'PENDING',
  "githubTeamSlug" TEXT,
  "lastError" TEXT,
  "lastSyncedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("repositoryId", "userId")
);

CREATE INDEX repository_assignments_user_state_idx
  ON projects.repository_assignments ("userId", "desiredState", "effectiveState");
CREATE INDEX repository_assignments_assigned_by_idx
  ON projects.repository_assignments ("assignedById");
CREATE INDEX repository_assignments_repository_state_idx
  ON projects.repository_assignments ("repositoryId", "desiredState");

CREATE TABLE projects.group_activity_events (
  id TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "actorId" UUID,
  "eventCode" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX group_activity_group_created_idx
  ON projects.group_activity_events ("groupId", "createdAt");
CREATE INDEX group_activity_actor_idx ON projects.group_activity_events ("actorId");
CREATE INDEX group_activity_code_created_idx
  ON projects.group_activity_events ("eventCode", "createdAt");
