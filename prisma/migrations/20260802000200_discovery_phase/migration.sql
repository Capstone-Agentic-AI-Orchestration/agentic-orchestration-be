-- Separate accepting a lead from starting delivery.
--
-- Approving an inquiry used to create a delivery-ready project immediately. In practice the PM
-- first talks to the client and collects documents, and only then commits to building. Adding a
-- pre-delivery state lets that conversation happen in a real workspace - with the conversation
-- thread, document upload, extraction and intake form all working - without the project counting
-- as delivery work or being able to start orchestration.
--
-- Both are additive enum values, so existing rows are unaffected.

ALTER TYPE "projects"."ProjectStatus" ADD VALUE IF NOT EXISTS 'DISCOVERY' BEFORE 'PENDING';

ALTER TYPE "intake"."InquiryStatus" ADD VALUE IF NOT EXISTS 'IN_DISCOVERY' BEFORE 'APPROVED';
