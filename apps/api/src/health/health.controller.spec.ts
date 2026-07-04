import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import type { HealthResponse, HealthStatus } from './health.service';

function makeServiceMock(
  status: HealthStatus,
  database: boolean,
  apiCenter: boolean,
): Partial<HealthService> {
  return {
    getStatus: jest.fn().mockResolvedValue({
      status,
      uptimeSeconds: 42,
      checks: { database, apiCenter },
    } satisfies HealthResponse),
  };
}

describe('HealthController', () => {
  async function createController(
    status: HealthStatus,
    database: boolean,
    apiCenter: boolean,
  ): Promise<HealthController> {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: makeServiceMock(status, database, apiCenter),
        },
      ],
    }).compile();
    return module.get<HealthController>(HealthController);
  }

  it('should be defined', async () => {
    const controller = await createController('ok', true, true);
    expect(controller).toBeDefined();
  });

  it('returns 200 with ok payload when both checks pass', async () => {
    const controller = await createController('ok', true, true);
    const response = await controller.getHealth();

    expect(response.status).toBe('ok');
    expect(response.checks.database).toBe(true);
    expect(response.checks.apiCenter).toBe(true);
    expect(typeof response.uptimeSeconds).toBe('number');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 200 with degraded payload when one check fails', async () => {
    const controller = await createController('degraded', false, true);
    const response = await controller.getHealth();

    expect(response.status).toBe('degraded');
    expect(response.checks.database).toBe(false);
    expect(response.checks.apiCenter).toBe(true);
  });

  it('throws HttpException 503 when both checks fail', async () => {
    const controller = await createController('error', false, false);

    const promise = controller.getHealth();
    await expect(promise).rejects.toThrow(HttpException);

    try {
      await controller.getHealth();
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = err.getResponse() as HealthResponse;
        expect(body.status).toBe('error');
        expect(body.checks.database).toBe(false);
        expect(body.checks.apiCenter).toBe(false);
      }
    }
  });
});
