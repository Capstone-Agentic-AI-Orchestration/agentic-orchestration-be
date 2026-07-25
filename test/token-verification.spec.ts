import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { ProfileStatus, UserRole } from '@prisma/client';
import { SupabaseAuthService } from '../src/auth/supabase-auth.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GithubTeamsService } from '../src/github/github-teams.service';

/**
 * Guards on the signature-less "offline" token path.
 *
 * When SUPABASE_URL is absent there is no JWKS, so verifyAccessToken reads the payload
 * without verifying it. That path is for local development only: `sub` comes straight from
 * the caller, so reaching it in production would let anyone authenticate as any user.
 */
function makeService(opts: { nodeEnv?: string; supabaseUrl?: string } = {}) {
  const config = {
    get: (key: string) => {
      if (key === 'auth.allowedProviders') return ['github'];
      if (key === 'nodeEnv') return opts.nodeEnv;
      if (key === 'supabase.url') return opts.supabaseUrl;
      return undefined;
    },
  } as unknown as ConfigService;

  // getFullName() falls back to user_metadata.user_name, so an identity-sync update fires
  // on sign-in; the update mock must return a full profile row, not undefined.
  const existing = {
    id: 'user-1',
    email: 'dev@company.com',
    fullName: 'Dev',
    githubLogin: 'dev-login',
    avatarUrl: null,
    role: UserRole.DEV,
    status: ProfileStatus.ACTIVE,
  };

  const prisma = {
    profile: {
      findUnique: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...existing, ...data })),
    },
    clientInquiry: { findFirst: vi.fn().mockResolvedValue(null) },
    clientInvite: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaService;

  const githubTeams = {
    resolveRoleFromTeams: vi.fn().mockResolvedValue(null),
    isEnabled: vi.fn().mockReturnValue(false),
  } as unknown as GithubTeamsService;

  return new SupabaseAuthService(config, prisma, githubTeams);
}

function jwt(payload: Record<string, unknown>) {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [seg({ alg: 'none', typ: 'JWT' }), seg(payload), 'signature'].join('.');
}

const devToken = jwt({
  sub: 'user-1',
  email: 'dev@company.com',
  app_metadata: { provider: 'github', providers: ['github'] },
  user_metadata: { user_name: 'dev-login' },
});

describe('offline token path guards', () => {
  it('refuses to boot in production when tokens cannot be verified', async () => {
    const service = makeService({ nodeEnv: 'production' });

    // Bootstrap must fail rather than serve an API that accepts unsigned tokens.
    await expect(service.onModuleInit()).rejects.toThrow(/Refusing to start in production/);
  });

  it('boots with a warning outside production', async () => {
    const service = makeService({ nodeEnv: 'development' });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('rejects an unsigned token in production even if boot was bypassed', async () => {
    const service = makeService({ nodeEnv: 'production' });

    await expect(service.verifyAccessToken(devToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * Regression: a malformed token used to be turned INTO a user — `sub` derived from the raw
   * string and `email` from the token text — so any garbage authenticated as somebody, and
   * malformed tokens in tests produced a plausible "Mock User" instead of an error.
   */
  it('rejects a malformed token instead of synthesising a user', async () => {
    const service = makeService({ nodeEnv: 'development' });

    for (const bad of ['garbage', 'attacker@evil.com', 'a.b.c', '']) {
      await expect(service.verifyAccessToken(bad)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('still accepts a well-formed token on the offline path in development', async () => {
    const service = makeService({ nodeEnv: 'development' });

    const user = await service.verifyAccessToken(devToken);
    expect(user).toMatchObject({ id: 'user-1', role: UserRole.DEV, status: ProfileStatus.ACTIVE });
  });
});
