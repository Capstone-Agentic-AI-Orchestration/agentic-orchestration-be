export type IntakeFeaturePriority = 'MUST_HAVE' | 'SHOULD_HAVE' | 'NICE_TO_HAVE';

/**
 * The worksheet steps, in the order a client works through them.
 *
 * Shared by the template, the readiness report and both frontends so the step order exists in
 * one place. `as const` keeps the ids literal, which is what makes IntakeSectionId a union
 * rather than plain string.
 */
export const INTAKE_SECTION_IDS = [
  'overview',
  'roles',
  'features',
  'workflows',
  'data',
  'delivery',
  'documents',
  'review',
] as const;

export type IntakeSectionId = (typeof INTAKE_SECTION_IDS)[number];

/**
 * How much a missing answer actually matters.
 *
 * `blocking` means the agents have nothing to build from — there is no scope without it.
 * `advisory` means the brief is thinner than we would like, which is a judgement for the project
 * manager at lock, not a wall in front of the client.
 *
 * The distinction exists because everything used to be blocking, including decision points and
 * error cases. Those are analyst work, and demanding them from a client before they can submit is
 * what left intakes sitting at "2 of 8 sections complete" indefinitely.
 */
export type IntakeBlockerSeverity = 'blocking' | 'advisory';

/** A missing answer, tagged with the step that would fix it. */
export interface IntakeSectionBlocker {
  section: IntakeSectionId;
  message: string;
  /** Absent on older payloads; treat as 'blocking' so nothing silently loosens. */
  severity?: IntakeBlockerSeverity;
}

export interface ClientIntakePayload {
  overview: {
    projectName: string;
    businessGoal: string;
    successMeasures: string[];
    primaryContact: string;
    approver: string;
    targetLaunch: string;
  };
  roles: Array<{
    name: string;
    responsibilities: string[];
    permissions: string[];
  }>;
  features: Array<{
    title: string;
    purpose: string;
    primaryRole: string;
    priority: IntakeFeaturePriority;
    workflow: string;
    businessRules: string[];
    acceptanceCriteria: string[];
  }>;
  workflows: Array<{
    title: string;
    startCondition: string;
    actor: string;
    steps: string[];
    decisionPoints: string[];
    errorCases: string[];
    outcome: string;
  }>;
  dataAndIntegrations: {
    entities: Array<{ name: string; fields: string[]; accessRules: string[] }>;
    integrations: Array<{ name: string; purpose: string; owner: string }>;
    dataNotApplicable?: boolean;
    integrationsNotApplicable?: boolean;
  };
  experienceAndDelivery: {
    designNotes?: string;
    securityRequirements: string[];
    constraints: string[];
    milestones: string[];
    outOfScope: string[];
    futurePhase: string[];
    documentsNotApplicable?: boolean;
  };
  /**
   * Replies the interview could not turn into structured answers, kept verbatim, keyed by topic.
   *
   * Two failures made this necessary, and both were silent. A reply the model could not parse was
   * discarded outright — the client typed a paragraph and it vanished. Worse, since the agenda
   * decides what to ask next by inspecting this payload, an unparsed topic never became "answered",
   * so the interview asked the same question again on the next turn, and the next. A provider
   * outage turned the conversation into a loop the client could not get out of.
   *
   * So an unparsed reply is recorded here instead. The agenda counts the topic as covered and moves
   * on, and the project manager reads the client's own words rather than a blank section. Parsing
   * the same topic successfully later clears the entry.
   *
   * Optional because every payload written before this existed lacks it.
   */
  unparsedReplies?: Partial<Record<IntakeInterviewTopicId, string>>;
}

export interface IntakeEvidence {
  documentId: string;
  documentVersion: number;
  title: string;
  kind: string;
  sha256: string;
  locator?: string;
  extractedText: string;
}

export interface IntakeContextPackage {
  schemaVersion: 'intake-context-v1';
  projectId: string;
  intakeSnapshotId: string;
  intakeVersion: number;
  canonicalBrief: string;
  clientRequirements: ClientIntakePayload;
  pmNotes: string;
  sources: IntakeEvidence[];
}

export interface RequirementEvidence {
  documentId: string;
  locator?: string;
  supports: string;
}

export function emptyClientIntakePayload(input: {
  projectName: string;
  companyName: string;
  brief: string;
  primaryContact?: string | null;
}): ClientIntakePayload {
  return {
    overview: {
      projectName: input.projectName || input.companyName,
      businessGoal: input.brief || '',
      successMeasures: [],
      primaryContact: input.primaryContact || '',
      approver: '',
      targetLaunch: '',
    },
    roles: [],
    features: [],
    workflows: [],
    dataAndIntegrations: { entities: [], integrations: [], dataNotApplicable: false, integrationsNotApplicable: false },
    experienceAndDelivery: {
      designNotes: '',
      securityRequirements: [],
      constraints: [],
      milestones: [],
      outOfScope: [],
      futurePhase: [],
      documentsNotApplicable: false,
    },
  };
}

/** Where a drafted value came from. Absent entirely when nothing supported the value. */
export type IntakeFieldOrigin = 'stated' | 'inferred';

/**
 * Provenance for a drafted payload, keyed by dotted field path (`overview.businessGoal`,
 * `features.0.title`).
 *
 * The point of tracking this is that a draft and a client's own answer must never look alike. The
 * locked package tells the agents it is authoritative and not to invent beyond it, so a guess the
 * client scrolled past becomes something the build treats as fact. Showing "we inferred this"
 * next to the value is what makes confirming it a decision rather than a formality.
 */
export type IntakeDraftProvenance = Record<
  string,
  { origin: IntakeFieldOrigin; documentId?: string }
>;

export interface IntakeDraftResult {
  payload: ClientIntakePayload;
  provenance: IntakeDraftProvenance;
  /** Documents the draft actually read, for "based on: <these files>". */
  sourceDocumentIds: string[];
  usedBrief: boolean;
}

/**
 * The interview agenda, in order. Four topics and no more.
 *
 * Deliberately short of the payload's full field set: acceptance criteria, business rules, decision
 * points, error cases, permissions and data entities are never asked, because a client cannot write
 * them. They are derived and marked assumed.
 */
export type IntakeInterviewTopicId = 'goal' | 'users' | 'musthaves' | 'boundaries';

export interface IntakeInterviewTurn {
  /** True once every topic is answered; `topicId` is then null and `message` is the sign-off. */
  done: boolean;
  topicId: IntakeInterviewTopicId | null;
  /** What the agent says next. Always populated, including on the closing turn. */
  message: string;
  /** The brief as it now stands, so the client can watch it fill in as they talk. */
  payload: ClientIntakePayload;
  answeredCount: number;
  totalCount: number;
}
