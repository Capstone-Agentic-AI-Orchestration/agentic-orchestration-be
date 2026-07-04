CREATE TYPE "UserRole" AS ENUM ('CLIENT', 'PM', 'DEV', 'ADMIN');

CREATE TABLE "profiles" (
  "id" UUID NOT NULL,
  "email" TEXT,
  "fullName" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'CLIENT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");

COMMENT ON TABLE "profiles" IS
  'Application-owned identity profile. id stores the upstream Supabase Auth user UUID, but profiles intentionally do not FK into auth.users so Prisma migrations stay schema-local and the identity boundary can be extracted independently.';

ALTER TABLE "Project"
  ADD COLUMN "createdById" UUID;

CREATE INDEX "Project_createdById_idx" ON "Project"("createdById");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "project_members" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "role" "UserRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_members_projectId_userId_key"
  ON "project_members"("projectId", "userId");

CREATE INDEX "project_members_userId_idx"
  ON "project_members"("userId");

ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
