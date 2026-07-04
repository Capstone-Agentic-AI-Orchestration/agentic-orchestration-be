import { HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types';
import { AdminController } from '../src/admin/admin.controller';
import type { AdminService } from '../src/admin/admin.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';

const adminUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@example.com',
  fullName: 'Ada Admin',
  role: UserRole.ADMIN,
};

describe('AdminController', () => {
  let admin: {
    listUsers: ReturnType<typeof vi.fn>;
    updateUserRole: ReturnType<typeof vi.fn>;
    updateUserStatus: ReturnType<typeof vi.fn>;
    createDomain: ReturnType<typeof vi.fn>;
    updateDomain: ReturnType<typeof vi.fn>;
    verifyDomain: ReturnType<typeof vi.fn>;
    deleteDomain: ReturnType<typeof vi.fn>;
    listDomains: ReturnType<typeof vi.fn>;
    listRepositories: ReturnType<typeof vi.fn>;
    createRepository: ReturnType<typeof vi.fn>;
    linkRepository: ReturnType<typeof vi.fn>;
    listHandoffs: ReturnType<typeof vi.fn>;
    overrideHandoff: ReturnType<typeof vi.fn>;
    updateSetting: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: AdminController;

  beforeEach(() => {
    admin = {
      listUsers: vi.fn().mockResolvedValue([]),
      updateUserRole: vi.fn().mockResolvedValue({ id: 'user-1', role: UserRole.PM }),
      updateUserStatus: vi.fn().mockResolvedValue({ id: 'user-1', active: true }),
      createDomain: vi.fn().mockResolvedValue({ id: 'domain-1' }),
      updateDomain: vi.fn().mockResolvedValue({ id: 'domain-1' }),
      verifyDomain: vi.fn().mockResolvedValue({ id: 'domain-1', verified: true }),
      deleteDomain: vi.fn().mockResolvedValue({ id: 'domain-1', deleted: true }),
      listDomains: vi.fn().mockResolvedValue([]),
      listRepositories: vi.fn().mockResolvedValue([]),
      createRepository: vi.fn().mockResolvedValue({ id: 'repo-1' }),
      linkRepository: vi.fn().mockResolvedValue({ id: 'repo-1' }),
      listHandoffs: vi.fn().mockResolvedValue([]),
      overrideHandoff: vi.fn().mockResolvedValue({ id: 'handoff-1' }),
      updateSetting: vi.fn().mockResolvedValue({ key: 'setting-1' }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler, responseStatus }) => ({
        fromCache: false,
        responseStatus,
        body: await handler(),
      })),
    };
    controller = new AdminController(
      admin as unknown as AdminService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('passes user list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'user-1' };

    await expect(controller.users('ada', UserRole.ADMIN, page)).resolves.toEqual([]);

    expect(admin.listUsers).toHaveBeenCalledWith({
      q: 'ada',
      role: UserRole.ADMIN,
      page,
    });
  });

  it('passes domain list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'domain-1' };

    await expect(controller.domains(page)).resolves.toEqual([]);

    expect(admin.listDomains).toHaveBeenCalledWith(page);
  });

  it('passes repository list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'project-1' };

    await expect(controller.repositories(page)).resolves.toEqual([]);

    expect(admin.listRepositories).toHaveBeenCalledWith(page);
  });

  it('passes handoff list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'project-1' };

    await expect(controller.handoffs(page)).resolves.toEqual([]);

    expect(admin.listHandoffs).toHaveBeenCalledWith(page);
  });

  it('bypasses idempotency for user role changes when no key is provided', async () => {
    await expect(
      controller.updateUserRole('user-1', { role: UserRole.PM }, adminUser),
    ).resolves.toEqual({ id: 'user-1', role: UserRole.PM });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(admin.updateUserRole).toHaveBeenCalledWith('user-1', UserRole.PM, adminUser);
  });

  it('scopes user role changes to the actor and admin route when a key is provided', async () => {
    await expect(
      controller.updateUserRole('user-1', { role: UserRole.PM }, adminUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'user-1', role: UserRole.PM });

    expect(idempotency.requestHash).toHaveBeenCalledWith({ role: UserRole.PM });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${adminUser.id}:PATCH:/admin/users/user-1/role`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(admin.updateUserRole).toHaveBeenCalledWith('user-1', UserRole.PM, adminUser);
  });

  it('runs domain creation through idempotency with created response status', async () => {
    const dto = { domain: 'client.example.com' };

    await expect(
      controller.createDomain(dto, adminUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'domain-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${adminUser.id}:POST:/admin/domains`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(admin.createDomain).toHaveBeenCalledWith(dto, adminUser);
  });

  it('runs repository linking through idempotency using the project route', async () => {
    const dto = { repoUrl: 'https://github.com/acme/devflow' };

    await expect(
      controller.linkRepository('project-1', dto, adminUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'repo-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${adminUser.id}:PATCH:/admin/projects/project-1/repository`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(admin.linkRepository).toHaveBeenCalledWith(
      'project-1',
      'https://github.com/acme/devflow',
      adminUser,
    );
  });
});
