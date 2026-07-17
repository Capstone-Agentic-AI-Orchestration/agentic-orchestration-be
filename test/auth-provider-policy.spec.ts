import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SupabaseAuthService } from '../src/auth/supabase-auth.service';

function serviceWithProviders(providers: string[]) {
  return new SupabaseAuthService(
    {
      get: (key: string) => {
        if (key === 'supabase.url') return 'https://test.supabase.co';
        if (key === 'auth.allowedProviders') return providers;
        return undefined;
      },
    } as never,
    {} as never,
    { resolveRoleFromTeams: async () => null, isEnabled: () => false } as never,
  );
}

describe('SupabaseAuthService provider policy', () => {
  it('allows configured Supabase OAuth providers', () => {
    const service = serviceWithProviders(['github']);

    expect(() =>
      service['assertAllowedProvider']({
        app_metadata: { provider: 'github', providers: ['github'] },
      }),
    ).not.toThrow();
  });

  it('rejects sessions from providers that are not configured', () => {
    const service = serviceWithProviders(['github']);

    expect(() =>
      service['assertAllowedProvider']({
        app_metadata: { provider: 'email', providers: ['email'] },
      }),
    ).toThrow(UnauthorizedException);
  });

  it('supports the future GitHub plus Google rollout', () => {
    const service = serviceWithProviders(['github', 'google']);

    expect(() =>
      service['assertAllowedProvider']({
        app_metadata: { provider: 'google', providers: ['google'] },
      }),
    ).not.toThrow();
  });
});
