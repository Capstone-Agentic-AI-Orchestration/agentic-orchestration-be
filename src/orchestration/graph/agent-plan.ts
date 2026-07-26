import type { RequirementsDocument } from './devflow.state';

export type PlannedAgent =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'mobile'
  | 'architecture'
  | 'qa'
  | 'integration'
  | 'security';

export type PlannedAgentRole = 'implementer' | 'reviewer' | 'documentation';

export interface AgentPlanEntry {
  agent: PlannedAgent;
  role: PlannedAgentRole;
  reason: string;
  ownedPaths: string[];
  dependsOn: PlannedAgent[];
}

export interface AgentPlan {
  version: 'agent-plan-v1';
  createdBy: 'planner-orchestrator';
  activeAgents: PlannedAgent[];
  skippedAgents: Array<{ agent: PlannedAgent; reason: string }>;
  entries: AgentPlanEntry[];
  securityReview: boolean;
}

type ImplementerAgent = 'frontend' | 'backend' | 'database' | 'mobile';

const IMPLEMENTERS: ImplementerAgent[] = ['frontend', 'backend', 'database', 'mobile'];
const ALL_AGENTS: PlannedAgent[] = [
  ...IMPLEMENTERS,
  'architecture',
  'qa',
  'integration',
  'security',
];

const PATH_SIGNALS: Record<Exclude<PlannedAgent, 'qa' | 'integration' | 'security'>, RegExp> = {
  frontend: /(^|\/)(src\/app\/.*(?:page|layout)\.(?:ts|tsx)|src\/features\/|components\/|.*\.(?:tsx|jsx|css|scss)|design\.md$)/i,
  backend: /(^|\/)(src\/main\.ts$|src\/app\.module\.ts$|src\/modules\/|.*(?:controller|service|dto|guard|pipe|interceptor)\.ts$|api_contract\.json$)/i,
  database: /(^|\/)(prisma\/|.*\.(?:prisma|sql)$|data_model\.json$)/i,
  mobile: /(^|\/)(mobile\/|app\/(?:\(tabs\)|_layout)|.*(?:expo|react-native))/i,
  architecture: /(^|\/)(architecture_review\.md|architecture\.md|api\.md|deployment\.md|adrs\.md)$/i,
};

const SECURITY_SIGNAL =
  /\b(auth|oauth|permission|role|security|secret|token|password|payment|billing|card|pii|personal data|upload|file storage|webhook)\b/i;

export function buildAgentPlan(input: {
  fileManifest: string[];
  requirements: RequirementsDocument;
  brief?: string;
  hasMobileRepo: boolean;
}): AgentPlan {
  const paths = input.fileManifest.map((path) => path.replace(/\\/g, '/'));
  const selectedImplementers = IMPLEMENTERS.filter((agent) => {
    if (agent === 'mobile' && !input.hasMobileRepo) return false;
    return paths.some((path) => PATH_SIGNALS[agent].test(path));
  });

  // A malformed or legacy empty manifest must still produce a usable team.
  if (selectedImplementers.length === 0) {
    selectedImplementers.push('frontend', 'backend', 'database');
    if (input.hasMobileRepo) selectedImplementers.push('mobile');
  }

  const wantsArchitecture = paths.some((path) => PATH_SIGNALS.architecture.test(path));
  const securityContext = [
    input.brief,
    input.requirements.projectType,
    ...input.requirements.features,
  ]
    .filter(Boolean)
    .join(' ');
  const securityReview = SECURITY_SIGNAL.test(securityContext);
  const activeAgents: PlannedAgent[] = [
    ...selectedImplementers,
    ...(wantsArchitecture ? ['architecture' as const] : []),
    'qa',
    ...(selectedImplementers.length > 1 ? ['integration' as const] : []),
    ...(securityReview ? ['security' as const] : []),
  ];

  const entries = activeAgents.map((agent): AgentPlanEntry => {
    const ownedPaths = paths.filter((path) =>
      agent === 'qa'
        ? /(?:test|spec|e2e|playwright|vitest|jest)/i.test(path)
        : agent === 'integration' || agent === 'security'
          ? false
          : PATH_SIGNALS[agent].test(path),
    );
    const role: PlannedAgentRole =
      agent === 'architecture'
        ? 'documentation'
        : agent === 'qa' || agent === 'integration' || agent === 'security'
          ? 'reviewer'
          : 'implementer';
    const dependsOn: PlannedAgent[] =
      role === 'implementer'
        ? []
        : agent === 'architecture'
          ? [...selectedImplementers]
          : activeAgents.includes('architecture')
            ? [...selectedImplementers, 'architecture']
            : [...selectedImplementers];
    const reason =
      agent === 'qa'
        ? 'Every implementation receives an independent contract and testability review.'
        : agent === 'integration'
          ? 'Multiple implementation domains must be checked together before validation.'
          : agent === 'security'
            ? 'The scope includes sensitive identity, data, payment, upload, or authorization concerns.'
            : agent === 'architecture'
              ? 'The delivery contract requests architecture or operational documentation.'
              : `The locked file manifest contains ${agent} implementation work.`;
    return { agent, role, reason, ownedPaths, dependsOn };
  });

  return {
    version: 'agent-plan-v1',
    createdBy: 'planner-orchestrator',
    activeAgents,
    skippedAgents: ALL_AGENTS
      .filter((agent) => !activeAgents.includes(agent))
      .map((agent) => ({
        agent,
        reason:
          agent === 'mobile' && !input.hasMobileRepo
            ? 'No mobile repository is attached to this project.'
            : agent === 'security'
              ? 'No sensitive security trigger was detected in the locked scope.'
              : 'The locked manifest does not require this specialist.',
      })),
    entries,
    securityReview,
  };
}
