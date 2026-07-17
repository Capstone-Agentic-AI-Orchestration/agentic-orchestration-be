import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContextRankerService } from './context-ranker.service';
import { HybridSearchService } from './hybrid-search.service';
import { RagAuditService } from './rag-audit.service';
import { HybridSearchResult, RagRetrieveInput } from './rag.types';

@Injectable()
export class RagRetrievalService {
  private readonly logger = new Logger(RagRetrievalService.name);

  constructor(
    private readonly hybridSearch: HybridSearchService,
    private readonly ranker: ContextRankerService,
    private readonly audit: RagAuditService,
    private readonly prisma: PrismaService,
  ) {}

  async retrieve(input: RagRetrieveInput): Promise<HybridSearchResult> {
    await this.audit.retrievalStarted(input.projectId, input);
    const result = await this.hybridSearch.search({ ...input, limit: input.limit ?? 18 });
    const items = this.ranker.rank(result.items, input).slice(0, input.limit ?? 18);
    await this.audit.retrievalCompleted(input.projectId, {
      runId: input.runId,
      workOrderId: input.workOrderId,
      workOrderExecutionId: input.workOrderExecutionId,
      agentName: input.agentName,
      mode: result.mode,
      chunksRetrieved: items.length,
      chunkIds: items.map((item) => item.id),
    });
    if (items.length) {
      void this.prisma.ragChunk.updateMany({ where: { id: { in: items.map((item) => item.id) } }, data: { lastAccessedAt: new Date() } })
        .catch((error: unknown) => this.logger.debug(`Could not update RAG access timestamps: ${this.errorMessage(error)}`));
    }
    return { items, mode: result.mode };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
