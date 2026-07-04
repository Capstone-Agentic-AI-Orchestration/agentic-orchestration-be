import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { GithubService } from '../src/github/github.service';
import { normalizeGithubPrivateKey } from '../src/config/configuration';

function makeConfig(values: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function validPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('GithubService', () => {
  it('normalizes base64, raw PEM, and escaped PEM GitHub private keys', () => {
    const privateKey = validPrivateKey();
    const escapedPrivateKey = privateKey.replace(/\n/g, '\\n');
    const base64PrivateKey = Buffer.from(privateKey, 'utf-8').toString('base64');
    const base64EscapedPrivateKey = Buffer.from(escapedPrivateKey, 'utf-8').toString('base64');

    expect(normalizeGithubPrivateKey(privateKey)).toBe(privateKey.trim());
    expect(normalizeGithubPrivateKey(escapedPrivateKey)).toBe(privateKey.trim());
    expect(normalizeGithubPrivateKey(base64PrivateKey)).toBe(privateKey.trim());
    expect(normalizeGithubPrivateKey(base64EscapedPrivateKey)).toBe(privateKey.trim());
  });

  it('reports missing GitHub delivery requirements', () => {
    const service = new GithubService(makeConfig({}));
    service.onModuleInit();

    expect(service.getDeliveryStatus()).toEqual({
      configured: false,
      available: false,
      owner: null,
      ownerSource: null,
      missingRequirements: [
        'GITHUB_APP_ID',
        'GITHUB_PRIVATE_KEY',
        'GITHUB_INSTALLATION_ID',
        'GITHUB_ORG',
      ],
      reason: 'GitHub delivery requires GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_ORG.',
    });
  });

  it('uses explicit GITHUB_ORG as the repository owner', async () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': validPrivateKey(),
      'github.installationId': 67890,
      'github.org': 'capstone-org',
    }));
    service.onModuleInit();
    const octokit = {
      apps: {
        getInstallation: vi.fn().mockResolvedValue({
          data: { account: { type: 'Organization' } },
        }),
      },
      repos: {
        createInOrg: vi.fn().mockResolvedValue({
          data: { clone_url: 'https://github.com/capstone-org/acme-project.git' },
        }),
      },
    };
    Object.assign(service as unknown as { octokit: unknown }, { octokit });

    const repoUrl = await service.createRepo('acme-project');

    expect(repoUrl).toBe('https://github.com/capstone-org/acme-project.git');
    expect(octokit.repos.createInOrg).toHaveBeenCalledWith({
      org: 'capstone-org',
      name: 'acme-project',
      private: true,
      description: 'Scaffolded by DevFlow',
    });
    expect(service.getDeliveryStatus()).toEqual(expect.objectContaining({
      configured: true,
      available: true,
      owner: 'capstone-org',
      ownerSource: 'env',
      missingRequirements: [],
      reason: null,
    }));
  });

  it('commits files by creating blobs, a tree, a commit, and updating main', async () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': validPrivateKey(),
      'github.installationId': 67890,
      'github.org': 'capstone-org',
    }));
    service.onModuleInit();
    const octokit = {
      repos: {
        get: vi.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      },
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'latest-sha' } } }),
        getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: 'base-tree-sha' } } }),
        createBlob: vi
          .fn()
          .mockResolvedValueOnce({ data: { sha: 'blob-1' } })
          .mockResolvedValueOnce({ data: { sha: 'blob-2' } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: 'new-tree-sha' } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: 'new-commit-sha' } }),
        updateRef: vi.fn().mockResolvedValue({}),
      },
    };
    Object.assign(service as unknown as { octokit: unknown }, { octokit });

    await service.commitFiles(
      'acme-project',
      [
        { filePath: 'README.md', content: '# Acme' },
        { filePath: 'src/index.ts', content: 'export const ok = true;' },
      ],
      'feat: initial scaffold',
    );

    expect(octokit.git.createTree).toHaveBeenCalledWith({
      owner: 'capstone-org',
      repo: 'acme-project',
      base_tree: 'base-tree-sha',
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'blob-2' },
      ],
    });
    expect(octokit.git.updateRef).toHaveBeenCalledWith({
      owner: 'capstone-org',
      repo: 'acme-project',
      ref: 'heads/main',
      sha: 'new-commit-sha',
    });
  });

  it('verifies GitHub App installation access before repository creation', async () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': validPrivateKey(),
      'github.installationId': 67890,
      'github.org': 'capstone-org',
    }));
    service.onModuleInit();
    const octokit = {
      apps: {
        getInstallation: vi.fn().mockResolvedValue({
          data: {
            account: { login: 'capstone-org' },
            permissions: { contents: 'write', administration: 'write' },
          },
        }),
      },
      request: vi.fn().mockResolvedValue({
        data: { total_count: 4 },
      }),
    };
    Object.assign(service as unknown as { octokit: unknown }, { octokit });

    await expect(service.verifyDeliveryAccess()).resolves.toEqual({
      ok: true,
      status: expect.objectContaining({
        available: true,
        owner: 'capstone-org',
      }),
      owner: 'capstone-org',
      installationOwner: 'capstone-org',
      repositoriesVisible: 4,
      permissions: { contents: 'write', administration: 'write' },
      reason: null,
    });
    expect(octokit.apps.getInstallation).toHaveBeenCalledWith({
      installation_id: 67890,
    });
    expect(octokit.request).toHaveBeenCalledWith('GET /installation/repositories', {
      per_page: 1,
    });
  });

  it('reports a configured GitHub org that does not match the installation owner', async () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': validPrivateKey(),
      'github.installationId': 67890,
      'github.org': 'wrong-org',
    }));
    service.onModuleInit();
    const octokit = {
      apps: {
        getInstallation: vi.fn().mockResolvedValue({
          data: {
            account: { login: 'capstone-org' },
            permissions: { contents: 'write' },
          },
        }),
      },
      request: vi.fn(),
    };
    Object.assign(service as unknown as { octokit: unknown }, { octokit });

    await expect(service.verifyDeliveryAccess()).resolves.toEqual({
      ok: false,
      status: expect.objectContaining({
        available: true,
        owner: 'wrong-org',
      }),
      owner: 'wrong-org',
      installationOwner: 'capstone-org',
      repositoriesVisible: null,
      permissions: { contents: 'write' },
      reason: 'GITHUB_ORG (wrong-org) does not match GitHub App installation owner (capstone-org).',
    });
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it('fails predictably when commit automation is not configured', async () => {
    const service = new GithubService(makeConfig({}));
    service.onModuleInit();

    await expect(service.createRepo('missing-config')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports an invalid private key as not ready for delivery', () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      'github.installationId': 67890,
      'github.org': 'capstone-org',
    }));
    service.onModuleInit();

    expect(service.getDeliveryStatus()).toEqual(expect.objectContaining({
      configured: false,
      available: false,
      owner: 'capstone-org',
      missingRequirements: ['valid GITHUB_PRIVATE_KEY'],
      reason: 'GitHub delivery requires valid GITHUB_PRIVATE_KEY.',
    }));
  });
});
