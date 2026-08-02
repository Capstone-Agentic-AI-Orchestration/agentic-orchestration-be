import { HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InquiryStatus, UserRole } from '@prisma/client';
import { InquiriesController } from '../src/inquiries/inquiries.controller';
import type { InquiriesService } from '../src/inquiries/inquiries.service';
import type { IdempotencyService } from '../src/shared/idempotency/idempotency.service';
import type { AuthUser } from '../src/auth/auth.types';

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

describe('InquiriesController idempotency', () => {
  let inquiries: {
    create: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
    sendAccountInvitation: ReturnType<typeof vi.fn>;
  };
  let idempotency: {
    requestHash: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let controller: InquiriesController;

  beforeEach(() => {
    inquiries = {
      create: vi.fn().mockResolvedValue({ id: 'inquiry-1' }),
      findAll: vi.fn().mockResolvedValue([]),
      approve: vi.fn().mockResolvedValue({ id: 'inquiry-1', status: 'APPROVED' }),
      reject: vi.fn().mockResolvedValue({ id: 'inquiry-1', status: 'REJECTED' }),
      sendAccountInvitation: vi.fn().mockResolvedValue({
        status: 'SENT',
        email: 'casey@example.com',
        message: 'The client account invitation email was sent.',
      }),
    };
    idempotency = {
      requestHash: vi.fn().mockReturnValue('hash-1'),
      run: vi.fn(async ({ handler }) => ({
        fromCache: false,
        responseStatus: HttpStatus.CREATED,
        body: await handler(),
      })),
    };
    controller = new InquiriesController(
      inquiries as unknown as InquiriesService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('runs public inquiry creation through idempotency when a key is provided', async () => {
    const dto = {
      companyName: 'Acme Co',
      contactName: 'Casey Client',
      email: 'casey@example.com',
      brief: 'Build a portal.',
    };

    await expect(controller.create(dto, 'request-key-1')).resolves.toEqual({ id: 'inquiry-1' });

    expect(idempotency.requestHash).toHaveBeenCalledWith(dto);
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: 'public:POST:/inquiries',
      requestHash: 'hash-1',
      responseStatus: HttpStatus.CREATED,
      handler: expect.any(Function),
    }));
    expect(inquiries.create).toHaveBeenCalledWith(dto);
  });

  it('bypasses idempotency when no key is provided', async () => {
    const dto = {
      companyName: 'Acme Co',
      contactName: 'Casey Client',
      email: 'casey@example.com',
      brief: 'Build a portal.',
    };

    await expect(controller.create(dto)).resolves.toEqual({ id: 'inquiry-1' });

    expect(idempotency.run).not.toHaveBeenCalled();
    expect(inquiries.create).toHaveBeenCalledWith(dto);
  });

  it('passes inquiry list pagination to the service', async () => {
    const page = { limit: '2', cursor: 'inquiry-1' };

    await expect(controller.findAll(InquiryStatus.NEW, page)).resolves.toEqual([]);

    expect(inquiries.findAll).toHaveBeenCalledWith(InquiryStatus.NEW, page);
  });

  it('scopes inquiry approval idempotency to the actor and route', async () => {
    idempotency.run = vi.fn(async ({ handler }) => ({
      fromCache: false,
      responseStatus: HttpStatus.OK,
      body: await handler(),
    }));

    await expect(
      controller.approve('inquiry-1', { reviewNote: 'Looks good.' }, pmUser, 'request-key-1'),
    ).resolves.toEqual({ id: 'inquiry-1', status: 'APPROVED' });

    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-1',
      scope: `user:${pmUser.id}:POST:/inquiries/inquiry-1/approve`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(inquiries.approve).toHaveBeenCalledWith(
      'inquiry-1',
      pmUser,
      { reviewNote: 'Looks good.' },
    );
  });

  it('lets a PM resend the account email for an approved inquiry', async () => {
    idempotency.run = vi.fn(async ({ handler }) => ({
      fromCache: false,
      responseStatus: HttpStatus.OK,
      body: await handler(),
    }));

    await expect(
      controller.sendAccountInvitation('inquiry-1', pmUser, 'request-key-2'),
    ).resolves.toEqual({
      status: 'SENT',
      email: 'casey@example.com',
      message: 'The client account invitation email was sent.',
    });

    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'request-key-2',
      scope: `user:${pmUser.id}:POST:/inquiries/inquiry-1/send-account-invite`,
      requestHash: 'hash-1',
      responseStatus: HttpStatus.OK,
      handler: expect.any(Function),
    }));
    expect(inquiries.sendAccountInvitation).toHaveBeenCalledWith('inquiry-1');
  });
});
