CREATE TYPE "OrchestrationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TYPE "OrchestrationRunTrigger" AS ENUM ('START', 'RERUN_READY_WORK_ORDERS', 'WORK_ORDER_DISPATCH', 'RETRY_FAILED_WORK_ORDER');

CREATE TYPE "WorkOrderExecutionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "orchestration_runs" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "providerMode" TEXT NOT NULL DEFAULT 'mock',
  "trigger" "OrchestrationRunTrigger" NOT NULL DEFAULT 'START',
  "status" "OrchestrationRunStatus" NOT NULL DEFAULT 'RUNNING',
  "currentNode" TEXT,
  "error" TEXT,
  "actorId" UUID,
  "readyWorkOrders" INTEGER NOT NULL DEFAULT 0,
  "completedWorkOrders" INTEGER NOT NULL DEFAULT 0,
  "failedWorkOrders" INTEGER NOT NULL DEFAULT 0,
  "completedArtifacts" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "orchestration_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_order_executions" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "orchestrationRunId" TEXT,
  "workOrderId" TEXT NOT NULL,
  "artifactId" TEXT,
  "executionRunId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "agentType" "WorkOrderAgentType" NOT NULL,
  "status" "WorkOrderExecutionStatus" NOT NULL DEFAULT 'RUNNING',
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "work_order_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orchestration_runs_runId_key" ON "orchestration_runs"("runId");
CREATE INDEX "orchestration_runs_projectId_createdAt_idx" ON "orchestration_runs"("projectId", "createdAt");
CREATE INDEX "orchestration_runs_projectId_status_idx" ON "orchestration_runs"("projectId", "status");
CREATE INDEX "orchestration_runs_actorId_idx" ON "orchestration_runs"("actorId");

CREATE UNIQUE INDEX "work_order_executions_executionRunId_key" ON "work_order_executions"("executionRunId");
CREATE INDEX "work_order_executions_projectId_startedAt_idx" ON "work_order_executions"("projectId", "startedAt");
CREATE INDEX "work_order_executions_orchestrationRunId_idx" ON "work_order_executions"("orchestrationRunId");
CREATE INDEX "work_order_executions_workOrderId_idx" ON "work_order_executions"("workOrderId");
CREATE INDEX "work_order_executions_artifactId_idx" ON "work_order_executions"("artifactId");

ALTER TABLE "orchestration_runs"
  ADD CONSTRAINT "orchestration_runs_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_executions"
  ADD CONSTRAINT "work_order_executions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_executions"
  ADD CONSTRAINT "work_order_executions_orchestrationRunId_fkey"
  FOREIGN KEY ("orchestrationRunId") REFERENCES "orchestration_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "work_order_executions"
  ADD CONSTRAINT "work_order_executions_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_executions"
  ADD CONSTRAINT "work_order_executions_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
