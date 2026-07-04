CREATE TYPE "ScheduleEventType" AS ENUM ('MILESTONE', 'MEETING', 'DUE_DATE', 'REMINDER', 'OTHER');

CREATE TYPE "ScheduleVisibility" AS ENUM ('PRIVATE', 'TEAM', 'CLIENT');

CREATE TYPE "DeveloperAvailabilityStatus" AS ENUM ('AVAILABLE', 'LIMITED', 'UNAVAILABLE');

ALTER TABLE "profiles"
  ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "schedule_events" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3),
  "type" "ScheduleEventType" NOT NULL DEFAULT 'MEETING',
  "visibility" "ScheduleVisibility" NOT NULL DEFAULT 'TEAM',
  "projectId" TEXT,
  "ownerId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "schedule_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schedule_events_ownerId_startsAt_idx" ON "schedule_events"("ownerId", "startsAt");
CREATE INDEX "schedule_events_projectId_startsAt_idx" ON "schedule_events"("projectId", "startsAt");
CREATE INDEX "schedule_events_visibility_startsAt_idx" ON "schedule_events"("visibility", "startsAt");

ALTER TABLE "schedule_events"
  ADD CONSTRAINT "schedule_events_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "schedule_events"
  ADD CONSTRAINT "schedule_events_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "developer_profiles" (
  "userId" UUID NOT NULL,
  "skills" JSONB NOT NULL DEFAULT '[]',
  "weeklyCapacityHours" INTEGER NOT NULL DEFAULT 40,
  "availabilityStatus" "DeveloperAvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "developer_profiles_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "developer_profiles_availabilityStatus_idx" ON "developer_profiles"("availabilityStatus");

ALTER TABLE "developer_profiles"
  ADD CONSTRAINT "developer_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
