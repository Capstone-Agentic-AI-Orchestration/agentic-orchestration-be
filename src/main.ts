import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

function corsOrigins(): string | string[] {
  const configured = process.env.CORS_ORIGIN?.trim() || '*';
  if (configured === '*') return configured;

  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length <= 1 ? origins[0] ?? configured : origins;
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Phase 2E — WebSocket adapter (Socket.IO)
  // Must be registered before app.listen() so the /devflow namespace is mounted.
  app.useWebSocketAdapter(new IoAdapter(app));

  // CORS_ORIGIN may list several origins comma-separated (e.g. localhost + 127.0.0.1,
  // or a prod frontend URL). The cors package only multi-matches when given an ARRAY —
  // a comma-joined string is treated as one literal origin and matches nothing.
  app.enableCors({
    origin: corsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // x-runtime-token authenticates the local companion daemon, which sends no Authorization header.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'x-runtime-token',
    ],
  });

  // A companion reports up to 5MB of captured CLI output when it finishes a task. Express defaults
  // to 100kb, which would 413 exactly the successful work we care most about keeping.
  app.useBodyParser('json', { limit: '8mb' });

  // Observability: LangChain/LangGraph (and its LangSmith tracer) has been removed in the Eve
  // migration. Orchestration tracing now flows through the typed protocol channel
  // (OrchestrationEmitter) and, for Eve-delegated turns, the Vercel Agent Runs dashboard.

  const port = parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port, '0.0.0.0');
  logger.log(`DevFlow backend running on port ${port}`);
}

bootstrap().catch((err: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    'Failed to start application',
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});
