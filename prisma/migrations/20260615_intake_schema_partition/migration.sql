-- Keep intake-owned data in its own service schema.

CREATE SCHEMA IF NOT EXISTS intake;

ALTER TYPE collaboration."InquiryStatus" SET SCHEMA intake;
ALTER TYPE collaboration."ClientInviteStatus" SET SCHEMA intake;
ALTER TABLE IF EXISTS collaboration.client_inquiries SET SCHEMA intake;
ALTER TABLE IF EXISTS collaboration.client_invites SET SCHEMA intake;
