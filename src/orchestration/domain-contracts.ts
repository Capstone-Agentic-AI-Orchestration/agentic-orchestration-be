import {
  type AgentDomainContractKind,
  type DevFlowStateType,
  type GeneratedArtifact,
} from './graph/devflow.state';
import type { ValidationError } from './output-validation/schemas/schema.types';

const CONTRACT_VERSION = 'v1' as const;
const DOMAIN_CONTRACT_PATHS: Record<AgentDomainContractKind, string> = {
  'frontend-design': 'DESIGN.md',
  'backend-api': 'API_CONTRACT.json',
  'database-model': 'DATA_MODEL.json',
  'architecture-review': 'ARCHITECTURE_REVIEW.md',
};

export function createBackendApiContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const contract = state.contract;
  const resources = resourceNames(contract?.requirements.features ?? []);
  const routes = resources.flatMap((resource) => [
    {
      method: 'GET',
      path: `/api/${resource}`,
      responseDto: `${pascalCase(resource)}ListResponseDto`,
      auth: 'project-default',
      errors: ['400 validation error', '401 unauthorized'],
    },
    {
      method: 'POST',
      path: `/api/${resource}`,
      requestDto: `Create${pascalCase(resource)}Dto`,
      responseDto: `${pascalCase(resource)}ResponseDto`,
      auth: 'project-default',
      errors: ['400 validation error', '401 unauthorized'],
    },
    {
      method: 'PATCH',
      path: `/api/${resource}/:id`,
      requestDto: `Update${pascalCase(resource)}Dto`,
      responseDto: `${pascalCase(resource)}ResponseDto`,
      auth: 'project-default',
      errors: ['400 validation error', '401 unauthorized', '404 not found'],
    },
    {
      method: 'DELETE',
      path: `/api/${resource}/:id`,
      responseDto: 'DeleteResultDto',
      auth: 'project-default',
      errors: ['401 unauthorized', '404 not found'],
    },
  ]);

  return {
    agentType: 'backend',
    filePath: DOMAIN_CONTRACT_PATHS['backend-api'],
    content: stableJson({
      kind: 'backend-api',
      version: CONTRACT_VERSION,
      projectName: contract?.projectName ?? state.companyName,
      source: 'DevFlow domain contract generated from the approved project contract',
      routes,
      dtoNaming: 'Use Create<Resource>Dto, Update<Resource>Dto, <Resource>ResponseDto, and <Resource>ListResponseDto.',
      authPolicy: 'Use the project auth approach implied by the brief. Public routes must be explicitly documented.',
      errorPolicy: 'Use typed HTTP errors with stable response bodies for validation, auth, and not-found failures.',
    }),
    language: 'json',
    source: 'scaffold',
    domainContract: {
      kind: 'backend-api',
      version: CONTRACT_VERSION,
      summary: `${routes.length} API routes for ${resources.join(', ')}`,
    },
  };
}

export function createDatabaseModelContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const contract = state.contract;
  const resources = resourceNames(contract?.requirements.features ?? []);
  const entities = resources.map((resource) => ({
    name: pascalCase(resource),
    tableName: resource.replace(/-/g, '_'),
    fields: [
      { name: 'id', type: 'String', constraints: ['@id', '@default(cuid())'] },
      { name: 'name', type: 'String', constraints: [] },
      { name: 'status', type: 'String', constraints: ['@default("active")'] },
      { name: 'createdAt', type: 'DateTime', constraints: ['@default(now())'] },
      { name: 'updatedAt', type: 'DateTime', constraints: ['@updatedAt'] },
    ],
    indexes: ['status', 'createdAt'],
    relationships: ['Add relations required by the approved features and backend API contract.'],
  }));

  return {
    agentType: 'database',
    filePath: DOMAIN_CONTRACT_PATHS['database-model'],
    content: stableJson({
      kind: 'database-model',
      version: CONTRACT_VERSION,
      projectName: contract?.projectName ?? state.companyName,
      database: contract?.requirements.techStack.database ?? 'postgresql',
      entities,
      migrationPolicy: 'Prisma schema and SQL migration must represent the same entities, fields, indexes, and relations.',
      seedPolicy: 'Seed data must cover each entity with realistic records connected by declared relations.',
    }),
    language: 'json',
    source: 'scaffold',
    domainContract: {
      kind: 'database-model',
      version: CONTRACT_VERSION,
      summary: `${entities.length} data entities for ${resources.join(', ')}`,
    },
  };
}

export function createArchitectureReviewContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const domainContracts = collectDomainContractArtifacts(state.artifacts);
  const contractNames = domainContracts.map((artifact) => artifact.filePath);

  return {
    agentType: 'architecture',
    filePath: DOMAIN_CONTRACT_PATHS['architecture-review'],
    content: [
      '# Architecture Review Contract',
      '',
      `Project: ${state.contract?.projectName ?? state.companyName}`,
      `Version: ${CONTRACT_VERSION}`,
      '',
      '## Source Contracts',
      ...(contractNames.length > 0
        ? contractNames.map((filePath) => `- ${filePath}`)
        : ['- No sibling domain contracts were available before architecture review.']),
      '',
      '## Review Rules',
      '- Verify frontend design, backend API, and database model contracts do not contradict each other.',
      '- Document API routes, DTOs, data entities, relations, deployment needs, and operational risks from generated artifacts.',
      '- Produce ADR-style decisions for the major stack, boundary, data, auth, and deployment choices.',
    ].join('\n'),
    language: 'markdown',
    source: 'scaffold',
    domainContract: {
      kind: 'architecture-review',
      version: CONTRACT_VERSION,
      summary: `Architecture review over ${contractNames.length} domain contracts`,
    },
  };
}

export function collectDomainContractArtifacts(
  artifacts: GeneratedArtifact[],
): GeneratedArtifact[] {
  return (artifacts ?? []).filter((artifact) => isDomainContractPath(artifact.filePath));
}

export function isDomainContractPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toUpperCase();
  return normalized.endsWith('/DESIGN.MD') ||
    normalized === 'DESIGN.MD' ||
    normalized.endsWith('/API_CONTRACT.JSON') ||
    normalized === 'API_CONTRACT.JSON' ||
    normalized.endsWith('/DATA_MODEL.JSON') ||
    normalized === 'DATA_MODEL.JSON' ||
    normalized.endsWith('/DATA_MODEL.MD') ||
    normalized === 'DATA_MODEL.MD' ||
    normalized.endsWith('/ARCHITECTURE_REVIEW.MD') ||
    normalized === 'ARCHITECTURE_REVIEW.MD';
}

export function renderDomainContractContext(
  artifacts: GeneratedArtifact[],
  heading = 'DOMAIN CONTRACTS (authoritative planning artifacts - generated code and docs must conform to these):',
): string {
  const contracts = collectDomainContractArtifacts(artifacts);
  if (contracts.length === 0) return '';
  const lines = [heading];
  for (const artifact of contracts) {
    lines.push(
      '',
      `--- ${artifact.filePath} (${artifact.domainContract?.kind ?? inferKind(artifact.filePath)}) ---`,
      artifact.content.slice(0, 5000),
    );
  }
  return lines.join('\n');
}

export function validateDomainContractArtifacts(
  artifacts: GeneratedArtifact[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const artifact of collectDomainContractArtifacts(artifacts)) {
    const path = artifact.filePath;
    if (/DESIGN\.md$/i.test(path)) {
      errors.push(...requireContent(path, artifact, ['# DESIGN.md', '## Color', '## Components'], 'frontend'));
    } else if (/API_CONTRACT\.json$/i.test(path)) {
      errors.push(...validateJsonContract(path, artifact, ['kind', 'version', 'routes'], 'backend'));
    } else if (/DATA_MODEL\.json$/i.test(path)) {
      errors.push(...validateJsonContract(path, artifact, ['kind', 'version', 'entities'], 'database'));
    } else if (/ARCHITECTURE_REVIEW\.md$/i.test(path)) {
      errors.push(...requireContent(path, artifact, ['Architecture', 'Review'], 'architecture'));
    }
  }
  return errors;
}

export function validateDomainContractDrift(
  artifacts: GeneratedArtifact[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const apiContract = parseJsonArtifact(findArtifact(artifacts, /API_CONTRACT\.json$/i));
  const dataContract = parseJsonArtifact(findArtifact(artifacts, /DATA_MODEL\.json$/i));

  if (apiContract && Array.isArray(apiContract.routes)) {
    const requiredResources = new Set<string>();
    for (const route of apiContract.routes) {
      if (route && typeof route === 'object' && 'path' in route) {
        const resource = firstResourceSegment(String(route.path));
        if (resource) requiredResources.add(resource);
      }
    }

    const backendContent = artifacts
      .filter((artifact) => artifact.agentType === 'backend' && /\.(ts|tsx)$/i.test(artifact.filePath))
      .map((artifact) => artifact.content.toLowerCase())
      .join('\n');

    for (const resource of requiredResources) {
      if (backendContent && !backendContent.includes(resource.toLowerCase())) {
        errors.push({
          code: 'CONTRACT',
          path: 'API_CONTRACT.json',
          agentType: 'backend',
          message: `backend API contract declares resource "${resource}" but backend code does not reference it`,
        });
      }
    }
  }

  if (dataContract && Array.isArray(dataContract.entities)) {
    const schemaContent = artifacts
      .filter((artifact) => artifact.agentType === 'database' && /\.prisma$/i.test(artifact.filePath))
      .map((artifact) => artifact.content)
      .join('\n');

    for (const entity of dataContract.entities) {
      if (!entity || typeof entity !== 'object' || !('name' in entity)) continue;
      const name = String(entity.name);
      if (schemaContent && !new RegExp(`\\bmodel\\s+${escapeRegExp(name)}\\b`).test(schemaContent)) {
        errors.push({
          code: 'CONTRACT',
          path: 'DATA_MODEL.json',
          agentType: 'database',
          message: `database model contract declares entity "${name}" but schema.prisma does not define model ${name}`,
        });
      }
    }
  }

  return errors;
}

function validateJsonContract(
  path: string,
  artifact: GeneratedArtifact,
  requiredKeys: string[],
  agentType: ValidationError['agentType'],
): ValidationError[] {
  const parsed = parseJsonArtifact(artifact);
  if (!parsed) {
    return [{
      code: 'SCHEMA_VIOLATION',
      path,
      agentType,
      message: `${path} must be valid JSON`,
    }];
  }
  return requiredKeys
    .filter((key) => !(key in parsed))
    .map((key) => ({
      code: 'SCHEMA_VIOLATION' as const,
      path,
      agentType,
      message: `${path} is missing required "${key}" domain contract field`,
    }));
}

function requireContent(
  path: string,
  artifact: GeneratedArtifact,
  requiredText: string[],
  agentType: ValidationError['agentType'],
): ValidationError[] {
  return requiredText
    .filter((text) => !artifact.content.includes(text))
    .map((text) => ({
      code: 'SCHEMA_VIOLATION' as const,
      path,
      agentType,
      message: `${path} must include "${text}"`,
    }));
}

function parseJsonArtifact(
  artifact: GeneratedArtifact | undefined,
): Record<string, unknown> | null {
  if (!artifact) return null;
  try {
    const parsed = JSON.parse(artifact.content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function findArtifact(
  artifacts: GeneratedArtifact[],
  pattern: RegExp,
): GeneratedArtifact | undefined {
  return artifacts.find((artifact) => pattern.test(artifact.filePath));
}

function resourceNames(features: string[]): string[] {
  const resources = features
    .map((feature) => slugify(feature))
    .filter(Boolean)
    .slice(0, 4);
  return resources.length > 0 ? resources : ['items'];
}

function firstResourceSegment(path: string): string | null {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && !segment.startsWith(':') && !['api', 'v1', 'v2'].includes(segment))
    [0] ?? null;
}

function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'items';
}

function pascalCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function inferKind(filePath: string): AgentDomainContractKind {
  if (/DESIGN\.md$/i.test(filePath)) return 'frontend-design';
  if (/API_CONTRACT\.json$/i.test(filePath)) return 'backend-api';
  if (/DATA_MODEL\.(json|md)$/i.test(filePath)) return 'database-model';
  return 'architecture-review';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
