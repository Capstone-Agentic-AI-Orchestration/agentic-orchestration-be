-- A request a client is still writing, before it is sent to a project manager.
--
-- Added ahead of NEW in the enum's order rather than appended, so `ORDER BY status` still reads
-- as the lifecycle it describes. That means a rebuild of the type: PostgreSQL can only ADD VALUE
-- at the end, and ADD VALUE cannot run inside a transaction block anyway, which a Prisma migration
-- always is.
--
-- Nothing is DRAFT yet -- the status is younger than every row in the table -- so this is a pure
-- relabelling of an existing type and no data moves.

ALTER TYPE "intake"."InquiryStatus" RENAME TO "InquiryStatus_old";

CREATE TYPE "intake"."InquiryStatus" AS ENUM ('DRAFT', 'NEW', 'IN_DISCOVERY', 'APPROVED', 'REJECTED');

ALTER TABLE "intake"."client_inquiries"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "intake"."InquiryStatus"
    USING ("status"::text::"intake"."InquiryStatus"),
  ALTER COLUMN "status" SET DEFAULT 'NEW';

DROP TYPE "intake"."InquiryStatus_old";
