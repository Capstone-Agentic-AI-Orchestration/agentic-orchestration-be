import { Injectable, Logger } from '@nestjs/common';
import type { IntegrationOutbox } from '@prisma/client';
import type { IntegrationEventPublisher } from './integration-event.publisher';

@Injectable()
export class LogIntegrationEventPublisher implements IntegrationEventPublisher {
  private readonly logger = new Logger(LogIntegrationEventPublisher.name);

  publish(event: IntegrationOutbox): Promise<void> {
    this.logger.log(
      `Published integration event ${event.eventType} for ${event.aggregateType}:${event.aggregateId}`,
    );
    return Promise.resolve();
  }
}
