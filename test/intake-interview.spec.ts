import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InquiryStatus, UserRole } from '@prisma/client';
import {
  IntakeInterviewService,
  type InterviewSubject,
} from '../src/intake/intake-interview.service';
import { IntakeService } from '../src/intake/intake.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentLlmRouter } from '../src/orchestration/providers/agent-llm.router';
import { emptyClientIntakePayload, type ClientIntakePayload } from '../src/intake/intake.types';
import { AuthUser } from '../src/auth/auth.types';

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

const blank = (): ClientIntakePayload =>
  emptyClientIntakePayload({ projectName: 'Depot booking', companyName: 'Acme', brief: '' });

describe('IntakeInterviewService', () => {
  let payload: ClientIntakePayload;
  let saves: number;
  let subject: InterviewSubject;
  let llm: { generateJson: ReturnType<typeof vi.fn> };
  let service: IntakeInterviewService;

  /** Answers `phrase` for any turn, and `absorb` with whatever the test queues up. */
  const respondWith = (extraction: Record<string, unknown>) => {
    llm.generateJson.mockImplementation(async ({ userPrompt }: { userPrompt: string }) =>
      userPrompt.startsWith('Ask the client this')
        ? { value: { message: 'Phrased question' }, model: 't', usage: {} }
        : { value: extraction, model: 't', usage: {} },
    );
  };

  beforeEach(() => {
    payload = blank();
    saves = 0;
    // Whatever the brief is stored on — a project's intake or an unapproved lead — the engine only
    // ever loads and saves. Holding it in memory keeps these tests about the agenda.
    subject = {
      projectId: 'project-1',
      load: async () => payload,
      save: async (next) => { payload = next; saves += 1; },
    };
    llm = { generateJson: vi.fn() };
    respondWith({});
    service = new IntakeInterviewService(
      {} as unknown as IntakeService,
      llm as unknown as AgentLlmRouter,
      {} as unknown as PrismaService,
    );
  });

  it('opens on the goal, and asks nothing before the client has said anything', async () => {
    const turn = await service.takeTurn(subject);

    expect(turn.topicId).toBe('goal');
    expect(turn.done).toBe(false);
    expect(turn.totalCount).toBe(4);
    expect(turn.answeredCount).toBe(0);
    expect(saves).toBe(0);
  });

  // The agenda is fixed. A model that decides its own next question cannot be tested and drifts
  // toward asking for whatever the payload is missing — which is how the old form got its
  // decision points and error cases.
  it('walks the four topics in order', async () => {
    respondWith({ businessGoal: 'Stop phone bookings', successMeasures: ['80% online'] });
    expect((await service.takeTurn(subject, { reply: 'Stop phone bookings', topicId: 'goal' })).topicId).toBe('users');

    respondWith({ roles: [{ name: 'Dispatcher', responsibilities: ['Books slots'] }] });
    expect((await service.takeTurn(subject, { reply: 'Dispatchers', topicId: 'users' })).topicId).toBe('musthaves');

    respondWith({ features: [{ title: 'Slot booking', purpose: 'Book without phoning', priority: 'MUST_HAVE' }] });
    expect((await service.takeTurn(subject, { reply: 'Booking', topicId: 'musthaves' })).topicId).toBe('boundaries');

    respondWith({ targetLaunch: 'October' });
    const last = await service.takeTurn(subject, { reply: 'October', topicId: 'boundaries' });
    expect(last.done).toBe(true);
    expect(last.topicId).toBeNull();
    expect(last.answeredCount).toBe(4);
  });

  it('persists each answer so a client can close the tab and come back', async () => {
    respondWith({ businessGoal: 'Stop phone bookings', successMeasures: ['80% online'] });

    await service.takeTurn(subject, { reply: 'Stop phone bookings', topicId: 'goal' });

    expect(saves).toBeGreaterThan(0);
    expect(payload.overview.businessGoal).toBe('Stop phone bookings');
  });

  // A client naming who uses the software has not described a permission model. Inferring one would
  // put a guess into a scope the agents are told is authoritative.
  it('never infers permissions from a reply about users', async () => {
    respondWith({ roles: [{ name: 'Dispatcher', responsibilities: ['Books slots'], permissions: ['Full admin'] }] });

    await service.takeTurn(subject, { reply: 'Dispatchers book slots', topicId: 'users' });

    expect(payload.roles[0].permissions).toEqual([]);
  });

  it('never invents acceptance criteria or business rules from a reply about features', async () => {
    respondWith({ features: [{ title: 'Slot booking', purpose: 'Book without phoning', priority: 'MUST_HAVE', acceptanceCriteria: ['Invented'], businessRules: ['Invented'] }] });

    await service.takeTurn(subject, { reply: 'Booking', topicId: 'musthaves' });

    expect(payload.features[0].acceptanceCriteria).toEqual([]);
    expect(payload.features[0].businessRules).toEqual([]);
  });

  // Scoping the merge is what stops an answer about launch dates rewriting the feature list.
  it('only writes the fields belonging to the topic being answered', async () => {
    payload.features = [{ title: 'Kept', purpose: 'Kept', primaryRole: '', priority: 'MUST_HAVE', workflow: '', businessRules: [], acceptanceCriteria: [] }];
    respondWith({ targetLaunch: 'October', features: [{ title: 'Should be ignored', purpose: 'x', priority: 'MUST_HAVE' }] });

    await service.takeTurn(subject, { reply: 'October', topicId: 'boundaries' });

    expect(payload.features).toHaveLength(1);
    expect(payload.features[0].title).toBe('Kept');
    expect(payload.overview.targetLaunch).toBe('October');
  });

  // The client said something real. Losing it to a provider timeout would make them retype it.
  it('keeps the raw reply as the goal when extraction fails', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider timeout'));

    await service.takeTurn(subject, { reply: 'We want online depot bookings', topicId: 'goal' });

    expect(payload.overview.businessGoal).toBe('We want online depot bookings');
  });

  // An interview that stalls because a model was unavailable is far worse than a plainly worded
  // question, so the agenda's own wording is the fallback.
  it('falls back to the fixed question wording when phrasing fails', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider down'));

    const turn = await service.takeTurn(subject);

    expect(turn.topicId).toBe('goal');
    expect(turn.message).toContain('What should this software do for your business');
    expect(turn.message).toContain('For example:');
  });

  // The bug this pins: the agenda is derived from the payload, so a reply the model could not parse
  // left its topic permanently unanswered -- and the next turn asked the same question again. A
  // provider outage turned the conversation into a loop with no way out.
  it('moves on after a reply it could not parse, instead of asking again', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider down'));

    const first = await service.takeTurn(subject, { reply: 'Dispatchers book slots', topicId: 'users' });

    expect(first.topicId).not.toBe('users');
    expect(first.answeredCount).toBeGreaterThan(0);
  });

  // The client typed a paragraph. Losing it because a provider was unavailable is the one outcome
  // worth avoiding entirely -- previously every topic but 'goal' discarded it outright.
  it('keeps an unparsable reply verbatim so nothing the client said is lost', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider down'));

    await service.takeTurn(subject, { reply: 'Dispatchers book slots, drivers confirm arrival', topicId: 'users' });

    expect(payload.unparsedReplies?.users).toBe('Dispatchers book slots, drivers confirm arrival');
  });

  it('walks to the end even when nothing can be parsed at all', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider down'));

    let turn = await service.takeTurn(subject);
    const asked: string[] = [];
    // Bounded so a regression fails as a wrong assertion rather than hanging the suite.
    for (let guard = 0; guard < 10 && !turn.done; guard += 1) {
      asked.push(turn.topicId!);
      turn = await service.takeTurn(subject, { reply: `answer for ${turn.topicId}`, topicId: turn.topicId! });
    }

    expect(turn.done).toBe(true);
    expect(asked).toEqual(['goal', 'users', 'musthaves', 'boundaries']);
  });

  // Otherwise the brief shows the same answer twice -- once structured, once raw -- implying the
  // structured one was never understood.
  it('drops the verbatim copy once the same topic parses successfully', async () => {
    llm.generateJson.mockRejectedValue(new Error('provider down'));
    await service.takeTurn(subject, { reply: 'Dispatchers book slots', topicId: 'users' });
    expect(payload.unparsedReplies?.users).toBeTruthy();

    respondWith({ roles: [{ name: 'Dispatcher', responsibilities: ['Books slots'] }] });
    await service.takeTurn(subject, { reply: 'Dispatchers book slots', topicId: 'users' });

    expect(payload.unparsedReplies?.users).toBeUndefined();
    expect(payload.roles[0].name).toBe('Dispatcher');
  });

  it('refuses a reply that names no topic, rather than guessing where it belongs', async () => {
    await expect(
      service.takeTurn(subject, { reply: 'Something' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // A client who arrives with a drafted brief should not be re-asked what it already answers.
  it('skips topics the brief already covers', async () => {
    payload.overview.businessGoal = 'Stop phone bookings';
    payload.overview.successMeasures = ['80% online'];
    payload.roles = [{ name: 'Dispatcher', responsibilities: ['Books slots'], permissions: [] }];

    const turn = await service.takeTurn(subject);

    expect(turn.topicId).toBe('musthaves');
    expect(turn.answeredCount).toBe(2);
  });

  it('returns the brief with every turn so it can be watched filling in', async () => {
    respondWith({ businessGoal: 'Stop phone bookings', successMeasures: ['80% online'] });

    const turn = await service.takeTurn(subject, { reply: 'Stop phone bookings', topicId: 'goal' });

    expect(turn.payload.overview.businessGoal).toBe('Stop phone bookings');
  });
});

/**
 * The lead-backed subject. This is the one that inverts the old order: the client fills the brief in
 * before anybody approves them, rather than after a project manager has already said yes.
 */
describe('IntakeInterviewService.forInquiry', () => {
  const inquiryRow = (over: Record<string, unknown> = {}) => ({
    id: 'inquiry-1',
    status: InquiryStatus.DRAFT,
    payload: null,
    companyName: 'Acme Co',
    brief: 'We need online depot bookings',
    ...over,
  });

  const makeService = (prisma: unknown) =>
    new IntakeInterviewService(
      {} as unknown as IntakeService,
      { generateJson: vi.fn() } as unknown as AgentLlmRouter,
      prisma as unknown as PrismaService,
    );

  it('seeds an untouched lead from what the client first typed', async () => {
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(inquiryRow()), update: vi.fn() } };

    const loaded = await makeService(prisma).forInquiry('inquiry-1', clientUser).load();

    // The agent opens already knowing roughly what this is about, rather than asking them to
    // repeat the sentence they just wrote.
    expect(loaded.overview.businessGoal).toBe('We need online depot bookings');
    expect(loaded.overview.primaryContact).toBe(clientUser.email);
  });

  it('returns the saved brief once the conversation has started', async () => {
    const saved = blank();
    saved.overview.businessGoal = 'Stop phone bookings';
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(inquiryRow({ payload: saved })), update: vi.fn() } };

    const loaded = await makeService(prisma).forInquiry('inquiry-1', clientUser).load();

    expect(loaded.overview.businessGoal).toBe('Stop phone bookings');
  });

  // The id is in the URL, so this is the whole boundary between one client's request and another's.
  it('refuses a lead belonging to somebody else', async () => {
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() } };

    await expect(
      makeService(prisma).forInquiry('someone-elses', clientUser).load(),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes the lookup to the signed-in client email', async () => {
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(inquiryRow()), update: vi.fn() } };

    await makeService(prisma).forInquiry('inquiry-1', clientUser).load();

    expect(prisma.clientInquiry.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inquiry-1', email: { equals: clientUser.email, mode: 'insensitive' } },
    }));
  });

  it('saves answers back onto the lead', async () => {
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(inquiryRow()), update: vi.fn() } };
    const next = blank();
    next.overview.businessGoal = 'Stop phone bookings';

    await makeService(prisma).forInquiry('inquiry-1', clientUser).save(next);

    expect(prisma.clientInquiry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inquiry-1' },
      data: expect.objectContaining({ payload: next }),
    }));
  });

  // Sending the request is what ends the conversation. From NEW onwards a project manager is
  // reading it, and a brief that rewrites itself under somebody mid-review is worse than one that
  // cannot be corrected.
  it.each([
    [InquiryStatus.NEW],
    [InquiryStatus.IN_DISCOVERY],
    [InquiryStatus.APPROVED],
    [InquiryStatus.REJECTED],
  ])('refuses to change a lead that is already %s', async (status) => {
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(inquiryRow({ status })), update: vi.fn() } };

    await expect(
      makeService(prisma).forInquiry('inquiry-1', clientUser).save(blank()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.clientInquiry.update).not.toHaveBeenCalled();
  });

  it('still loads a request that has been sent, so the client can read back what they asked for', async () => {
    const sent = blank();
    sent.overview.businessGoal = 'Stop phone bookings';
    const prisma = { clientInquiry: { findFirst: vi.fn().mockResolvedValue(inquiryRow({ status: InquiryStatus.NEW, payload: sent })), update: vi.fn() } };

    const loaded = await makeService(prisma).forInquiry('inquiry-1', clientUser).load();

    expect(loaded.overview.businessGoal).toBe('Stop phone bookings');
  });

  // No project exists yet, so there is nothing to correlate model spend against.
  it('carries no projectId', () => {
    const prisma = { clientInquiry: { findFirst: vi.fn(), update: vi.fn() } };

    expect(makeService(prisma).forInquiry('inquiry-1', clientUser).projectId).toBeUndefined();
  });
});
