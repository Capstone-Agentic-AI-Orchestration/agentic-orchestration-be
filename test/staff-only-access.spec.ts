import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { ProfileStatus, UserRole } from '@prisma/client';
import { NOT_A_TEAM_MEMBER, SupabaseAuthService } from '../src/auth/supabase-auth.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GithubTeamsService } from '../src/github/github-teams.service';

/**
 * This console is staff-only: the sole way in is membership of a mapped GitHub org team.
 *
 * Replaces the former client-approval-gate spec. Client accounts live in the separate
 * Alphaexplora client app, which shares this Supabase project but owns its own sign-up,
 * intake approval, and invites — so no CLIENT is ever provisioned or admitted here.
 */
function makeService(opts: {
  existingProfile?: { id: string; email: string | null; status: ProfileStatus; role: UserRole; githubLogin?: string | null; fullName?: string | null };
  teamRole?: UserRole | null;
  teamMappingEnabled?: boolean;
}) {
  // No supabase.url → the service reads the token payload directly (offline path), so a test
  // can pass a base64url JWT without minting a real signed one.
  const config = {
    get: (key: string) => {
      if (key === 'auth.allowedProviders') return ['github'];
      if (key === 'github.org') return 'Capstone-Agentic-AI-Orchestration';
      return undefined;
    },
  } as unknown as ConfigService;

  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const prisma = {
    profile: {
      findUnique: vi.fn().mockResolvedValue(opts.existingProfile ?? null),
      create: vi.fn().mockImplementation(({ data }: any) => {
        created.push(data);
        return Promise.resolve({ ...data });
      }),
      update: vi.fn().mockImplementation(({ data }: any) => {
        updated.push(data);
        return Promise.resolve({ ...(opts.existingProfile ?? {}), ...data });
      }),
    },
  } as unknown as PrismaService;

  const githubTeams = {
    resolveRoleFromTeams: vi.fn().mockResolvedValue(opts.teamRole ?? null),
    isEnabled: vi.fn().mockReturnValue(opts.teamMappingEnabled ?? true),
  } as unknown as GithubTeamsService;

  const service = new SupabaseAuthService(config, prisma, githubTeams);
  return { service, prisma, created, updated };
}

/** Real 3-segment base64url JWT: a bare JSON string would be rejected as malformed. */
function token(email: string, githubLogin: string | null = 'some-login') {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    seg({ alg: 'none', typ: 'JWT' }),
    seg({
      sub: `user-${email}`,
      email,
      app_metadata: { provider: 'github', providers: ['github'] },
      user_metadata: { full_name: 'Test Person', ...(githubLogin ? { user_name: githubLogin } : {}) },
    }),
    'signature',
  ].join('.');
}

describe('staff-only console access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('provisions a new project-manager team member as PM/ACTIVE', async () => {
    const { service, created } = makeService({ teamRole: UserRole.PM });

    const user = await service.verifyAccessToken(token('pm@company.com', 'pm-login'));
    expect(user.role).toBe(UserRole.PM);
    expect(created[0]).toMatchObject({ role: UserRole.PM, status: ProfileStatus.ACTIVE });
  });

  it('provisions a new developer team member as DEV/ACTIVE', async () => {
    const { service, created } = makeService({ teamRole: UserRole.DEV });

    const user = await service.verifyAccessToken(token('dev@company.com', 'dev-login'));
    expect(user.role).toBe(UserRole.DEV);
    expect(created[0]).toMatchObject({ role: UserRole.DEV, status: ProfileStatus.ACTIVE });
  });

  /** The core of the policy: no team, no account. A CLIENT must never be created here. */
  it('refuses a GitHub user in no mapped team and creates no profile', async () => {
    const { service, prisma } = makeService({ teamRole: null });

    await expect(
      service.verifyAccessToken(token('outsider@nowhere.com', 'outsider')),
    ).rejects.toMatchObject({ response: { code: NOT_A_TEAM_MEMBER } });
    expect(prisma.profile.create).not.toHaveBeenCalled();
  });

  it('refuses a GitHub session with no resolvable login', async () => {
    const { service, prisma } = makeService({ teamRole: UserRole.PM });

    await expect(
      service.verifyAccessToken(token('nologin@company.com', null)),
    ).rejects.toMatchObject({ response: { code: NOT_A_TEAM_MEMBER } });
    expect(prisma.profile.create).not.toHaveBeenCalled();
  });

  it('refuses everyone, loudly, when team mapping is not configured', async () => {
    const { service, prisma } = makeService({ teamMappingEnabled: false, teamRole: UserRole.PM });

    await expect(
      service.verifyAccessToken(token('pm@company.com', 'pm-login')),
    ).rejects.toMatchObject({ response: { code: NOT_A_TEAM_MEMBER } });
    expect(prisma.profile.create).not.toHaveBeenCalled();
  });

  /** A client-app profile (shared Supabase) that has since joined a team gets upgraded. */
  it('promotes an existing CLIENT who is now in a team', async () => {
    const { service, updated } = makeService({
      existingProfile: {
        id: 'user-1', email: 'pm@company.com', status: ProfileStatus.PENDING,
        role: UserRole.CLIENT, githubLogin: 'pm-login', fullName: 'Test Person',
      },
      teamRole: UserRole.PM,
    });

    const user = await service.verifyAccessToken(token('pm@company.com', 'pm-login'));
    expect(user.role).toBe(UserRole.PM);
    expect(user.status).toBe(ProfileStatus.ACTIVE);
    expect(updated.some((u) => u.role === UserRole.PM && u.status === ProfileStatus.ACTIVE)).toBe(true);
  });

  it('refuses an existing CLIENT who is in no team', async () => {
    const { service } = makeService({
      existingProfile: {
        id: 'user-2', email: 'client@acme.com', status: ProfileStatus.ACTIVE,
        role: UserRole.CLIENT, githubLogin: 'client-login', fullName: 'Test Person',
      },
      teamRole: null,
    });

    await expect(
      service.verifyAccessToken(token('client@acme.com', 'client-login')),
    ).rejects.toMatchObject({ response: { code: NOT_A_TEAM_MEMBER } });
  });

  /**
   * No auto-demotion. GithubTeamsService reports GitHub errors as "not a member", so demoting
   * on a null lookup would lock out every staff member during a GitHub outage. It also keeps
   * a manually granted ADMIN — who belongs to no team — working.
   */
  it('keeps existing staff access when the team lookup returns nothing', async () => {
    for (const role of [UserRole.DEV, UserRole.PM, UserRole.ADMIN]) {
      const { service } = makeService({
        existingProfile: {
          id: `user-${role}`, email: 'staff@company.com', status: ProfileStatus.ACTIVE,
          role, githubLogin: 'staff-login', fullName: 'Test Person',
        },
        teamRole: null,
      });

      const user = await service.verifyAccessToken(token('staff@company.com', 'staff-login'));
      expect(user.role).toBe(role);
    }
  });

  it('still refuses a suspended staff profile', async () => {
    const { service } = makeService({
      existingProfile: {
        id: 'user-3', email: 'gone@company.com', status: ProfileStatus.SUSPENDED,
        role: UserRole.DEV, githubLogin: 'gone-login', fullName: 'Test Person',
      },
      teamRole: UserRole.DEV,
    });

    await expect(
      service.verifyAccessToken(token('gone@company.com', 'gone-login')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
