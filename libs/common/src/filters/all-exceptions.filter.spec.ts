import { HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockResponse {
  status: jest.Mock<MockResponse, [number]>;
  json: jest.Mock<void, [unknown]>;
  _statusCode: number;
  _body: unknown;
}

function makeResponse(): MockResponse {
  const res: MockResponse = {
    status: jest.fn<MockResponse, [number]>(),
    json: jest.fn<void, [unknown]>(),
    _statusCode: 0,
    _body: undefined,
  };
  res.status.mockImplementation((statusCode: number) => {
    res._statusCode = statusCode;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
  });
  return res;
}

function makeHost(
  req: Partial<{
    url: string;
    method: string;
    headers: Record<string, string>;
    correlationId?: string;
  }>,
  res: MockResponse,
): ArgumentsHost {
  return {
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue(req),
      getResponse: jest.fn().mockReturnValue(res),
    }),
  } as unknown as ArgumentsHost;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  describe('HttpException handling', () => {
    it('returns the correct HTTP status code from an HttpException', () => {
      const res = makeResponse();
      const req = { url: '/test', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new HttpException('Not Found', HttpStatus.NOT_FOUND), host);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('serialises a string HttpException response correctly', () => {
      const res = makeResponse();
      const req = { url: '/test', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new HttpException('Forbidden', HttpStatus.FORBIDDEN), host);

      const body = res._body as Record<string, unknown>;
      expect(body['statusCode']).toBe(403);
      expect(body['message']).toBe('Forbidden');
    });

    it('serialises an object HttpException response — string message field', () => {
      const res = makeResponse();
      const req = { url: '/test', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(
        new HttpException(
          { message: 'Validation failed', error: 'Bad Request' },
          HttpStatus.BAD_REQUEST,
        ),
        host,
      );

      const body = res._body as Record<string, unknown>;
      expect(body['statusCode']).toBe(400);
      expect(body['message']).toBe('Validation failed');
      expect(body['error']).toBe('Bad Request');
    });

    it('joins array message fields with a semicolon', () => {
      const res = makeResponse();
      const req = { url: '/test', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(
        new HttpException(
          {
            message: ['field1 required', 'field2 invalid'],
            error: 'Bad Request',
          },
          HttpStatus.BAD_REQUEST,
        ),
        host,
      );

      const body = res._body as Record<string, unknown>;
      expect(body['message']).toBe('field1 required; field2 invalid');
    });

    it('includes the request path in the error envelope', () => {
      const res = makeResponse();
      const req = { url: '/my/path', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new HttpException('error', HttpStatus.BAD_REQUEST), host);

      const body = res._body as Record<string, unknown>;
      expect(body['path']).toBe('/my/path');
    });

    it('includes a timestamp in the error envelope', () => {
      const res = makeResponse();
      const req = { url: '/', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new HttpException('error', HttpStatus.BAD_REQUEST), host);

      const body = res._body as Record<string, unknown>;
      expect(typeof body['timestamp']).toBe('string');
      expect(() => new Date(body['timestamp'] as string)).not.toThrow();
    });

    it('reads correlationId from req.correlationId when present', () => {
      const res = makeResponse();
      const req = {
        url: '/',
        method: 'GET',
        headers: {},
        correlationId: 'req-corr-id',
      };
      const host = makeHost(req, res);

      filter.catch(new HttpException('error', HttpStatus.BAD_REQUEST), host);

      const body = res._body as Record<string, unknown>;
      expect(body['correlationId']).toBe('req-corr-id');
    });

    it('falls back to x-correlation-id header when req.correlationId is absent', () => {
      const res = makeResponse();
      const req = {
        url: '/',
        method: 'GET',
        headers: { 'x-correlation-id': 'header-corr-id' },
      };
      const host = makeHost(req, res);

      filter.catch(new HttpException('error', HttpStatus.BAD_REQUEST), host);

      const body = res._body as Record<string, unknown>;
      expect(body['correlationId']).toBe('header-corr-id');
    });

    it('sets correlationId to null when neither source is present', () => {
      const res = makeResponse();
      const req = { url: '/', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new HttpException('error', HttpStatus.BAD_REQUEST), host);

      const body = res._body as Record<string, unknown>;
      expect(body['correlationId']).toBeNull();
    });
  });

  describe('non-HttpException handling', () => {
    it('returns 500 for a plain Error', () => {
      const res = makeResponse();
      const req = { url: '/crash', method: 'POST', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new Error('something exploded'), host);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('returns "Internal Server Error" message for any unhandled exception', () => {
      const res = makeResponse();
      const req = { url: '/', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new Error('boom'), host);

      const body = res._body as Record<string, unknown>;
      expect(body['message']).toBe('Internal Server Error');
      expect(body['error']).toBe('Internal Server Error');
    });

    it('handles a non-Error thrown value (string)', () => {
      const res = makeResponse();
      const req = { url: '/', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch('raw string thrown', host);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('does not leak error details in production mode', () => {
      process.env['NODE_ENV'] = 'production';

      const res = makeResponse();
      const req = { url: '/', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new Error('internal secret'), host);

      const body = res._body as Record<string, unknown>;
      // message should be the generic text, not the internal error detail
      expect(body['message']).toBe('Internal Server Error');
    });

    it('returns 500 status code in production mode', () => {
      process.env['NODE_ENV'] = 'production';

      const res = makeResponse();
      const req = { url: '/', method: 'GET', headers: {} };
      const host = makeHost(req, res);

      filter.catch(new Error('boom'), host);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
