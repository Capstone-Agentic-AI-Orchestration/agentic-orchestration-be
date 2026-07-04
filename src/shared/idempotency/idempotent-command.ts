import { IdempotencyService } from './idempotency.service';

export interface IdempotentCommandInput<TBody> {
  idempotency: IdempotencyService;
  idempotencyKey?: string;
  scope: string;
  requestPayload: unknown;
  responseStatus: number;
  handler: () => Promise<TBody>;
}

export function executeIdempotentCommand<TBody>(
  input: IdempotentCommandInput<TBody>,
): Promise<TBody> {
  if (!input.idempotencyKey) {
    return input.handler();
  }

  return input.idempotency
    .run({
      key: input.idempotencyKey,
      scope: input.scope,
      requestHash: input.idempotency.requestHash(input.requestPayload),
      responseStatus: input.responseStatus,
      handler: input.handler,
    })
    .then((result) => result.body);
}
