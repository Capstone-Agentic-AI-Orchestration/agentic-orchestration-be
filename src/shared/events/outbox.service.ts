import { Injectable } from '@nestjs/common';
import { IntegrationOutboxStatus, type IntegrationOutbox, type Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { findIntegrationEventContractViolations } from '../architecture/service-boundaries';
import { integrationEventContractFor, type IntegrationEvent } from './integration-event';

type OutboxClient = Pick<PrismaService, 'integrationOutbox'> | Prisma.TransactionClient;

export interface ClaimOutboxBatchOptions {
  batchSize: number;
  lockMs: number;
  maxAttempts: number;
  relayId: string;
}

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async append<TPayload extends Prisma.InputJsonValue>(
    event: IntegrationEvent<TPayload>,
    client: OutboxClient = this.prisma,
  ): Promise<void> {
    this.assertValidEventContract(event);

    await client.integrationOutbox.create({
      data: {
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        producer: event.producer,
        payload: event.payload,
        metadata: event.metadata ?? {},
      },
    });
  }

  async claimDueBatch(options: ClaimOutboxBatchOptions): Promise<IntegrationOutbox[]> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + options.lockMs);
    const unlockedWhere = {
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    } satisfies Prisma.IntegrationOutboxWhereInput;

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.integrationOutbox.findMany({
        where: {
          AND: [
            unlockedWhere,
            {
              OR: [
                {
                  status: IntegrationOutboxStatus.PENDING,
                  nextAttemptAt: null,
                },
                {
                  status: IntegrationOutboxStatus.PENDING,
                  nextAttemptAt: { lte: now },
                },
                {
                  status: IntegrationOutboxStatus.FAILED,
                  attempts: { lt: options.maxAttempts },
                  nextAttemptAt: { lte: now },
                },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: options.batchSize,
      });

      if (candidates.length === 0) {
        return [];
      }

      const ids = candidates.map((event) => event.id);
      await tx.integrationOutbox.updateMany({
        where: {
          id: { in: ids },
          ...unlockedWhere,
        },
        data: {
          lockId: options.relayId,
          lockedAt: now,
          lockedUntil,
        },
      });

      return tx.integrationOutbox.findMany({
        where: {
          id: { in: ids },
          lockId: options.relayId,
        },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async markPublished(id: string, relayId: string): Promise<void> {
    await this.prisma.integrationOutbox.updateMany({
      where: { id, lockId: relayId },
      data: {
        status: IntegrationOutboxStatus.PUBLISHED,
        publishedAt: new Date(),
        lockId: null,
        lockedAt: null,
        lockedUntil: null,
        nextAttemptAt: null,
        error: null,
      },
    });
  }

  async markFailed(input: {
    id: string;
    relayId: string;
    error: string;
    attempts: number;
    maxAttempts: number;
  }): Promise<void> {
    const nextAttemptAt =
      input.attempts >= input.maxAttempts
        ? null
        : new Date(Date.now() + this.retryDelayMs(input.attempts));

    await this.prisma.integrationOutbox.updateMany({
      where: { id: input.id, lockId: input.relayId },
      data: {
        status: IntegrationOutboxStatus.FAILED,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        nextAttemptAt,
        lockId: null,
        lockedAt: null,
        lockedUntil: null,
        error: input.error.slice(0, 4000),
      },
    });
  }

  private retryDelayMs(attempts: number): number {
    const retryNumber = Math.max(attempts, 1);
    return Math.min(60_000, 1_000 * 2 ** (retryNumber - 1));
  }

  private assertValidEventContract(event: IntegrationEvent): void {
    const violations = findIntegrationEventContractViolations([event.eventType]);
    const eventProducer = event.eventType.split('.')[0];
    const eventContract = integrationEventContractFor(event.eventType);

    if (eventProducer !== event.producer) {
      violations.push({
        eventType: event.eventType,
        producer: event.producer,
        reason: 'undeclared-publisher',
      });
    }

    if (eventContract && eventContract.aggregateType !== event.aggregateType) {
      violations.push({
        eventType: event.eventType,
        producer: event.producer,
        reason: 'aggregate-type-mismatch',
      });
    }

    if (violations.length > 0) {
      throw new Error(`Invalid integration event contract: ${violations
        .map((violation) => `${violation.eventType}:${violation.reason}`)
        .join(', ')}`);
    }
  }
}
