import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Phase 2E — WebSocket adapter (Socket.IO)
  // Must be registered before app.listen() so the /devflow namespace is mounted.
  app.useWebSocketAdapter(new IoAdapter(app));

  // CORS_ORIGIN may list several origins comma-separated (e.g. localhost + 127.0.0.1,
  // or a prod frontend URL). The cors package only multi-matches when given an ARRAY —
  // a comma-joined string is treated as one literal origin and matches nothing.
  const corsOrigin = process.env.CORS_ORIGIN ?? '*';
  app.enableCors({
    origin:
      corsOrigin === '*'
        ? true
        : corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });

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
