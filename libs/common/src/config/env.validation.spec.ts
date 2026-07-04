import { validateEnv } from './env.validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  describe('happy path', () => {
    it('returns a fully typed config object for a valid env', () => {
      const result = validateEnv(validEnv());

      expect(result.NODE_ENV).toBe('development');
      expect(result.PORT).toBe(3000);
      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
      expect(result.SUPABASE_ANON_KEY).toBe('anon-key');
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('service-role-key');
      expect(result.ALLOWED_ORIGINS).toBe('http://localhost:5173');
    });

    it('accepts production as NODE_ENV', () => {
      const result = validateEnv(
        validEnv({
          NODE_ENV: 'production',
          API_CENTER_BASE_URL: 'http://api-center.local',
          API_CENTER_TRIBE_ID: 'tribe-a',
          API_CENTER_TRIBE_SECRET: 'tribe-secret',
        }),
      );
      expect(result.NODE_ENV).toBe('production');
    });

    it('accepts test as NODE_ENV', () => {
      const result = validateEnv(validEnv({ NODE_ENV: 'test' }));
      expect(result.NODE_ENV).toBe('test');
    });

    it('includes optional API_CENTER_BASE_URL when provided', () => {
      const result = validateEnv(
        validEnv({ API_CENTER_BASE_URL: 'http://api-center.local' }),
      );
      expect(result.API_CENTER_BASE_URL).toBe('http://api-center.local');
    });

    it('includes optional API_CENTER_API_KEY when provided', () => {
      const result = validateEnv(
        validEnv({
          API_CENTER_BASE_URL: 'http://api-center.local',
          API_CENTER_API_KEY: 'secret-key',
        }),
      );
      expect(result.API_CENTER_API_KEY).toBe('secret-key');
    });

    it('includes optional API_CENTER_TRIBE_ID and API_CENTER_TRIBE_SECRET when provided', () => {
      const result = validateEnv(
        validEnv({
          API_CENTER_TRIBE_ID: 'tribe-a',
          API_CENTER_TRIBE_SECRET: 'tribe-secret',
        }),
      );

      expect(result.API_CENTER_TRIBE_ID).toBe('tribe-a');
      expect(result.API_CENTER_TRIBE_SECRET).toBe('tribe-secret');
    });

    it('includes optional API_CENTER_TIMEOUT_MS when provided', () => {
      const result = validateEnv(validEnv({ API_CENTER_TIMEOUT_MS: '8000' }));
      expect(result.API_CENTER_TIMEOUT_MS).toBe('8000');
    });

    it('accepts APICENTER_* aliases', () => {
      const result = validateEnv(
        validEnv({
          APICENTER_URL: 'http://api-center.local',
          APICENTER_TRIBE_ID: 'tribe-a',
          APICENTER_TRIBE_SECRET: 'tribe-secret',
          APICENTER_TIMEOUT_MS: '5000',
        }),
      );

      expect(result.API_CENTER_BASE_URL).toBe('http://api-center.local');
      expect(result.API_CENTER_TRIBE_ID).toBe('tribe-a');
      expect(result.API_CENTER_TRIBE_SECRET).toBe('tribe-secret');
      expect(result.API_CENTER_TIMEOUT_MS).toBe('5000');
    });

    it('accepts scoped Supabase-only config without default SUPABASE_* trio', () => {
      const result = validateEnv(
        validEnv({
          SUPABASE_URL: undefined,
          SUPABASE_ANON_KEY: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
          PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
        }),
      );

      expect(result.SUPABASE_URL).toBeUndefined();
      expect(result.SUPABASE_ANON_KEY).toBeUndefined();
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    });

    it('accepts incomplete default SUPABASE_* when scoped clients are configured', () => {
      const result = validateEnv(
        validEnv({
          SUPABASE_ANON_KEY: undefined,
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
          PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
        }),
      );

      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
      expect(result.SUPABASE_ANON_KEY).toBeUndefined();
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('service-role-key');
    });

    it('omits API_CENTER_BASE_URL from result when not set', () => {
      const result = validateEnv(validEnv());
      expect(result.API_CENTER_BASE_URL).toBeUndefined();
    });

    it('defaults ENABLE_SWAGGER to "false" when not set', () => {
      const result = validateEnv(validEnv());
      expect(result.ENABLE_SWAGGER).toBe('false');
    });

    it('uses the provided ENABLE_SWAGGER value when set', () => {
      const result = validateEnv(validEnv({ ENABLE_SWAGGER: 'true' }));
      expect(result.ENABLE_SWAGGER).toBe('true');
    });

    it('trims leading/trailing whitespace from string values', () => {
      const result = validateEnv(
        validEnv({ SUPABASE_URL: '  https://abc.supabase.co  ' }),
      );
      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
    });
  });

  describe('NODE_ENV validation', () => {
    it('throws for an invalid NODE_ENV value', () => {
      expect(() => validateEnv(validEnv({ NODE_ENV: 'staging' }))).toThrow(
        /NODE_ENV/,
      );
    });

    it('throws when NODE_ENV is missing', () => {
      const env = validEnv();
      delete env['NODE_ENV'];
      expect(() => validateEnv(env)).toThrow(/NODE_ENV/);
    });

    it('throws when NODE_ENV is an empty string', () => {
      expect(() => validateEnv(validEnv({ NODE_ENV: '' }))).toThrow(/NODE_ENV/);
    });
  });

  describe('PORT validation', () => {
    it('throws when PORT is missing', () => {
      const env = validEnv();
      delete env['PORT'];
      expect(() => validateEnv(env)).toThrow(/PORT/);
    });

    it('throws when PORT is zero', () => {
      expect(() => validateEnv(validEnv({ PORT: '0' }))).toThrow(/PORT/);
    });

    it('throws when PORT is above 65535', () => {
      expect(() => validateEnv(validEnv({ PORT: '65536' }))).toThrow(/PORT/);
    });

    it('throws when PORT is not a number', () => {
      expect(() => validateEnv(validEnv({ PORT: 'abc' }))).toThrow(/PORT/);
    });

    it('accepts PORT at boundary value 1', () => {
      const result = validateEnv(validEnv({ PORT: '1' }));
      expect(result.PORT).toBe(1);
    });

    it('accepts PORT at boundary value 65535', () => {
      const result = validateEnv(validEnv({ PORT: '65535' }));
      expect(result.PORT).toBe(65535);
    });
  });

  describe('required string fields', () => {
    const requiredFields = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ALLOWED_ORIGINS',
    ];

    for (const field of requiredFields) {
      it(`throws when ${field} is missing`, () => {
        const env = validEnv();
        delete env[field];
        expect(() => validateEnv(env)).toThrow(new RegExp(field));
      });

      it(`throws when ${field} is an empty string`, () => {
        expect(() => validateEnv(validEnv({ [field]: '' }))).toThrow(
          new RegExp(field),
        );
      });

      it(`throws when ${field} is whitespace only`, () => {
        expect(() => validateEnv(validEnv({ [field]: '   ' }))).toThrow(
          new RegExp(field),
        );
      });
    }
  });

  describe('optional field warnings', () => {
    it('does not throw when API_CENTER_BASE_URL is missing', () => {
      expect(() => validateEnv(validEnv())).not.toThrow();
    });

    it('does not throw when API_CENTER_API_KEY is missing', () => {
      expect(() =>
        validateEnv(
          validEnv({ API_CENTER_BASE_URL: 'http://api-center.local' }),
        ),
      ).not.toThrow();
    });

    it('does not throw when only APICENTER_URL alias is set', () => {
      expect(() =>
        validateEnv(validEnv({ APICENTER_URL: 'http://api-center.local' })),
      ).not.toThrow();
    });

    it('throws when API_CENTER_TIMEOUT_MS is invalid', () => {
      expect(() =>
        validateEnv(validEnv({ API_CENTER_TIMEOUT_MS: 'abc' })),
      ).toThrow(/API_CENTER_TIMEOUT_MS/);
    });

    it('throws when API_CENTER_TIMEOUT_MS is zero', () => {
      expect(() =>
        validateEnv(validEnv({ API_CENTER_TIMEOUT_MS: '0' })),
      ).toThrow(/API_CENTER_TIMEOUT_MS/);
    });
  });

  describe('production APICenter requirements', () => {
    it('throws in production when API center base URL is missing', () => {
      expect(() =>
        validateEnv(
          validEnv({
            NODE_ENV: 'production',
            API_CENTER_TRIBE_ID: 'tribe-a',
            API_CENTER_TRIBE_SECRET: 'tribe-secret',
          }),
        ),
      ).toThrow(/API_CENTER_BASE_URL|APICENTER_URL/);
    });

    it('throws in production when auth variables are missing', () => {
      expect(() =>
        validateEnv(
          validEnv({
            NODE_ENV: 'production',
            API_CENTER_BASE_URL: 'http://api-center.local',
          }),
        ),
      ).toThrow(/Production APICenter auth is missing/);
    });

    it('passes in production with tribe credentials', () => {
      expect(() =>
        validateEnv(
          validEnv({
            NODE_ENV: 'production',
            API_CENTER_BASE_URL: 'http://api-center.local',
            API_CENTER_TRIBE_ID: 'tribe-a',
            API_CENTER_TRIBE_SECRET: 'tribe-secret',
          }),
        ),
      ).not.toThrow();
    });
  });
});
