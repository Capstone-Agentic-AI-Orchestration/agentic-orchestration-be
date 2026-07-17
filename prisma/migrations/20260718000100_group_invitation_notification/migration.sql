-- Add GROUP_INVITATION_SENT to the notifications.NotificationType enum so group
-- invites can push a system notification to the invited member.
ALTER TYPE "notifications"."NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_INVITATION_SENT';
