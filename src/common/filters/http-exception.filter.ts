import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = exception.getResponse();
    const isProduction = process.env.NODE_ENV === 'production';

    let message: string | string[];
    // A machine-readable error code (e.g. ACCOUNT_PENDING_APPROVAL) surfaced from
    // `throw new ForbiddenException({ code, message })`, so clients can branch on it instead
    // of matching prose that may change.
    let code: string | undefined;
    if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
    } else if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null
    ) {
      const resp = exceptionResponse as Record<string, unknown>;
      message = (resp.message as string | string[]) ?? exception.message;
      if (typeof resp.code === 'string') code = resp.code;
    } else {
      message = exception.message;
    }

    const title =
      Array.isArray(message) || !message
        ? exception.name || 'HTTP Exception'
        : message;

    const body: Record<string, unknown> = {
      type: `https://api.devflow.local/problems/${status}`,
      title,
      status,
      detail: message,
      instance: request.url,
      timestamp: new Date().toISOString(),
      statusCode: status,
      ...(code ? { code } : {}),
    };

    if (!isProduction && status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} — ${status}`,
        exception.stack,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} — ${status}`);
    }

    response.status(status).type('application/problem+json').json(body);
  }
}
