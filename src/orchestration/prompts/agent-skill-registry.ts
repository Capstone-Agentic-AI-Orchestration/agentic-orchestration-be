export type AgentSkillRole =
  | 'contract'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'architecture';

export interface AgentSkillDefinition {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly roles: readonly AgentSkillRole[];
  readonly summary: string;
  readonly instructions: readonly string[];
}

export const AGENT_SKILL_REGISTRY: readonly AgentSkillDefinition[] = [
  {
    id: 'artifact-contract-obedience',
    version: '1.0.0',
    title: 'Artifact Contract Obedience',
    roles: ['contract', 'frontend', 'backend', 'database', 'architecture'],
    summary: 'Treat the requested JSON shape, file manifest, and acceptance criteria as the output contract.',
    instructions: [
      'Return only the requested JSON shape and include complete file content in every artifact.',
      'Generate only files owned by your role and requested by the manifest or work order.',
      'Keep file paths, public names, routes, DTOs, and model names stable across retries.',
    ],
  },
  {
    id: 'scoped-retry-repair',
    version: '1.0.0',
    title: 'Scoped Retry Repair',
    roles: ['contract', 'frontend', 'backend', 'database', 'architecture'],
    summary: 'Fix failed validation feedback without disturbing artifacts that already passed.',
    instructions: [
      'Read previous validation and self-review feedback as must-fix instructions.',
      'Replace only the failed artifacts for your role unless the feedback explicitly asks for a dependency change.',
      'Preserve compatible contracts with sibling agents when repairing an artifact.',
    ],
  },
  {
    id: 'contract-deliverable-planning',
    version: '1.0.0',
    title: 'Contract Deliverable Planning',
    roles: ['contract'],
    summary: 'Produce manifests and acceptance criteria that downstream agents can execute without guessing.',
    instructions: [
      'List concrete source and documentation files, excluding scaffolded project config.',
      'Prefix acceptance criteria by responsible agent type: frontend, backend, database, or architecture.',
      'Make every criterion verifiable against a route, model, UI state, document section, or integration behavior.',
    ],
  },
  {
    id: 'frontend-api-wiring',
    version: '1.0.0',
    title: 'Frontend API Wiring',
    roles: ['frontend'],
    summary: 'Build UI artifacts that integrate with backend routes and handle real user-facing states.',
    instructions: [
      'Match supplied backend routes, DTO names, response shapes, and error semantics exactly.',
      'Implement loading, empty, error, and success states with accessible controls and semantic markup.',
      'Use typed helpers or local constants for API paths; do not hide fetch logic behind placeholders.',
    ],
  },
  {
    id: 'frontend-design-principles',
    version: '1.0.0',
    title: 'Frontend Design Principles',
    roles: ['frontend'],
    summary: 'Translate the PM design contract into complete, accessible, non-placeholder UI artifacts.',
    instructions: [
      'Default to a black operational interface unless the design contract says otherwise.',
      'Make layout density, product feel, and accessibility level visible through component structure, spacing, contrast, and states.',
      'Do not use forbidden patterns listed in the design contract; replace them with domain-specific, usable UI.',
      'Include loading, empty, error, disabled, and success states when data or actions are present.',
    ],
  },
  {
    id: 'backend-nest-boundaries',
    version: '1.0.0',
    title: 'NestJS Boundary Discipline',
    roles: ['backend'],
    summary: 'Keep NestJS controllers, services, DTOs, and Prisma access cleanly separated.',
    instructions: [
      'Keep controllers thin and move business rules into injectable services.',
      'Validate request bodies before use and return typed DTO-compatible responses.',
      'Use injected PrismaService for persistence and align route names with frontend/API docs.',
    ],
  },
  {
    id: 'database-prisma-integrity',
    version: '1.0.0',
    title: 'Prisma Schema Integrity',
    roles: ['database'],
    summary: 'Generate relational schemas that backend code can query safely and predictably.',
    instructions: [
      'Define both sides of Prisma relations and include indexes for foreign keys, status fields, and timestamps.',
      'Keep Prisma models, SQL DDL, and seed data consistent with the same names and constraints.',
      'Use stable IDs, table maps, defaults, nullability, and cascade behavior deliberately.',
    ],
  },
  {
    id: 'architecture-cross-artifact-docs',
    version: '1.0.0',
    title: 'Cross-Artifact Documentation',
    roles: ['architecture'],
    summary: 'Document the actual generated system, not a generic architecture template.',
    instructions: [
      'Base API docs, diagrams, deployment notes, and tradeoffs on the generated artifacts.',
      'Keep endpoint, DTO, model, environment, and command names synchronized with sibling outputs.',
      'Call out operational assumptions and verification steps that a delivery reviewer can run.',
    ],
  },
] as const;

export function getAgentSkillsForRole(
  role?: AgentSkillRole,
): readonly AgentSkillDefinition[] {
  if (!role) return [];
  return AGENT_SKILL_REGISTRY.filter((skill) => skill.roles.includes(role));
}

export function renderAgentSkillPack(role?: AgentSkillRole): string {
  const skills = getAgentSkillsForRole(role);
  if (skills.length === 0) return '';

  const lines = [
    'ACTIVE AGENT SKILLS (built-in role guidance; apply before project memory):',
  ];

  for (const skill of skills) {
    lines.push(
      `[${skill.id}@${skill.version}] ${skill.title}: ${skill.summary}`,
      ...skill.instructions.map((instruction) => `- ${instruction}`),
    );
  }

  return lines.join('\n');
}
