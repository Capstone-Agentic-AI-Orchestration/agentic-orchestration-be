import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { InquiryStatus, ProfileStatus, UserRole } from '@prisma/client';
import { SupabaseAuthService } from '../src/auth/supabase-auth.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GithubTeamsService } from '../src/github/github-teams.service';

/**
 * The client-approval gate: a new CLIENT is only ACTIVE once a PM has approved their intake,
 * otherwise the account is PENDING and the API refuses it with ACCOUNT_PENDING_APPROVAL.
 * Staff resolved from an org team bypass the gate entirely.
 */
function makeService(opts: {
  existingProfile?: { id: string; email: string | null; status: ProfileStatus; role: UserRole };
  approvedInquiry?: boolean;
  invite?: boolean;
  teamRole?: UserRole | null;
  /** Whether GitHub team mapping is live. Promotion of an *existing* profile is
   *  skipped unless this is true, so it must be on to exercise that path. */
  teamMappingEnabled?: boolean;
}) {
  // No supabase.url → the service parses the token payload directly (offline path), so a test
  // can pass a JSON payload as the token without minting a real JWT.
  const config = {
    get: (key: string) => {
      if (key === 'auth.allowedProviders') return ['github', 'google'];
      return undefined;
    },
  } as unknown as ConfigService;

  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const prisma = {
    profile: {
      findUnique: vi.fn().mockResolvedValue(opts.existingProfile ?? null),
      create: vi.fn().mockImplementation(({ data, select }: any) => {
        created.push(data);
        return Promise.resolve({ ...data, ...pickSelect(data, select) });
      }),
      update: vi.fn().mockImplementation(({ data }: any) => {
        updated.push(data);
        return Promise.resolve({ ...(opts.existingProfile ?? {}), ...data });
      }),
    },
    clientInquiry: {
      findFirst: vi.fn().mockResolvedValue(opts.approvedInquiry ? { id: 'inq-1' } : null),
    },
    clientInvite: {
      findFirst: vi.fn().mockResolvedValue(opts.invite ? { id: 'inv-1' } : null),
      // Reached only on the ACTIVE path (acceptPendingClientInvites); no invites to accept here.
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaService;

  const githubTeams = {
    resolveRoleFromTeams: vi.fn().mockResolvedValue(opts.teamRole ?? null),
    isEnabled: vi.fn().mockReturnValue(opts.teamMappingEnabled ?? false),
  } as unknown as GithubTeamsService;

  const service = new SupabaseAuthService(config, prisma, githubTeams);
  return { service, prisma, created, updated };
}

function pickSelect(data: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = data[key] ?? null;
  return out;
}

/**
 * Builds a real 3-segment base64url JWT so the service takes its normal parse path.
 * A bare JSON string will NOT do: the emails inside it contain dots, so `split('.')`
 * yields 3 parts, the service tries to base64-decode the middle one, fails, and falls
 * back to a synthesised "mock user" payload — silently discarding everything set here.
 */
function token(email: string, provider = 'google', githubLogin?: string) {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    seg({ alg: 'none', typ: 'JWT' }),
    seg({
      sub: `user-${email}`,
      email,
      app_metadata: { provider, providers: [provider] },
      user_metadata: { full_name: 'Test Client', ...(githubLogin ? { user_name: githubLogin } : {}) },
    }),
    'signature',
  ].join('.');
}

describe('client approval gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a brand-new client as PENDING and refuses with ACCOUNT_PENDING_APPROVAL', async () => {
    const { service, created } = makeService({ approvedInquiry: false });

    await expect(service.verifyAccessToken(token('new@acme.com'))).rejects.toMatchObject({
      response: { code: 'ACCOUNT_PENDING_APPROVAL' },
    });
    expect(created[0]).toMatchObject({ role: UserRole.CLIENT, status: ProfileStatus.PENDING });
  });

  it('creates a client as ACTIVE when an approved inquiry matches their email', async () => {
    const { service, created } = makeService({ approvedInquiry: true });

    const user = await service.verifyAccessToken(token('approved@acme.com'));
    expect(user.status).toBe(ProfileStatus.ACTIVE);
    expect(created[0]).toMatchObject({ status: ProfileStatus.ACTIVE });
  });

  it('activates an existing PENDING client once their inquiry is approved', async () => {
    const { service, updated } = makeService({
      existingProfile: { id: 'user-x', email: 'wait@acme.com', status: ProfileStatus.PENDING, role: UserRole.CLIENT },
      approvedInquiry: true,
    });

    const user = await service.verifyAccessToken(token('wait@acme.com'));
    expect(user.status).toBe(ProfileStatus.ACTIVE);
    expect(updated.some((u) => u.status === ProfileStatus.ACTIVE)).toBe(true);
  });

  it('keeps refusing an existing PENDING client while still unapproved', async () => {
    const { service } = makeService({
      existingProfile: { id: 'user-y', email: 'still@acme.com', status: ProfileStatus.PENDING, role: UserRole.CLIENT },
      approvedInquiry: false,
    });

    await expect(service.verifyAccessToken(token('still@acme.com'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a client whose approval came via a client invite (no inquiry row)', async () => {
    const { service } = makeService({ approvedInquiry: false, invite: true });

    const user = await service.verifyAccessToken(token('invited@acme.com'));
    expect(user.status).toBe(ProfileStatus.ACTIVE);
  });

  it('never gates staff resolved from an org team, even without an inquiry', async () => {
    const { service, created } = makeService({ approvedInquiry: false, teamRole: UserRole.PM });

    const user = await service.verifyAccessToken(token('pm@company.com', 'github'));
    expect(user.role).toBe(UserRole.PM);
    expect(user.status).toBe(ProfileStatus.ACTIVE);
    expect(created[0]).toMatchObject({ role: UserRole.PM, status: ProfileStatus.ACTIVE });
  });

  /**
   * Regression: staff whose profile ALREADY exists as CLIENT/PENDING — created before team
   * mapping was configured, or before they were added to the org team. Team promotion used to
   * run after the pending-approval gate, so the gate threw first and the promotion was
   * unreachable: a real PM/DEV was locked out permanently, with no inquiry anyone would ever
   * approve. Promotion must now run before the gate.
   */
  it('promotes an existing PENDING client to staff instead of locking them out', async () => {
    const { service, updated } = makeService({
      existingProfile: { id: 'user-z', email: 'pm@company.com', status: ProfileStatus.PENDING, role: UserRole.CLIENT },
      approvedInquiry: false,
      invite: false,
      teamRole: UserRole.PM,
      teamMappingEnabled: true,
    });

    const user = await service.verifyAccessToken(token('pm@company.com', 'github', 'pm-login'));
    expect(user.role).toBe(UserRole.PM);
    // Promotion must clear PENDING too — team membership is the vetting step for staff.
    expect(user.status).toBe(ProfileStatus.ACTIVE);
    expect(updated.some((u) => u.role === UserRole.PM && u.status === ProfileStatus.ACTIVE)).toBe(true);
  });

  it('still refuses an existing PENDING client who is in no org team', async () => {
    const { service } = makeService({
      existingProfile: { id: 'user-w', email: 'nobody@acme.com', status: ProfileStatus.PENDING, role: UserRole.CLIENT },
      approvedInquiry: false,
      teamRole: null,
      teamMappingEnabled: true,
    });

    await expect(
      service.verifyAccessToken(token('nobody@acme.com', 'github', 'nobody-login')),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_PENDING_APPROVAL' } });
  });
});
