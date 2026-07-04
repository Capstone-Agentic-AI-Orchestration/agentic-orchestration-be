import { HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';
import { executeIdempotentCommand } from '../src/shared/idempotency/idempotent-command';

describe('executeIdempotentCommand', () => {
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ responseStatus, handler }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
  });

  it('bypasses idempotency and executes the handler when no key is provided', async () => {
    const handler = vi.fn().mockResolvedValue({ id: 'project-1' });

    await expect(executeIdempotentCommand({
      idempotency: idempotency as unknown as IdempotencyService,
      idempotencyKey: undefined,
      scope: 'user:user-1:POST:/projects',
      requestPayload: { companyName: 'Acme' },
      responseStatus: HttpStatus.CREATED,
      handler,
    })).resolves.toEqual({ id: 'project-1' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(idempotency.requestHash).not.toHaveBeenCalled();
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('hashes the payload and returns the idempotency body when a key is provided', async () => {
    const handler = vi.fn().mockResolvedValue({ id: 'project-1' });
    const payload = { companyName: 'Acme' };

    await expect(executeIdempotentCommand({
      idempotency: idempotency as unknown as IdempotencyService,
      idempotencyKey: 'request-key-1',
      scope: 'user:user-1:POST:/projects',
      requestPayload: payload,
      responseStatus: HttpStatus.CREATED,
      handler,
    })).resolves.toEqual({ id: 'project-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(payload);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: 'user:user-1:POST:/projects',
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler,
    }));
  });
});
