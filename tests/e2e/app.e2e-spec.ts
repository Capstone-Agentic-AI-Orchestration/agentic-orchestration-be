import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiModule } from '../../apps/api/src/api.module';

describe('ApiController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/v1 (GET)', () => {
    const httpServer = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    return request(httpServer)
      .get('/api/v1')
      .expect(200)
      .expect((res: { body: { service: string; version: string } }) => {
        expect(res.body.service).toBe('tribe-backend');
        expect(res.body.version).toBe('1.0.0');
      });
  });

  it('/api/v1/health (GET)', () => {
    const httpServer = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    return request(httpServer)
      .get('/api/v1/health')
      .expect(
        (res: {
          status: number;
          body: { status: string; uptimeSeconds: number };
        }) => {
          expect([200, 503]).toContain(res.status);
          expect(['ok', 'degraded', 'error']).toContain(res.body.status);
          expect(typeof res.body.uptimeSeconds).toBe('number');
        },
      );
  });
});
