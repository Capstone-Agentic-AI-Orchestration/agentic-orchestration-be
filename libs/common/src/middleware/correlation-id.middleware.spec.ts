import { CorrelationIdMiddleware } from './correlation-id.middleware';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
  headers: Record<string, string | string[] | undefined> = {},
): Request & { correlationId?: string } {
  return { headers } as unknown as Request & { correlationId?: string };
}

function makeRes(): Response & { _headers: Record<string, string> } {
  const res = {
    _headers: {} as Record<string, string>,
    setHeader: jest.fn(function (
      this: { _headers: Record<string, string> },
      name: string,
      value: string,
    ) {
      this._headers[name] = value;
    }),
  };
  return res as unknown as Response & { _headers: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;
  let next: jest.Mock;

  beforeEach(() => {
    middleware = new CorrelationIdMiddleware();
    next = jest.fn();
  });

  it('should be defined', () => {
    expect(middleware).toBeDefined();
  });

  describe('when x-correlation-id header is present and valid', () => {
    it('attaches the sanitized id to req.correlationId', () => {
      const req = makeReq({ 'x-correlation-id': 'abc-123_XYZ' });
      const res = makeRes();

      middleware.use(req, res, next);

      expect(req.correlationId).toBe('abc-123_XYZ');
    });

    it('echoes the id in the X-Correlation-ID response header', () => {
      const req = makeReq({ 'x-correlation-id': 'corr-001' });
      const res = makeRes();

      middleware.use(req, res, next);

      expect(res._headers['X-Correlation-ID']).toBe('corr-001');
    });

    it('calls next()', () => {
      const req = makeReq({ 'x-correlation-id': 'corr-001' });
      const res = makeRes();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('when x-correlation-id header is absent', () => {
    it('generates a UUID and assigns it to req.correlationId', () => {
      const req = makeReq({});
      const res = makeRes();

      middleware.use(req, res, next);

      expect(typeof req.correlationId).toBe('string');
      expect(req.correlationId!.length).toBeGreaterThan(0);
    });

    it('sets the generated id in the X-Correlation-ID response header', () => {
      const req = makeReq({});
      const res = makeRes();

      middleware.use(req, res, next);

      expect(res._headers['X-Correlation-ID']).toBe(req.correlationId);
    });

    it('calls next()', () => {
      const req = makeReq({});
      const res = makeRes();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('sanitization', () => {
    it('strips characters outside alphanumeric, hyphen, and underscore', () => {
      const req = makeReq({
        'x-correlation-id': 'corr<script>alert(1)</script>',
      });
      const res = makeRes();

      middleware.use(req, res, next);

      expect(req.correlationId).toBe('corrscriptalert1script');
    });

    it('truncates ids longer than 128 characters to exactly 128', () => {
      const longId = 'a'.repeat(200);
      const req = makeReq({ 'x-correlation-id': longId });
      const res = makeRes();

      middleware.use(req, res, next);

      expect(req.correlationId!.length).toBe(128);
    });

    it('falls back to a generated UUID when the sanitized result is empty', () => {
      const req = makeReq({ 'x-correlation-id': '!!!@@@###' });
      const res = makeRes();

      middleware.use(req, res, next);

      // Should be a non-empty string (UUID format)
      expect(typeof req.correlationId).toBe('string');
      expect(req.correlationId!.length).toBeGreaterThan(0);
      // All special chars stripped means sanitized is '' → UUID fallback
      expect(req.correlationId).not.toBe('');
    });

    it('accepts a valid UUID as-is', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const req = makeReq({ 'x-correlation-id': uuid });
      const res = makeRes();

      middleware.use(req, res, next);

      expect(req.correlationId).toBe(uuid);
    });

    it('handles an array-valued header by falling back to a new UUID', () => {
      // Express normalises multi-value headers to arrays in some scenarios
      const req = makeReq({
        'x-correlation-id': ['id-a', 'id-b'] as unknown as string,
      });
      const res = makeRes();

      middleware.use(req, res, next);

      // The header is not a string, so sanitized falls back to UUID
      expect(typeof req.correlationId).toBe('string');
      expect(req.correlationId!.length).toBeGreaterThan(0);
    });
  });
});
