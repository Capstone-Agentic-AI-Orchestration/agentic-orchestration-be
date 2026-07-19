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
    isEnabled: vi.fn().mockReturnValue(false),
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

function token(email: string, provider = 'google') {
  return JSON.stringify({
    sub: `user-${email}`,
    email,
    app_metadata: { provider, providers: [provider] },
    user_metadata: { full_name: 'Test Client' },
  });
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
});
