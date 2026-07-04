CREATE TYPE "ClientInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

CREATE TABLE "client_invites" (
  "id" TEXT NOT NULL,
  "inquiryId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "companyName" TEXT NOT NULL,
  "status" "ClientInviteStatus" NOT NULL DEFAULT 'PENDING',
  "createdById" UUID,
  "acceptedById" UUID,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "client_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_invites_inquiryId_key" ON "client_invites"("inquiryId");
CREATE UNIQUE INDEX "client_invites_projectId_key" ON "client_invites"("projectId");
CREATE INDEX "client_invites_email_status_idx" ON "client_invites"("email", "status");
CREATE INDEX "client_invites_createdById_idx" ON "client_invites"("createdById");
CREATE INDEX "client_invites_acceptedById_idx" ON "client_invites"("acceptedById");

ALTER TABLE "client_invites"
  ADD CONSTRAINT "client_invites_inquiryId_fkey"
  FOREIGN KEY ("inquiryId") REFERENCES "client_inquiries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_invites"
  ADD CONSTRAINT "client_invites_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_invites"
  ADD CONSTRAINT "client_invites_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_invites"
  ADD CONSTRAINT "client_invites_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
