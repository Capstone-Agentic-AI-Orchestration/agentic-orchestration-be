CREATE TYPE "InquiryStatus" AS ENUM ('NEW', 'APPROVED', 'REJECTED');

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INQUIRY_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INQUIRY_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INQUIRY_REJECTED';

CREATE TABLE "client_inquiries" (
  "id" TEXT NOT NULL,
  "companyName" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "role" TEXT,
  "brief" TEXT NOT NULL,
  "stackKey" TEXT NOT NULL DEFAULT 'nextjs-nestjs-supabase',
  "budgetRange" TEXT,
  "timeline" TEXT,
  "status" "InquiryStatus" NOT NULL DEFAULT 'NEW',
  "reviewNote" TEXT,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMP(3),
  "approvedProjectId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "client_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_inquiries_status_createdAt_idx" ON "client_inquiries"("status", "createdAt");
CREATE INDEX "client_inquiries_email_idx" ON "client_inquiries"("email");
CREATE INDEX "client_inquiries_reviewedById_idx" ON "client_inquiries"("reviewedById");

ALTER TABLE "client_inquiries"
  ADD CONSTRAINT "client_inquiries_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
