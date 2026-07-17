import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DevFlowGateway } from '../gateway/devflow.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { RagRetrievalMode } from './rag.types';

@Injectable()
export class RagAuditService {
  private readonly logger = new Logger(RagAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly gateway?: DevFlowGateway,
  ) {}

  async retrievalStarted(projectId: string, meta: { runId?: string; workOrderId?: string; agentName: string }): Promise<void> {
    await this.log(projectId, 'RAG_RETRIEVAL_STARTED', meta);
  }

  async retrievalCompleted(projectId: string, meta: {
    runId?: string; workOrderId?: string; workOrderExecutionId?: string; agentName: string;
    mode: RagRetrievalMode; chunksRetrieved: number; chunkIds: string[];
  }): Promise<void> {
    await this.log(projectId, 'RAG_RETRIEVAL_COMPLETED', meta);
  }

  async contextPackCreated(projectId: string, meta: {
    runId?: string; workOrderId?: string; workOrderExecutionId?: string; agentName: string;
    mode: RagRetrievalMode; chunksRetrieved: number; chunksUsed: number; contextChars: number; chunkIds: string[];
  }): Promise<void> {
    await this.log(projectId, 'RAG_CONTEXT_PACK_CREATED', meta);
    this.gateway?.emitRagContextCreated(projectId, {
      runId: meta.runId,
      workOrderId: meta.workOrderId,
      workOrderExecutionId: meta.workOrderExecutionId,
      agentName: meta.agentName,
      retrievalMode: meta.mode,
      chunksRetrieved: meta.chunksRetrieved,
      chunksUsed: meta.chunksUsed,
      contextChars: meta.contextChars,
    });
  }

  async memoryUpdated(projectId: string, meta: {
    runId?: string; workOrderId?: string; workOrderExecutionId?: string; agentName?: string; sourceType: string; chunks: number;
  }): Promise<void> {
    await this.log(projectId, 'RAG_MEMORY_UPDATED', meta);
    this.gateway?.emitRagMemoryUpdated(projectId, {
      runId: meta.runId,
      workOrderId: meta.workOrderId,
      workOrderExecutionId: meta.workOrderExecutionId,
      agentName: meta.agentName,
      sourceType: meta.sourceType,
      chunks: meta.chunks,
    });
  }

  private async log(projectId: string, eventType: string, costMeta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.eventLog.create({
        data: { projectId, nodeName: 'rag_context_engine', eventType, costMeta: costMeta as Prisma.InputJsonValue, runTokens: 0 },
      });
    } catch (error) {
      this.logger.warn(`Failed to write ${eventType}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
