import { Global, Module } from '@nestjs/common';
import { OUTBOX_PUBLISHER } from './events/integration-event.publisher';
import { LogIntegrationEventPublisher } from './events/log-integration-event.publisher';
import { OutboxRelayService } from './events/outbox-relay.service';
import { OutboxService } from './events/outbox.service';
import { IdempotencyService } from './idempotency/idempotency.service';

@Global()
@Module({
  providers: [
    OutboxService,
    IdempotencyService,
    LogIntegrationEventPublisher,
    OutboxRelayService,
    {
      provide: OUTBOX_PUBLISHER,
      useExisting: LogIntegrationEventPublisher,
    },
  ],
  exports: [OutboxService, IdempotencyService],
})
export class SharedKernelModule {}
