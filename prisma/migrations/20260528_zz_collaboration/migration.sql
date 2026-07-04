ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COLLAB_MESSAGE_SENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COLLAB_DOCUMENT_UPLOADED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COLLAB_DOCUMENT_REVIEWED';

ALTER TYPE "ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'COLLAB_CONVERSATION_CREATED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'COLLAB_MESSAGE_SENT';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'COLLAB_DOCUMENT_UPLOADED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE IF NOT EXISTS 'COLLAB_DOCUMENT_REVIEWED';

CREATE TYPE "CollaborationVisibility" AS ENUM ('TEAM', 'CLIENT');
CREATE TYPE "ConversationCategory" AS ENUM ('GENERAL', 'DELIVERY', 'CONTRACT', 'SUPPORT');
CREATE TYPE "CollaborationDocumentKind" AS ENUM ('REQUIREMENT', 'CONTRACT', 'DELIVERABLE', 'GENERAL');
CREATE TYPE "CollaborationDocumentStatus" AS ENUM ('DRAFT', 'UPLOADED', 'APPROVAL_REQUESTED', 'APPROVED', 'REVISION_REQUESTED', 'ARCHIVED');

CREATE TABLE "project_conversations" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category" "ConversationCategory" NOT NULL DEFAULT 'GENERAL',
  "visibility" "CollaborationVisibility" NOT NULL DEFAULT 'TEAM',
  "createdById" UUID,
  "lastMessageAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_messages" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "authorId" UUID,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_reads" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "collaboration_documents" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "artifactId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "fileName" TEXT,
  "externalUrl" TEXT,
  "kind" "CollaborationDocumentKind" NOT NULL DEFAULT 'GENERAL',
  "status" "CollaborationDocumentStatus" NOT NULL DEFAULT 'UPLOADED',
  "clientVisible" BOOLEAN NOT NULL DEFAULT false,
  "uploadedById" UUID,
  "reviewedById" UUID,
  "reviewNote" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "collaboration_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_conversations_projectId_visibility_lastMessageAt_idx"
  ON "project_conversations"("projectId", "visibility", "lastMessageAt");
CREATE INDEX "project_conversations_createdById_idx" ON "project_conversations"("createdById");

CREATE INDEX "project_messages_projectId_createdAt_idx" ON "project_messages"("projectId", "createdAt");
CREATE INDEX "project_messages_conversationId_createdAt_idx" ON "project_messages"("conversationId", "createdAt");
CREATE INDEX "project_messages_authorId_idx" ON "project_messages"("authorId");

CREATE UNIQUE INDEX "conversation_reads_conversationId_userId_key"
  ON "conversation_reads"("conversationId", "userId");
CREATE INDEX "conversation_reads_userId_idx" ON "conversation_reads"("userId");

CREATE INDEX "collaboration_documents_projectId_clientVisible_status_idx"
  ON "collaboration_documents"("projectId", "clientVisible", "status");
CREATE INDEX "collaboration_documents_uploadedById_idx" ON "collaboration_documents"("uploadedById");
CREATE INDEX "collaboration_documents_reviewedById_idx" ON "collaboration_documents"("reviewedById");

ALTER TABLE "project_conversations"
  ADD CONSTRAINT "project_conversations_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_conversations"
  ADD CONSTRAINT "project_conversations_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_messages"
  ADD CONSTRAINT "project_messages_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "project_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_messages"
  ADD CONSTRAINT "project_messages_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversation_reads"
  ADD CONSTRAINT "conversation_reads_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "project_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_reads"
  ADD CONSTRAINT "conversation_reads_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "collaboration_documents"
  ADD CONSTRAINT "collaboration_documents_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "collaboration_documents"
  ADD CONSTRAINT "collaboration_documents_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "collaboration_documents"
  ADD CONSTRAINT "collaboration_documents_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
