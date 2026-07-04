-- Partition the monolithic public schema into service-owned schemas while keeping
-- a single Supabase Postgres database.

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS projects;
CREATE SCHEMA IF NOT EXISTS collaboration;
CREATE SCHEMA IF NOT EXISTS orchestration;
CREATE SCHEMA IF NOT EXISTS memory;
CREATE SCHEMA IF NOT EXISTS notifications;
CREATE SCHEMA IF NOT EXISTS admin;
CREATE SCHEMA IF NOT EXISTS scheduling;
CREATE SCHEMA IF NOT EXISTS integration;

-- Identity service
ALTER TYPE public."UserRole" SET SCHEMA identity;
ALTER TYPE public."ProfileStatus" SET SCHEMA identity;
ALTER TYPE public."DeveloperAvailabilityStatus" SET SCHEMA identity;
ALTER TABLE IF EXISTS public.profiles SET SCHEMA identity;
ALTER TABLE IF EXISTS public.developer_profiles SET SCHEMA identity;

-- Project service
ALTER TYPE public."ProjectStatus" SET SCHEMA projects;
ALTER TYPE public."GateType" SET SCHEMA projects;
ALTER TYPE public."GateDecision" SET SCHEMA projects;
ALTER TYPE public."ProjectKickoffStatus" SET SCHEMA projects;
ALTER TYPE public."ProjectTaskStatus" SET SCHEMA projects;
ALTER TYPE public."ProjectTaskActivityType" SET SCHEMA projects;
ALTER TYPE public."ArtifactReviewStatus" SET SCHEMA projects;
ALTER TYPE public."ArtifactOutputReviewStatus" SET SCHEMA projects;
ALTER TYPE public."ArtifactValidationStatus" SET SCHEMA projects;
ALTER TYPE public."ProjectTimelineEventType" SET SCHEMA projects;
ALTER TYPE public."ProjectTimelineVisibility" SET SCHEMA projects;
ALTER TYPE public."ProjectDeliveryReviewStatus" SET SCHEMA projects;
ALTER TABLE IF EXISTS public."Project" SET SCHEMA projects;
ALTER TABLE IF EXISTS public."GateEvent" SET SCHEMA projects;
ALTER TABLE IF EXISTS public."Artifact" SET SCHEMA projects;
ALTER TABLE IF EXISTS public.project_members SET SCHEMA projects;
ALTER TABLE IF EXISTS public.project_tasks SET SCHEMA projects;
ALTER TABLE IF EXISTS public.project_task_activities SET SCHEMA projects;
ALTER TABLE IF EXISTS public.project_timeline_events SET SCHEMA projects;
ALTER TABLE IF EXISTS public.project_kickoffs SET SCHEMA projects;
ALTER TABLE IF EXISTS public.project_delivery_reviews SET SCHEMA projects;

-- Collaboration service
ALTER TYPE public."InquiryStatus" SET SCHEMA collaboration;
ALTER TYPE public."ClientInviteStatus" SET SCHEMA collaboration;
ALTER TYPE public."CollaborationVisibility" SET SCHEMA collaboration;
ALTER TYPE public."ConversationCategory" SET SCHEMA collaboration;
ALTER TYPE public."CollaborationDocumentKind" SET SCHEMA collaboration;
ALTER TYPE public."CollaborationDocumentStatus" SET SCHEMA collaboration;
ALTER TABLE IF EXISTS public.client_inquiries SET SCHEMA collaboration;
ALTER TABLE IF EXISTS public.client_invites SET SCHEMA collaboration;
ALTER TABLE IF EXISTS public.project_conversations SET SCHEMA collaboration;
ALTER TABLE IF EXISTS public.project_messages SET SCHEMA collaboration;
ALTER TABLE IF EXISTS public.conversation_reads SET SCHEMA collaboration;
ALTER TABLE IF EXISTS public.collaboration_documents SET SCHEMA collaboration;

-- Orchestration service
ALTER TYPE public."WorkOrderAgentType" SET SCHEMA orchestration;
ALTER TYPE public."WorkOrderStatus" SET SCHEMA orchestration;
ALTER TYPE public."WorkOrderPriority" SET SCHEMA orchestration;
ALTER TYPE public."OrchestrationRunStatus" SET SCHEMA orchestration;
ALTER TYPE public."OrchestrationRunTrigger" SET SCHEMA orchestration;
ALTER TYPE public."WorkOrderExecutionStatus" SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.work_orders SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.orchestration_runs SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.work_order_executions SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.event_logs SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.run_budgets SET SCHEMA orchestration;

-- Memory service
ALTER TYPE public."AgentMemoryScope" SET SCHEMA memory;
ALTER TYPE public."AgentMemoryType" SET SCHEMA memory;
ALTER TABLE IF EXISTS public.agent_profiles SET SCHEMA memory;
ALTER TABLE IF EXISTS public.agent_memories SET SCHEMA memory;

-- Notification service
ALTER TYPE public."NotificationType" SET SCHEMA notifications;
ALTER TABLE IF EXISTS public.notifications SET SCHEMA notifications;

-- Admin service
ALTER TYPE public."AdminDomainStatus" SET SCHEMA admin;
ALTER TABLE IF EXISTS public.admin_domains SET SCHEMA admin;
ALTER TABLE IF EXISTS public.admin_audit_logs SET SCHEMA admin;
ALTER TABLE IF EXISTS public.platform_settings SET SCHEMA admin;

-- Scheduling service
ALTER TYPE public."ScheduleEventType" SET SCHEMA scheduling;
ALTER TYPE public."ScheduleVisibility" SET SCHEMA scheduling;
ALTER TABLE IF EXISTS public.schedule_events SET SCHEMA scheduling;

-- Integration service
ALTER TYPE public."IntegrationOutboxStatus" SET SCHEMA integration;
ALTER TYPE public."IdempotencyRecordStatus" SET SCHEMA integration;
ALTER TABLE IF EXISTS public.integration_outbox SET SCHEMA integration;
ALTER TABLE IF EXISTS public.idempotency_records SET SCHEMA integration;
