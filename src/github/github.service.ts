import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createPrivateKey } from 'node:crypto';
import { GitHubArtifact } from './github.types';

export interface GithubDeliveryStatus {
  configured: boolean;
  available: boolean;
  owner: string | null;
  ownerSource: 'env' | 'installation' | null;
  missingRequirements: string[];
  reason: string | null;
}

export interface GithubDeliveryVerification {
  ok: boolean;
  status: GithubDeliveryStatus;
  owner: string | null;
  installationOwner: string | null;
  repositoriesVisible: number | null;
  permissions: Record<string, string> | null;
  reason: string | null;
}

export interface GithubRepository {
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  visibility: string;
}

@Injectable()
export class GithubService implements OnModuleInit {
  private readonly logger = new Logger(GithubService.name);
  private octokit!: Octokit;
  private installationId!: number;
  private ownerLogin!: string;
  private ownerSource: GithubDeliveryStatus['ownerSource'] = null;
  private hasAppId = false;
  private hasPrivateKey = false;
  private privateKeyValid = false;
  private hasToken = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const appId = this.configService.get<string>('github.appId');
    const privateKey = this.configService.get<string>('github.privateKey');
    this.hasAppId = Boolean(appId);
    this.hasPrivateKey = Boolean(privateKey);
    this.privateKeyValid = this.isPrivateKeyValid(privateKey);
    this.installationId = this.configService.get<number>(
      'github.installationId',
    ) ?? 0;
    this.ownerLogin = this.configService.get<string>('github.org') ?? '';
    this.ownerSource = this.ownerLogin ? 'env' : null;
    this.hasToken = Boolean(this.configService.get<string>('github.token'));

    if (this.hasToken) {
      this.logger.log('GitHub PAT configured; using personal access token for repo operations');
      this.octokit = new Octokit({
        auth: this.configService.get<string>('github.token'),
      });
      return;
    }

    if (!appId || !privateKey || !this.privateKeyValid || !this.installationId) {
      this.logger.warn(
        'GitHub App credentials are not configured; GitHub commit automation is disabled',
      );
      return;
    }

    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId: this.installationId,
      },
    });
  }

  getDeliveryStatus(): GithubDeliveryStatus {
    const missingRequirements = this.missingRequirements();
    const configured = missingRequirements.length === 0;
    return {
      configured,
      available: configured,
      owner: this.ownerLogin || null,
      ownerSource: this.ownerSource,
      missingRequirements,
      reason: configured
        ? null
        : `GitHub delivery requires ${missingRequirements.join(', ')}.`,
    };
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  buildRepoName(companyName: string, projectId: string): string {
    return `${this.slugify(companyName)}-${projectId}`;
  }

  private async getOwner(): Promise<string> {
    this.assertConfigured();
    if (this.ownerLogin) return this.ownerLogin;
    const { data } = await this.octokit.apps.getInstallation({
      installation_id: this.installationId,
    });
    this.ownerLogin =
      data.account && 'login' in data.account ? data.account.login : '';
    this.ownerSource = 'installation';
    return this.ownerLogin;
  }

  async createPlainRepository(
    name: string,
    description = 'Created by DevFlow',
  ): Promise<GithubRepository> {
    this.assertConfigured();
    this.logger.log(`Creating plain repository: ${name}`);
    const owner = await this.getOwner();

    if (this.hasToken) {
      const url = this.ownerLogin
        ? `https://api.github.com/orgs/${encodeURIComponent(this.ownerLogin)}/repos`
        : 'https://api.github.com/user/repos';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.configService.get<string>('github.token')}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          name,
          private: true,
          auto_init: true,
          description,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub repo creation failed (${response.status}): ${body.slice(0, 300)}`);
      }
      const data = await response.json() as {
        name: string;
        full_name: string;
        html_url: string;
        clone_url: string;
        default_branch: string;
        visibility?: string;
        private?: boolean;
      };
      const repository = this.toRepository(data);
      this.logger.log(`Plain repository created: ${repository.htmlUrl}`);
      return repository;
    }

    // No PAT — try via GitHub App installation (org accounts only).
    const { data: installation } = await this.octokit.apps.getInstallation({
      installation_id: this.installationId,
    });
    const isOrg = installation.account && 'type' in installation.account && installation.account.type === 'Organization';
    if (!isOrg) {
      throw new Error(
        `GitHub App installation on user account "${owner}" cannot create repos. Set GITHUB_TOKEN to a personal access token with repo scope.`,
      );
    }

    const { data } = await this.octokit.repos.createInOrg({
      org: owner,
      name,
      private: true,
      auto_init: true,
      description,
    });

    const repository = this.toRepository(data);
    this.logger.log(`Plain repository created: ${repository.htmlUrl}`);
    return repository;
  }

  /** Backward-compatible wrapper. All callers still receive a plain repository with no CI/CD. */
  async createRepo(name: string): Promise<string> {
    return (await this.createPlainRepository(name)).cloneUrl;
  }

  getInstallUrl(): string | null {
    const slug = this.configService.get<string>('github.appSlug')?.trim();
    return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
  }

  getConfiguredInstallationId(): number | null {
    return this.installationId || null;
  }

  async verifyInstallation(installationId: number) {
    this.assertConfigured();
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new ServiceUnavailableException('A valid GitHub installation id is required');
    }
    if (this.hasToken) {
      return { installationId, accountLogin: await this.getOwner(), accountType: 'Organization' };
    }
    const { data } = await this.octokit.apps.getInstallation({ installation_id: installationId });
    const accountLogin = data.account && 'login' in data.account ? data.account.login : null;
    const accountType = data.account && 'type' in data.account ? data.account.type : null;
    if (this.installationId && installationId !== this.installationId) {
      throw new ServiceUnavailableException(
        `Installation ${installationId} is not the installation configured for this DevFlow environment`,
      );
    }
    return { installationId, accountLogin, accountType };
  }

  async listVisibleRepositories() {
    this.assertConfigured();
    const owner = await this.getOwner();
    if (this.hasToken) {
      const { data } = await this.octokit.repos.listForOrg({ org: owner, per_page: 100, sort: 'updated' });
      return data.map((repository) => ({
        id: String(repository.id),
        name: repository.name,
        fullName: repository.full_name,
        htmlUrl: repository.html_url,
        private: repository.private,
        defaultBranch: repository.default_branch,
      }));
    }
    const { data } = await this.octokit.request('GET /installation/repositories', { per_page: 100 });
    return data.repositories.map((repository) => ({
      id: String(repository.id),
      name: repository.name,
      fullName: repository.full_name,
      htmlUrl: repository.html_url,
      private: repository.private,
      defaultBranch: repository.default_branch,
    }));
  }

  async addRepositoryCollaborator(repoName: string, githubLogin: string): Promise<void> {
    this.assertConfigured();
    const owner = await this.getOwner();
    await this.octokit.repos.addCollaborator({
      owner,
      repo: repoName,
      username: githubLogin,
      permission: 'push',
    });
  }

  async removeRepositoryCollaborator(repoName: string, githubLogin: string): Promise<void> {
    this.assertConfigured();
    const owner = await this.getOwner();
    await this.octokit.repos.removeCollaborator({
      owner,
      repo: repoName,
      username: githubLogin,
    });
  }

  async verifyDeliveryAccess(): Promise<GithubDeliveryVerification> {
    const status = this.getDeliveryStatus();
    if (!status.available) {
      return {
        ok: false,
        status,
        owner: status.owner,
        installationOwner: null,
        repositoriesVisible: null,
        permissions: null,
        reason: status.reason,
      };
    }

    if (this.hasToken) {
      const owner = this.ownerLogin || (await this.getOwner());
      try {
        const { data: repos } = await this.octokit.repos.listForOrg({
          org: owner,
          per_page: 1,
        });
        return {
          ok: true,
          status,
          owner,
          installationOwner: null,
          repositoriesVisible: repos.length,
          permissions: {},
          reason: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status,
          owner,
          installationOwner: null,
          repositoriesVisible: null,
          permissions: null,
          reason: `PAT verification failed: ${message}`,
        };
      }
    }

    try {
      const { data: installation } = await this.octokit.apps.getInstallation({
        installation_id: this.installationId,
      });
      const installationOwner =
        installation.account && 'login' in installation.account
          ? installation.account.login
          : null;

      if (this.ownerLogin && installationOwner && this.ownerLogin !== installationOwner) {
        return {
          ok: false,
          status,
          owner: this.ownerLogin,
          installationOwner,
          repositoriesVisible: null,
          permissions: installation.permissions ?? null,
          reason: `GITHUB_ORG (${this.ownerLogin}) does not match GitHub App installation owner (${installationOwner}).`,
        };
      }

      if (!this.ownerLogin && installationOwner) {
        this.ownerLogin = installationOwner;
        this.ownerSource = 'installation';
      }

      const { data: repositories } = await this.octokit.request(
        'GET /installation/repositories',
        { per_page: 1 },
      );

      return {
        ok: true,
        status: this.getDeliveryStatus(),
        owner: this.ownerLogin || installationOwner,
        installationOwner,
        repositoriesVisible: repositories.total_count ?? null,
        permissions: installation.permissions ?? null,
        reason: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status,
        owner: status.owner,
        installationOwner: null,
        repositoriesVisible: null,
        permissions: null,
        reason: `GitHub App installation verification failed: ${message}`,
      };
    }
  }

  async commitFiles(
    repoName: string,
    artifacts: GitHubArtifact[],
    message: string,
  ): Promise<void> {
    this.assertConfigured();
    this.logger.log(
      `Committing ${artifacts.length} files to ${repoName}: "${message}"`,
    );
    const owner = await this.getOwner();

    // Get the repo info to determine the default branch
    const { data: repo } = await this.octokit.repos.get({
      owner,
      repo: repoName,
    });
    const defaultBranch = repo.default_branch;

    // Get the latest commit on the default branch to use as parent
    const { data: refData } = await this.octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${defaultBranch}`,
    });
    const latestCommitSha = refData.object.sha;

    // Get the base tree from the latest commit
    const { data: commitData } = await this.octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    // Create blobs for all artifacts in parallel
    const treeItems = await Promise.all(
      artifacts.map(async (artifact) => {
        const { data: blobData } = await this.octokit.git.createBlob({
          owner,
          repo: repoName,
          content: Buffer.from(artifact.content).toString('base64'),
          encoding: 'base64',
        });
        return {
          path: artifact.filePath,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobData.sha,
        };
      }),
    );

    // Create a new tree pointing to the new blobs
    const { data: treeData } = await this.octokit.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // Create a single commit
    const { data: newCommit } = await this.octokit.git.createCommit({
      owner,
      repo: repoName,
      message,
      tree: treeData.sha,
      parents: [latestCommitSha],
    });

    // Update the branch ref
    await this.octokit.git.updateRef({
      owner,
      repo: repoName,
      ref: `heads/${defaultBranch}`,
      sha: newCommit.sha,
    });

    this.logger.log(`Committed ${artifacts.length} files to ${repoName}`);
  }

  private assertConfigured(): void {
    const missingRequirements = this.missingRequirements();
    if (missingRequirements.length > 0) {
      throw new ServiceUnavailableException(
        `GitHub commit automation is not configured: missing ${missingRequirements.join(', ')}`,
      );
    }
  }

  private missingRequirements(): string[] {
    const missing: string[] = [];
    if (this.hasToken) {
      if (!this.ownerLogin) missing.push('GITHUB_ORG');
      return [...new Set(missing)];
    }
    if (!this.hasAppId) missing.push('GITHUB_APP_ID');
    if (!this.hasPrivateKey) missing.push('GITHUB_PRIVATE_KEY');
    if (this.hasPrivateKey && !this.privateKeyValid) missing.push('valid GITHUB_PRIVATE_KEY');
    if (!this.installationId) missing.push('GITHUB_INSTALLATION_ID');
    if (!this.ownerLogin) missing.push('GITHUB_ORG');
    return [...new Set(missing)];
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

  private toRepository(data: {
    name: string;
    full_name: string;
    html_url: string;
    clone_url: string;
    default_branch: string;
    visibility?: string | null;
    private?: boolean;
  }): GithubRepository {
    return {
      name: data.name,
      fullName: data.full_name,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
      defaultBranch: data.default_branch || 'main',
      visibility: data.visibility ?? (data.private ? 'private' : 'public'),
    };
  }
}
