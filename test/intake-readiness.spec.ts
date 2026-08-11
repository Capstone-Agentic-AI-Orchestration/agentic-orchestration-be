import { describe, expect, it } from 'vitest';
import { IntakeService } from '../src/intake/intake.service';
import {
  emptyClientIntakePayload,
  type ClientIntakePayload,
} from '../src/intake/intake.types';

/**
 * Readiness is derived from the payload alone, so these drive the private rule set through a bare
 * instance rather than standing up Prisma. `readinessFor` is what both frontends and the submit and
 * lock guards all read, so its severity split is the contract worth pinning down.
 */
const readiness = (
  payload: ClientIntakePayload,
  documents: Array<{ storageKey: string | null; extraction: { status: string } | null }> = [],
) =>
  (
    new IntakeService(
      null as never,
      null as never,
      null as never,
      null as never,
    ) as unknown as {
      readinessFor: (
        payload: ClientIntakePayload,
        documents: unknown[],
      ) => {
        blockers: string[];
        suggestions: string[];
        readyForSubmission: boolean;
        readyForLock: boolean;
        sections: Array<{ section: string; complete: boolean; blocking: string[]; advisory: string[] }>;
      };
    }
  ).readinessFor(payload, documents);

const base = () =>
  emptyClientIntakePayload({ projectName: 'Depot booking', companyName: 'Acme', brief: 'Book depot slots' });

/** The least a client can say that still describes something buildable. */
function minimalViable(): ClientIntakePayload {
  const payload = base();
  payload.overview.businessGoal = 'Stop taking depot bookings by phone';
  payload.features = [{
    title: 'Slot booking',
    purpose: 'Let dispatchers book a depot slot themselves',
    primaryRole: '',
    priority: 'MUST_HAVE',
    workflow: '',
    businessRules: [],
    acceptanceCriteria: [],
  }];
  return payload;
}

describe('intake readiness severity', () => {
  // The whole point of the change: a client who has said what to build and why can submit, without
  // first producing decision points and error cases they are in no position to write.
  it('lets a goal and one must-have feature through', () => {
    const result = readiness(minimalViable());

    expect(result.blockers).toEqual([]);
    expect(result.readyForSubmission).toBe(true);
    expect(result.readyForLock).toBe(true);
  });

  it('still reports the thin parts as suggestions rather than dropping them', () => {
    const result = readiness(minimalViable());

    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions).toContain('Name the final approver.');
    expect(result.suggestions).toContain('Add at least one measurable success criterion.');
    expect(result.suggestions).toContain('Add how you will know each Must-have works.');
  });

  // Without these there is genuinely nothing to build, and the requirements agent is forbidden from
  // inventing beyond the locked package — so it would produce nothing useful.
  it('blocks on a missing business goal', () => {
    const payload = minimalViable();
    payload.overview.businessGoal = '   ';

    const result = readiness(payload);

    expect(result.blockers).toContain('Describe the business goal.');
    expect(result.readyForSubmission).toBe(false);
  });

  it('blocks when nothing is marked Must-have', () => {
    const payload = minimalViable();
    payload.features = [];

    const result = readiness(payload);

    expect(result.blockers).toContain('Add at least one Must-have feature.');
    expect(result.readyForSubmission).toBe(false);
  });

  it('blocks a Must-have with no purpose, because a title alone is not a requirement', () => {
    const payload = minimalViable();
    payload.features[0].purpose = '';

    const result = readiness(payload);

    expect(result.blockers).toContain('Every Must-have feature needs a title and a purpose.');
  });

  // These four used to stop a client dead. They are analyst work or scheduling detail, and the
  // project manager decides at lock whether the brief is thin enough to matter.
  it.each([
    ['acceptance criteria', (p: ClientIntakePayload) => { p.features[0].acceptanceCriteria = []; }],
    ['permissions', (p: ClientIntakePayload) => { p.roles = [{ name: 'Dispatcher', responsibilities: [], permissions: [] }]; }],
    ['workflow detail', (p: ClientIntakePayload) => { p.workflows = [{ title: 'Booking', startCondition: '', actor: '', steps: [], decisionPoints: [], errorCases: [], outcome: '' }]; }],
    ['a launch date', (p: ClientIntakePayload) => { p.overview.targetLaunch = ''; }],
  ])('does not block on missing %s', (_label, degrade) => {
    const payload = minimalViable();
    degrade(payload);

    expect(readiness(payload).readyForSubmission).toBe(true);
  });

  it('marks a section complete when only advisory items remain', () => {
    const result = readiness(minimalViable());
    const overview = result.sections.find((section) => section.section === 'overview');

    expect(overview?.complete).toBe(true);
    expect(overview?.blocking).toEqual([]);
    expect(overview?.advisory.length).toBeGreaterThan(0);
  });

  // A client who has nothing to attach, or whose upload is still being read, is not a reason to
  // refuse a brief that already says what to build.
  it('treats document gaps as advisory', () => {
    const result = readiness(minimalViable(), [
      { storageKey: 'key-1', extraction: { status: 'EXTRACTING' } },
    ]);

    expect(result.readyForSubmission).toBe(true);
    expect(result.suggestions.some((item) => item.includes('still being processed'))).toBe(true);
  });

  it('reports every blocker at once so a client is not sent back repeatedly', () => {
    // Not `base()`: emptyClientIntakePayload seeds the goal from the project brief, so a payload
    // built that way already clears one of the two blocking rules.
    const empty = emptyClientIntakePayload({ projectName: '', companyName: '', brief: '' });

    const result = readiness(empty);

    expect(result.blockers).toContain('Add a project name.');
    expect(result.blockers).toContain('Describe the business goal.');
    expect(result.blockers).toContain('Add at least one Must-have feature.');
  });

  // The brief a client wrote when they first got in touch is seeded as the goal, which is why an
  // untouched intake is usually one Must-have feature away from submittable rather than nine items.
  it('counts the seeded brief as the business goal', () => {
    const result = readiness(base());

    expect(result.blockers).toEqual(['Add at least one Must-have feature.']);
  });
});
