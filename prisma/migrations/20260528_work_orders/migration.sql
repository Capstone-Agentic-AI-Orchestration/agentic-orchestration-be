CREATE TYPE "WorkOrderAgentType" AS ENUM (
  'FRONTEND',
  'BACKEND',
  'DATABASE',
  'ARCHITECTURE',
  'CONTRACT'
);

CREATE TYPE "WorkOrderStatus" AS ENUM (
  'DRAFT',
  'READY',
  'DISPATCHED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "WorkOrderPriority" AS ENUM (
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT'
);

ALTER TYPE "NotificationType" ADD VALUE 'WORK_ORDER_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'WORK_ORDER_DISPATCHED';
ALTER TYPE "NotificationType" ADD VALUE 'WORK_ORDER_STATUS_CHANGED';

ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'WORK_ORDER_CREATED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'WORK_ORDER_DISPATCHED';
ALTER TYPE "ProjectTimelineEventType" ADD VALUE 'WORK_ORDER_STATUS_CHANGED';

CREATE TABLE "work_orders" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT,
  "artifactId" TEXT,
  "title" TEXT NOT NULL,
  "instructions" TEXT,
  "agentType" "WorkOrderAgentType" NOT NULL,
  "status" "WorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "priority" "WorkOrderPriority" NOT NULL DEFAULT 'NORMAL',
  "createdById" UUID,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_orders_projectId_status_idx" ON "work_orders"("projectId", "status");
CREATE INDEX "work_orders_taskId_idx" ON "work_orders"("taskId");
CREATE INDEX "work_orders_artifactId_idx" ON "work_orders"("artifactId");
CREATE INDEX "work_orders_createdById_idx" ON "work_orders"("createdById");

ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "project_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
