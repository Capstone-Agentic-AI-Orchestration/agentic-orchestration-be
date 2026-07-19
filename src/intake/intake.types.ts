export type IntakeFeaturePriority = 'MUST_HAVE' | 'SHOULD_HAVE' | 'NICE_TO_HAVE';

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
