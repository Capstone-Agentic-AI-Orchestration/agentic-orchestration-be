import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmbeddingService } from '../memory/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { RagAuditService } from './rag-audit.service';
import { chunkRagText, contentHash, ragSummary, sanitizeRagText } from './rag-safety';
import { RagIndexRecord, RagSourceType } from './rag.types';

@Injectable()
export class RagIndexingService {
  private readonly logger = new Logger(RagIndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly audit: RagAuditService,
  ) {}

  async indexProject(projectId: string): Promise<{ createdOrUpdated: number }> {
    const [project, workOrders, executions, artifacts, eventLogs, memories, profiles, tasks, activities, timeline, gates, documents] = await Promise.all([
      this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, companyName: true, brief: true, stackKey: true, updatedAt: true } }),
      this.prisma.workOrder.findMany({ where: { projectId } }),
      this.prisma.workOrderExecution.findMany({ where: { projectId } }),
      this.prisma.artifact.findMany({ where: { projectId } }),
      this.prisma.eventLog.findMany({ where: { projectId }, orderBy: { occurredAt: 'desc' }, take: 250 }),
      this.prisma.agentMemory.findMany({ where: { projectId } }),
      this.prisma.agentProfile.findMany({ where: { active: true } }),
      this.prisma.projectTask.findMany({ where: { projectId } }),
      this.prisma.projectTaskActivity.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 300 }),
      this.prisma.projectTimelineEvent.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 300 }),
      this.prisma.gateEvent.findMany({ where: { projectId } }),
      this.prisma.collaborationDocument.findMany({ where: { projectId }, include: { extraction: true } }),
    ]);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const records: RagIndexRecord[] = [
      { projectId, sourceType: 'project', sourceId: project.id, title: `${project.companyName} project requirements`, content: `Company: ${project.companyName}\nStack: ${project.stackKey}\nRequirements:\n${project.brief}`, importance: 10, tags: ['requirements', project.stackKey] },
      ...workOrders.map((item) => ({ projectId, sourceType: 'work_order' as const, sourceId: item.id, workOrderId: item.id, agentName: item.agentType.toLowerCase(), title: item.title, content: `Work order: ${item.title}\nAgent: ${item.agentType}\nPriority: ${item.priority}\nStatus: ${item.status}\nInstructions:\n${item.instructions ?? ''}`, importance: 9, tags: ['work-order', item.agentType.toLowerCase(), item.status.toLowerCase()] })),
      ...executions.map((item) => ({ projectId, sourceType: 'work_order_execution' as const, sourceId: item.id, runId: item.executionRunId, workOrderId: item.workOrderId, workOrderExecutionId: item.id, agentName: item.agentType.toLowerCase(), title: `Execution ${item.executionRunId}`, content: `Work-order execution status: ${item.status}\nAttempt: ${item.attempt}\n${item.error ? `Error: ${item.error}` : ''}\nMetadata: ${this.safeJson(item.metadata)}`, importance: item.status === 'FAILED' ? 9 : 6, tags: ['execution', item.status.toLowerCase(), item.agentType.toLowerCase()] })),
      ...artifacts.map((item) => ({ projectId, sourceType: 'artifact' as const, sourceId: item.id, agentName: item.agentType, title: item.displayName ?? item.filePath, content: `Artifact: ${item.filePath}\nAgent: ${item.agentType}\nValidation: ${item.validationStatus}\nReview: ${item.outputReviewStatus}\n${item.validationSummary ?? ''}\n\n${item.content}`, importance: item.validationStatus === 'FAILED' ? 4 : 8, tags: ['artifact', item.agentType, item.filePath.split('.').pop() ?? 'text'] })),
      ...eventLogs.map((item) => ({ projectId, sourceType: item.eventType === 'FAILED' ? 'error' as const : 'event_log' as const, sourceId: item.id, title: `${item.nodeName} ${item.eventType}`, content: `Node: ${item.nodeName}\nEvent: ${item.eventType}\nOccurred: ${item.occurredAt.toISOString()}\nDetails: ${this.safeJson(item.costMeta)}`, importance: item.eventType === 'FAILED' ? 8 : 3, tags: ['event', item.nodeName, item.eventType.toLowerCase()] })),
      ...memories.map((item) => ({ projectId, sourceType: item.memoryType === 'MISTAKE' ? 'error' as const : item.memoryType === 'PATTERN' ? 'pattern' as const : 'agent_memory' as const, sourceId: item.id, agentName: item.agentType, title: `${item.agentType} ${item.memoryType}`, content: item.content, importance: Math.round(Math.max(1, Math.min(10, item.importance * 10))), tags: ['memory', item.agentType, item.memoryType.toLowerCase()] })),
      ...profiles.map((item) => ({ projectId, sourceType: 'agent_profile' as const, sourceId: item.id, agentName: item.agentType, title: item.displayName, content: `Agent profile: ${item.displayName}\nRole: ${item.role}\nAgent type: ${item.agentType}\nKnown model hint: ${item.modelHint ?? 'none'}`, importance: 4, tags: ['agent-profile', item.agentType] })),
      ...tasks.map((item) => ({ projectId, sourceType: 'project_task' as const, sourceId: item.id, title: item.title, content: `Task: ${item.title}\nStatus: ${item.status}\nDescription: ${item.description ?? ''}`, importance: 7, tags: ['task', item.status.toLowerCase()] })),
      ...activities.map((item) => ({ projectId, sourceType: 'project_task_activity' as const, sourceId: item.id, title: item.type, content: `Task activity: ${item.type}\n${item.message ?? ''}\nMetadata: ${this.safeJson(item.metadata)}`, importance: item.type === 'COMMENT' ? 6 : 3, tags: ['task-activity', item.type.toLowerCase()] })),
      ...timeline.map((item) => ({ projectId, sourceType: 'project_timeline_event' as const, sourceId: item.id, title: item.title, content: `${item.title}\n${item.body ?? ''}\nMetadata: ${this.safeJson(item.metadata)}`, importance: 5, tags: ['timeline', item.type.toLowerCase(), item.visibility.toLowerCase()] })),
      ...gates.map((item) => ({ projectId, sourceType: item.decision === 'APPROVED' ? 'architecture_decision' as const : 'error' as const, sourceId: item.id, title: `${item.gateType} ${item.decision}`, content: `Gate: ${item.gateType}\nDecision: ${item.decision}\nNotes: ${item.notes ?? ''}`, importance: 10, tags: ['gate', item.gateType.toLowerCase(), item.decision.toLowerCase()] })),
      ...documents.map((item) => ({ projectId, sourceType: 'document' as const, sourceId: item.id, title: item.title, content: `Document: ${item.title}\nDescription: ${item.description ?? ''}\nType: ${item.mimeType ?? item.kind}\nExtracted content:\n${item.extraction?.extractedText ?? ''}`, importance: 7, tags: ['document', item.kind.toLowerCase()] })),
    ];

    let createdOrUpdated = 0;
    for (const record of records) createdOrUpdated += await this.indexRecord(record, false);
    if (createdOrUpdated) {
      await this.audit.memoryUpdated(projectId, { sourceType: 'project_reindex', chunks: createdOrUpdated });
    }
    return { createdOrUpdated };
  }

  async reindexSource(projectId: string, sourceType: string, sourceId: string): Promise<{ createdOrUpdated: number }> {
    const createdOrUpdated = await this.reindexOne(projectId, sourceType, sourceId);
    return { createdOrUpdated };
  }

  async indexProjectDetails(projectId: string): Promise<number> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, companyName: true, brief: true, stackKey: true } });
    if (!project) return 0;
    return this.indexRecord({ projectId, sourceType: 'project', sourceId: project.id, title: `${project.companyName} project requirements`, content: `Company: ${project.companyName}\nStack: ${project.stackKey}\nRequirements:\n${project.brief}`, importance: 10, tags: ['requirements', project.stackKey] });
  }

  async indexWorkOrder(projectId: string, workOrderId: string): Promise<number> {
    const item = await this.prisma.workOrder.findFirst({ where: { id: workOrderId, projectId } });
    if (!item) return 0;
    return this.indexRecord({ projectId, sourceType: 'work_order', sourceId: item.id, workOrderId: item.id, agentName: item.agentType.toLowerCase(), title: item.title, content: `Work order: ${item.title}\nAgent: ${item.agentType}\nPriority: ${item.priority}\nStatus: ${item.status}\nInstructions:\n${item.instructions ?? ''}`, importance: 9, tags: ['work-order', item.agentType.toLowerCase(), item.status.toLowerCase()] });
  }

  async indexTask(projectId: string, taskId: string): Promise<number> {
    const item = await this.prisma.projectTask.findFirst({ where: { id: taskId, projectId } });
    if (!item) return 0;
    return this.indexRecord({ projectId, sourceType: 'project_task', sourceId: item.id, title: item.title, content: `Task: ${item.title}\nStatus: ${item.status}\nDescription: ${item.description ?? ''}`, importance: 7, tags: ['task', item.status.toLowerCase()] });
  }

  async indexTaskActivity(projectId: string, activityId: string): Promise<number> {
    const item = await this.prisma.projectTaskActivity.findFirst({ where: { id: activityId, projectId } });
    if (!item) return 0;
    return this.indexRecord({ projectId, sourceType: 'project_task_activity', sourceId: item.id, title: item.type, content: `Task activity: ${item.type}\n${item.message ?? ''}\nMetadata: ${this.safeJson(item.metadata)}`, importance: item.type === 'COMMENT' ? 6 : 3, tags: ['task-activity', item.type.toLowerCase()] });
  }

  async listChunks(projectId: string, sourceType?: string, agentName?: string, limit = 50) {
    return this.prisma.ragChunk.findMany({
      where: {
        projectId,
        ...(sourceType ? { sourceType } : {}),
        ...(agentName ? { agentName } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true, sourceType: true, sourceId: true, title: true, summary: true,
        tags: true, importance: true, isSuperseded: true, runId: true,
        workOrderId: true, workOrderExecutionId: true, agentName: true, createdAt: true, updatedAt: true,
      },
    });
  }

  async indexArtifact(projectId: string, artifactId: string, runId?: string, workOrderId?: string, workOrderExecutionId?: string): Promise<number> {
    const artifact = await this.prisma.artifact.findFirst({ where: { id: artifactId, projectId } });
    if (!artifact) return 0;
    return this.indexRecord({ projectId, sourceType: 'artifact', sourceId: artifact.id, runId, workOrderId, workOrderExecutionId, agentName: artifact.agentType, title: artifact.displayName ?? artifact.filePath, content: `Artifact: ${artifact.filePath}\n${artifact.validationSummary ?? ''}\n\n${artifact.content}`, importance: 8, tags: ['artifact', artifact.agentType] });
  }

  async indexExecution(projectId: string, executionId: string): Promise<number> {
    const execution = await this.prisma.workOrderExecution.findFirst({ where: { id: executionId, projectId } });
    if (!execution) return 0;
    return this.indexRecord({ projectId, sourceType: execution.status === 'FAILED' ? 'error' : 'work_order_execution', sourceId: execution.id, runId: execution.executionRunId, workOrderId: execution.workOrderId, workOrderExecutionId: execution.id, agentName: execution.agentType.toLowerCase(), title: `Execution ${execution.executionRunId}`, content: `Status: ${execution.status}\nAttempt: ${execution.attempt}\n${execution.error ?? ''}\n${this.safeJson(execution.metadata)}`, importance: execution.status === 'FAILED' ? 9 : 6, tags: ['execution', execution.status.toLowerCase()] });
  }

  async indexGeneratedOutput(input: { projectId: string; runId?: string; agentName: string; artifacts: Array<{ filePath: string; content: string; language?: string }> }): Promise<void> {
    let chunks = 0;
    for (const artifact of input.artifacts) {
      chunks += await this.indexRecord({ projectId: input.projectId, sourceType: 'artifact', sourceId: `${input.runId ?? 'run'}:${input.agentName}:${artifact.filePath}`, runId: input.runId, agentName: input.agentName, title: artifact.filePath, content: `Generated ${artifact.language ?? 'text'} artifact: ${artifact.filePath}\n\n${artifact.content}`, importance: 8, tags: ['artifact', 'generated', input.agentName, artifact.language ?? 'text'] });
    }
    if (chunks) await this.audit.memoryUpdated(input.projectId, { runId: input.runId, agentName: input.agentName, sourceType: 'artifact', chunks });
  }

  async indexRecord(record: RagIndexRecord, emitAudit = true): Promise<number> {
    const safeContent = sanitizeRagText(record.content);
    if (!safeContent) return 0;
    const chunks = chunkRagText(safeContent);
    await this.prisma.ragChunk.updateMany({ where: { projectId: record.projectId, sourceType: record.sourceType, sourceId: record.sourceId, chunkIndex: { gte: chunks.length } }, data: { isSuperseded: true } });
    let count = 0;
    for (const [chunkIndex, content] of chunks.entries()) {
      const summary = ragSummary(content);
      const hash = contentHash(content);
      const chunk = await this.prisma.ragChunk.upsert({
        where: { projectId_sourceType_sourceId_chunkIndex: { projectId: record.projectId, sourceType: record.sourceType, sourceId: record.sourceId, chunkIndex } },
        create: { projectId: record.projectId, runId: record.runId ?? null, workOrderId: record.workOrderId ?? null, workOrderExecutionId: record.workOrderExecutionId ?? null, agentName: record.agentName ?? null, sourceType: record.sourceType, sourceId: record.sourceId, title: record.title ?? null, content, summary, chunkIndex, tags: record.tags ?? [], importance: record.importance ?? 3, confidence: record.confidence ?? 1, contentHash: hash, metadata: (record.metadata ?? {}) as Prisma.InputJsonValue },
        update: { runId: record.runId ?? null, workOrderId: record.workOrderId ?? null, workOrderExecutionId: record.workOrderExecutionId ?? null, agentName: record.agentName ?? null, title: record.title ?? null, content, summary, tags: record.tags ?? [], importance: record.importance ?? 3, confidence: record.confidence ?? 1, contentHash: hash, metadata: (record.metadata ?? {}) as Prisma.InputJsonValue, isSuperseded: false },
      });
      const embedding = await this.embedding.tryEmbed(content);
      if (embedding) {
        const vectorSql = EmbeddingService.toSql(embedding);
        await this.prisma.$executeRaw(Prisma.sql`UPDATE memory.rag_chunks SET embedding = ${vectorSql}::vector WHERE id = ${chunk.id}`);
      }
      count += 1;
    }
    if (count && emitAudit) await this.audit.memoryUpdated(record.projectId, { runId: record.runId ?? undefined, workOrderId: record.workOrderId ?? undefined, workOrderExecutionId: record.workOrderExecutionId ?? undefined, agentName: record.agentName ?? undefined, sourceType: record.sourceType, chunks: count });
    return count;
  }

  private safeJson(value: unknown): string {
    try { return sanitizeRagText(JSON.stringify(value ?? {}), 4_000); } catch { return ''; }
  }

  private async reindexOne(projectId: string, sourceType: string, sourceId: string): Promise<number> {
    switch (sourceType as RagSourceType) {
      case 'project': return this.indexProjectDetails(projectId);
      case 'work_order': return this.indexWorkOrder(projectId, sourceId);
      case 'work_order_execution': return this.indexExecution(projectId, sourceId);
      case 'artifact': return this.indexArtifact(projectId, sourceId);
      case 'project_task': return this.indexTask(projectId, sourceId);
      case 'project_task_activity': return this.indexTaskActivity(projectId, sourceId);
      case 'document': {
        const item = await this.prisma.collaborationDocument.findFirst({ where: { id: sourceId, projectId }, include: { extraction: true } });
        return item ? this.indexRecord({ projectId, sourceType: 'document', sourceId: item.id, title: item.title, content: `Document: ${item.title}\nDescription: ${item.description ?? ''}\nExtracted content:\n${item.extraction?.extractedText ?? ''}`, importance: 7, tags: ['document', item.kind.toLowerCase()] }) : 0;
      }
      case 'agent_memory':
      case 'pattern':
      case 'error': {
        const memory = await this.prisma.agentMemory.findFirst({ where: { id: sourceId, projectId } });
        if (memory) return this.indexRecord({ projectId, sourceType: memory.memoryType === 'MISTAKE' ? 'error' : memory.memoryType === 'PATTERN' ? 'pattern' : 'agent_memory', sourceId: memory.id, agentName: memory.agentType, title: `${memory.agentType} ${memory.memoryType}`, content: memory.content, importance: Math.round(Math.max(1, Math.min(10, memory.importance * 10))), tags: ['memory', memory.agentType, memory.memoryType.toLowerCase()] });
        const event = await this.prisma.eventLog.findFirst({ where: { id: sourceId, projectId } });
        return event ? this.indexRecord({ projectId, sourceType: event.eventType === 'FAILED' ? 'error' : 'event_log', sourceId: event.id, title: `${event.nodeName} ${event.eventType}`, content: `Node: ${event.nodeName}\nEvent: ${event.eventType}\nDetails: ${this.safeJson(event.costMeta)}`, importance: event.eventType === 'FAILED' ? 8 : 3, tags: ['event', event.nodeName, event.eventType.toLowerCase()] }) : 0;
      }
      default: return 0;
    }
  }
}
