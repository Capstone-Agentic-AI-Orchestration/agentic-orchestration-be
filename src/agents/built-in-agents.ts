import {
  ARCHITECTURE_AGENT_SYSTEM,
  BACKEND_AGENT_SYSTEM,
  CONTRACT_NEGOTIATOR_SYSTEM,
  DATABASE_AGENT_SYSTEM,
  FRONTEND_AGENT_SYSTEM,
  MOBILE_AGENT_SYSTEM,
  REQUIREMENTS_PARSER_SYSTEM,
} from '../orchestration/prompts/agent-prompts';

/**
 * The agents the orchestration ships with.
 *
 * This is the seed source for a workspace's roster and the fallback for an agent whose
 * `instructions` are null. `builtInPrompt` points at the compiled-in system prompt so an
 * unedited agent always reflects the current package rather than a copy frozen at seed time.
 *
 * Cross-checked against three places rather than assumed:
 *  - `agentic-orchestration-ag/agent/subagents/<key>/agent.ts` for the description and tools,
 *  - `src/orchestration/nodes/*` for which node dispatches the key (`subagent: '<key>'`),
 *  - `src/orchestration/graph/agent-plan.ts` for the plan key that switches the agent on.
 */

export type BuiltInAgentStage = 'plan' | 'build' | 'review';

export interface BuiltInAgent {
  /** Dispatch identity. Matches `subagent: '<key>'` in the orchestration nodes. */
  key: string;
  name: string;
  description: string;
  avatarEmoji: string;
  stage: BuiltInAgentStage;
  /** Pipeline node this agent executes as. */
  node?: string;
  /** Set when a node named after something else dispatches this agent. */
  dispatchedBy?: string;
  /** The `PlannedAgent` key that switches it on. Absent means it always runs. */
  plannedAs?: string;
  /** Tool files in the subagent's `tools/` directory. Facts, not configuration. */
  tools: string[];
  /** Extra gating beyond the plan. */
  condition?: string;
  /**
   * The compiled-in system prompt, used when `instructions` is null. Absent for agents whose
   * node builds its prompt inline rather than from a named constant.
   */
  builtInPrompt?: string;
}

const REPO_TOOLS = ['list-repo-files', 'read-repo-file', 'write-repo-files', 'typecheck'];

export const BUILT_IN_AGENTS: BuiltInAgent[] = [
  {
    key: 'requirements-parser',
    name: 'Requirements parser',
    description: 'Analyzes a project brief and produces a structured RequirementsDocument.',
    avatarEmoji: '🧭',
    stage: 'plan',
    node: 'parse_requirements',
    tools: [],
    builtInPrompt: REQUIREMENTS_PARSER_SYSTEM,
  },
  {
    key: 'planner-orchestrator',
    name: 'Planner / orchestrator',
    description: 'Locks the delivery contract and selects the bounded specialist team before Gate 1.',
    avatarEmoji: '🗺️',
    stage: 'plan',
    node: 'negotiate_contract',
    dispatchedBy: 'negotiate_contract',
    tools: [],
    builtInPrompt: CONTRACT_NEGOTIATOR_SYSTEM,
  },
  {
    key: 'contract-negotiator',
    name: 'Contract negotiator',
    description: 'Produces a detailed, locked ProjectContract from a RequirementsDocument.',
    avatarEmoji: '📜',
    stage: 'plan',
    node: 'negotiate_contract',
    tools: [],
    builtInPrompt: CONTRACT_NEGOTIATOR_SYSTEM,
  },
  {
    key: 'architecture',
    name: 'Architecture',
    description: 'Generates comprehensive architecture/system documentation from a DevFlow contract.',
    avatarEmoji: '🏛️',
    stage: 'build',
    node: 'architecture_agent',
    plannedAs: 'architecture',
    tools: REPO_TOOLS,
    builtInPrompt: ARCHITECTURE_AGENT_SYSTEM,
  },
  {
    key: 'frontend',
    name: 'Frontend',
    description: 'Generates production-quality React/Next.js + TypeScript frontend files from a DevFlow contract.',
    avatarEmoji: '🎨',
    stage: 'build',
    node: 'frontend_agent',
    plannedAs: 'frontend',
    tools: REPO_TOOLS,
    builtInPrompt: FRONTEND_AGENT_SYSTEM,
  },
  {
    key: 'backend',
    name: 'Backend',
    description: 'Generates production-quality NestJS/TypeScript backend files from an orchestration contract.',
    avatarEmoji: '⚙️',
    stage: 'build',
    node: 'backend_agent',
    plannedAs: 'backend',
    tools: REPO_TOOLS,
    builtInPrompt: BACKEND_AGENT_SYSTEM,
  },
  {
    key: 'database',
    name: 'Database',
    description: 'Generates production-quality Prisma schemas and SQL migrations from a DevFlow contract.',
    avatarEmoji: '🗄️',
    stage: 'build',
    node: 'database_agent',
    plannedAs: 'database',
    tools: REPO_TOOLS,
    builtInPrompt: DATABASE_AGENT_SYSTEM,
  },
  {
    key: 'mobile',
    name: 'Mobile',
    description: 'Generates production-quality React Native/Expo files from an orchestration contract.',
    avatarEmoji: '📱',
    stage: 'build',
    node: 'mobile_agent',
    plannedAs: 'mobile',
    tools: REPO_TOOLS,
    condition: 'Also requires the project to have a mobile repository',
    builtInPrompt: MOBILE_AGENT_SYSTEM,
  },
  {
    key: 'qa',
    name: 'QA',
    description: 'Independently reviews acceptance coverage, testability, edge cases, and build risk.',
    avatarEmoji: '🔍',
    stage: 'review',
    node: 'qa_review',
    plannedAs: 'qa',
    tools: [],
  },
  {
    key: 'integration-reviewer',
    name: 'Integration reviewer',
    description: 'Reviews joined specialist outputs for cross-domain contract and ownership mismatches.',
    avatarEmoji: '🔗',
    stage: 'review',
    node: 'self_critique',
    dispatchedBy: 'self_critique',
    plannedAs: 'integration',
    tools: [],
  },
  {
    key: 'security-review',
    name: 'Security review',
    description: 'Conditionally reviews sensitive scopes for concrete implementation security risks.',
    avatarEmoji: '🛡️',
    stage: 'review',
    node: 'security_review',
    plannedAs: 'security',
    tools: [],
  },
  {
    key: 'self-critique',
    name: 'Self-critique',
    description: 'Reviews generated artifacts against the contract and returns quality feedback.',
    avatarEmoji: '🪞',
    stage: 'review',
    tools: [],
    condition: 'Defined in the agent package but not dispatched by any node today',
  },
];

export const BUILT_IN_AGENTS_BY_KEY = new Map(BUILT_IN_AGENTS.map((agent) => [agent.key, agent]));

/**
 * The role-neutral runtimes a custom agent can borrow.
 *
 * Capability is a closed set because it is executable code: a tool runs in a sandbox with
 * repository write access, so "create a tool" can never be a console feature. A workspace picks
 * one of these and supplies the role as text.
 *
 * Names must match directories in `agentic-orchestration-ag/agent/subagents/`. They are authored
 * but NOT yet deployed — see docs/operations/what-you-need-to-do.md.
 */
export const GENERIC_RUNTIMES = [
  {
    key: 'generic-builder',
    label: 'Builder',
    summary: 'Repository access and a typecheck self-repair loop. For agents that write code.',
    tools: REPO_TOOLS,
  },
  {
    key: 'generic-reviewer',
    label: 'Reviewer',
    summary: 'Reasoning only, no repository access. For agents that inspect and report.',
    tools: [] as string[],
  },
] as const;

export type GenericRuntimeKey = (typeof GENERIC_RUNTIMES)[number]['key'];

/**
 * The Eve subagent that actually executes an agent.
 *
 * Null `runtimeKey` means "same as key", which is how every built-in row behaves and why the
 * column needed no backfill.
 */
export function resolveRuntimeKey(agent: { key: string; runtimeKey: string | null }): string {
  return agent.runtimeKey?.trim() || agent.key;
}

export function builtInPromptFor(key: string): string | undefined {
  return BUILT_IN_AGENTS_BY_KEY.get(key)?.builtInPrompt;
}
