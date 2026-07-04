import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  IdempotencyRecordStatus,
  Prisma,
  type IdempotencyRecord,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const PROCESSING_LOCK_MS = 60_000;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 200;

export interface IdempotencyRunInput<TBody> {
  key: string;
  scope: string;
  requestHash: string;
  responseStatus: number;
  handler: () => Promise<TBody>;
  ttlMs?: number;
}

export interface IdempotencyRunResult<TBody> {
  fromCache: boolean;
  responseStatus: number;
  body: TBody;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  requestHash(value: unknown): string {
    return createHash('sha256')
      .update(this.stableStringify(value))
      .digest('hex');
  }

  async run<TBody>(
    input: IdempotencyRunInput<TBody>,
  ): Promise<IdempotencyRunResult<TBody>> {
    const key = this.normalizeKey(input.key);
    const now = new Date();
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        key_scope: {
          key,
          scope: input.scope,
        },
      },
    });

    if (existing && existing.expiresAt > now) {
      return this.handleExisting(existing, input);
    }

    const claimed = existing
      ? {
          record: await this.prisma.idempotencyRecord.update({
            where: { id: existing.id },
            data: this.processingData(key, input, now),
          }),
        }
      : await this.createProcessingRecord(key, input, now);

    if ('result' in claimed) {
      return claimed.result;
    }

    const { record } = claimed;

    try {
      const body = await input.handler();
      await this.prisma.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: IdempotencyRecordStatus.COMPLETED,
          responseStatus: input.responseStatus,
          responseBody: this.toJsonValue(body),
          error: null,
          lockedUntil: null,
        },
      });

      return {
        fromCache: false,
        responseStatus: input.responseStatus,
        body,
      };
    } catch (err) {
      await this.prisma.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: IdempotencyRecordStatus.FAILED,
          error: err instanceof Error ? err.message : String(err),
          lockedUntil: null,
        },
      });
      throw err;
    }
  }

  private handleExisting<TBody>(
    record: IdempotencyRecord,
    input: IdempotencyRunInput<TBody>,
  ): IdempotencyRunResult<TBody> {
    if (record.requestHash !== input.requestHash) {
      throw new BadRequestException(
        'Idempotency-Key was already used with a different request payload',
      );
    }

    if (
      record.status === IdempotencyRecordStatus.COMPLETED &&
      record.responseStatus !== null
    ) {
      return {
        fromCache: true,
        responseStatus: record.responseStatus,
        body: record.responseBody as TBody,
      };
    }

    if (
      record.status === IdempotencyRecordStatus.PROCESSING &&
      record.lockedUntil &&
      record.lockedUntil > new Date()
    ) {
      throw new ConflictException(
        'Request with this Idempotency-Key is still processing',
      );
    }

    throw new ConflictException(
      'Idempotency-Key is not ready for replay; retry with a new key',
    );
  }

  private normalizeKey(key: string): string {
    const normalized = key.trim();
    if (
      normalized.length < MIN_KEY_LENGTH ||
      normalized.length > MAX_KEY_LENGTH
    ) {
      throw new BadRequestException(
        `Idempotency-Key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters`,
      );
    }
    return normalized;
  }

  private processingData<TBody>(
    key: string,
    input: IdempotencyRunInput<TBody>,
    now: Date,
  ): Prisma.IdempotencyRecordCreateInput {
    return {
      key,
      scope: input.scope,
      requestHash: input.requestHash,
      status: IdempotencyRecordStatus.PROCESSING,
      responseStatus: null,
      responseBody: undefined,
      error: null,
      lockedUntil: new Date(now.getTime() + PROCESSING_LOCK_MS),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
    };
  }

  private async createProcessingRecord<TBody>(
    key: string,
    input: IdempotencyRunInput<TBody>,
    now: Date,
  ): Promise<
    | { record: IdempotencyRecord }
    | { result: IdempotencyRunResult<TBody> }
  > {
    try {
      return {
        record: await this.prisma.idempotencyRecord.create({
          data: this.processingData(key, input, now),
        }),
      };
    } catch (err) {
      if (!this.isUniqueConflict(err)) {
        throw err;
      }

      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: {
          key_scope: {
            key,
            scope: input.scope,
          },
        },
      });

      if (!existing) {
        throw err;
      }

      return { result: this.handleExisting(existing, input) };
    }
  }

  private isUniqueConflict(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'P2002'
    );
  }

  private stableStringify(value: unknown): string {
    if (value === undefined) {
      return 'undefined';
    }

    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${this.stableStringify(entryValue)}`)
      .join(',')}}`;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
