import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from '@app/common';
import {
  BODY_SIZE_LIMIT,
  corsOptions,
  helmetConfig,
  helmetConfigSwagger,
} from '@app/common';
import * as express from 'express';
import helmet from 'helmet';
import { ApiModule } from './api.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    bodyParser: false,
  });

  const configService = app.get(ConfigService);
  const enableSwagger = configService.get<string>('ENABLE_SWAGGER') === 'true';

  app.use(helmet(enableSwagger ? helmetConfigSwagger : helmetConfig));
  app.use(express.json({ limit: BODY_SIZE_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');

  const allowedOriginsEnv = configService.get<string>('ALLOWED_ORIGINS');
  app.enableCors(corsOptions(allowedOriginsEnv));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  if (enableSwagger) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Tribe Backend')
      .setDescription('Tribe Backend API')
      .setVersion('1.0.0')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/v1/docs', app, document);
    logger.log('Swagger docs available at /api/v1/docs');
  }

  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`Application running on 0.0.0.0:${String(port)}`);
}

void bootstrap();
