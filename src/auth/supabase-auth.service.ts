import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { ClientInviteStatus, ProfileStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth.types';

const INVITE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class SupabaseAuthService implements OnModuleInit {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private jwksWarmed = false;
  private readonly lastInviteCheck = new Map<string, number>();
  private readonly allowedProviders: Set<string>;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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
      this.jwks = null as any;
    }
    this.allowedProviders = new Set(
      (this.configService.get<string[]>('auth.allowedProviders') ?? ['github'])
        .map((provider) => provider.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  async onModuleInit() {
    await this.warmJwks();
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
        // Suppress verification - parse JWT directly for local offline execution.
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            payload = JSON.parse(
              Buffer.from(parts[1], 'base64').toString('utf8'),
            ) as JWTPayload;
          } else {
            payload = JSON.parse(token) as JWTPayload;
          }
        } catch {
          payload = {
            sub: token.replace(/[^a-zA-Z0-9-]/g, '') || 'mock-user-id',
            email: token.includes('@') ? token.toLowerCase() : 'mock-user@devflow-eve.local',
            user_metadata: { full_name: 'Mock User' },
            app_metadata: { provider: 'github', providers: ['github'] },
          };
        }
      }

      this.assertAllowedProvider(payload);
      return this.syncProfile(payload);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
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
      profile = await this.prisma.profile.create({
        data: {
          id: userId,
          email,
          fullName,
          githubLogin,
          avatarUrl,
          role: UserRole.CLIENT,
        },
        select: { id: true, email: true, fullName: true, githubLogin: true, avatarUrl: true, role: true, status: true },
      });
    }

    if (profile.status === ProfileStatus.SUSPENDED) {
      throw new UnauthorizedException('This account has been suspended');
    }

    const lastCheck = this.lastInviteCheck.get(userId) ?? 0;
    if (Date.now() - lastCheck > INVITE_CHECK_INTERVAL_MS) {
      await this.acceptPendingClientInvites(profile);
      this.lastInviteCheck.set(userId, Date.now());
    }

    return { ...profile, authProvider };
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
