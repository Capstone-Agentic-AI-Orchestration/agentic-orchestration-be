import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';

type MockSupabaseClient = {
  auth: {
    admin: {
      listUsers: jest.Mock;
    };
  };
};

function setInternalClient(
  service: SupabaseService,
  client: MockSupabaseClient,
): void {
  (service as unknown as { client: MockSupabaseClient }).client = client;
}

function setScopedClient(
  service: SupabaseService,
  servicePrefix: string,
  client: MockSupabaseClient,
): void {
  (
    service as unknown as { scopedClients: Map<string, MockSupabaseClient> }
  ).scopedClients.set(servicePrefix, client);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(
  url: string | undefined,
  key: string | undefined,
): Partial<ConfigService> {
  return {
    get: jest.fn().mockImplementation((k: string) => {
      if (k === 'SUPABASE_URL') return url;
      if (k === 'SUPABASE_SERVICE_ROLE_KEY') return key;
      return undefined;
    }),
  };
}

async function createService(
  url: string | undefined,
  key: string | undefined,
  scopedEnv: Record<string, string | undefined> = {},
): Promise<SupabaseService> {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    ...scopedEnv,
  };

  try {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupabaseService,
        { provide: ConfigService, useValue: makeConfigService(url, key) },
      ],
    }).compile();

    const service = module.get<SupabaseService>(SupabaseService);
    // Manually trigger lifecycle hook (NestJS testing module does not call it automatically)
    service.onModuleInit();
    return service;
  } finally {
    process.env = originalEnv;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SupabaseService', () => {
  describe('onModuleInit / getClient', () => {
    it('should be defined', async () => {
      const service = await createService(
        'https://abc.supabase.co',
        'service-role-key',
      );
      expect(service).toBeDefined();
    });

    it('creates a Supabase client when both URL and key are provided', async () => {
      const service = await createService(
        'https://abc.supabase.co',
        'service-role-key',
      );
      expect(service.getClient()).not.toBeNull();
    });

    it('leaves client null when URL is missing', async () => {
      const service = await createService(undefined, 'service-role-key');
      expect(service.getClient()).toBeNull();
    });

    it('leaves client null when key is missing', async () => {
      const service = await createService('https://abc.supabase.co', undefined);
      expect(service.getClient()).toBeNull();
    });

    it('leaves client null when both URL and key are missing', async () => {
      const service = await createService(undefined, undefined);
      expect(service.getClient()).toBeNull();
    });

    it('creates scoped clients for tribe service env pairs', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
        {
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
          PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
          CHAT_SERVICE_SUPABASE_URL: 'https://chat.supabase.co',
          CHAT_SERVICE_SUPABASE_SECRET_KEY: 'chat-secret',
        },
      );

      expect(service.listConfiguredServices()).toEqual([
        'CHAT_SERVICE',
        'PAYMENT_SERVICE',
      ]);
      expect(service.getClientForService('PAYMENT_SERVICE')).not.toBeNull();
      expect(service.getClientForService('chat-service')).not.toBeNull();
    });

    it('supports scoped _SUPABASE_SERVICE_ROLE_KEY suffix', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
        {
          PROVIDER_SERVICE_SUPABASE_URL: 'https://provider.supabase.co',
          PROVIDER_SERVICE_SUPABASE_SERVICE_ROLE_KEY: 'provider-secret',
        },
      );

      expect(service.getClientForService('provider service')).not.toBeNull();
      expect(service.hasServiceClient('provider_service')).toBe(true);
    });

    it('ignores incomplete scoped service config', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
        {
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
        },
      );

      expect(service.getClientForService('PAYMENT_SERVICE')).toBeNull();
      expect(service.listConfiguredServices()).toEqual([]);
    });

    it('returns null for unknown service client', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
      );

      expect(service.getClientForService('does-not-exist')).toBeNull();
      expect(service.hasServiceClient('does-not-exist')).toBe(false);
    });
  });

  describe('ping()', () => {
    it('returns false immediately when client is null', async () => {
      const service = await createService(undefined, undefined);
      const result = await service.ping();
      expect(result).toBe(false);
    });

    it('returns true when listUsers resolves without error', async () => {
      const service = await createService(
        'https://abc.supabase.co',
        'service-role-key',
      );

      // Stub the internal Supabase client
      const mockListUsers = jest.fn().mockResolvedValue({ error: null });
      setInternalClient(service, {
        auth: { admin: { listUsers: mockListUsers } },
      });

      const result = await service.ping();
      expect(result).toBe(true);
      expect(mockListUsers).toHaveBeenCalledWith({ page: 1, perPage: 1 });
    });

    it('returns false when listUsers resolves with an error object', async () => {
      const service = await createService(
        'https://abc.supabase.co',
        'service-role-key',
      );

      const mockListUsers = jest
        .fn()
        .mockResolvedValue({ error: new Error('auth failed') });
      setInternalClient(service, {
        auth: { admin: { listUsers: mockListUsers } },
      });

      const result = await service.ping();
      expect(result).toBe(false);
    });

    it('returns false when listUsers throws', async () => {
      const service = await createService(
        'https://abc.supabase.co',
        'service-role-key',
      );

      const mockListUsers = jest
        .fn()
        .mockRejectedValue(new Error('network error'));
      setInternalClient(service, {
        auth: { admin: { listUsers: mockListUsers } },
      });

      const result = await service.ping();
      expect(result).toBe(false);
    });

    it('returns false when the 3-second timeout fires before listUsers resolves', async () => {
      jest.useFakeTimers();

      const service = await createService(
        'https://abc.supabase.co',
        'service-role-key',
      );

      // Promise that never resolves
      const mockListUsers = jest.fn().mockReturnValue(new Promise(() => {}));
      setInternalClient(service, {
        auth: { admin: { listUsers: mockListUsers } },
      });

      const pingPromise = service.ping();

      // Advance past the 3000 ms timeout
      jest.advanceTimersByTime(3001);

      const result = await pingPromise;
      expect(result).toBe(false);

      jest.useRealTimers();
    });

    it('pings a scoped service client when service name is provided', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
      );

      const mockListUsers = jest.fn().mockResolvedValue({ error: null });
      setScopedClient(service, 'PAYMENT_SERVICE', {
        auth: { admin: { listUsers: mockListUsers } },
      });

      const result = await service.pingService('payment-service');
      expect(result).toBe(true);
      expect(mockListUsers).toHaveBeenCalledWith({ page: 1, perPage: 1 });
    });

    it('returns false when scoped service client is missing', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
      );

      const result = await service.pingService('missing-service');
      expect(result).toBe(false);
    });
  });

  describe('getDefaultOrServiceClient()', () => {
    it('returns default client when service name is not provided', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
      );

      expect(service.getDefaultOrServiceClient()).toBe(service.getClient());
    });

    it('returns scoped client when service is provided', async () => {
      const service = await createService(
        'https://default.supabase.co',
        'default-service-role-key',
        {
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
          PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
        },
      );

      expect(
        service.getDefaultOrServiceClient('payment_service'),
      ).not.toBeNull();
    });
  });
});
