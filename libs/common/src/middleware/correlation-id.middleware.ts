import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

// Augment the Express Request type to carry the correlation ID downstream
// so filters and interceptors can read it without re-parsing the header.
declare module 'express' {
  interface Request {
    correlationId?: string;
  }
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const existing = req.headers['x-correlation-id'];

    // Sanitize the inbound header before echoing it into response headers and
    // logs. Strip anything that is not alphanumeric, hyphen, or underscore to
    // prevent control-character or oversized-value injection. Truncate to 128
    // characters. Fall back to a fresh UUID if nothing survives sanitization.
    const sanitized =
      typeof existing === 'string'
        ? existing.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 128)
        : '';

    const correlationId: string =
      sanitized.length > 0 ? sanitized : crypto.randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    next();
  }
}
