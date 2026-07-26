import type { DevFlowStateType, RetryDirective } from './devflow.state';

/**
 * Declarative DevFlow pipeline topology.
 *
 * Eve migration: routing decisions previously returned LangGraph `Send[]` fan-out objects.
 * LangGraph has been removed; the routers now return plain node-name lists / directives that
 * the OrchestrationSequencer executes (in parallel via Promise.all for fan-out). The routers
 * remain pure and unit-tested in isolation.
 */

export const NODE = {
  PARSE_REQUIREMENTS: 'parse_requirements',
  NEGOTIATE_CONTRACT: 'negotiate_contract',
  GATE_1_CHECK: 'gate_1_check',
  FRONTEND_AGENT: 'frontend_agent',
  MOBILE_AGENT: 'mobile_agent',
  BACKEND_AGENT: 'backend_agent',
  DATABASE_AGENT: 'database_agent',
  ARCHITECTURE_AGENT: 'architecture_agent',
  QA_REVIEW: 'qa_review',
  SELF_CRITIQUE: 'self_critique',
  SECURITY_REVIEW: 'security_review',
  VALIDATE_OUTPUTS: 'validate_outputs',
  EXECUTION_VALIDATE_OUTPUTS: 'execution_validate_outputs',
  GATE_2_CHECK: 'gate_2_check',
  COMMIT_TO_GITHUB: 'commit_to_github',
  MARK_DELIVERED: 'mark_delivered',
  MARK_FAILED: 'mark_failed',
} as const;

export type NodeName = (typeof NODE)[keyof typeof NODE];

/**
 * Code-gen agents dispatched in parallel after Gate 1 and joined at validate_outputs via the
 * artifacts merge reducer. Single source of truth for both the Gate 1 fan-out and the
 * validator retry map.
 */
export const CODE_AGENTS = [
  NODE.FRONTEND_AGENT,
  NODE.BACKEND_AGENT,
  NODE.DATABASE_AGENT,
] as const;

/** Every code agent that can exist in a run, including the opt-in mobile agent. */
export const ALL_CODE_AGENTS = [...CODE_AGENTS, NODE.MOBILE_AGENT] as const;

export type CodeAgentNode = (typeof ALL_CODE_AGENTS)[number];

/**
 * The code agents to dispatch for a given run. Mobile is opt-in: it only joins the fan-out when
 * the project actually has a MOBILE repository, so backend+frontend projects never spend tokens
 * generating React Native code that would have nowhere to be committed.
 */
export function codeAgentsFor(state: DevFlowStateType): readonly CodeAgentNode[] {
  const planned = state.contract?.agentPlan?.activeAgents;
  if (!planned?.length) return state.hasMobileRepo ? ALL_CODE_AGENTS : CODE_AGENTS;
  const nodes = [
    ...(planned.includes('frontend') ? [NODE.FRONTEND_AGENT] : []),
    ...(planned.includes('backend') ? [NODE.BACKEND_AGENT] : []),
    ...(planned.includes('database') ? [NODE.DATABASE_AGENT] : []),
    ...(planned.includes('mobile') && state.hasMobileRepo ? [NODE.MOBILE_AGENT] : []),
  ];
  return nodes.length ? nodes : CODE_AGENTS;
}

/** Maps a retry directive's agent type to the agent node to re-run. */
export const RETRY_HINT_TO_NODE: Record<string, NodeName> = {
  frontend: NODE.FRONTEND_AGENT,
  mobile: NODE.MOBILE_AGENT,
  backend: NODE.BACKEND_AGENT,
  database: NODE.DATABASE_AGENT,
  architecture: NODE.ARCHITECTURE_AGENT,
};

/** A node to run plus the state overrides it should receive (e.g. scoped validation feedback). */
export interface FanoutTarget {
  node: NodeName;
  patch?: Partial<DevFlowStateType>;
}

// ─── Pure routers (unit-tested directly) ───────────────────────────────────────

/**
 * After Gate 1: a pre-codegen error routes to the terminal failure node; otherwise fan out in
 * parallel to every code agent. Returns `MARK_FAILED` or a list of fan-out targets.
 */
export function gate1Router(state: DevFlowStateType): NodeName | FanoutTarget[] {
  if (state.error) return NODE.MARK_FAILED;
  return codeAgentsFor(state).map((node) => ({ node }));
}

/**
 * After validation: a non-empty retry plan fans out in parallel to every agent that needs to
 * re-run, each receiving the validation feedback scoped to its own failures (unknown agent
 * types restart at frontend). An empty plan proceeds to Gate 2.
 */
export function validatorRouter(state: DevFlowStateType): NodeName | FanoutTarget[] {
  const plan = state.retryPlan ?? [];
  if (plan.length > 0) {
    return plan.map((directive: RetryDirective) => ({
      node: RETRY_HINT_TO_NODE[directive.agentType] ?? NODE.FRONTEND_AGENT,
      patch: { validationFeedback: directive.feedback },
    }));
  }
  return NODE.GATE_2_CHECK;
}

/**
 * After Gate 2: any error is terminal and routes to the failure node, otherwise commit.
 */
export function gate2Router(state: DevFlowStateType): NodeName {
  return state.error != null ? NODE.MARK_FAILED : NODE.COMMIT_TO_GITHUB;
}

// ─── Per-node provider selection (extension point) ──────────────────────────────

export interface NodeProviderSelector {
  provider?: string;
  model?: string;
}

/**
 * Resolves an optional per-node provider/model override. Configure via the
 * `NODE_PROVIDER_OVERRIDES` env var (JSON map keyed by node name). Returns null when no
 * override applies — callers fall back to the global provider/model.
 */
export function resolveNodeProvider(nodeName: string): NodeProviderSelector | null {
  const raw = process.env.NODE_PROVIDER_OVERRIDES;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, NodeProviderSelector>;
    const selector = map[nodeName];
    return selector && typeof selector === 'object' ? selector : null;
  } catch {
    return null;
  }
}
