-- Clients who sign in before a PM approves their inquiry are held in PENDING.
-- Existing profiles keep their current status; only new sign-ins can land here.
ALTER TYPE "identity"."ProfileStatus" ADD VALUE IF NOT EXISTS 'PENDING' BEFORE 'ACTIVE';
