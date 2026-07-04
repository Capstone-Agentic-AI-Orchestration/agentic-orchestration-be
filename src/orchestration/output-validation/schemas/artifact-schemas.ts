import { z } from 'zod';
import { WorkOrderAgentType } from '@prisma/client';

export const FrontendArtifactSchema = z.object({
  filePath: z.string().regex(/^work-orders\/[^/]+\/.+\.tsx?$/),
  content: z.string()
    .min(40, 'content must be at least 40 chars')
    .refine(s => /export\s+(function|default|const)/.test(s), 'must export a component or function')
    .refine(s => /<section|<div|React/.test(s), 'must contain renderable UI'),
}).strict();

export const BackendArtifactSchema = z.object({
  filePath: z.string().regex(/^work-orders\/[^/]+\/.+\.ts$/),
  content: z.string()
    .min(40, 'content must be at least 40 chars')
    .refine(s => /export\s+(class|function)/.test(s), 'must export a service or function')
    .refine(s => /@Injectable|describeWorkOrder|Controller/.test(s), 'must include NestJS-compatible contract signal'),
}).strict();

export const DatabaseArtifactSchema = z.object({
  filePath: z.string().regex(/^work-orders\/[^/]+\/.+\.sql$/),
  content: z.string()
    .min(40, 'content must be at least 40 chars')
    .refine(s => /CREATE\s+TABLE|ALTER\s+TABLE/i.test(s), 'must include DDL')
    .refine(s => /;/.test(s), 'must include SQL statement terminators'),
}).strict();

export const MarkdownArtifactSchema = z.object({
  filePath: z.string().regex(/^work-orders\/[^/]+\/.+\.md$/),
  content: z.string()
    .min(40, 'content must be at least 40 chars'),
}).strict();

export const AGENT_SCHEMAS: Record<WorkOrderAgentType, z.ZodTypeAny> = {
  [WorkOrderAgentType.FRONTEND]: FrontendArtifactSchema,
  [WorkOrderAgentType.BACKEND]: BackendArtifactSchema,
  [WorkOrderAgentType.DATABASE]: DatabaseArtifactSchema,
  [WorkOrderAgentType.ARCHITECTURE]: MarkdownArtifactSchema,
  [WorkOrderAgentType.CONTRACT]: MarkdownArtifactSchema,
};
