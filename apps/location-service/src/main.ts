import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { LocationServiceAppModule } from './location-service.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('LocationServiceBootstrap');
  const port = Number(process.env.LOCATION_SERVICE_PORT ?? 4010);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    LocationServiceAppModule,
    {
      transport: Transport.TCP,
      options: {
        host: process.env.LOCATION_SERVICE_HOST ?? '0.0.0.0',
        port,
      },
    },
  );

  await app.listen();
  logger.log(`Location microservice listening on TCP port ${String(port)}`);
}

void bootstrap();
