import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { TribeClient } from '@implementsprint/sdk';
import { SupabaseService } from '@app/supabase';

const makeSupabaseMock = (pingResult: boolean): Partial<SupabaseService> => ({
  ping: jest.fn().mockResolvedValue(pingResult),
});

const makeTribeClientMock = (exists: boolean): Partial<TribeClient> | null =>
  exists ? {} : null;

describe('HealthService', () => {
  async function createService(
    dbPing: boolean,
    apiPing: boolean,
  ): Promise<HealthService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: SupabaseService, useValue: makeSupabaseMock(dbPing) },
        {
          provide: TribeClient,
          useValue: makeTribeClientMock(apiPing),
        },
      ],
    }).compile();

    return module.get<HealthService>(HealthService);
  }

  it('should be defined', async () => {
    const service = await createService(true, true);
    expect(service).toBeDefined();
  });

  it('returns ok when both checks pass', async () => {
    const service = await createService(true, true);
    const result = await service.getStatus();

    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe(true);
    expect(result.checks.apiCenter).toBe(true);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns degraded when database fails but apiCenter passes', async () => {
    const service = await createService(false, true);
    const result = await service.getStatus();

    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe(false);
    expect(result.checks.apiCenter).toBe(true);
  });

  it('returns degraded when apiCenter fails but database passes', async () => {
    const service = await createService(true, false);
    const result = await service.getStatus();

    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe(true);
    expect(result.checks.apiCenter).toBe(false);
  });

  it('returns error when both checks fail', async () => {
    const service = await createService(false, false);
    const result = await service.getStatus();

    expect(result.status).toBe('error');
    expect(result.checks.database).toBe(false);
    expect(result.checks.apiCenter).toBe(false);
  });
});
