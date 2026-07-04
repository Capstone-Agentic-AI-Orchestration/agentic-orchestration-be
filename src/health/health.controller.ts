import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type HealthResponse = { status: 'ok'; checks: { apiCenter: true } };

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(['health', 'api/v1/health'])
  live(): HealthResponse {
    return { status: 'ok', checks: { apiCenter: true } };
  }

  @Get(['health/live', 'api/v1/health/live'])
  liveness(): HealthResponse {
    return { status: 'ok', checks: { apiCenter: true } };
  }

  @Get(['health/ready', 'api/v1/health/ready'])
  async readiness(): Promise<HealthResponse & { dependencies: { database: 'ok' } }> {
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return {
        status: 'ok',
        checks: { apiCenter: true },
        dependencies: { database: 'ok' },
      };
    } catch {
      throw new ServiceUnavailableException({
        title: 'Service Unavailable',
        detail: 'Database readiness check failed',
      });
    }
  }
}
