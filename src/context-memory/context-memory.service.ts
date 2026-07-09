import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONTEXT_MEMORY_TYPES,
  ContextMemoryHandoff,
  ContextMemoryRecord,
  ContextMemorySearchResult,
  ContextMemorySnapshot,
  ContextPackResult,
} from './context-memory.types';
import {
  BuildContextPackDto,
  CompactContextMemoryDto,
  CreateContextHandoffDto,
  ListContextHandoffsDto,
  ListContextSnapshotsDto,
  RecordContextMemoryDto,
  SearchContextMemoryDto,
} from './dto/context-memory.dto';
import { rankContextMemories, serializeEmbedding } from './context-memory-ranker';
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
  status?: string | null;
  pinned?: boolean | null;
  expiresAt?: Date | null;
  archivedAt?: Date | null;
  lastAccessedAt?: Date | null;
  accessCount?: number | null;
  embedding?: number[] | string | null;
  createdAt: Date;
}

interface ContextHandoffRow {
  id: string;
  projectId: string;
  runId: string | null;
  fromAgent: string;
  toAgent: string;
  title: string;
  content: string;
  artifact: unknown;
  status: string;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ContextSnapshotRow {
  id: string;
  projectId: string;
  runId: string | null;
  agentType: string;
  taskHash: string;
  task: string;
  text: string;
  includedEventIds: string[] | null;
  sourceEventMaxCreatedAt: Date | null;
  sourceEventCount: number | null;
  retrievalMode: string;
  stalenessMs: number | null;
  metadata: unknown;
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

interface SnapshotInsertInput {
  projectId: string;
  runId?: string;
  agentType: string;
  taskHash: string;
  task: string;
  text: string;
  includedEventIds: string[];
  sourceEventMaxCreatedAt: Date | null;
  sourceEventCount: number;
  retrievalMode: 'hybrid' | 'lexical';
  stalenessMs: number;
  metadata: Record<string, unknown>;
}

@Injectable()
export class ContextMemoryService {
  private readonly logger = new Logger(ContextMemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordContextMemoryDto): Promise<ContextMemoryRecord> {
    const normalized = this.normalizeRecordInput(input);
    const hash = this.hashRecord(normalized);
    const embedding = serializeEmbedding([
      normalized.title,
      normalized.content,
      normalized.agentType ?? '',
      normalized.type,
      ...normalized.tags,
    ].join(' '));
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
        hash,
        status,
        pinned,
        embedding
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
        ${hash},
        'active',
        false,
        ${embedding}::vector
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
        status,
        pinned,
        "expiresAt",
        "archivedAt",
        "lastAccessedAt",
        "accessCount",
        embedding,
        "createdAt"
    `;
    return this.mapRow(rows[0]);
  }

  async buildContextPack(input: BuildContextPackDto): Promise<ContextPackResult> {
    const normalized = {
      projectId: input.projectId.trim(),
      runId: input.runId?.trim() || undefined,
      agentType: input.agentType.trim(),
      task: input.task.trim(),
      tags: this.normalizeTags(input.tags),
      maxChars: this.normalizeMaxChars(input.maxChars),
    };
    const cached = await this.findReusableSnapshot(normalized, input.allowCached === true);
    if (cached) return this.contextPackFromSnapshot(cached, normalized);

    const records = await this.fetchProjectRecords(normalized.projectId, normalized.runId);
    const handoffs = await this.fetchOpenHandoffRecords(
      normalized.projectId,
      normalized.runId,
      normalized.agentType,
    );
    const pack = formatContextPack([...records, ...handoffs], normalized);
    const includedIds = this.flattenIncludedIds(pack.included);
    const sourceMax = this.maxCreatedAt([...records, ...handoffs]);
    const generatedAt = new Date();
    const stalenessMs = sourceMax ? Math.max(0, generatedAt.getTime() - sourceMax.getTime()) : 0;
    const freshness = {
      retrievalMode: 'hybrid' as const,
      generatedAt: generatedAt.toISOString(),
      lastMemoryEventAt: sourceMax?.toISOString() ?? null,
      stalenessMs,
      sourceEventCount: records.length + handoffs.length,
      includedEventCount: includedIds.length,
    };
    const snapshot = await this.createSnapshot({
      ...normalized,
      taskHash: this.hashTask(normalized),
      text: pack.text,
      includedEventIds: includedIds,
      sourceEventMaxCreatedAt: sourceMax,
      sourceEventCount: freshness.sourceEventCount,
      retrievalMode: freshness.retrievalMode,
      stalenessMs,
      metadata: { freshness },
    });
    return {
      ...pack,
      cacheHit: false,
      snapshotId: snapshot?.id,
      freshness,
    };
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
            status,
            pinned,
            "expiresAt",
            "archivedAt",
            "lastAccessedAt",
            "accessCount",
            embedding,
            "createdAt"
          FROM public.memory_context_events
          WHERE "projectId" = ${projectId}
            AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
            AND (status = 'active' OR pinned = true)
            AND "archivedAt" IS NULL
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          ORDER BY "createdAt" DESC
          LIMIT ${limit}
        `
      : await this.fetchRecentRows(limit);
    return rows.map((row) => this.mapRow(row));
  }

  async createHandoff(input: CreateContextHandoffDto): Promise<ContextMemoryHandoff> {
    const artifact = input.artifact ? JSON.stringify(input.artifact) : null;
    const rows = await this.prisma.$queryRaw<ContextHandoffRow[]>`
      INSERT INTO public.memory_context_handoffs (
        "projectId",
        "runId",
        "fromAgent",
        "toAgent",
        title,
        content,
        artifact,
        metadata
      )
      VALUES (
        ${input.projectId.trim()},
        ${input.runId?.trim() || null},
        ${input.fromAgent.trim()},
        ${input.toAgent.trim()},
        ${input.title.trim()},
        ${input.content.trim()},
        ${artifact}::jsonb,
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING
        id,
        "projectId",
        "runId",
        "fromAgent",
        "toAgent",
        title,
        content,
        artifact,
        status,
        "acknowledgedAt",
        "resolvedAt",
        "createdAt",
        "updatedAt"
    `;
    return this.mapHandoffRow(rows[0]);
  }

  async acknowledgeHandoff(handoffId: string): Promise<ContextMemoryHandoff> {
    const rows = await this.prisma.$queryRaw<ContextHandoffRow[]>`
      UPDATE public.memory_context_handoffs
      SET
        status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
        "acknowledgedAt" = COALESCE("acknowledgedAt", NOW()),
        "updatedAt" = NOW()
      WHERE id = ${handoffId}::uuid
      RETURNING
        id,
        "projectId",
        "runId",
        "fromAgent",
        "toAgent",
        title,
        content,
        artifact,
        status,
        "acknowledgedAt",
        "resolvedAt",
        "createdAt",
        "updatedAt"
    `;
    return this.mapHandoffRow(rows[0]);
  }

  async resolveHandoff(handoffId: string): Promise<ContextMemoryHandoff> {
    const rows = await this.prisma.$queryRaw<ContextHandoffRow[]>`
      UPDATE public.memory_context_handoffs
      SET
        status = 'resolved',
        "acknowledgedAt" = COALESCE("acknowledgedAt", NOW()),
        "resolvedAt" = COALESCE("resolvedAt", NOW()),
        "updatedAt" = NOW()
      WHERE id = ${handoffId}::uuid
      RETURNING
        id,
        "projectId",
        "runId",
        "fromAgent",
        "toAgent",
        title,
        content,
        artifact,
        status,
        "acknowledgedAt",
        "resolvedAt",
        "createdAt",
        "updatedAt"
    `;
    return this.mapHandoffRow(rows[0]);
  }

  async listHandoffs(
    input: ListContextHandoffsDto & { projectId: string },
  ): Promise<ContextMemoryHandoff[]> {
    const limit = this.normalizeLimit(input.limit);
    const runId = input.runId?.trim();
    const toAgent = input.toAgent?.trim();
    const status = input.status?.trim();
    const rows = await this.prisma.$queryRaw<ContextHandoffRow[]>`
      SELECT
        id,
        "projectId",
        "runId",
        "fromAgent",
        "toAgent",
        title,
        content,
        artifact,
        status,
        "acknowledgedAt",
        "resolvedAt",
        "createdAt",
        "updatedAt"
      FROM public.memory_context_handoffs
      WHERE "projectId" = ${input.projectId.trim()}
        AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
        AND (${toAgent ?? null}::text IS NULL OR "toAgent" = ${toAgent ?? null})
        AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
      ORDER BY "updatedAt" DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.mapHandoffRow(row));
  }

  async listSnapshots(
    input: ListContextSnapshotsDto & { projectId: string },
  ): Promise<ContextMemorySnapshot[]> {
    const limit = this.normalizeSnapshotLimit(input.limit);
    const runId = input.runId?.trim();
    const agentType = input.agentType?.trim();
    const rows = await this.prisma.$queryRaw<ContextSnapshotRow[]>`
      SELECT
        id,
        "projectId",
        "runId",
        "agentType",
        "taskHash",
        task,
        text,
        "includedEventIds",
        "sourceEventMaxCreatedAt",
        "sourceEventCount",
        "retrievalMode",
        "stalenessMs",
        metadata,
        "createdAt"
      FROM public.memory_context_snapshots
      WHERE "projectId" = ${input.projectId.trim()}
        AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
        AND (${agentType ?? null}::text IS NULL OR "agentType" = ${agentType ?? null})
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.mapSnapshotRow(row));
  }

  async compactProjectMemory(input: CompactContextMemoryDto): Promise<{
    summary: ContextMemoryRecord;
    compactedEventCount: number;
  }> {
    const projectId = input.projectId.trim();
    const runId = input.runId?.trim();
    const limit = this.normalizeCompactionLimit(input.maxEvents);
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
        status,
        pinned,
        "expiresAt",
        "archivedAt",
        "lastAccessedAt",
        "accessCount",
        embedding,
        "createdAt"
      FROM public.memory_context_events
      WHERE "projectId" = ${projectId}
        AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
        AND type <> 'project_memory'
        AND (status = 'active' OR pinned = true)
        AND "archivedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
    const records = rows.map((row) => this.mapRow(row));
    const summaryText = this.buildCompactionSummary(records);
    const summary = await this.record({
      projectId,
      runId,
      agentType: 'context_memory',
      type: 'project_memory',
      title: 'Run memory summary',
      content: summaryText,
      importance: 0.85,
      tags: ['summary', 'compacted-memory'],
      metadata: {
        compactedEventIds: records.map((record) => record.id),
        compactedEventCount: records.length,
      },
    });
    return {
      summary,
      compactedEventCount: records.length,
    };
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
            status,
            pinned,
            "expiresAt",
            "archivedAt",
            "lastAccessedAt",
            "accessCount",
            embedding,
            "createdAt"
      FROM public.memory_context_events
      WHERE "projectId" = ${projectId}
        AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
        AND (status = 'active' OR pinned = true)
        AND "archivedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
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
        status,
        pinned,
        "expiresAt",
        "archivedAt",
        "lastAccessedAt",
        "accessCount",
        embedding,
        "createdAt"
      FROM public.memory_context_events
      WHERE (status = 'active' OR pinned = true)
        AND "archivedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
  }

  private async findReusableSnapshot(
    input: {
      projectId: string;
      runId?: string;
      agentType: string;
      task: string;
    },
    allowCached: boolean,
  ): Promise<ContextMemorySnapshot | null> {
    const taskHash = this.hashTask(input);
    const rows = await this.prisma.$queryRaw<ContextSnapshotRow[]>`
      SELECT
        id,
        "projectId",
        "runId",
        "agentType",
        "taskHash",
        task,
        text,
        "includedEventIds",
        "sourceEventMaxCreatedAt",
        "sourceEventCount",
        "retrievalMode",
        "stalenessMs",
        metadata,
        "createdAt"
      FROM public.memory_context_snapshots snapshot
      WHERE snapshot."projectId" = ${input.projectId}
        AND (${input.runId ?? null}::text IS NULL OR snapshot."runId" = ${input.runId ?? null})
        AND snapshot."agentType" = ${input.agentType}
        AND snapshot."taskHash" = ${taskHash}
        AND NOT EXISTS (
          SELECT 1
          FROM public.memory_context_events event
          WHERE event."projectId" = snapshot."projectId"
            AND (${input.runId ?? null}::text IS NULL OR event."runId" = ${input.runId ?? null})
            AND (event.status = 'active' OR event.pinned = true)
            AND event."archivedAt" IS NULL
            AND (event."expiresAt" IS NULL OR event."expiresAt" > NOW())
            AND event."createdAt" > COALESCE(snapshot."sourceEventMaxCreatedAt", 'epoch'::timestamptz)
        )
      ORDER BY snapshot."createdAt" DESC
      LIMIT 1
    `;
    if (!allowCached || rows.length === 0) return null;
    return this.mapSnapshotRow(rows[0]);
  }

  private async fetchOpenHandoffRecords(
    projectId: string,
    runId: string | undefined,
    agentType: string,
  ): Promise<ContextMemoryRecord[]> {
    const rows = await this.prisma.$queryRaw<ContextHandoffRow[]>`
      SELECT
        id,
        "projectId",
        "runId",
        "fromAgent",
        "toAgent",
        title,
        content,
        artifact,
        status,
        "acknowledgedAt",
        "resolvedAt",
        "createdAt",
        "updatedAt"
      FROM public.memory_context_handoffs
      WHERE "projectId" = ${projectId}
        AND (${runId ?? null}::text IS NULL OR "runId" = ${runId ?? null})
        AND "toAgent" = ${agentType}
        AND status IN ('open', 'acknowledged')
      ORDER BY "updatedAt" DESC
      LIMIT 50
    `;
    return rows.map((row) => this.handoffToMemoryRecord(this.mapHandoffRow(row)));
  }

  private async createSnapshot(input: SnapshotInsertInput): Promise<ContextMemorySnapshot | null> {
    const rows = await this.prisma.$queryRaw<ContextSnapshotRow[]>`
      INSERT INTO public.memory_context_snapshots (
        "projectId",
        "runId",
        "agentType",
        "taskHash",
        task,
        text,
        "includedEventIds",
        "sourceEventMaxCreatedAt",
        "sourceEventCount",
        "retrievalMode",
        "stalenessMs",
        metadata
      )
      VALUES (
        ${input.projectId},
        ${input.runId ?? null},
        ${input.agentType},
        ${input.taskHash},
        ${input.task},
        ${input.text},
        ${input.includedEventIds},
        ${input.sourceEventMaxCreatedAt},
        ${input.sourceEventCount},
        ${input.retrievalMode},
        ${input.stalenessMs},
        ${JSON.stringify(input.metadata)}::jsonb
      )
      RETURNING
        id,
        "projectId",
        "runId",
        "agentType",
        "taskHash",
        task,
        text,
        "includedEventIds",
        "sourceEventMaxCreatedAt",
        "sourceEventCount",
        "retrievalMode",
        "stalenessMs",
        metadata,
        "createdAt"
    `;
    return rows[0] ? this.mapSnapshotRow(rows[0]) : null;
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

  private normalizeSnapshotLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return 10;
    return Math.max(1, Math.min(50, Math.round(value)));
  }

  private normalizeCompactionLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return 100;
    return Math.max(1, Math.min(500, Math.round(value)));
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

  private hashTask(input: {
    projectId: string;
    runId?: string;
    agentType: string;
    task: string;
  }): string {
    return createHash('sha256')
      .update([
        input.projectId,
        input.runId ?? '',
        input.agentType,
        input.task.trim().toLowerCase().replace(/\s+/g, ' '),
      ].join('\n'))
      .digest('hex');
  }

  private contextPackFromSnapshot(
    snapshot: ContextMemorySnapshot,
    input: {
      projectId: string;
      runId?: string;
      agentType: string;
      task: string;
      maxChars: number;
    },
  ): ContextPackResult {
    const included = Object.fromEntries(
      CONTEXT_MEMORY_TYPES.map((type) => [type, [] as string[]]),
    ) as ContextPackResult['included'];
    const freshness = {
      retrievalMode: 'cached' as const,
      generatedAt: new Date().toISOString(),
      lastMemoryEventAt: snapshot.sourceEventMaxCreatedAt?.toISOString() ?? null,
      stalenessMs: snapshot.stalenessMs,
      sourceEventCount: snapshot.sourceEventCount,
      includedEventCount: snapshot.sourceEventCount,
    };
    return {
      projectId: input.projectId,
      runId: input.runId ?? null,
      agentType: input.agentType,
      task: input.task,
      maxChars: input.maxChars,
      text: snapshot.text,
      included,
      cacheHit: true,
      snapshotId: snapshot.id,
      freshness,
    };
  }

  private flattenIncludedIds(included: ContextPackResult['included']): string[] {
    return [...new Set(Object.values(included).flat())];
  }

  private maxCreatedAt(records: ContextMemoryRecord[]): Date | null {
    let max: Date | null = null;
    for (const record of records) {
      if (!max || record.createdAt.getTime() > max.getTime()) {
        max = record.createdAt;
      }
    }
    return max;
  }

  private handoffToMemoryRecord(handoff: ContextMemoryHandoff): ContextMemoryRecord {
    return {
      id: `handoff:${handoff.id}`,
      projectId: handoff.projectId,
      runId: handoff.runId,
      agentType: handoff.fromAgent,
      type: 'handoff',
      title: handoff.title,
      content: handoff.content,
      importance: handoff.status === 'open' ? 0.9 : 0.75,
      tags: ['handoff', handoff.fromAgent.toLowerCase(), handoff.toAgent.toLowerCase()],
      artifact: handoff.artifact,
      progress: null,
      metadata: { status: handoff.status, toAgent: handoff.toAgent },
      hash: null,
      status: 'active',
      pinned: true,
      expiresAt: null,
      archivedAt: null,
      lastAccessedAt: null,
      accessCount: 0,
      embedding: null,
      createdAt: handoff.updatedAt,
    };
  }

  private buildCompactionSummary(records: ContextMemoryRecord[]): string {
    if (records.length === 0) {
      return 'No active run memory was available to compact.';
    }
    const grouped = new Map<string, ContextMemoryRecord[]>();
    for (const record of records) {
      const bucket = grouped.get(record.type) ?? [];
      bucket.push(record);
      grouped.set(record.type, bucket);
    }
    const lines = [
      `Compacted ${records.length} memory events into a project summary.`,
    ];
    for (const [type, items] of grouped.entries()) {
      lines.push(`\n${type}:`);
      for (const item of items.slice(0, 8)) {
        lines.push(`- ${item.title}: ${item.content.replace(/\s+/g, ' ').slice(0, 240)}`);
      }
    }
    return lines.join('\n');
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
      status: row.status === 'archived' ? 'archived' : 'active',
      pinned: row.pinned === true,
      expiresAt: row.expiresAt ?? null,
      archivedAt: row.archivedAt ?? null,
      lastAccessedAt: row.lastAccessedAt ?? null,
      accessCount: typeof row.accessCount === 'number' ? row.accessCount : 0,
      embedding: this.parseEmbedding(row.embedding),
      createdAt: row.createdAt,
    };
  }

  private mapHandoffRow(row: ContextHandoffRow | undefined): ContextMemoryHandoff {
    if (!row) {
      throw new Error('Context handoff query returned no row');
    }
    return {
      id: row.id,
      projectId: row.projectId,
      runId: row.runId,
      fromAgent: row.fromAgent,
      toAgent: row.toAgent,
      title: row.title,
      content: row.content,
      artifact: this.objectOrNull(row.artifact),
      status: this.handoffStatus(row.status),
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapSnapshotRow(row: ContextSnapshotRow | undefined): ContextMemorySnapshot {
    if (!row) {
      throw new Error('Context snapshot query returned no row');
    }
    return {
      id: row.id,
      projectId: row.projectId,
      runId: row.runId,
      agentType: row.agentType,
      taskHash: row.taskHash,
      task: row.task,
      text: row.text,
      includedEventIds: Array.isArray(row.includedEventIds) ? row.includedEventIds : [],
      sourceEventMaxCreatedAt: row.sourceEventMaxCreatedAt,
      sourceEventCount: typeof row.sourceEventCount === 'number' ? row.sourceEventCount : 0,
      retrievalMode: row.retrievalMode === 'lexical' ? 'lexical' : 'hybrid',
      stalenessMs: typeof row.stalenessMs === 'number' ? row.stalenessMs : 0,
      metadata: this.objectOrEmpty(row.metadata),
      createdAt: row.createdAt,
    };
  }

  private handoffStatus(value: string): ContextMemoryHandoff['status'] {
    if (value === 'acknowledged' || value === 'resolved') return value;
    return 'open';
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

  private parseEmbedding(value: number[] | string | null | undefined): number[] | null {
    if (Array.isArray(value)) return value.filter((component) => typeof component === 'number');
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!trimmed) return null;
    const parsed = trimmed
      .split(',')
      .map((component) => Number(component.trim()))
      .filter((component) => Number.isFinite(component));
    return parsed.length > 0 ? parsed : null;
  }
}
