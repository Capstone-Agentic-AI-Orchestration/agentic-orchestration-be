import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocumentExtractionStatus, UserRole } from '@prisma/client';
import { IntakeDraftService } from '../src/intake/intake-draft.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentLlmRouter } from '../src/orchestration/providers/agent-llm.router';
import { AuthUser } from '../src/auth/auth.types';

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

function makePrismaMock() {
  return {
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'project-1',
        companyName: 'Acme Logistics',
        brief: 'We need a booking system for our depots.',
      }),
    },
    collaborationDocument: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'document-1',
          title: 'Process map',
          kind: 'REQUIREMENT',
          extraction: { extractedText: 'Dispatchers book slots. Drivers confirm arrival.' },
        },
      ]),
    },
  };
}

/** A complete, well-formed model answer. Individual tests degrade it to probe the coercion. */
function goodDraft(overrides: Record<string, unknown> = {}) {
  return {
    overview: {
      projectName: 'Depot booking',
      businessGoal: 'Cut phone bookings',
      successMeasures: ['80% of slots booked online'],
      primaryContact: 'casey@acme.test',
      approver: '',
      targetLaunch: '',
    },
    roles: [{ name: 'Dispatcher', responsibilities: ['Books slots'], permissions: ['Own depot only'] }],
    features: [{
      title: 'Slot booking',
      purpose: 'Let dispatchers book without phoning',
      primaryRole: 'Dispatcher',
      priority: 'MUST_HAVE',
      workflow: 'Pick depot, pick slot, confirm',
      businessRules: ['No double booking'],
      acceptanceCriteria: ['A booked slot cannot be booked again'],
    }],
    workflows: [],
    dataAndIntegrations: { entities: [], integrations: [] },
    experienceAndDelivery: { securityRequirements: [], constraints: [], milestones: [], outOfScope: [], futurePhase: [] },
    provenance: {
      'overview.businessGoal': { origin: 'stated', documentId: 'document-1' },
      'features.0.acceptanceCriteria': { origin: 'inferred', documentId: 'document-1' },
    },
    ...overrides,
  };
}

describe('IntakeDraftService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let llm: { generateJson: ReturnType<typeof vi.fn> };
  let service: IntakeDraftService;

  beforeEach(() => {
    prisma = makePrismaMock();
    llm = { generateJson: vi.fn().mockResolvedValue({ value: goodDraft(), model: 'test', usage: {} }) };
    service = new IntakeDraftService(
      prisma as unknown as PrismaService,
      llm as unknown as AgentLlmRouter,
    );
  });

  // The project id comes from the URL. Without the shared access rule a client could draft from —
  // and read the extracted document text of — another company's project.
  it('applies the project access rule before reading anything', async () => {
    await service.draftFromSources('project-1', clientUser);

    expect(prisma.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'project-1',
        OR: [{ createdById: clientUser.id }, { members: { some: { userId: clientUser.id } } }],
      }),
    }));
  });

  it('refuses a project the caller cannot reach, without calling the model', async () => {
    prisma.project.findFirst.mockResolvedValue(null);

    await expect(service.draftFromSources('someone-elses', clientUser)).rejects.toBeInstanceOf(NotFoundException);
    expect(llm.generateJson).not.toHaveBeenCalled();
  });

  it('only reads documents whose text was successfully extracted', async () => {
    await service.draftFromSources('project-1', clientUser);

    expect(prisma.collaborationDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', extraction: { status: DocumentExtractionStatus.READY } },
    }));
  });

  it('returns the drafted payload with provenance and its sources', async () => {
    const result = await service.draftFromSources('project-1', clientUser);

    expect(result.payload.overview.businessGoal).toBe('Cut phone bookings');
    expect(result.payload.features[0].acceptanceCriteria).toEqual(['A booked slot cannot be booked again']);
    expect(result.provenance['overview.businessGoal']).toEqual({ origin: 'stated', documentId: 'document-1' });
    expect(result.sourceDocumentIds).toEqual(['document-1']);
    expect(result.usedBrief).toBe(true);
  });

  // Everything downstream indexes into these fields without checking, so a model that omits an
  // array has to fail here rather than three screens away.
  it('coerces a malformed answer into the full payload shape', async () => {
    llm.generateJson.mockResolvedValue({
      value: { overview: { businessGoal: 'Cut phone bookings' }, features: 'not an array' },
      model: 'test',
      usage: {},
    });

    const result = await service.draftFromSources('project-1', clientUser);

    expect(result.payload.features).toEqual([]);
    expect(result.payload.roles).toEqual([]);
    expect(result.payload.overview.successMeasures).toEqual([]);
    expect(result.payload.dataAndIntegrations.entities).toEqual([]);
    // Falls back to the company name rather than sitting blank — we already know it.
    expect(result.payload.overview.projectName).toBe('Acme Logistics');
  });

  // "Not applicable" is an assertion the client makes. Auto-ticking it would silently drop a whole
  // section from the scope the agents build to.
  it('never ticks a not-applicable box on the client behalf', async () => {
    llm.generateJson.mockResolvedValue({
      value: goodDraft({ dataAndIntegrations: { entities: [], integrations: [], dataNotApplicable: true, integrationsNotApplicable: true } }),
      model: 'test',
      usage: {},
    });

    const result = await service.draftFromSources('project-1', clientUser);

    expect(result.payload.dataAndIntegrations.dataNotApplicable).toBe(false);
    expect(result.payload.dataAndIntegrations.integrationsNotApplicable).toBe(false);
  });

  // Provenance is what stops a guess reading as the client's own answer, so an unusable origin must
  // drop the entry rather than default to something reassuring.
  it('drops provenance entries with an unrecognised origin', async () => {
    llm.generateJson.mockResolvedValue({
      value: goodDraft({
        provenance: {
          'overview.businessGoal': { origin: 'guessed' },
          'overview.approver': { origin: 'STATED' },
          'overview.targetLaunch': 'not an object',
        },
      }),
      model: 'test',
      usage: {},
    });

    const result = await service.draftFromSources('project-1', clientUser);

    expect(result.provenance['overview.businessGoal']).toBeUndefined();
    expect(result.provenance['overview.targetLaunch']).toBeUndefined();
    // Case is normalised rather than rejected — the value is usable, only its spelling was off.
    expect(result.provenance['overview.approver']).toEqual({ origin: 'stated', documentId: undefined });
  });

  it('drafts from the brief alone when no documents have been uploaded', async () => {
    prisma.collaborationDocument.findMany.mockResolvedValue([]);

    const result = await service.draftFromSources('project-1', clientUser);

    expect(llm.generateJson).toHaveBeenCalled();
    expect(result.sourceDocumentIds).toEqual([]);
    expect(result.usedBrief).toBe(true);
  });

  it('refuses when there is neither a document nor a brief', async () => {
    prisma.collaborationDocument.findMany.mockResolvedValue([]);
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1', companyName: 'Acme', brief: '   ' });

    await expect(service.draftFromSources('project-1', clientUser)).rejects.toBeInstanceOf(BadRequestException);
    expect(llm.generateJson).not.toHaveBeenCalled();
  });

  // A failed draft must not be mistaken for an empty one, or the client concludes their documents
  // were useless and fills the form by hand for nothing.
  it('surfaces a model failure as an error rather than an empty draft', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider timeout'));

    await expect(service.draftFromSources('project-1', clientUser)).rejects.toBeInstanceOf(BadRequestException);
  });
});
