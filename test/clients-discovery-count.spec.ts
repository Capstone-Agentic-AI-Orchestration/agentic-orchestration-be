import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientStatus, ProjectStatus } from '@prisma/client';
import { ClientsService } from '../src/clients/clients.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Approving an inquiry creates a DISCOVERY project so the client has somewhere to be invited and
 * to upload documents into. That row is not delivery work, and counting it as one is what made a
 * brand-new client read as "1 project" on the Clients page.
 *
 * These tests pin the split at the source, because the console cannot recover it: the list
 * endpoint returns counts, not statuses.
 */
function makePrismaMock(projects: Array<{ status: ProjectStatus; updatedAt: Date }>) {
  return {
    client: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'client-1',
          name: 'Acme',
          status: ClientStatus.ACTIVE,
          primaryContactName: null,
          primaryContactEmail: null,
          groupId: 'group-1',
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
          _count: { contacts: 2 },
          projects,
        },
      ]),
    },
  };
}

function serviceFor(projects: Array<{ status: ProjectStatus; updatedAt: Date }>) {
  const prisma = makePrismaMock(projects);
  return new ClientsService(prisma as unknown as PrismaService);
}

const at = (iso: string) => new Date(iso);

describe('ClientsService.list — discovery is not delivery', () => {
  let listed: Awaited<ReturnType<ClientsService['list']>>['clients'];

  beforeEach(() => {
    listed = [];
  });

  it('reports a freshly approved client as zero projects, one discovery space', async () => {
    const service = serviceFor([{ status: ProjectStatus.DISCOVERY, updatedAt: at('2026-08-05T00:00:00.000Z') }]);

    ({ clients: listed } = await service.list());

    expect(listed[0].projectCount).toBe(0);
    expect(listed[0].discoveryCount).toBe(1);
  });

  it('counts every non-discovery status as a project', async () => {
    const service = serviceFor([
      { status: ProjectStatus.DISCOVERY, updatedAt: at('2026-08-05T00:00:00.000Z') },
      { status: ProjectStatus.PENDING, updatedAt: at('2026-08-04T00:00:00.000Z') },
      { status: ProjectStatus.GENERATING_CODE, updatedAt: at('2026-08-03T00:00:00.000Z') },
      { status: ProjectStatus.DELIVERED, updatedAt: at('2026-08-02T00:00:00.000Z') },
      { status: ProjectStatus.FAILED, updatedAt: at('2026-08-01T00:00:00.000Z') },
    ]);

    ({ clients: listed } = await service.list());

    expect(listed[0].projectCount).toBe(4);
    expect(listed[0].discoveryCount).toBe(1);
  });

  it('leaves a client with nothing at all at zero on both counts', async () => {
    const service = serviceFor([]);

    ({ clients: listed } = await service.list());

    expect(listed[0].projectCount).toBe(0);
    expect(listed[0].discoveryCount).toBe(0);
    expect(listed[0].lastProjectActivityAt).toBeNull();
  });

  it('still dates last activity from a discovery space', async () => {
    // Uploading a document during discovery is activity. Suppressing it would leave the card
    // reading "No project activity" while the PM is actively working the lead.
    const service = serviceFor([{ status: ProjectStatus.DISCOVERY, updatedAt: at('2026-08-06T00:00:00.000Z') }]);

    ({ clients: listed } = await service.list());

    expect(listed[0].lastProjectActivityAt).toEqual(at('2026-08-06T00:00:00.000Z'));
  });
});
