import type { IntegrationOutbox } from '@prisma/client';

export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

export interface IntegrationEventPublisher {
  publish(event: IntegrationOutbox): Promise<void>;
}
