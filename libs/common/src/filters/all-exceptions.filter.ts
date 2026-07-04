import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorEnvelope {
  statusCode: number;
  message: string;
  error: string;
  correlationId: string | null;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { correlationId?: string }>();
    const response = ctx.getResponse<Response>();

    let statusCode: number;
    let message: string;
    let error: string;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.message;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, unknown>;
        message =
          typeof resp['message'] === 'string'
            ? resp['message']
            : Array.isArray(resp['message'])
              ? (resp['message'] as string[]).join('; ')
              : exception.message;
        error =
          typeof resp['error'] === 'string' ? resp['error'] : exception.message;
      } else {
        message = exception.message;
        error = exception.message;
      }
      this.logger.warn(
        `HTTP ${statusCode} on ${request.method} ${request.url}: ${message}`,
      );
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal Server Error';
      error = 'Internal Server Error';

      if (process.env['NODE_ENV'] !== 'production') {
        this.logger.error(
          `Unhandled exception: ${String(exception)}`,
          exception instanceof Error ? exception.stack : undefined,
        );
      } else {
        // Production: log class name only — no stack or message to avoid
        // leaking internal details. The name alone is sufficient for triage.
        const exceptionName =
          exception instanceof Error ? exception.name : typeof exception;
        this.logger.error(
          `Unhandled exception on ${request.url} [${exceptionName}]`,
        );
      }
    }

    const correlationId: string | null =
      request.correlationId ??
      (typeof request.headers['x-correlation-id'] === 'string'
        ? request.headers['x-correlation-id']
        : null);

    const body: ErrorEnvelope = {
      statusCode,
      message,
      error,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(body);
  }
}
