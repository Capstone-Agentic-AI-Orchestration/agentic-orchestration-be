import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationOutbox } from '@prisma/client';
import { OUTBOX_PUBLISHER, type IntegrationEventPublisher } from './integration-event.publisher';
import { OutboxService } from './outbox.service';

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly relayId = `relay-${process.pid}-${Date.now()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly outbox: OutboxService,
    @Inject(OUTBOX_PUBLISHER)
    private readonly publisher: IntegrationEventPublisher,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Outbox relay disabled; integration events will remain pending.');
      return;
    }

    this.logger.warn(
      'Outbox relay enabled with local publisher. Replace OUTBOX_PUBLISHER with a broker publisher before multi-service production deployment.',
    );

    this.timer = setInterval(() => {
      this.relayTick().catch((err: unknown) => {
        this.logger.error(
          `Outbox relay tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs());
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async relayTick(): Promise<void> {
    if (!this.enabled() || this.running) {
      return;
    }

    this.running = true;
    try {
      const batch = await this.outbox.claimDueBatch({
        batchSize: this.batchSize(),
        lockMs: this.lockMs(),
        maxAttempts: this.maxAttempts(),
        relayId: this.relayId,
      });

      for (const event of batch) {
        await this.publishOne(event);
      }
    } finally {
      this.running = false;
    }
  }

  private async publishOne(event: IntegrationOutbox): Promise<void> {
    const nextAttempt = event.attempts + 1;
    try {
      await this.publisher.publish(event);
      await this.outbox.markPublished(event.id, this.relayId);
    } catch (err) {
      await this.outbox.markFailed({
        id: event.id,
        relayId: this.relayId,
        attempts: nextAttempt,
        maxAttempts: this.maxAttempts(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private enabled(): boolean {
    return this.configService.get<boolean>('outboxRelay.enabled') ?? false;
  }

  private intervalMs(): number {
    return this.configService.get<number>('outboxRelay.intervalMs') ?? 10_000;
  }

  private batchSize(): number {
    return this.configService.get<number>('outboxRelay.batchSize') ?? 25;
  }

  private lockMs(): number {
    return this.configService.get<number>('outboxRelay.lockMs') ?? 60_000;
  }

  private maxAttempts(): number {
    return this.configService.get<number>('outboxRelay.maxAttempts') ?? 5;
  }
}
