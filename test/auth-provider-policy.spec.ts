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

/**
 * What a failure after the token is verified must NOT be reported as.
 *
 * This is a regression pin for a live incident: the Supabase connection poolers stopped accepting
 * connections, every Prisma query threw, and because token verification and profile sync shared one
 * catch block the result was `401 Invalid or expired access token`. Users were told their session
 * had expired and to sign in again — which produced the same message, because their session was
 * fine. The outage was invisible and the advice was impossible to follow.
 */
describe('SupabaseAuthService when the database is unreachable', () => {
  const validPayload = { sub: 'user-1', email: 'casey@example.test', app_metadata: { provider: 'github', providers: ['github'] } };

  /** A service whose token verification always succeeds and whose profile sync always fails. */
  function serviceWithBrokenDatabase(failure: Error) {
    const service = serviceWithProviders(['github']);
    // Drop the JWKS so verification takes the local offline path, where this payload stands in for
    // a genuinely verified token. The point of these tests is what happens AFTER a good token.
    (service as unknown as { jwks: unknown }).jwks = null;
    service['parseUnverifiedPayload'] = () => validPayload as never;
    service['syncProfile'] = async () => {
      throw failure;
    };
    return service;
  }

  it('reports a database outage as unavailable, not as a bad token', async () => {
    const service = serviceWithBrokenDatabase(
      new Error("Can't reach database server at `aws-0-ap-northeast-1.pooler.supabase.com:6543`"),
    );

    await expect(service.verifyAccessToken('any-token')).rejects.toMatchObject({ status: 503 });
  });

  // The precise words matter: this is the text a signed-in person reads, and it must not send them
  // to a sign-in page that cannot help them.
  it('never tells the user their session expired when their token was valid', async () => {
    const service = serviceWithBrokenDatabase(new Error('connection refused'));

    await expect(service.verifyAccessToken('any-token')).rejects.not.toThrow(/expired/i);
  });

  // The other half of the split: a token that genuinely does not verify is still a 401.
  it('still rejects a token that does not parse', async () => {
    const service = serviceWithProviders(['github']);

    await expect(service.verifyAccessToken('not-a-jwt')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // Deliberate auth refusals raised during sync must survive, or the console cannot tell
  // "you are not on a team" apart from an outage and shows the wrong screen.
  it('preserves a deliberate refusal raised while syncing the profile', async () => {
    const service = serviceWithBrokenDatabase(new UnauthorizedException('This account has been suspended'));

    await expect(service.verifyAccessToken('any-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
