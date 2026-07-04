import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const IdempotencyRecordStatus = {
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

function makeRecord(overrides = {}) {
  return {
    id: 'idem-1',
    key: 'request-key-1',
    scope: 'public:POST:/inquiries',
    requestHash: 'hash-1',
    status: IdempotencyRecordStatus.COMPLETED,
    responseStatus: 201,
    responseBody: { id: 'inquiry-1' },
    error: null,
    lockedUntil: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    idempotencyRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(makeRecord({
        status: IdempotencyRecordStatus.PROCESSING,
        responseBody: null,
      })),
      update: vi.fn().mockResolvedValue(makeRecord()),
    },
  };
}

describe('IdempotencyService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: IdempotencyService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new IdempotencyService(prisma as unknown as PrismaService);
  });

  it('executes the handler once and stores the successful response', async () => {
    const handler = vi.fn().mockResolvedValue({ id: 'inquiry-1' });

    const result = await service.run({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: 201,
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      fromCache: false,
      responseStatus: 201,
      body: { id: 'inquiry-1' },
    });
    expect(prisma.idempotencyRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        key: 'request-key-1',
        scope: 'public:POST:/inquiries',
        requestHash: 'hash-1',
        status: IdempotencyRecordStatus.PROCESSING,
      }),
    }));
    expect(prisma.idempotencyRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: IdempotencyRecordStatus.COMPLETED,
        responseStatus: 201,
        responseBody: { id: 'inquiry-1' },
      }),
    }));
  });

  it('returns a completed cached response without rerunning the handler', async () => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue(makeRecord());
    const handler = vi.fn();

    const result = await service.run({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: 201,
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      fromCache: true,
      responseStatus: 201,
      body: { id: 'inquiry-1' },
    });
  });

  it('rejects a reused key with a different request hash', async () => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue(makeRecord({
      requestHash: 'different-hash',
    }));

    await expect(service.run({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: 201,
      handler: vi.fn(),
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects concurrent replays while the original request is still processing', async () => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue(makeRecord({
      status: IdempotencyRecordStatus.PROCESSING,
      responseBody: null,
      lockedUntil: new Date(Date.now() + 60_000),
    }));

    await expect(service.run({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: 201,
      handler: vi.fn(),
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('recovers from a unique-key race by reading the existing record', async () => {
    prisma.idempotencyRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeRecord());
    prisma.idempotencyRecord.create.mockRejectedValue({ code: 'P2002' });
    const handler = vi.fn();

    const result = await service.run({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: 201,
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      fromCache: true,
      responseStatus: 201,
      body: { id: 'inquiry-1' },
    });
  });

  it('marks the record failed when the handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('create failed'));

    await expect(service.run({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: 201,
      handler,
    })).rejects.toThrow('create failed');

    expect(prisma.idempotencyRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: IdempotencyRecordStatus.FAILED,
        error: 'create failed',
      }),
    }));
  });
});
