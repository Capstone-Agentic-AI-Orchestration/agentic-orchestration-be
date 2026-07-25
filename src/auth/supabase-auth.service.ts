import { ForbiddenException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { ClientInviteStatus, InquiryStatus, ProfileStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GithubTeamsService } from '../github/github-teams.service';
import { AuthUser } from './auth.types';

const INVITE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class SupabaseAuthService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private readonly issuer: string;
  // Null when SUPABASE_URL is unset — the field was previously typed non-nullable and
  // assigned `null as any`, which hid that state from the compiler.
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private jwksWarmed = false;
  private readonly lastInviteCheck = new Map<string, number>();
  private readonly allowedProviders: Set<string>;
  private readonly isProduction: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly githubTeams: GithubTeamsService,
  ) {
    const supabaseUrl = this.configService.get<string>('supabase.url');
    if (supabaseUrl) {
      const normalizedUrl = supabaseUrl.replace(/\/$/, '');
      this.issuer = `${normalizedUrl}/auth/v1`;
      this.jwks = createRemoteJWKSet(
        new URL(`${this.issuer}/.well-known/jwks.json`),
      );
    } else {
      this.issuer = '';
      this.jwks = null;
    }
    this.allowedProviders = new Set(
      (this.configService.get<string[]>('auth.allowedProviders') ?? ['github'])
        .map((provider) => provider.trim().toLowerCase())
        .filter(Boolean),
    );
    this.isProduction = this.configService.get<string>('nodeEnv') === 'production';
  }

  async onModuleInit() {
    this.assertVerificationAvailable();
    await this.warmJwks();
  }

  /**
   * Refuses to start a production deployment that cannot verify token signatures.
   *
   * Without SUPABASE_URL there is no JWKS, and verifyAccessToken falls back to reading the
   * payload UNVERIFIED — a signature-less path intended only for local offline work. Reaching
   * that state in production would be a total auth bypass, since `sub` is caller-controlled:
   * anyone could mint a token for any user. A single missing env var must not silently turn
   * the whole API open, so fail loudly at boot instead.
   */
  private assertVerificationAvailable(): void {
    if (this.jwks) return;

    const detail =
      'SUPABASE_URL is not configured, so access tokens cannot be signature-verified.';
    if (this.isProduction) {
      throw new Error(`${detail} Refusing to start in production.`);
    }
    this.logger.warn(`${detail} Tokens are accepted UNVERIFIED — local development only.`);
  }

  private async warmJwks() {
    if (!this.jwks) return;
    try {
      const fakeToken =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ3YXJtdXAiLCJpYXQiOjAsImV4cCI6OTQ2Njg0ODAwfQ';
      await jwtVerify(fakeToken, this.jwks).catch(() => {});
      this.jwksWarmed = true;
    } catch {
      // JWKS warming is best-effort
    }
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      let payload: JWTPayload;

      if (this.jwks) {
        if (!this.jwksWarmed) {
          await this.warmJwks();
        }
        const { payload: verified } = await jwtVerify(token, this.jwks, {
          issuer: this.issuer,
          audience: 'authenticated',
        });
        payload = verified;
      } else {
        // Local offline path: no JWKS, so the payload is read WITHOUT verifying the
        // signature. Boot is already blocked in production by assertVerificationAvailable();
        // re-checked here so a service constructed outside the Nest lifecycle (a test, a
        // script) can never reach the unverified path in a production process.
        if (this.isProduction) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        payload = this.parseUnverifiedPayload(token);
      }

      this.assertAllowedProvider(payload);
      return this.syncProfile(payload);
    } catch (error) {
      // Deliberate auth decisions pass through unchanged. A pending-approval refusal in
      // particular must keep its 403 + ACCOUNT_PENDING_APPROVAL code, or the frontend cannot
      // tell "awaiting approval" apart from "your token is broken" and shows the wrong screen.
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  /**
   * Reads a JWT payload WITHOUT verifying its signature — local offline development only.
   *
   * A malformed token is rejected. This used to synthesise a "mock user" instead, deriving
   * `sub` from `token.replace(/[^a-zA-Z0-9-]/g, '')` and `email` from the raw string, so any
   * garbage value became an authenticated identity. It also silently masked malformed tokens
   * in tests: a bad token produced a plausible user rather than an error.
   */
  private parseUnverifiedPayload(token: string): JWTPayload {
    try {
      const parts = token.split('.');
      // base64url (not base64) — that is what JWT uses, so '-' and '_' decode correctly.
      const raw =
        parts.length === 3 ? Buffer.from(parts[1], 'base64url').toString('utf8') : token;
      const payload = JSON.parse(raw) as JWTPayload;
      if (!payload || typeof payload !== 'object') {
        throw new Error('token payload is not an object');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private async syncProfile(payload: JWTPayload): Promise<AuthUser> {
    const userId = payload.sub;
    if (!userId) {
      throw new UnauthorizedException('Access token is missing subject');
    }

    const email = this.getEmail(payload);
    const fullName = this.getFullName(payload);
    const authProvider = this.getAuthProvider(payload);
    const githubLogin = this.getGithubLogin(payload);
    const avatarUrl = this.getAvatarUrl(payload);

    const existing = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, githubLogin: true, avatarUrl: true, role: true, status: true },
    });

    let profile: { id: string; email: string | null; fullName: string | null; githubLogin: string | null; avatarUrl: string | null; role: UserRole; status: ProfileStatus };

    if (existing) {
      if (
        existing.email !== email ||
        (fullName && existing.fullName !== fullName) ||
        (githubLogin && existing.githubLogin !== githubLogin) ||
        (avatarUrl && existing.avatarUrl !== avatarUrl)
      ) {
        profile = await this.prisma.profile.update({
          where: { id: userId },
          data: {
            email,
            ...(fullName ? { fullName } : {}),
            ...(githubLogin ? { githubLogin } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
          },
          select: { id: true, email: true, fullName: true, githubLogin: true, avatarUrl: true, role: true, status: true },
        });
      } else {
        profile = existing;
      }
    } else {
      // New sign-in: derive the role from GitHub org team membership when
      // configured (github-teams.service.ts); fall back to CLIENT otherwise.
      const provisionedRole =
        (await this.githubTeams.resolveRoleFromTeams(githubLogin)) ?? UserRole.CLIENT;

      // Clients must be vetted before they get in. Staff (DEV/PM/ADMIN resolved from an org
      // team) are already trusted by virtue of that membership, so only CLIENT is gated:
      // a client is ACTIVE only when a PM has already approved an inquiry for this email,
      // otherwise the account is created PENDING so the person can see their request status.
      const provisionedStatus =
        provisionedRole === UserRole.CLIENT && !(await this.hasApprovedIntake(email))
          ? ProfileStatus.PENDING
          : ProfileStatus.ACTIVE;

      profile = await this.prisma.profile.create({
        data: {
          id: userId,
          email,
          fullName,
          githubLogin,
          avatarUrl,
          role: provisionedRole,
          status: provisionedStatus,
        },
        select: { id: true, email: true, fullName: true, githubLogin: true, avatarUrl: true, role: true, status: true },
      });
    }

    if (profile.status === ProfileStatus.SUSPENDED) {
      throw new UnauthorizedException('This account has been suspended');
    }

    // Team promotion MUST run before the PENDING gate below. A staff member whose profile
    // was first created as CLIENT — because team mapping was unconfigured at the time, or
    // because they were added to the org team after their first sign-in — sits at PENDING
    // with no approved intake. Gating first would 403 them on every request and leave the
    // promotion permanently unreachable, locking real DEV/PMs out of the console for good.
    const throttleExpired =
      Date.now() - (this.lastInviteCheck.get(userId) ?? 0) > INVITE_CHECK_INTERVAL_MS;

    // A PENDING profile bypasses the GitHub-call throttle: it is the locked-out case, so it
    // must resolve on the very next request rather than up to INVITE_CHECK_INTERVAL_MS later.
    // Non-CLIENT and login-less profiles cost no API call (promoteFromTeamsIfNeeded exits early).
    if (throttleExpired || profile.status === ProfileStatus.PENDING) {
      profile = await this.promoteFromTeamsIfNeeded(profile, githubLogin);
    }

    // A pending client may have been approved since they last signed in; re-check before
    // refusing, so approval takes effect on their next request without admin intervention.
    if (profile.status === ProfileStatus.PENDING) {
      profile = await this.activateIfApproved(profile);
    }

    if (profile.status === ProfileStatus.PENDING) {
      throw new ForbiddenException({
        code: 'ACCOUNT_PENDING_APPROVAL',
        message: 'Your account is awaiting project manager approval.',
      });
    }

    if (throttleExpired) {
      await this.acceptPendingClientInvites(profile);
      this.lastInviteCheck.set(userId, Date.now());
    }

    return { ...profile, authProvider };
  }

  /**
   * Upgrades an existing CLIENT to DEV/PM when their GitHub login is (now) in a
   * mapped org team. Only ever promotes — never auto-demotes — so manual/admin
   * role changes are preserved. No-op unless team mapping is enabled.
   *
   * A promoted profile is also marked ACTIVE: org team membership is itself the
   * vetting step for staff (mirroring how a brand-new staff profile is provisioned
   * in syncProfile), so a promoted DEV/PM must not be left behind the CLIENT
   * pending-approval gate — nobody would ever approve a "client inquiry" for them.
   */
  private async promoteFromTeamsIfNeeded(
    profile: {
      id: string;
      email: string | null;
      fullName: string | null;
      githubLogin: string | null;
      avatarUrl: string | null;
      role: UserRole;
      status: ProfileStatus;
    },
    githubLogin: string | null,
  ) {
    if (profile.role !== UserRole.CLIENT || !githubLogin || !this.githubTeams.isEnabled()) {
      return profile;
    }

    const teamRole = await this.githubTeams.resolveRoleFromTeams(githubLogin);
    if (!teamRole || teamRole === UserRole.CLIENT) return profile;

    this.logger.log(
      `Promoting ${githubLogin} to ${teamRole} from ${this.org()} team membership`,
    );

    return this.prisma.profile.update({
      where: { id: profile.id },
      data: { role: teamRole, status: ProfileStatus.ACTIVE },
      select: { id: true, email: true, fullName: true, githubLogin: true, avatarUrl: true, role: true, status: true },
    });
  }

  /** Org name for log lines only; team mapping itself lives in GithubTeamsService. */
  private org(): string {
    return this.configService.get<string>('github.org') ?? 'GitHub';
  }

  private getEmail(payload: JWTPayload): string | null {
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  }

  private getFullName(payload: JWTPayload): string | null {
    const metadata = payload.user_metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const fullName = (metadata as Record<string, unknown>).full_name;
    const name = (metadata as Record<string, unknown>).name;
    const userName = (metadata as Record<string, unknown>).user_name;
    const candidate = [fullName, name, userName].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    return typeof candidate === 'string'
      ? candidate.trim()
      : null;
  }

  private getGithubLogin(payload: JWTPayload): string | null {
    const metadata = payload.user_metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const values = metadata as Record<string, unknown>;
    const candidate = [values.user_name, values.preferred_username, values.login].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    return typeof candidate === 'string' ? candidate.trim() : null;
  }

  private getAvatarUrl(payload: JWTPayload): string | null {
    const metadata = payload.user_metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const values = metadata as Record<string, unknown>;
    const candidate = [values.avatar_url, values.picture].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    return typeof candidate === 'string' ? candidate.trim() : null;
  }

  private assertAllowedProvider(payload: JWTPayload): void {
    if (this.allowedProviders.has('*')) return;

    const providers = this.getAuthProviders(payload);
    if (providers.some((provider) => this.allowedProviders.has(provider))) {
      return;
    }

    throw new UnauthorizedException(
      `Sign in with ${Array.from(this.allowedProviders).join(' or ')} to access DevFlow`,
    );
  }

  private getAuthProvider(payload: JWTPayload): string | null {
    return this.getAuthProviders(payload)[0] ?? null;
  }

  private getAuthProviders(payload: JWTPayload): string[] {
    const appMetadata = payload.app_metadata;
    if (!appMetadata || typeof appMetadata !== 'object' || Array.isArray(appMetadata)) {
      return [];
    }

    const metadata = appMetadata as Record<string, unknown>;
    const providers = metadata.providers;
    const provider = metadata.provider;

    if (Array.isArray(providers)) {
      return providers
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
    }

    return typeof provider === 'string' ? [provider.toLowerCase()] : [];
  }

  /**
   * True when a project manager has already approved this email's way in — either an approved
   * inquiry or a client invite addressed to them. Email is the only link between the anonymous
   * intake form and the account created later at sign-in, so it is matched case-insensitively.
   */
  private async hasApprovedIntake(email: string | null): Promise<boolean> {
    const value = email?.trim().toLowerCase();
    if (!value) return false;

    const [approvedInquiry, invite] = await Promise.all([
      this.prisma.clientInquiry.findFirst({
        where: { email: { equals: value, mode: 'insensitive' }, status: InquiryStatus.APPROVED },
        select: { id: true },
      }),
      this.prisma.clientInvite.findFirst({
        where: {
          email: { equals: value, mode: 'insensitive' },
          status: { in: [ClientInviteStatus.PENDING, ClientInviteStatus.ACCEPTED] },
        },
        select: { id: true },
      }),
    ]);

    return Boolean(approvedInquiry || invite);
  }

  /** Promotes a PENDING profile to ACTIVE once their intake has been approved. */
  private async activateIfApproved<T extends { id: string; status: ProfileStatus; email: string | null }>(
    profile: T,
  ): Promise<T> {
    if (!(await this.hasApprovedIntake(profile.email))) return profile;

    this.logger.log(`Activating approved client profile ${profile.id}`);
    await this.prisma.profile
      .update({ where: { id: profile.id }, data: { status: ProfileStatus.ACTIVE } })
      .catch(() => undefined);

    return { ...profile, status: ProfileStatus.ACTIVE };
  }

  private async acceptPendingClientInvites(profile: AuthUser): Promise<void> {
    if (profile.role !== UserRole.CLIENT || !profile.email) return;

    const pendingInvites = await this.prisma.clientInvite.findMany({
      where: {
        email: profile.email,
        status: ClientInviteStatus.PENDING,
      },
      select: { id: true, projectId: true },
    });

    if (pendingInvites.length === 0) return;

    await this.prisma.$transaction(
      pendingInvites.flatMap((invite) => [
        this.prisma.projectMember.upsert({
          where: {
            projectId_userId: {
              projectId: invite.projectId,
              userId: profile.id,
            },
          },
          update: { role: UserRole.CLIENT },
          create: {
            projectId: invite.projectId,
            userId: profile.id,
            role: UserRole.CLIENT,
          },
        }),
        this.prisma.clientInvite.update({
          where: { id: invite.id },
          data: {
            status: ClientInviteStatus.ACCEPTED,
            acceptedById: profile.id,
            acceptedAt: new Date(),
          },
        }),
      ]),
    );
  }
}
