-- Mobile agent type so orchestration can produce/route code for a project's mobile repo.
ALTER TYPE "orchestration"."WorkOrderAgentType" ADD VALUE IF NOT EXISTS 'MOBILE';
