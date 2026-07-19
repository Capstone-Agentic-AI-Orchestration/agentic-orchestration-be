import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createPrivateKey } from 'node:crypto';
import { UserRole } from '@prisma/client';

export interface RoleTeamMember {
  githubLogin: string;
  role: UserRole;
  avatarUrl: string | null;
}

/**
 * Resolves a GitHub login to a DevFlow role from org **team membership**.
 *
 * This is intentionally isolated from {@link GithubService}: the existing
 * GithubModule imports AuthModule, so AuthModule cannot import GithubModule back
 * without a circular dependency. This leaf service depends only on the global
 * ConfigService, so AuthModule can consume it safely.
 *
 * Requires the GitHub App installation to have `Members: read` org permission.
 * When teams are unconfigured or the App is not set up, {@link resolveRoleFromTeams}
 * returns null and callers fall back to the default CLIENT role.
 */
@Injectable()
export class GithubTeamsService implements OnModuleInit {
  private readonly logger = new Logger(GithubTeamsService.name);
  private octokit: Octokit | null = null;
  private org = '';
  private devTeam = '';
  private pmTeam = '';

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.org = this.configService.get<string>('github.org') ?? '';
    this.devTeam = this.configService.get<string>('github.devTeam') ?? '';
    this.pmTeam = this.configService.get<string>('github.pmTeam') ?? '';

    if (!this.org || (!this.devTeam && !this.pmTeam)) {
      this.logger.log(
        'GitHub team-based role mapping is disabled (GITHUB_ORG and at least one of GITHUB_DEV_TEAM/GITHUB_PM_TEAM required)',
      );
      return;
    }

    const appId = this.configService.get<string>('github.appId');
    const privateKey = this.configService.get<string>('github.privateKey');
    const installationId = this.configService.get<number>('github.installationId');

    if (!appId || !privateKey || !this.isPrivateKeyValid(privateKey) || !installationId) {
      this.logger.warn(
        'GitHub team-based role mapping is configured but GitHub App credentials are missing/invalid; GitHub logins will default to CLIENT',
      );
      return;
    }

    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey, installationId },
    });
  }

  /** True when team mapping is fully configured and usable. */
  isEnabled(): boolean {
    return this.octokit !== null;
  }

  /**
   * Returns the highest-precedence role the login qualifies for via team
   * membership, or null when it matches no configured team (or mapping is off).
   *
   * Precedence: PM outranks DEV — a login in both the PM and DEV teams resolves
   * to PM (managerial). Adjust the order below if your org models it differently.
   */
  async resolveRoleFromTeams(githubLogin: string | null): Promise<UserRole | null> {
    if (!this.octokit || !githubLogin) return null;

    if (this.pmTeam && (await this.isActiveMember(this.pmTeam, githubLogin))) {
      return UserRole.PM;
    }
    if (this.devTeam && (await this.isActiveMember(this.devTeam, githubLogin))) {
      return UserRole.DEV;
    }
    return null;
  }

  /**
   * Lists the org's dev + PM team members as a role-annotated roster. PM outranks
   * DEV when someone is in both (matches {@link resolveRoleFromTeams} precedence).
   * Returns [] when team mapping is disabled. Lets a PM see the full GitHub org
   * roster — including people who have not signed into DevFlow yet.
   */
  async listRoleTeamMembers(): Promise<RoleTeamMember[]> {
    if (!this.octokit) return [];
    const byLogin = new Map<string, RoleTeamMember>();
    // DEV first, then PM, so PM overwrites on overlap (PM precedence).
    if (this.devTeam) await this.collectTeam(this.devTeam, UserRole.DEV, byLogin);
    if (this.pmTeam) await this.collectTeam(this.pmTeam, UserRole.PM, byLogin);
    return [...byLogin.values()];
  }

  private async collectTeam(
    teamSlug: string,
    role: UserRole,
    out: Map<string, RoleTeamMember>,
  ): Promise<void> {
    try {
      const { data } = await this.octokit!.rest.teams.listMembersInOrg({
        org: this.org,
        team_slug: teamSlug,
        per_page: 100,
      });
      for (const m of data) {
        if (!m.login) continue;
        out.set(m.login.toLowerCase(), {
          githubLogin: m.login,
          role,
          avatarUrl: m.avatar_url ?? null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Failed to list members of ${this.org}/${teamSlug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async isActiveMember(teamSlug: string, username: string): Promise<boolean> {
    try {
      const { data } = await this.octokit!.rest.teams.getMembershipForUserInOrg({
        org: this.org,
        team_slug: teamSlug,
        username,
      });
      return data.state === 'active';
    } catch (error) {
      // 404 = not a member (the common case). Anything else (403/perms, network)
      // is logged and treated as "not a member" so login is never blocked on it.
      const status = (error as { status?: number })?.status;
      if (status !== 404) {
        this.logger.warn(
          `GitHub team membership check failed for ${username} in ${this.org}/${teamSlug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return false;
    }
  }

  private isPrivateKeyValid(privateKey: string | undefined): boolean {
    if (!privateKey) return false;
    try {
      createPrivateKey(privateKey);
      return true;
    } catch {
      return false;
    }
  }
}
