import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmbeddingService } from '../memory/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { HybridSearchResult, RagRetrieveInput, RetrievedContextItem } from './rag.types';

interface RagSearchRow {
  id: string;
  projectId: string;
  runId: string | null;
  workOrderId: string | null;
  workOrderExecutionId: string | null;
  agentName: string | null;
  sourceType: string;
  sourceId: string;
  title: string | null;
  content: string;
  summary: string | null;
  importance: number;
  isSuperseded: boolean;
  createdAt: Date;
  score: number | string | null;
}

@Injectable()
export class HybridSearchService {
  private readonly logger = new Logger(HybridSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  async search(input: RagRetrieveInput): Promise<HybridSearchResult> {
    const limit = Math.min(Math.max(input.limit ?? 18, 1), 50);
    const useKeyword = input.useKeyword !== false;
    const useVector = input.useVector !== false;
    const keyword = useKeyword ? await this.keywordSearch(input, limit) : [];
    const vector = useVector ? await this.vectorSearch(input, limit) : [];
    const merged = new Map<string, RetrievedContextItem>();

    for (const item of [...keyword, ...vector]) {
      const prior = merged.get(item.id);
      if (!prior) {
        merged.set(item.id, item);
        continue;
      }
      merged.set(item.id, {
        ...prior,
        scoreBreakdown: {
          ...prior.scoreBreakdown,
          ...item.scoreBreakdown,
          keywordScore: Math.max(prior.scoreBreakdown.keywordScore ?? 0, item.scoreBreakdown.keywordScore ?? 0),
          vectorScore: Math.max(prior.scoreBreakdown.vectorScore ?? 0, item.scoreBreakdown.vectorScore ?? 0),
        },
      });
    }

    const mode = keyword.length && vector.length ? 'hybrid' : vector.length ? 'vector' : 'keyword';
    return { items: [...merged.values()], mode };
  }

  private async keywordSearch(input: RagRetrieveInput, limit: number): Promise<RetrievedContextItem[]> {
    if (!input.query.trim()) return [];
    try {
      const where = this.where(input);
      const rows = await this.prisma.$queryRaw<RagSearchRow[]>(Prisma.sql`
        SELECT id, "projectId", "runId", "workOrderId", "workOrderExecutionId", "agentName",
          "sourceType", "sourceId", title, content, summary, importance, "isSuperseded", "createdAt",
          ts_rank_cd("searchVector", websearch_to_tsquery('english', ${input.query})) AS score
        FROM memory.rag_chunks
        WHERE ${where} AND "searchVector" @@ websearch_to_tsquery('english', ${input.query})
        ORDER BY score DESC, "createdAt" DESC
        LIMIT ${limit}
      `);
      return rows.map((row) => this.toItem(row, 'keyword'));
    } catch (error) {
      this.logger.warn(`Keyword RAG search failed; returning no keyword results: ${this.errorMessage(error)}`);
      return [];
    }
  }

  private async vectorSearch(input: RagRetrieveInput, limit: number): Promise<RetrievedContextItem[]> {
    const vector = await this.embedding.tryEmbed(input.query);
    if (!vector) return [];
    try {
      const vectorSql = EmbeddingService.toSql(vector);
      const where = this.where(input);
      const rows = await this.prisma.$queryRaw<RagSearchRow[]>(Prisma.sql`
        SELECT id, "projectId", "runId", "workOrderId", "workOrderExecutionId", "agentName",
          "sourceType", "sourceId", title, content, summary, importance, "isSuperseded", "createdAt",
          1 - (embedding <=> ${vectorSql}::vector) AS score
        FROM memory.rag_chunks
        WHERE ${where} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorSql}::vector
        LIMIT ${limit}
      `);
      return rows.map((row) => this.toItem(row, 'vector'));
    } catch (error) {
      this.logger.warn(`Vector RAG search failed; falling back to keyword: ${this.errorMessage(error)}`);
      return [];
    }
  }

  private where(input: RagRetrieveInput): Prisma.Sql {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`"projectId" = ${input.projectId}`,
      Prisma.sql`"isSuperseded" = false`,
    ];
    if (input.sourceTypes?.length) {
      clauses.push(Prisma.sql`"sourceType" IN (${Prisma.join(input.sourceTypes)})`);
    }
    if (input.tags?.length) {
      clauses.push(Prisma.sql`tags && ARRAY[${Prisma.join(input.tags)}]::text[]`);
    }
    return Prisma.join(clauses, ' AND ');
  }

  private toItem(row: RagSearchRow, kind: 'keyword' | 'vector'): RetrievedContextItem {
    const score = Number(row.score ?? 0);
    return {
      id: row.id,
      projectId: row.projectId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      title: row.title ?? undefined,
      content: row.content,
      summary: row.summary ?? undefined,
      agentName: row.agentName ?? undefined,
      runId: row.runId ?? undefined,
      workOrderId: row.workOrderId ?? undefined,
      workOrderExecutionId: row.workOrderExecutionId ?? undefined,
      importance: row.importance,
      isSuperseded: row.isSuperseded,
      score: 0,
      scoreBreakdown: kind === 'keyword' ? { keywordScore: score } : { vectorScore: score },
      createdAt: row.createdAt.toISOString(),
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
