import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { ProfileStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GithubTeamsService } from '../github/github-teams.service';
import { AuthUser } from './auth.types';

/**
 * Refusal code for a GitHub account that is in none of the mapped org teams.
 *
 * This console is staff-only, so "not on a team" is the single reason a successfully
 * authenticated GitHub user is denied. It replaces the old ACCOUNT_PENDING_APPROVAL
 * refusal, which implied a client-approval workflow that does not exist here.
 */
export const NOT_A_TEAM_MEMBER = 'NOT_A_TEAM_MEMBER';

@Injectable()
export class SupabaseAuthService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private readonly issuer: string;
  // Null when SUPABASE_URL is unset — the field was previously typed non-nullable and
  // assigned `null as any`, which hid that state from the compiler.
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private jwksWarmed = false;
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

  /**
   * Two failures, kept apart on purpose.
   *
   * Verifying the token can only fail because of the token, so anything unrecognised there is a
   * 401. Everything after it has a valid token in hand, and the only way it fails is on our side —
   * in practice the database. Those used to share one catch, so a Supabase pooler outage reached
   * users as "your session is missing or expired": they were told to sign in again, and signing in
   * again produced the same message, because nothing was wrong with their session.
   */
  async verifyAccessToken(token: string): Promise<AuthUser> {
    let payload: JWTPayload;
    try {
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
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired access token');
    }

    this.assertAllowedProvider(payload);

    try {
      // Awaited, so a rejection here is actually caught. Returning the promise unawaited put every
      // profile-sync failure outside the try entirely, which surfaced as an unhandled 500.
      return await this.syncProfile(payload);
    } catch (error) {
      // Deliberate auth decisions pass through unchanged. The not-a-team-member refusal in
      // particular must keep its 403 + NOT_A_TEAM_MEMBER code, or the frontend cannot tell
      // "you are not on a team" apart from "your token is broken" and shows the wrong screen.
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }
      // The token was good. Reporting this as an auth problem sends people to a sign-in page that
      // cannot help them, and hides an outage behind a message about their own account.
      this.logger.error(
        `Profile sync failed for a valid token: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'We cannot reach our systems right now. This is not a problem with your account — please try again shortly.',
      );
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
      // Staff-only console: a profile is created ONLY for a GitHub login that resolves to a
      // mapped org team. There is deliberately no CLIENT provisioning here — the client
      // product is a separate app (alphaexplora-client-be/-fe) over the same Supabase
      // project, and it owns client sign-up, intake approval, and invites.
      profile = await this.prisma.profile.create({
        data: {
          id: userId,
          email,
          fullName,
          githubLogin,
          avatarUrl,
          role: await this.resolveStaffRole(githubLogin),
          // Org team membership IS the vetting step for staff, so there is no approval gate.
          status: ProfileStatus.ACTIVE,
        },
        select: { id: true, email: true, fullName: true, githubLogin: true, avatarUrl: true, role: true, status: true },
      });
    }

    if (profile.status === ProfileStatus.SUSPENDED) {
      throw new UnauthorizedException('This account has been suspended');
    }

    // An existing CLIENT profile can reach this point two ways: it was created by the client
    // app (same shared Supabase project), or by this console before it became staff-only.
    // Give team membership the final say — someone added to a team since their last sign-in
    // is upgraded here rather than being turned away.
    if (profile.role === UserRole.CLIENT) {
      profile = await this.promoteFromTeamsIfNeeded(profile, githubLogin);
    }

    // Still a client: no workspace exists for them in this console. Refuse with a code the
    // frontend can act on, rather than the old pending-approval gate — nobody is going to
    // "approve" a client into an internal staff console.
    if (profile.role === UserRole.CLIENT) {
      throw new ForbiddenException({
        code: NOT_A_TEAM_MEMBER,
        message: this.notATeamMemberMessage(githubLogin),
      });
    }

    return { ...profile, authProvider };
  }

  /**
   * Upgrades an existing CLIENT to DEV/PM when their GitHub login is (now) in a mapped org
   * team, so someone added to a team after their first sign-in gets in without an admin
   * touching the database. Only ever promotes — never auto-demotes — so a manually granted
   * ADMIN, and a DEV/PM whose team lookup fails transiently (GithubTeamsService treats
   * GitHub errors as "not a member"), keep their access instead of being locked out.
   *
   * A promoted profile is also marked ACTIVE: org team membership is itself the vetting step
   * for staff, mirroring how a brand-new staff profile is provisioned in syncProfile.
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
   * The role a NEW sign-in is provisioned with, from GitHub org team membership.
   *
   * Team membership is the only way into this console, so anything that prevents resolving
   * it is a refusal — never a fallback to CLIENT. Client accounts belong to the separate
   * Alphaexplora client app, which shares this Supabase project but has its own sign-up.
   */
  private async resolveStaffRole(githubLogin: string | null): Promise<UserRole> {
    if (!this.githubTeams.isEnabled()) {
      // Misconfiguration, not a user error: with team mapping off nobody can be granted a
      // role at all, so make it loud in the logs instead of silently refusing every sign-in.
      this.logger.error(
        'GitHub team mapping is not configured (GITHUB_ORG + GITHUB_DEV_TEAM/GITHUB_PM_TEAM ' +
          'and valid GitHub App credentials); no new user can sign in to the console.',
      );
      throw new ForbiddenException({
        code: NOT_A_TEAM_MEMBER,
        message: 'Console sign-in is unavailable: GitHub team mapping is not configured.',
      });
    }

    const role = githubLogin
      ? await this.githubTeams.resolveRoleFromTeams(githubLogin)
      : null;

    if (!role || role === UserRole.CLIENT) {
      // Logged because this refusal is indistinguishable, from the user's side, from the API
      // being unreachable — they just fail to get in. The line names the login that was
      // checked, which is what tells a PM whether the person signed in with the GitHub
      // account they actually added to the team.
      this.logger.warn(
        `Refused sign-in: ${githubLogin ? `@${githubLogin}` : 'a GitHub account with no login in its token'} ` +
          `is in no mapped team of ${this.org()}`,
      );
      throw new ForbiddenException({
        code: NOT_A_TEAM_MEMBER,
        message: this.notATeamMemberMessage(githubLogin),
      });
    }

    return role;
  }

  private notATeamMemberMessage(githubLogin: string | null): string {
    const who = githubLogin ? `GitHub account @${githubLogin} is` : 'GitHub account is';
    return (
      `Your ${who} not a member of a DevFlow team in the ${this.org()} organisation. ` +
      'Ask a project manager to add you to the developer or project-manager team, then sign in again.'
    );
  }
}
