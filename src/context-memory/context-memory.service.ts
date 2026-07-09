import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContextMemoryRecord,
  ContextMemorySearchResult,
} from './context-memory.types';
import {
  BuildContextPackDto,
  RecordContextMemoryDto,
  SearchContextMemoryDto,
} from './dto/context-memory.dto';
import { rankContextMemories } from './context-memory-ranker';
import { formatContextPack } from './context-pack.formatter';

interface ContextMemoryRow {
  id: string;
  projectId: string;
  runId: string | null;
  agentType: string | null;
  type: string;
  title: string;
  content: string;
  importance: Prisma.Decimal | number | string | null;
  tags: string[] | null;
  artifact: unknown;
  progress: unknown;
  metadata: unknown;
  hash: string | null;
  createdAt: Date;
}

interface NormalizedRecordInput {
  projectId: string;
  runId?: string;
  agentType?: string;
  type: RecordContextMemoryDto['type'];
  title: string;
  content: string;
  importance: number;
  tags: string[];
  artifact?: RecordContextMemoryDto['artifact'];
  progress?: RecordContextMemoryDto['progress'];
  metadata: Record<string, unknown>;
}

@Injectable()
export class ContextMemoryService {
  private readonly logger = new Logger(ContextMemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordContextMemoryDto): Promise<ContextMemoryRecord> {
    const normalized = this.normalizeRecordInput(input);
    const hash = this.hashRecord(normalized);
    const rows = await this.prisma.$queryRaw<ContextMemoryRow[]>`
      INSERT INTO public.memory_context_events (
        "projectId",
        "runId",
        "agentType",
        type,
        title,
        content,
        importance,
        tags,
        artifact,
        progress,
        metadata,
        hash
      )
      VALUES (
        ${normalized.projectId},
        ${normalized.runId},
        ${normalized.agentType},
        ${normalized.type},
        ${normalized.title},
        ${normalized.content},
        ${normalized.importance},
        ${normalized.tags},
        ${normalized.artifact ? JSON.stringify(normalized.artifact) : null}::jsonb,
        ${normalized.progress ? JSON.stringify(normalized.progress) : null}::jsonb,
        ${JSON.stringify(normalized.metadata)}::jsonb,
        ${hash}
      )
      RETURNING
        id,
        "projectId",
        "runId",
        "agentType",
        type,
        title,
        content,
        importance,
        tags,
        artifact,
        progress,
        metadata,
        hash,
        "createdAt"
    `;
    return this.mapRow(rows[0]);
  }

  async buildContextPack(input: BuildContextPackDto) {
    const normalized = {
      projectId: input.projectId.trim(),
      runId: input.runId?.trim() || undefined,
      agentType: input.agentType.trim(),
      task: input.task.trim(),
      tags: this.normalizeTags(input.tags),
      maxChars: this.normalizeMaxChars(input.maxChars),
    };
    const records = await this.fetchProjectRecords(normalized.projectId, normalized.runId);
    return formatContextPack(records, normalized);
  }

  async search(input: SearchContextMemoryDto): Promise<ContextMemorySearchResult[]> {
    const normalized = {
      projectId: input.projectId?.trim() || undefined,
      runId: input.runId?.trim() || undefined,
      agentType: input.agentType?.trim() || undefined,
      query: input.query?.trim() ?? '',
      tags: this.normalizeTags(input.tags),
      types: input.types ?? [],
      limit: this.normalizeLimit(input.limit),
    };
    const records = normalized.projectId
      ? await this.fetchProjectRecords(normalized.projectId, normalized.runId)
      : await this.fetchRecentRecords(normalized.limit * 5);
    return rankContextMemories(records, normalized);
  }

  async list(input: SearchContextMemoryDto): Promise<ContextMemoryRecord[]> {
    const limit = this.normalizeLimit(input.limit);
    const projectId = input.projectId?.trim();
    const runId = input.runId?.trim();
    const rows = projectId
      ? await this.prisma.$queryRaw<ContextMemoryRow[]>`
          SELECT
            id,
            "projectId",
            "runId",
            "agentType",
            type,
            title,
            content,
            importance,
            tags,
            artifact,
            progress,
            metadata,
            hash,
            "createdAt"
          FROM public.memory_context_events
          WHERE "projectId" = ${projectId}
            AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
          ORDER BY "createdAt" DESC
          LIMIT ${limit}
        `
      : await this.fetchRecentRows(limit);
    return rows.map((row) => this.mapRow(row));
  }

  private async fetchProjectRecords(projectId: string, runId?: string): Promise<ContextMemoryRecord[]> {
    const rows = await this.prisma.$queryRaw<ContextMemoryRow[]>`
      SELECT
        id,
        "projectId",
        "runId",
        "agentType",
        type,
        title,
        content,
        importance,
        tags,
        artifact,
        progress,
        metadata,
        hash,
        "createdAt"
      FROM public.memory_context_events
      WHERE "projectId" = ${projectId}
        AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
      ORDER BY "createdAt" DESC
      LIMIT 500
    `;
    return rows.map((row) => this.mapRow(row));
  }

  private async fetchRecentRecords(limit: number): Promise<ContextMemoryRecord[]> {
    return (await this.fetchRecentRows(limit)).map((row) => this.mapRow(row));
  }

  private async fetchRecentRows(limit: number): Promise<ContextMemoryRow[]> {
    return this.prisma.$queryRaw<ContextMemoryRow[]>`
      SELECT
        id,
        "projectId",
        "runId",
        "agentType",
        type,
        title,
        content,
        importance,
        tags,
        artifact,
        progress,
        metadata,
        hash,
        "createdAt"
      FROM public.memory_context_events
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
  }

  private normalizeRecordInput(input: RecordContextMemoryDto): NormalizedRecordInput {
    const title = input.title?.trim();
    const content = input.content?.trim();
    if (!title) throw new Error('title must be a non-empty string');
    if (!content) throw new Error('content must be a non-empty string');
    return {
      projectId: input.projectId.trim(),
      runId: input.runId?.trim() || undefined,
      agentType: input.agentType?.trim() || undefined,
      type: input.type,
      title,
      content,
      importance: this.normalizeImportance(input.importance),
      tags: this.normalizeTags(input.tags),
      artifact: input.artifact ?? undefined,
      progress: input.progress
        ? {
            ...input.progress,
            percent: typeof input.progress.percent === 'number'
              ? Math.max(0, Math.min(100, Math.round(input.progress.percent)))
              : undefined,
          }
        : undefined,
      metadata: input.metadata ?? {},
    };
  }

  private normalizeTags(tags: string[] | undefined): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const tag of tags ?? []) {
      const value = tag.trim().toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  private normalizeImportance(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }

  private normalizeLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return 10;
    return Math.max(1, Math.min(100, Math.round(value)));
  }

  private normalizeMaxChars(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return 12_000;
    return Math.max(1000, Math.min(80_000, Math.round(value)));
  }

  private hashRecord(input: NormalizedRecordInput): string {
    return createHash('sha256')
      .update([
        input.projectId,
        input.runId ?? '',
        input.agentType ?? '',
        input.type,
        input.title,
        input.content,
      ].join('\n'))
      .digest('hex');
  }

  private mapRow(row: ContextMemoryRow | undefined): ContextMemoryRecord {
    if (!row) {
      throw new Error('Context memory insert returned no row');
    }

    return {
      id: row.id,
      projectId: row.projectId,
      runId: row.runId,
      agentType: row.agentType,
      type: row.type as ContextMemoryRecord['type'],
      title: row.title,
      content: row.content,
      importance: this.numberFrom(row.importance, 0.5),
      tags: Array.isArray(row.tags) ? row.tags : [],
      artifact: this.objectOrNull(row.artifact),
      progress: this.objectOrNull(row.progress),
      metadata: this.objectOrEmpty(row.metadata),
      hash: row.hash,
      createdAt: row.createdAt,
    };
  }

  private numberFrom(value: Prisma.Decimal | number | string | null, fallback: number): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    if (value && typeof value === 'object' && 'toNumber' in value) {
      return (value as Prisma.Decimal).toNumber();
    }
    return fallback;
  }

  private objectOrNull<T extends Record<string, unknown>>(value: unknown): T | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as T;
  }

  private objectOrEmpty(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }
}
