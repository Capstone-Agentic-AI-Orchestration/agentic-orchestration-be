import {
  corsOptions,
  helmetConfig,
  helmetConfigSwagger,
  BODY_SIZE_LIMIT,
} from './security.config';

// ---------------------------------------------------------------------------
// BODY_SIZE_LIMIT
// ---------------------------------------------------------------------------

describe('BODY_SIZE_LIMIT', () => {
  it('is defined', () => {
    expect(BODY_SIZE_LIMIT).toBeDefined();
  });

  it('equals "5mb"', () => {
    expect(BODY_SIZE_LIMIT).toBe('5mb');
  });
});

// ---------------------------------------------------------------------------
// helmetConfig
// ---------------------------------------------------------------------------

describe('helmetConfig', () => {
  it('is defined', () => {
    expect(helmetConfig).toBeDefined();
  });

  it('has contentSecurityPolicy with defaultSrc self-only', () => {
    expect(helmetConfig.contentSecurityPolicy.directives.defaultSrc).toEqual([
      "'self'",
    ]);
  });

  it('has scriptSrc restricted to self', () => {
    expect(helmetConfig.contentSecurityPolicy.directives.scriptSrc).toEqual([
      "'self'",
    ]);
  });

  it('has frameAncestors set to none (clickjacking protection)', () => {
    expect(
      helmetConfig.contentSecurityPolicy.directives.frameAncestors,
    ).toEqual(["'none'"]);
  });

  it('has objectSrc set to none', () => {
    expect(helmetConfig.contentSecurityPolicy.directives.objectSrc).toEqual([
      "'none'",
    ]);
  });

  it('has hsts maxAge of 1 year (31536000)', () => {
    expect(helmetConfig.hsts.maxAge).toBe(31536000);
  });

  it('has hsts includeSubDomains enabled', () => {
    expect(helmetConfig.hsts.includeSubDomains).toBe(true);
  });

  it('has hsts preload enabled', () => {
    expect(helmetConfig.hsts.preload).toBe(true);
  });

  it('has noSniff enabled', () => {
    expect(helmetConfig.noSniff).toBe(true);
  });

  it('has referrerPolicy set to no-referrer', () => {
    expect(helmetConfig.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });

  it('has frameguard disabled (using CSP frame-ancestors instead)', () => {
    expect(helmetConfig.frameguard).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helmetConfigSwagger
// ---------------------------------------------------------------------------

describe('helmetConfigSwagger', () => {
  it('is defined', () => {
    expect(helmetConfigSwagger).toBeDefined();
  });

  it('allows unsafe-inline scripts (required by Swagger UI)', () => {
    expect(
      helmetConfigSwagger.contentSecurityPolicy.directives.scriptSrc,
    ).toContain("'unsafe-inline'");
  });

  it('allows unsafe-inline styles (required by Swagger UI)', () => {
    expect(
      helmetConfigSwagger.contentSecurityPolicy.directives.styleSrc,
    ).toContain("'unsafe-inline'");
  });

  it('still enforces frameAncestors none', () => {
    expect(
      helmetConfigSwagger.contentSecurityPolicy.directives.frameAncestors,
    ).toEqual(["'none'"]);
  });

  it('still has hsts enabled', () => {
    expect(helmetConfigSwagger.hsts.maxAge).toBe(31536000);
  });

  it('still has noSniff enabled', () => {
    expect(helmetConfigSwagger.noSniff).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// corsOptions
// ---------------------------------------------------------------------------

describe('corsOptions', () => {
  type CorsOriginCallback = (
    origin: string | undefined,
    callback: (err: Error | null, result?: boolean | string) => void,
  ) => void;

  function resolveOrigin(
    options: ReturnType<typeof corsOptions>,
    origin: string | undefined,
  ): Promise<boolean | string | Error> {
    return new Promise((resolve) => {
      const callback = (err: Error | null, result?: boolean | string) => {
        if (err) resolve(err);
        else resolve(result as boolean | string);
      };
      const originHandler = options.origin as CorsOriginCallback;
      originHandler(origin, callback);
    });
  }

  it('allows a whitelisted origin', async () => {
    const opts = corsOptions('http://localhost:5173,https://app.example.com');
    const result = await resolveOrigin(opts, 'http://localhost:5173');
    expect(result).toBe(true);
  });

  it('allows a second whitelisted origin', async () => {
    const opts = corsOptions('http://localhost:5173,https://app.example.com');
    const result = await resolveOrigin(opts, 'https://app.example.com');
    expect(result).toBe(true);
  });

  it('rejects an origin not in the whitelist', async () => {
    const opts = corsOptions('http://localhost:5173');
    const result = await resolveOrigin(opts, 'https://evil.example.com');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/not allowed/);
  });

  it('allows requests with no origin (server-to-server / health probes)', async () => {
    const opts = corsOptions('http://localhost:5173');
    const result = await resolveOrigin(opts, undefined);
    expect(result).toBe(true);
  });

  it('rejects all origins when allowedOriginsEnv is empty string', async () => {
    const opts = corsOptions('');
    const result = await resolveOrigin(opts, 'http://localhost:5173');
    expect(result).toBeInstanceOf(Error);
  });

  it('rejects all browser origins when allowedOriginsEnv is undefined', async () => {
    const opts = corsOptions(undefined);
    const result = await resolveOrigin(opts, 'http://localhost:5173');
    expect(result).toBeInstanceOf(Error);
  });

  it('trims whitespace around origin entries', async () => {
    const opts = corsOptions(
      '  http://localhost:5173  ,  https://app.example.com  ',
    );
    const result = await resolveOrigin(opts, 'http://localhost:5173');
    expect(result).toBe(true);
  });

  it('includes credentials: true', () => {
    const opts = corsOptions('http://localhost:5173');
    expect(opts.credentials).toBe(true);
  });

  it('exposes X-Request-Id header', () => {
    const opts = corsOptions('http://localhost:5173');
    expect(opts.exposedHeaders).toContain('X-Request-Id');
  });

  it('includes standard HTTP methods', () => {
    const opts = corsOptions('http://localhost:5173');
    const methods = opts.methods as string[];
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('OPTIONS');
  });

  it('includes Authorization in allowedHeaders', () => {
    const opts = corsOptions('http://localhost:5173');
    const headers = opts.allowedHeaders as string[];
    expect(headers).toContain('Authorization');
  });

  it('sets maxAge to 86400 (24h preflight cache)', () => {
    const opts = corsOptions('http://localhost:5173');
    expect(opts.maxAge).toBe(86400);
  });

  it('does not allow a prefix-matched subdomain attack', async () => {
    const opts = corsOptions('https://example.com');
    const result = await resolveOrigin(opts, 'https://evil.example.com');
    expect(result).toBeInstanceOf(Error);
  });
});
