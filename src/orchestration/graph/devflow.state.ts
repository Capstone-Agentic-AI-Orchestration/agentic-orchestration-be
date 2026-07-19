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

export type AgentDomainContractKind =
  | 'frontend-design'
  | 'output-structure'
  | 'backend-api'
  | 'database-model'
  | 'architecture-review';

export interface AgentDomainContract {
  kind: AgentDomainContractKind;
  version: 'v1';
  summary: string;
}

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

export interface ExecutionValidationCheck {
  name: string;
  agentType: RetryDirective['agentType'];
  status: 'passed' | 'failed' | 'skipped';
  command?: string;
  durationMs: number;
  summary: string;
  outputTail?: string;
}

export interface ExecutionValidationReport {
  valid: boolean;
  checkedAt: string;
  checks: ExecutionValidationCheck[];
  retryPlan?: RetryDirective[];
}

export interface DesignGuidance {
  theme: 'black' | 'light' | 'system';
  productFeel: 'enterprise' | 'playful' | 'editorial' | 'luxury' | 'operational';
  layoutDensity: 'compact' | 'balanced' | 'spacious';
  accessibilityLevel: 'standard' | 'strict';
  forbiddenPatterns: string[];
  notes?: string;
  designSystem?: DesignSystemContract;
}

export interface DesignSystemContract {
  presetId: string;
  palette: string;
  typography: string;
  spacing: string;
  layout: string;
  components: string;
  motion: string;
  voice: string;
  brand: string;
  antiPatterns: string[];
}

export type DesignGuidanceInput = Partial<Omit<DesignGuidance, 'designSystem'>> & {
  designSystem?: Partial<DesignSystemContract> | null;
};

export interface GeneratedArtifact {
  agentType: CodeAgentType;
  filePath: string;
  content: string;
  language: string;
  source?: ArtifactSource;
  domainContract?: AgentDomainContract;
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
  /** Runtime/build validation report for materialized generated artifacts. */
  executionValidation: ExecutionValidationReport | null;
  /** PM-selected frontend design contract, carried through prompts and validation. */
  designGuidance: DesignGuidance;
}

export const DEFAULT_DESIGN_SYSTEM: DesignSystemContract = {
  presetId: 'devflow-black-ops',
  palette:
    'Black operational cockpit: near-black canvas, graphite panels, white primary text, muted blue actions, amber warnings, green success states.',
  typography:
    'System sans UI, compact hierarchy, clear labels, tabular numbers for operational data, no decorative display fonts.',
  spacing:
    'Balanced 8px grid with compact controls, generous row hit areas, and stable panel dimensions.',
  layout:
    'Dense dashboard layouts with side navigation, task panels, timelines, tables, and approval surfaces. Avoid marketing hero composition.',
  components:
    'Tables, timelines, cards, tabs, segmented controls, forms, status badges, approval panels, and command/tool buttons.',
  motion:
    'Subtle feedback only: hover, focus, progress, loading, and state transitions. Avoid ornamental motion.',
  voice:
    'Clear PM/operator language with concise labels, explicit states, and no hype copy.',
  brand:
    'DevFlow black theme: technical, reliable, agent-orchestration aware, and built for repeated project delivery.',
  antiPatterns: [
    'generic marketing hero',
    'gradient orb',
    'placeholder UI',
    'lorem ipsum',
  ],
};

export const DEFAULT_DESIGN_GUIDANCE: DesignGuidance = {
  theme: 'black',
  productFeel: 'operational',
  layoutDensity: 'balanced',
  accessibilityLevel: 'strict',
  forbiddenPatterns: [],
  designSystem: DEFAULT_DESIGN_SYSTEM,
};

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
    executionValidation: seed.executionValidation ?? null,
    designGuidance: normalizeDesignGuidance(seed.designGuidance),
  };
}

export function normalizeDesignGuidance(
  guidance?: DesignGuidanceInput | null,
): DesignGuidance {
  const designSystem = normalizeDesignSystem(guidance?.designSystem);
  return {
    ...DEFAULT_DESIGN_GUIDANCE,
    ...guidance,
    forbiddenPatterns: Array.isArray(guidance?.forbiddenPatterns)
      ? guidance.forbiddenPatterns
          .map((pattern) => pattern.trim())
          .filter(Boolean)
      : [],
    notes: guidance?.notes?.trim() || undefined,
    designSystem,
  };
}

function normalizeDesignSystem(
  designSystem?: Partial<DesignSystemContract> | null,
): DesignSystemContract {
  const merged = {
    ...DEFAULT_DESIGN_SYSTEM,
    ...designSystem,
  };
  return {
    presetId: cleanDesignText(merged.presetId) || DEFAULT_DESIGN_SYSTEM.presetId,
    palette: cleanDesignText(merged.palette) || DEFAULT_DESIGN_SYSTEM.palette,
    typography: cleanDesignText(merged.typography) || DEFAULT_DESIGN_SYSTEM.typography,
    spacing: cleanDesignText(merged.spacing) || DEFAULT_DESIGN_SYSTEM.spacing,
    layout: cleanDesignText(merged.layout) || DEFAULT_DESIGN_SYSTEM.layout,
    components: cleanDesignText(merged.components) || DEFAULT_DESIGN_SYSTEM.components,
    motion: cleanDesignText(merged.motion) || DEFAULT_DESIGN_SYSTEM.motion,
    voice: cleanDesignText(merged.voice) || DEFAULT_DESIGN_SYSTEM.voice,
    brand: cleanDesignText(merged.brand) || DEFAULT_DESIGN_SYSTEM.brand,
    antiPatterns: Array.isArray(merged.antiPatterns)
      ? merged.antiPatterns.map((pattern) => pattern.trim()).filter(Boolean)
      : [...DEFAULT_DESIGN_SYSTEM.antiPatterns],
  };
}

function cleanDesignText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
