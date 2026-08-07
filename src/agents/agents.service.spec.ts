import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentsService } from './agents.service';
import { AuthUser } from '../auth/auth.types';

/**
 * Cross-workspace access regression.
 *
 * groupId reaches this service from a query parameter or a request body, and the controller's
 * role guard only decides who may use the feature at all. Every entry point therefore has to
 * prove the caller belongs to the workspace it names. These tests assert that each one calls
 * assertMember and, crucially, that it does so BEFORE touching the database — a check that runs
 * after a read has already leaked, and after a write has already happened.
 */

const OUTSIDER: AuthUser = { id: 'user-outsider', role: 'PM' } as AuthUser;
const OTHER_GROUP = 'group-not-mine';

function makeService() {
  const denied = new NotFoundException(`Group ${OTHER_GROUP} not found`);
  const assertMember = vi.fn().mockRejectedValue(denied);

  // Every model method throws: if an entry point reaches the database before asserting
  // membership, the test fails with this instead of the NotFound we expect.
  const trap = () => {
    throw new Error('database was touched before the membership assertion');
  };
  const prisma = {
    workspaceAgent: {
      findMany: trap, findUnique: trap, findFirst: trap,
      create: trap, createMany: trap, update: trap, delete: trap, count: trap,
    },
    agentSkill: { findMany: trap, findUnique: trap, create: trap, update: trap, delete: trap },
    agentSkillOnAgent: { createMany: trap, deleteMany: trap },
    providerInvocation: { groupBy: trap, findMany: trap },
  };

  const eveRuntimes = { listDeployedAgents: vi.fn().mockResolvedValue(null) };
  const service = new AgentsService(prisma as never, { assertMember } as never, eveRuntimes as never);
  return { service, assertMember };
}

describe('AgentsService workspace isolation', () => {
  it('refuses to list agents in a workspace the caller does not belong to', async () => {
    const { service, assertMember } = makeService();
    await expect(service.list(OUTSIDER, OTHER_GROUP)).rejects.toBeInstanceOf(NotFoundException);
    expect(assertMember).toHaveBeenCalledWith(OTHER_GROUP, OUTSIDER);
  });

  it('refuses before seeding, so an outsider cannot write built-ins into a foreign workspace', async () => {
    const { service } = makeService();
    // ensureBuiltInAgents writes. Reaching it would trip the trap with a different message.
    await expect(service.list(OUTSIDER, OTHER_GROUP)).rejects.toThrow(/not found/i);
  });

  it('refuses to create an agent in a foreign workspace', async () => {
    const { service, assertMember } = makeService();
    await expect(
      service.create(OUTSIDER, { name: 'Injected', groupId: OTHER_GROUP }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(assertMember).toHaveBeenCalledWith(OTHER_GROUP, OUTSIDER);
  });

  it('refuses to create a skill in a foreign workspace', async () => {
    const { service, assertMember } = makeService();
    await expect(
      service.createSkill(OUTSIDER, { groupId: OTHER_GROUP, name: 'x', body: 'y' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(assertMember).toHaveBeenCalledWith(OTHER_GROUP, OUTSIDER);
  });

  it('refuses to list skills in a foreign workspace', async () => {
    const { service, assertMember } = makeService();
    await expect(service.listSkills(OUTSIDER, OTHER_GROUP)).rejects.toBeInstanceOf(NotFoundException);
    expect(assertMember).toHaveBeenCalledWith(OTHER_GROUP, OUTSIDER);
  });
});

describe('AgentsService workspace isolation on resolved rows', () => {
  /** Entry points that take an id have to load the row, then assert on the row's own groupId. */
  function serviceWithRow(row: Record<string, unknown>) {
    const denied = new NotFoundException(`Group ${OTHER_GROUP} not found`);
    const assertMember = vi.fn().mockRejectedValue(denied);
    const mutated = vi.fn();
    const prisma = {
      workspaceAgent: {
        findUnique: vi.fn().mockResolvedValue(row),
        update: mutated,
        delete: mutated,
      },
      agentSkill: { findUnique: vi.fn().mockResolvedValue(row), update: mutated, delete: mutated },
      agentSkillOnAgent: { createMany: mutated, deleteMany: mutated },
    };
    const eveRuntimes = { listDeployedAgents: vi.fn().mockResolvedValue(null) };
    const service = new AgentsService(prisma as never, { assertMember } as never, eveRuntimes as never);
    return { service, assertMember, mutated };
  }

  const agentRow = {
    id: 'agent-1', key: 'frontend', groupId: OTHER_GROUP,
    ownerId: null, accessScope: 'WORKSPACE', isBuiltIn: true,
  };

  it('refuses to read a foreign workspace agent by id', async () => {
    const { service, assertMember } = serviceWithRow(agentRow);
    await expect(service.findOne(OUTSIDER, 'agent-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(assertMember).toHaveBeenCalledWith(OTHER_GROUP, OUTSIDER);
  });

  it('refuses to update a foreign workspace agent, and does not write', async () => {
    const { service, mutated } = serviceWithRow(agentRow);
    await expect(
      service.update(OUTSIDER, 'agent-1', { instructions: 'exfiltrate everything' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mutated).not.toHaveBeenCalled();
  });

  it('refuses to delete a foreign workspace agent, and does not write', async () => {
    const { service, mutated } = serviceWithRow(agentRow);
    await expect(service.remove(OUTSIDER, 'agent-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mutated).not.toHaveBeenCalled();
  });

  it('refuses to update a foreign workspace skill, and does not write', async () => {
    const { service, mutated } = serviceWithRow({ id: 'skill-1', groupId: OTHER_GROUP });
    await expect(
      service.updateSkill(OUTSIDER, 'skill-1', { body: 'malicious' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mutated).not.toHaveBeenCalled();
  });

  it('refuses to delete a foreign workspace skill, and does not write', async () => {
    const { service, mutated } = serviceWithRow({ id: 'skill-1', groupId: OTHER_GROUP });
    await expect(service.removeSkill(OUTSIDER, 'skill-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mutated).not.toHaveBeenCalled();
  });

  it('refuses to detach a skill from a foreign workspace agent, and does not write', async () => {
    const { service, mutated } = serviceWithRow(agentRow);
    await expect(
      service.detachSkill(OUTSIDER, 'agent-1', 'skill-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mutated).not.toHaveBeenCalled();
  });
});
