import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { IntegrationOutboxStatus, type IntegrationOutbox } from '@prisma/client';
import { OutboxRelayService } from '../src/shared/events/outbox-relay.service';
import { OutboxService } from '../src/shared/events/outbox.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function makeOutboxEvent(overrides: Partial<IntegrationOutbox> = {}): IntegrationOutbox {
  return {
    id: 'outbox-1',
    eventType: 'intake.inquiry.submitted.v1',
    aggregateType: 'client_inquiry',
    aggregateId: 'inquiry-1',
    producer: 'intake',
    payload: { inquiryId: 'inquiry-1' },
    metadata: {},
    status: IntegrationOutboxStatus.PENDING,
    attempts: 0,
    lockId: null,
    lockedAt: null,
    lockedUntil: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    publishedAt: null,
    error: null,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    ...overrides,
  };
}

function makeConfig(enabled: boolean) {
  const values = new Map<string, unknown>([
    ['outboxRelay.enabled', enabled],
    ['outboxRelay.intervalMs', 10_000],
    ['outboxRelay.batchSize', 25],
    ['outboxRelay.lockMs', 60_000],
    ['outboxRelay.maxAttempts', 5],
  ]);

  return {
    get: vi.fn((key: string) => values.get(key)),
  };
}

describe('OutboxRelayService', () => {
  let outbox: {
    claimDueBatch: ReturnType<typeof vi.fn>;
    markPublished: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  let publisher: { publish: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    outbox = {
      claimDueBatch: vi.fn().mockResolvedValue([]),
      markPublished: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    publisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('does not claim events when the relay is disabled', async () => {
    const service = new OutboxRelayService(
      makeConfig(false) as unknown as ConfigService,
      outbox as unknown as OutboxService,
      publisher,
    );

    await service.relayTick();

    expect(outbox.claimDueBatch).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('publishes claimed events and marks them published', async () => {
    const event = makeOutboxEvent();
    outbox.claimDueBatch.mockResolvedValue([event]);
    const service = new OutboxRelayService(
      makeConfig(true) as unknown as ConfigService,
      outbox as unknown as OutboxService,
      publisher,
    );

    await service.relayTick();

    expect(outbox.claimDueBatch).toHaveBeenCalledWith(expect.objectContaining({
      batchSize: 25,
      lockMs: 60_000,
      maxAttempts: 5,
      relayId: expect.stringMatching(/^relay-/),
    }));
    expect(publisher.publish).toHaveBeenCalledWith(event);
    expect(outbox.markPublished).toHaveBeenCalledWith(
      event.id,
      expect.stringMatching(/^relay-/),
    );
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  it('marks failed publishes with the next attempt count', async () => {
    const event = makeOutboxEvent({ attempts: 2 });
    outbox.claimDueBatch.mockResolvedValue([event]);
    publisher.publish.mockRejectedValue(new Error('broker unavailable'));
    const service = new OutboxRelayService(
      makeConfig(true) as unknown as ConfigService,
      outbox as unknown as OutboxService,
      publisher,
    );

    await service.relayTick();

    expect(outbox.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: event.id,
      relayId: expect.stringMatching(/^relay-/),
      attempts: 3,
      maxAttempts: 5,
      error: 'broker unavailable',
    }));
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });
});

describe('OutboxService', () => {
  it('appends valid integration events to the outbox', async () => {
    const prisma = {
      integrationOutbox: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    };
    const service = new OutboxService(prisma as unknown as PrismaService);

    await service.append({
      eventType: 'intake.inquiry.submitted.v1',
      aggregateType: 'client_inquiry',
      aggregateId: 'inquiry-1',
      producer: 'intake',
      payload: { inquiryId: 'inquiry-1' },
    });

    expect(prisma.integrationOutbox.create).toHaveBeenCalledWith({
      data: {
        eventType: 'intake.inquiry.submitted.v1',
        aggregateType: 'client_inquiry',
        aggregateId: 'inquiry-1',
        producer: 'intake',
        payload: { inquiryId: 'inquiry-1' },
        metadata: {},
      },
    });
  });

  it('rejects malformed integration events before appending', async () => {
    const prisma = {
      integrationOutbox: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    };
    const service = new OutboxService(prisma as unknown as PrismaService);

    await expect(service.append({
      eventType: 'intake.inquiry.submitted',
      aggregateType: 'client_inquiry',
      aggregateId: 'inquiry-1',
      producer: 'intake',
      payload: { inquiryId: 'inquiry-1' },
    })).rejects.toThrow('Invalid integration event contract');

    expect(prisma.integrationOutbox.create).not.toHaveBeenCalled();
  });

  it('rejects integration events whose producer does not match the declared event publisher', async () => {
    const prisma = {
      integrationOutbox: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    };
    const service = new OutboxService(prisma as unknown as PrismaService);

    await expect(service.append({
      eventType: 'intake.inquiry.submitted.v1',
      aggregateType: 'client_inquiry',
      aggregateId: 'inquiry-1',
      producer: 'notifications',
      payload: { inquiryId: 'inquiry-1' },
    })).rejects.toThrow('Invalid integration event contract');

    expect(prisma.integrationOutbox.create).not.toHaveBeenCalled();
  });

  it('rejects integration events whose aggregate type does not match the declared contract', async () => {
    const prisma = {
      integrationOutbox: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    };
    const service = new OutboxService(prisma as unknown as PrismaService);

    await expect(service.append({
      eventType: 'intake.inquiry.submitted.v1',
      aggregateType: 'project',
      aggregateId: 'inquiry-1',
      producer: 'intake',
      payload: { inquiryId: 'inquiry-1' },
    })).rejects.toThrow('Invalid integration event contract');

    expect(prisma.integrationOutbox.create).not.toHaveBeenCalled();
  });

  it('marks failed events retryable until max attempts is reached', async () => {
    const prisma = {
      integrationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new OutboxService(prisma as unknown as PrismaService);

    await service.markFailed({
      id: 'outbox-1',
      relayId: 'relay-1',
      attempts: 2,
      maxAttempts: 5,
      error: 'temporary failure',
    });

    expect(prisma.integrationOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'outbox-1', lockId: 'relay-1' },
      data: expect.objectContaining({
        status: IntegrationOutboxStatus.FAILED,
        attempts: { increment: 1 },
        nextAttemptAt: expect.any(Date),
        lockId: null,
      }),
    });
  });

  it('stops retry scheduling when max attempts is reached', async () => {
    const prisma = {
      integrationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new OutboxService(prisma as unknown as PrismaService);

    await service.markFailed({
      id: 'outbox-1',
      relayId: 'relay-1',
      attempts: 5,
      maxAttempts: 5,
      error: 'permanent failure',
    });

    expect(prisma.integrationOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'outbox-1', lockId: 'relay-1' },
      data: expect.objectContaining({
        status: IntegrationOutboxStatus.FAILED,
        attempts: { increment: 1 },
        nextAttemptAt: null,
        error: 'permanent failure',
      }),
    });
  });
});
