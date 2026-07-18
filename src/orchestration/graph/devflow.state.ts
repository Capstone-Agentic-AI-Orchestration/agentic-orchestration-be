// ─── DevFlow run state ────────────────────────────────────────────────────────
//
// Eve migration: this module previously defined the LangGraph `Annotation.Root` state
// schema. LangGraph has been removed; the state is now a plain object and the per-field
// "reducers" are applied explicitly by the OrchestrationSequencer via {@link applyDevFlowPartial}.
// The domain types and the artifact-merge reducer are unchanged, so node implementations and
// the output-validation layer need no changes.

// ─── Domain Types ─────────────────────────────────────────────────────────────

import type { IntakeContextPackage, RequirementEvidence } from '../../intake/intake.types';

export interface TechStack {
  frontend: string;
  backend: string;
  database: string;
  styling: string;
  /** Only present for projects provisioned with a mobile repository. */
  mobile?: string;
}

export interface RequirementsDocument {
  projectType: string;
  features: string[];
  techStack: TechStack;
  complexity: 'simple' | 'medium' | 'complex';
  estimatedFiles: number;
  assumptions?: string[];
  openQuestions?: string[];
  evidence?: RequirementEvidence[];
}

export interface ProjectContract {
  projectId: string;
  projectName: string;
  description: string;
  requirements: RequirementsDocument;
  fileManifest: string[];
  acceptanceCriteria: string[];
  lockedAt: string;
}

export type ArtifactSource = 'llm' | 'scaffold' | 'skip' | 'mock';

/**
 * A single agent's retry instruction emitted by the validator: which code agent
 * to re-run and the validation feedback scoped to that agent's own failures.
 */
export interface RetryDirective {
  agentType: CodeAgentType;
  feedback: string;
}

/** The agent kinds that can author artifacts. `mobile` only runs for projects with a mobile repo. */
export type CodeAgentType = 'frontend' | 'backend' | 'database' | 'architecture' | 'mobile';

export interface GeneratedArtifact {
  agentType: CodeAgentType;
  filePath: string;
  content: string;
  language: string;
  source?: ArtifactSource;
}

export function mergeArtifactsByPath(
  existing: GeneratedArtifact[],
  next: GeneratedArtifact[],
): GeneratedArtifact[] {
  const order: string[] = [];
  const artifactsByPath = new Map<string, GeneratedArtifact>();

  for (const artifact of [...existing, ...next]) {
    if (!artifactsByPath.has(artifact.filePath)) {
      order.push(artifact.filePath);
    }
    artifactsByPath.set(artifact.filePath, artifact);
  }

  return order
    .map((filePath) => artifactsByPath.get(filePath))
    .filter((artifact): artifact is GeneratedArtifact => Boolean(artifact));
}

// ─── Run state ────────────────────────────────────────────────────────────────

export interface DevFlowStateType {
  projectId: string;
  runId: string;
  brief: string;
  stackKey: string;
  companyName: string;
  intakeContext: IntakeContextPackage | null;
  requirements: RequirementsDocument | null;
  contract: ProjectContract | null;
  artifacts: GeneratedArtifact[];
  gate1Approved: boolean;
  gate2Approved: boolean;
  gate1Notes: string;
  gate2Notes: string;
  retryCount: number;
  repoUrl: string | null;
  /**
   * Top-level complexity derived from the parsed requirements. Drives the conditional
   * code-generation fan-out: 'complex' → parallel; 'simple' | 'medium' → sequential.
   */
  complexity: 'simple' | 'medium' | 'complex' | null;
  error: string | null;
  validationFeedback: string | null;
  /**
   * Agents the validator wants to re-run, each with feedback scoped to its own failures.
   * A non-empty plan drives a retry fan-out from validate_outputs; empty means validation
   * passed or exhausted its retry budget.
   */
  retryPlan: RetryDirective[];
  /**
   * Cross-agent contract summary extracted from backend/database artifacts, injected into
   * frontend/architecture agents.
   */
  contractSummary: string;
  /** Self-critique feedback from the review node, addressed before formal validation. */
  selfCritique: string;
  requirementsAssumptions: string[];
  openQuestions: string[];
  requirementsEvidence: RequirementEvidence[];
  /**
   * Whether this project was provisioned with a MOBILE repository. The mobile agent is opt-in
   * per project (the PM chooses it at creation), so the Gate 1 fan-out only dispatches it when
   * there is a repo to commit its output to — a 2-repo project never pays for mobile tokens.
   */
  hasMobileRepo: boolean;
  /**
   * Capability token letting the external agent service read/write this project's repositories
   * for the duration of the run. Null when repository access is disabled, in which case agents
   * generate from the contract alone. Scope is resolved server-side from this token.
   */
  repoToken: string | null;
  /** Branch every agent write and the final delivery commit land on. Never the default branch. */
  repoBranch: string | null;
}

/** Field defaults — the explicit equivalent of the old Annotation `default` factories. */
export function createInitialDevFlowState(
  seed: Partial<DevFlowStateType> & Pick<DevFlowStateType, 'projectId' | 'runId'>,
): DevFlowStateType {
  return {
    projectId: seed.projectId,
    runId: seed.runId,
    brief: seed.brief ?? '',
    stackKey: seed.stackKey ?? '',
    companyName: seed.companyName ?? '',
    intakeContext: seed.intakeContext ?? null,
    requirements: seed.requirements ?? null,
    contract: seed.contract ?? null,
    artifacts: seed.artifacts ?? [],
    gate1Approved: seed.gate1Approved ?? false,
    gate2Approved: seed.gate2Approved ?? false,
    gate1Notes: seed.gate1Notes ?? '',
    gate2Notes: seed.gate2Notes ?? '',
    retryCount: seed.retryCount ?? 0,
    repoUrl: seed.repoUrl ?? null,
    complexity: seed.complexity ?? null,
    error: seed.error ?? null,
    validationFeedback: seed.validationFeedback ?? null,
    retryPlan: seed.retryPlan ?? [],
    contractSummary: seed.contractSummary ?? '',
    selfCritique: seed.selfCritique ?? '',
    requirementsAssumptions: seed.requirementsAssumptions ?? [],
    openQuestions: seed.openQuestions ?? [],
    requirementsEvidence: seed.requirementsEvidence ?? [],
    hasMobileRepo: seed.hasMobileRepo ?? false,
    repoToken: seed.repoToken ?? null,
    repoBranch: seed.repoBranch ?? null,
  };
}

/**
 * Applies a node's partial result onto the running state — the explicit equivalent of the old
 * Annotation reducers. Every channel is last-write-wins EXCEPT `artifacts`, which accumulates
 * via {@link mergeArtifactsByPath} (matching the old append reducer that joined the parallel
 * code-agent fan-out).
 */
export function applyDevFlowPartial(
  state: DevFlowStateType,
  partial: Partial<DevFlowStateType> | null | undefined,
): DevFlowStateType {
  if (!partial) return state;
  const next: DevFlowStateType = { ...state };
  for (const [key, value] of Object.entries(partial) as [keyof DevFlowStateType, unknown][]) {
    if (value === undefined) continue;
    if (key === 'artifacts') {
      next.artifacts = mergeArtifactsByPath(state.artifacts, value as GeneratedArtifact[]);
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}
