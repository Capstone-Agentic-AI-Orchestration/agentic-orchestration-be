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

const CI_WORKFLOW_CONTENT = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build --if-present
      - name: Test
        run: npm test --if-present
`;

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

  async createRepo(name: string): Promise<string> {
    this.assertConfigured();
    this.logger.log(`Creating repository: ${name}`);
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
          description: `Scaffolded by DevFlow`,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub repo creation failed (${response.status}): ${body.slice(0, 300)}`);
      }
      const data = await response.json();
      this.logger.log(`Repository created: ${data.clone_url}`);
      return data.clone_url;
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
      description: `Scaffolded by DevFlow`,
    });

    this.logger.log(`Repository created: ${data.clone_url}`);
    return data.clone_url;
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

  async injectCiWorkflow(repoName: string): Promise<void> {
    await this.commitFiles(
      repoName,
      [
        {
          filePath: '.github/workflows/ci.yml',
          content: CI_WORKFLOW_CONTENT,
        },
      ],
      'ci: add GitHub Actions workflow',
    );
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
}
