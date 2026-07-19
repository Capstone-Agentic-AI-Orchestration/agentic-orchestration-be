import {
  type AgentDomainContractKind,
  type DevFlowStateType,
  type GeneratedArtifact,
} from './graph/devflow.state';
import type { ValidationError } from './output-validation/schemas/schema.types';

const CONTRACT_VERSION = 'v1' as const;
const DOMAIN_CONTRACT_PATHS: Record<AgentDomainContractKind, string> = {
  'frontend-design': 'DESIGN.md',
  'output-structure': 'OUTPUT_STRUCTURE.json',
  'backend-api': 'API_CONTRACT.json',
  'database-model': 'DATA_MODEL.json',
  'architecture-review': 'ARCHITECTURE_REVIEW.md',
};

type OutputStructureAgentType = GeneratedArtifact['agentType'];

export interface OutputStructureFeatureTemplate {
  feature: string;
  routePath: string;
  modelPath: string;
  viewModelPath: string;
  viewPath: string;
}

export interface OutputStructureAgentRule {
  agentType: OutputStructureAgentType;
  architecture: 'mvvm' | 'nestjs-domain' | 'prisma' | 'architecture-docs';
  allowedPatterns: string[];
  requiredPatterns: string[];
  forbiddenPatterns: string[];
  notes: string[];
}

export interface OutputStructureContractTemplate {
  kind: 'output-structure';
  version: typeof CONTRACT_VERSION;
  projectName: string;
  source: string;
  agents: {
    frontend: OutputStructureAgentRule & {
      mvvmRoot: 'src/features';
      appRoutePolicy: string;
      sharedUiPolicy: string;
      features: OutputStructureFeatureTemplate[];
    };
    backend: OutputStructureAgentRule;
    database: OutputStructureAgentRule;
    architecture: OutputStructureAgentRule;
  };
  repairHints: string[];
}

export interface BackendApiRouteTemplate {
  resource: string;
  action: 'list' | 'create' | 'update' | 'delete';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  controller: string;
  handler: string;
  serviceMethod: string;
  prismaModel: string;
  requestDto?: string;
  responseDto: string;
  auth: 'project-default' | 'public';
  pagination?: {
    enabled: boolean;
    queryParams: string[];
    responseFields: string[];
  };
  errors: string[];
}

export interface BackendDtoTemplate {
  name: string;
  kind: 'request' | 'response';
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    validators: string[];
  }>;
}

export interface BackendModuleTemplate {
  resource: string;
  moduleName: string;
  controllerName: string;
  serviceName: string;
  controllerFile: string;
  serviceFile: string;
  dtoFiles: string[];
  prismaModel: string;
}

export interface BackendApiContractTemplate {
  kind: 'backend-api';
  version: typeof CONTRACT_VERSION;
  projectName: string;
  source: string;
  routeGroups: Array<{
    resource: string;
    basePath: string;
    controller: string;
    module: string;
    service: string;
    routes: BackendApiRouteTemplate[];
  }>;
  routes: BackendApiRouteTemplate[];
  dtos: BackendDtoTemplate[];
  authPolicy: {
    default: 'project-default';
    guard: string;
    publicRoutes: string[];
  };
  pagination: {
    style: 'page-limit';
    queryParams: string[];
    responseFields: string[];
  };
  errorPolicy: {
    standardErrors: string[];
    validationPattern: string;
    notFoundPattern: string;
  };
  modulePlan: BackendModuleTemplate[];
  prismaPolicy: {
    access: string;
    transactionRule: string;
    rawSqlRule: string;
  };
  repairHints: string[];
}

export interface DatabaseEntityTemplate {
  name: string;
  tableName: string;
  fields: Array<{
    name: string;
    type: string;
    constraints: string[];
    required: boolean;
  }>;
  relations: Array<{
    field: string;
    target: string;
    cardinality: 'one' | 'many';
    onDelete: 'Cascade' | 'Restrict' | 'SetNull';
  }>;
  indexes: Array<{
    fields: string[];
    unique: boolean;
    reason: string;
  }>;
  constraints: string[];
}

export interface DatabaseModelContractTemplate {
  kind: 'database-model';
  version: typeof CONTRACT_VERSION;
  projectName: string;
  database: string;
  entities: DatabaseEntityTemplate[];
  queryPatterns: Array<{
    resource: string;
    access: string;
    indexesRequired: string[];
  }>;
  migrationPolicy: string;
  seedPolicy: {
    recordsPerEntity: number;
    relationCoverage: string;
  };
  repairHints: string[];
}

export interface ArchitectureReviewContractTemplate {
  projectName: string;
  version: typeof CONTRACT_VERSION;
  sourceContracts: string[];
  requiredDocs: string[];
  reviewRules: string[];
  adrTopics: string[];
  c4Views: string[];
}

export function createBackendApiContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const contract = buildBackendApiContract(state);
  const resources = contract.routeGroups.map((group) => group.resource);
  return {
    agentType: 'backend',
    filePath: DOMAIN_CONTRACT_PATHS['backend-api'],
    content: stableJson(contract),
    language: 'json',
    source: 'scaffold',
    domainContract: {
      kind: 'backend-api',
      version: CONTRACT_VERSION,
      summary: `${contract.routes.length} API routes for ${resources.join(', ')}`,
    },
  };
}

export function createDatabaseModelContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const contract = buildDatabaseModelContract(state);
  const entities = contract.entities.map((entity) => entity.name);
  return {
    agentType: 'database',
    filePath: DOMAIN_CONTRACT_PATHS['database-model'],
    content: stableJson(contract),
    language: 'json',
    source: 'scaffold',
    domainContract: {
      kind: 'database-model',
      version: CONTRACT_VERSION,
      summary: `${entities.length} data entities for ${entities.join(', ')}`,
    },
  };
}

export function createArchitectureReviewContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const contract = buildArchitectureReviewContract(state);
  return {
    agentType: 'architecture',
    filePath: DOMAIN_CONTRACT_PATHS['architecture-review'],
    content: renderArchitectureReviewMarkdown(contract),
    language: 'markdown',
    source: 'scaffold',
    domainContract: {
      kind: 'architecture-review',
      version: CONTRACT_VERSION,
      summary: `Architecture review over ${contract.sourceContracts.length} domain contracts`,
    },
  };
}

export function createOutputStructureContractArtifact(
  state: DevFlowStateType,
): GeneratedArtifact {
  const contract = buildOutputStructureContract(state);
  return {
    agentType: 'frontend',
    filePath: DOMAIN_CONTRACT_PATHS['output-structure'],
    content: stableJson(contract),
    language: 'json',
    source: 'scaffold',
    domainContract: {
      kind: 'output-structure',
      version: CONTRACT_VERSION,
      summary: `Output structure contract for ${contract.agents.frontend.features.length} MVVM feature(s)`,
    },
  };
}

export function buildOutputStructureContract(
  state: DevFlowStateType,
): OutputStructureContractTemplate {
  const projectContract = state.contract;
  const features = resourceNames(projectContract?.requirements.features ?? [])
    .map((feature) => buildOutputStructureFeature(feature));

  return {
    kind: 'output-structure',
    version: CONTRACT_VERSION,
    projectName: projectContract?.projectName ?? state.companyName,
    source: 'DevFlow output structure contract generated from the approved project contract',
    agents: {
      frontend: {
        agentType: 'frontend',
        architecture: 'mvvm',
        mvvmRoot: 'src/features',
        appRoutePolicy: 'src/app/** files are route/layout shells only and must import feature views from src/features/**/view.',
        sharedUiPolicy: 'Reusable primitives belong in src/shared/ui/**; existing src/components/ui/** remains allowed for compatibility.',
        features,
        allowedPatterns: [
          'src/features/<feature>/model/**',
          'src/features/<feature>/view-model/**',
          'src/features/<feature>/view/**',
          'src/app/**/page.tsx',
          'src/app/layout.tsx',
          'src/shared/ui/**',
          'src/components/ui/**',
          'src/styles/**',
          'README-frontend.md',
        ],
        requiredPatterns: [
          'src/features/<feature>/model/types.ts',
          'src/features/<feature>/view-model/use-<feature>.ts',
          'src/features/<feature>/view/<Feature>View.tsx',
          'src/app/<feature>/page.tsx',
        ],
        forbiddenPatterns: [
          'business UI directly in src/app/**',
          'feature components directly in src/components/**',
        ],
        notes: [
          'Keep state derivation and client-side interaction logic in view-model files.',
          'Keep display components in view files.',
          'Keep DTO/view types in model files.',
        ],
      },
      backend: {
        agentType: 'backend',
        architecture: 'nestjs-domain',
        allowedPatterns: [
          'src/main.ts',
          'src/app.module.ts',
          'src/modules/<resource>/<resource>.module.ts',
          'src/modules/<resource>/<resource>.controller.ts',
          'src/modules/<resource>/<resource>.service.ts',
          'src/modules/<resource>/dto/*.dto.ts',
          'src/modules/core/**',
          'README-backend.md',
        ],
        requiredPatterns: [
          'src/modules/<resource>/<resource>.module.ts',
          'src/modules/<resource>/<resource>.controller.ts',
          'src/modules/<resource>/<resource>.service.ts',
          'src/modules/<resource>/dto/*.dto.ts',
        ],
        forbiddenPatterns: [
          'domain services at src/*.service.ts',
          'controllers outside src/modules/**',
        ],
        notes: ['Keep NestJS resources grouped by module under src/modules/<resource>.'],
      },
      database: {
        agentType: 'database',
        architecture: 'prisma',
        allowedPatterns: [
          'prisma/schema.prisma',
          'prisma/migrations/**/*.sql',
          'prisma/seed.ts',
          'README-database.md',
        ],
        requiredPatterns: [
          'prisma/schema.prisma',
          'prisma/migrations/**/*.sql',
          'prisma/seed.ts',
        ],
        forbiddenPatterns: ['schema files outside prisma/**'],
        notes: ['Keep Prisma schema, SQL migrations, and seed data under prisma/.'],
      },
      architecture: {
        agentType: 'architecture',
        architecture: 'architecture-docs',
        allowedPatterns: [
          'ARCHITECTURE.md',
          'API.md',
          'DEPLOYMENT.md',
          'ADRS.md',
          'ARCHITECTURE_REVIEW.md',
        ],
        requiredPatterns: [
          'ARCHITECTURE.md',
          'API.md',
          'DEPLOYMENT.md',
          'ADRS.md',
        ],
        forbiddenPatterns: ['implementation source files from architecture agent'],
        notes: ['Keep architecture output as root-level Markdown documentation.'],
      },
    },
    repairHints: [
      'Move frontend business UI into src/features/<feature>/view and keep src/app pages as thin route shells.',
      'Move frontend state and mapping logic into src/features/<feature>/view-model.',
      'Move backend source files into src/modules/<resource> unless they are approved entrypoint files.',
      'Keep database files under prisma/ and architecture docs at the repository root.',
    ],
  };
}

export function buildBackendApiContract(
  state: DevFlowStateType,
): BackendApiContractTemplate {
  const projectContract = state.contract;
  const resources = resourceNames(projectContract?.requirements.features ?? []);
  const routeGroups = resources.map((resource) => buildRouteGroup(resource));
  const routes = routeGroups.flatMap((group) => group.routes);
  const dtos = resources.flatMap((resource) => buildDtos(resource));
  const modulePlan = resources.map((resource) => buildModulePlan(resource));

  return {
    kind: 'backend-api',
    version: CONTRACT_VERSION,
    projectName: projectContract?.projectName ?? state.companyName,
    source: 'DevFlow domain contract generated from the approved project contract',
    routeGroups,
    routes,
    dtos,
    authPolicy: {
      default: 'project-default',
      guard: 'Use the Supabase JWT project auth guard or explicitly mark the route public.',
      publicRoutes: [],
    },
    pagination: {
      style: 'page-limit',
      queryParams: ['page', 'limit'],
      responseFields: ['items', 'total', 'page', 'limit', 'totalPages'],
    },
    errorPolicy: {
      standardErrors: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
      validationPattern: 'Reject invalid request DTOs before service execution.',
      notFoundPattern: 'Throw NotFoundException when an id lookup returns null.',
    },
    modulePlan,
    prismaPolicy: {
      access: 'Access Prisma only through an injected PrismaService inside services.',
      transactionRule: 'Use transactions when a command writes more than one model.',
      rawSqlRule: 'Avoid raw SQL unless Prisma cannot express the query.',
    },
    repairHints: [
      'Add or rename NestJS route decorators until every API_CONTRACT.json route is present.',
      'If validation says a route is missing, add the controller method and matching service method.',
      'If validation says a DTO is missing, create the named class/interface and use it in the route.',
      'Preserve route paths, DTO names, service names, and Prisma model names during retries.',
    ],
  };
}

export function buildDatabaseModelContract(
  state: DevFlowStateType,
): DatabaseModelContractTemplate {
  const projectContract = state.contract;
  const apiContract = parseBackendApiContract(
    findArtifact(state.artifacts ?? [], /API_CONTRACT\.json$/i),
  ) ?? buildBackendApiContract(state);
  const resources = unique(apiContract.routeGroups.map((group) => group.resource));
  const entities = resources.map((resource) => buildEntity(resource));

  return {
    kind: 'database-model',
    version: CONTRACT_VERSION,
    projectName: projectContract?.projectName ?? state.companyName,
    database: projectContract?.requirements.techStack.database ?? 'postgresql',
    entities,
    queryPatterns: resources.map((resource) => {
      const routeSummary = apiContract.routes
        .filter((route) => route.resource === resource)
        .map((route) => `${route.method} ${route.path}`)
        .join(', ');
      return {
        resource,
        access: `Support backend routes ${routeSummary || `for ${resource}`} with list, create, update, and delete query paths.`,
        indexesRequired: ['status', 'createdAt'],
      };
    }),
    migrationPolicy: 'Prisma schema and SQL migration must represent the same entities, fields, indexes, constraints, and relations. Never drop or rename columns without an explicit migration note.',
    seedPolicy: {
      recordsPerEntity: 3,
      relationCoverage: 'Every required relation gets at least one linked seed record. Seed each entity and include relation examples whenever relations are declared.',
    },
    repairHints: [
      'If validation says a model is missing, add the Prisma model with matching table mapping.',
      'If validation says a field is missing, add the field with the required type and constraint.',
      'If validation says an index is missing, add the matching @@index or @unique directive.',
    ],
  };
}

export function buildArchitectureReviewContract(
  state: DevFlowStateType,
): ArchitectureReviewContractTemplate {
  const existing = collectDomainContractArtifacts(state.artifacts ?? [])
    .map((artifact) => artifact.filePath);
  const sourceContracts = unique([
    'DESIGN.md',
    'OUTPUT_STRUCTURE.json',
    'API_CONTRACT.json',
    'DATA_MODEL.json',
    ...existing,
  ]);

  return {
    projectName: state.contract?.projectName ?? state.companyName,
    version: CONTRACT_VERSION,
    sourceContracts,
    requiredDocs: ['ARCHITECTURE.md', 'API.md', 'DEPLOYMENT.md', 'ADRS.md'],
    reviewRules: [
      'Verify frontend design, backend API, and database model contracts do not contradict each other.',
      'Document route groups, DTOs, data entities, relations, deployment needs, and operational risks from generated artifacts.',
      'Call out contract drift explicitly instead of hiding it in generic documentation.',
    ],
    adrTopics: ['stack', 'service-boundaries', 'api-contract', 'data-model', 'auth-security', 'deployment'],
    c4Views: ['system-context', 'container', 'component'],
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
    normalized.endsWith('/OUTPUT_STRUCTURE.JSON') ||
    normalized === 'OUTPUT_STRUCTURE.JSON' ||
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
    } else if (/OUTPUT_STRUCTURE\.json$/i.test(path)) {
      errors.push(...validateOutputStructureContractArtifact(path, artifact));
    } else if (/API_CONTRACT\.json$/i.test(path)) {
      errors.push(...validateBackendApiContractArtifact(path, artifact));
    } else if (/DATA_MODEL\.json$/i.test(path)) {
      errors.push(...validateDatabaseModelContractArtifact(path, artifact));
    } else if (/ARCHITECTURE_REVIEW\.md$/i.test(path)) {
      errors.push(...requireContent(path, artifact, ['Architecture', 'Review', 'ADR Topics'], 'architecture'));
    }
  }
  return errors;
}

export function validateDomainContractDrift(
  artifacts: GeneratedArtifact[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const outputStructureContract = parseOutputStructureContract(findArtifact(artifacts, /OUTPUT_STRUCTURE\.json$/i));
  const apiContract = parseBackendApiContract(findArtifact(artifacts, /API_CONTRACT\.json$/i));
  const dataContract = parseDatabaseModelContract(findArtifact(artifacts, /DATA_MODEL\.json$/i));

  if (outputStructureContract) {
    errors.push(...validateOutputStructureDrift(artifacts, outputStructureContract));
  }
  if (apiContract) {
    errors.push(...validateBackendApiDrift(artifacts, apiContract));
  }
  if (dataContract) {
    errors.push(...validateDatabaseModelDrift(artifacts, dataContract));
  }
  errors.push(...validateArchitectureReviewDrift(artifacts));

  return errors;
}

export function parseOutputStructureContract(
  artifact: GeneratedArtifact | undefined,
): OutputStructureContractTemplate | null {
  const parsed = parseJsonArtifact(artifact);
  if (!parsed || parsed.kind !== 'output-structure') return null;
  const agents = objectValue(parsed.agents, {});
  const frontend = objectValue(agents.frontend, {});
  const backend = objectValue(agents.backend, {});
  const database = objectValue(agents.database, {});
  const architecture = objectValue(agents.architecture, {});

  return {
    kind: 'output-structure',
    version: CONTRACT_VERSION,
    projectName: stringValue(parsed.projectName, 'Project'),
    source: stringValue(parsed.source, 'unknown'),
    agents: {
      frontend: {
        ...parseOutputStructureAgentRule(frontend, 'frontend', 'mvvm'),
        mvvmRoot: 'src/features',
        appRoutePolicy: stringValue(frontend.appRoutePolicy, ''),
        sharedUiPolicy: stringValue(frontend.sharedUiPolicy, ''),
        features: arrayValue(frontend.features) as OutputStructureFeatureTemplate[],
      },
      backend: parseOutputStructureAgentRule(backend, 'backend', 'nestjs-domain'),
      database: parseOutputStructureAgentRule(database, 'database', 'prisma'),
      architecture: parseOutputStructureAgentRule(architecture, 'architecture', 'architecture-docs'),
    },
    repairHints: arrayValue(parsed.repairHints).map(String),
  };
}

export function parseBackendApiContract(
  artifact: GeneratedArtifact | undefined,
): BackendApiContractTemplate | null {
  const parsed = parseJsonArtifact(artifact);
  if (!parsed || parsed.kind !== 'backend-api') return null;
  if (!Array.isArray(parsed.routes)) return null;

  return {
    kind: 'backend-api',
    version: CONTRACT_VERSION,
    projectName: stringValue(parsed.projectName, 'Project'),
    source: stringValue(parsed.source, 'unknown'),
    routeGroups: arrayValue(parsed.routeGroups) as BackendApiContractTemplate['routeGroups'],
    routes: parsed.routes as BackendApiRouteTemplate[],
    dtos: arrayValue(parsed.dtos) as BackendDtoTemplate[],
    authPolicy: objectValue(parsed.authPolicy, {
      default: 'project-default',
      guard: '',
      publicRoutes: [],
    }) as BackendApiContractTemplate['authPolicy'],
    pagination: objectValue(parsed.pagination, {
      style: 'page-limit',
      queryParams: ['page', 'limit'],
      responseFields: ['items', 'total'],
    }) as BackendApiContractTemplate['pagination'],
    errorPolicy: objectValue(parsed.errorPolicy, {
      standardErrors: [],
      validationPattern: '',
      notFoundPattern: '',
    }) as BackendApiContractTemplate['errorPolicy'],
    modulePlan: arrayValue(parsed.modulePlan) as BackendModuleTemplate[],
    prismaPolicy: objectValue(parsed.prismaPolicy, {
      access: '',
      transactionRule: '',
      rawSqlRule: '',
    }) as BackendApiContractTemplate['prismaPolicy'],
    repairHints: arrayValue(parsed.repairHints).map(String),
  };
}

export function parseDatabaseModelContract(
  artifact: GeneratedArtifact | undefined,
): DatabaseModelContractTemplate | null {
  const parsed = parseJsonArtifact(artifact);
  if (!parsed || parsed.kind !== 'database-model') return null;
  if (!Array.isArray(parsed.entities)) return null;

  return {
    kind: 'database-model',
    version: CONTRACT_VERSION,
    projectName: stringValue(parsed.projectName, 'Project'),
    database: stringValue(parsed.database, 'postgresql'),
    entities: parsed.entities as DatabaseEntityTemplate[],
    queryPatterns: arrayValue(parsed.queryPatterns) as DatabaseModelContractTemplate['queryPatterns'],
    migrationPolicy: stringValue(parsed.migrationPolicy, ''),
    seedPolicy: objectValue(parsed.seedPolicy, {
      recordsPerEntity: 0,
      relationCoverage: '',
    }) as DatabaseModelContractTemplate['seedPolicy'],
    repairHints: arrayValue(parsed.repairHints).map(String),
  };
}

function validateBackendApiContractArtifact(
  path: string,
  artifact: GeneratedArtifact,
): ValidationError[] {
  const contract = parseBackendApiContract(artifact);
  if (!contract) {
    return [{
      code: 'SCHEMA_VIOLATION',
      path,
      agentType: 'backend',
      message: `${path} must be valid JSON using the backend-api contract shape with a routes array`,
    }];
  }
  const errors: ValidationError[] = [];
  const requiredArrays: Array<[keyof BackendApiContractTemplate, string]> = [
    ['routeGroups', 'routeGroups'],
    ['routes', 'routes'],
    ['dtos', 'dtos'],
    ['modulePlan', 'modulePlan'],
    ['repairHints', 'repairHints'],
  ];
  for (const [key, label] of requiredArrays) {
    if (!Array.isArray(contract[key]) || (contract[key] as unknown[]).length === 0) {
      errors.push(contractError(path, 'backend', `${path} requires non-empty ${label}`));
    }
  }
  if (!contract.authPolicy?.guard) errors.push(contractError(path, 'backend', `${path} requires authPolicy.guard`));
  if (!contract.errorPolicy?.standardErrors?.length) errors.push(contractError(path, 'backend', `${path} requires errorPolicy.standardErrors`));
  if (!contract.pagination?.queryParams?.length) errors.push(contractError(path, 'backend', `${path} requires pagination.queryParams`));
  if (!contract.prismaPolicy?.access) errors.push(contractError(path, 'backend', `${path} requires prismaPolicy.access`));
  return errors;
}

function validateOutputStructureContractArtifact(
  path: string,
  artifact: GeneratedArtifact,
): ValidationError[] {
  const contract = parseOutputStructureContract(artifact);
  if (!contract) {
    return [{
      code: 'SCHEMA_VIOLATION',
      path,
      agentType: 'frontend',
      message: `${path} must be valid JSON using the output-structure contract shape`,
    }];
  }

  const errors: ValidationError[] = [];
  const rules = [
    contract.agents.frontend,
    contract.agents.backend,
    contract.agents.database,
    contract.agents.architecture,
  ];
  for (const rule of rules) {
    if (!rule.allowedPatterns.length) {
      errors.push(contractError(path, rule.agentType, `${path} requires allowedPatterns for ${rule.agentType}`));
    }
    if (!rule.requiredPatterns.length) {
      errors.push(contractError(path, rule.agentType, `${path} requires requiredPatterns for ${rule.agentType}`));
    }
  }
  if (!contract.agents.frontend.features.length) {
    errors.push(contractError(path, 'frontend', `${path} requires frontend.features for MVVM output folders`));
  }
  if (!contract.agents.frontend.mvvmRoot) {
    errors.push(contractError(path, 'frontend', `${path} requires frontend.mvvmRoot`));
  }
  if (!contract.repairHints.length) {
    errors.push(contractError(path, 'frontend', `${path} requires repairHints`));
  }
  return errors;
}

function validateOutputStructureDrift(
  artifacts: GeneratedArtifact[],
  contract: OutputStructureContractTemplate,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const artifact of artifacts) {
    if (isDomainContractPath(artifact.filePath)) continue;
    const normalizedPath = normalizeArtifactPath(artifact.filePath);
    if (!isAllowedByOutputStructure(artifact.agentType, normalizedPath)) {
      errors.push({
        code: 'CONTRACT',
        path: 'OUTPUT_STRUCTURE.json',
        agentType: artifact.agentType,
        message: `${artifact.filePath} violates OUTPUT_STRUCTURE.json for ${artifact.agentType}. Expected one of: ${patternsForAgent(contract, artifact.agentType).join(', ')}`,
      });
      continue;
    }
    if (artifact.agentType === 'frontend' && isNonShellAppRoute(artifact)) {
      errors.push({
        code: 'CONTRACT',
        path: 'OUTPUT_STRUCTURE.json',
        agentType: 'frontend',
        message: `${artifact.filePath} violates OUTPUT_STRUCTURE.json: src/app/** files must be thin route/layout shells that import a feature view from src/features/**/view`,
      });
    }
  }
  return errors.slice(0, 24);
}

function validateDatabaseModelContractArtifact(
  path: string,
  artifact: GeneratedArtifact,
): ValidationError[] {
  const contract = parseDatabaseModelContract(artifact);
  if (!contract) {
    return [{
      code: 'SCHEMA_VIOLATION',
      path,
      agentType: 'database',
      message: `${path} must be valid JSON using the database-model contract shape with an entities array`,
    }];
  }
  const errors: ValidationError[] = [];
  if (contract.entities.length === 0) errors.push(contractError(path, 'database', `${path} requires non-empty entities`));
  if (contract.queryPatterns.length === 0) errors.push(contractError(path, 'database', `${path} requires queryPatterns`));
  if (!contract.migrationPolicy) errors.push(contractError(path, 'database', `${path} requires migrationPolicy`));
  if (!contract.seedPolicy?.relationCoverage) errors.push(contractError(path, 'database', `${path} requires seedPolicy.relationCoverage`));

  for (const entity of contract.entities) {
    if (!entity.name) errors.push(contractError(path, 'database', `${path} entity is missing name`));
    if (!entity.tableName) errors.push(contractError(path, 'database', `${path} entity ${entity.name} is missing tableName`));
    if (!Array.isArray(entity.fields) || entity.fields.length === 0) {
      errors.push(contractError(path, 'database', `${path} entity ${entity.name} requires fields`));
    }
    if (!Array.isArray(entity.indexes) || entity.indexes.length === 0) {
      errors.push(contractError(path, 'database', `${path} entity ${entity.name} requires indexes`));
    }
  }
  return errors;
}

function validateBackendApiDrift(
  artifacts: GeneratedArtifact[],
  contract: BackendApiContractTemplate,
): ValidationError[] {
  const backendFiles = artifacts.filter((artifact) =>
    artifact.agentType === 'backend' && /\.(ts|tsx)$/i.test(artifact.filePath),
  );
  if (backendFiles.length === 0) return [];

  const backendContent = backendFiles.map((artifact) => artifact.content).join('\n');
  const backendContentLower = backendContent.toLowerCase();
  const routeSignatures = extractBackendRouteSignatures(backendContent);
  const errors: ValidationError[] = [];

  for (const route of contract.routes) {
    const expected = `${route.method} ${normalizeRoutePath(route.path)}`;
    const resource = route.resource.toLowerCase();
    const exactRouteExists = routeSignatures.has(expected);
    const resourceExists = backendContentLower.includes(resource);
    if (routeSignatures.size > 0 ? !exactRouteExists : !resourceExists) {
      errors.push({
        code: 'CONTRACT',
        path: 'API_CONTRACT.json',
        agentType: 'backend',
        message: `backend API contract declares ${expected} for resource "${route.resource}" but backend code does not implement it`,
      });
    }
  }

  const dtoNames = unique([
    ...contract.dtos.map((dto) => dto.name),
    ...contract.routes.flatMap((route) => [route.requestDto, route.responseDto].filter(Boolean) as string[]),
  ]);
  for (const dtoName of dtoNames) {
    const dtoPattern = new RegExp(`\\b(?:class|interface)\\s+${escapeRegExp(dtoName)}\\b`);
    if (!dtoPattern.test(backendContent)) {
      errors.push({
        code: 'CONTRACT',
        path: 'API_CONTRACT.json',
        agentType: 'backend',
        message: `backend API contract requires DTO "${dtoName}" but backend code does not declare it`,
      });
    }
  }

  return errors.slice(0, 16);
}

function validateDatabaseModelDrift(
  artifacts: GeneratedArtifact[],
  contract: DatabaseModelContractTemplate,
): ValidationError[] {
  const schemaContent = artifacts
    .filter((artifact) => artifact.agentType === 'database' && /\.prisma$/i.test(artifact.filePath))
    .map((artifact) => artifact.content)
    .join('\n');
  if (!schemaContent) return [];

  const errors: ValidationError[] = [];
  for (const entity of contract.entities) {
    const modelBody = modelBodyFor(schemaContent, entity.name);
    if (!modelBody) {
      errors.push({
        code: 'CONTRACT',
        path: 'DATA_MODEL.json',
        agentType: 'database',
        message: `database model contract declares entity "${entity.name}" but schema.prisma does not define model ${entity.name}`,
      });
      continue;
    }

    for (const field of entity.fields ?? []) {
      if (!new RegExp(`\\b${escapeRegExp(field.name)}\\s+${escapeRegExp(field.type)}\\b`).test(modelBody)) {
        errors.push({
          code: 'CONTRACT',
          path: 'DATA_MODEL.json',
          agentType: 'database',
          message: `database model contract requires ${entity.name}.${field.name}: ${field.type} but schema.prisma does not match it`,
        });
      }
    }

    for (const index of entity.indexes ?? []) {
      const indexFields = index.fields.map(escapeRegExp).join('\\s*,\\s*');
      const indexPattern = index.unique
        ? new RegExp(`@@unique\\s*\\(\\s*\\[\\s*${indexFields}\\s*\\]`)
        : new RegExp(`@@index\\s*\\(\\s*\\[\\s*${indexFields}\\s*\\]`);
      if (!indexPattern.test(modelBody)) {
        errors.push({
          code: 'CONTRACT',
          path: 'DATA_MODEL.json',
          agentType: 'database',
          message: `database model contract requires ${entity.name} index on [${index.fields.join(', ')}]`,
        });
      }
    }
  }
  return errors.slice(0, 16);
}

function validateArchitectureReviewDrift(
  artifacts: GeneratedArtifact[],
): ValidationError[] {
  const hasArchitectureReview = artifacts.some((artifact) =>
    /ARCHITECTURE_REVIEW\.md$/i.test(artifact.filePath),
  );
  if (!hasArchitectureReview) return [];

  const architectureDocs = artifacts.filter((artifact) => artifact.agentType === 'architecture');
  const implementationDocs = architectureDocs.filter((artifact) => !/ARCHITECTURE_REVIEW\.md$/i.test(artifact.filePath));
  if (implementationDocs.length === 0) return [];

  const adrs = architectureDocs.find((artifact) => /ADRS\.md$/i.test(artifact.filePath));
  if (!adrs) {
    return [{
      code: 'CONTRACT',
      path: 'ARCHITECTURE_REVIEW.md',
      agentType: 'architecture',
      message: 'architecture review contract requires ADRS.md but architecture output did not include it',
    }];
  }

  const requiredTopics = ['api', 'data', 'auth', 'deployment'];
  return requiredTopics
    .filter((topic) => !adrs.content.toLowerCase().includes(topic))
    .map((topic) => ({
      code: 'CONTRACT' as const,
      path: 'ADRS.md',
      agentType: 'architecture' as const,
      message: `architecture ADRS.md must cover ${topic} decisions from ARCHITECTURE_REVIEW.md`,
    }));
}

function buildRouteGroup(resource: string): BackendApiContractTemplate['routeGroups'][number] {
  const names = namesFor(resource);
  const routes = buildRoutes(resource);
  return {
    resource,
    basePath: `/api/${resource}`,
    controller: names.controller,
    module: names.module,
    service: names.service,
    routes,
  };
}

function buildOutputStructureFeature(feature: string): OutputStructureFeatureTemplate {
  const viewName = `${pascalCase(feature)}View`;
  return {
    feature,
    routePath: `src/app/${feature}/page.tsx`,
    modelPath: `src/features/${feature}/model/types.ts`,
    viewModelPath: `src/features/${feature}/view-model/use-${feature}.ts`,
    viewPath: `src/features/${feature}/view/${viewName}.tsx`,
  };
}

function parseOutputStructureAgentRule(
  raw: Record<string, unknown>,
  agentType: OutputStructureAgentType,
  architecture: OutputStructureAgentRule['architecture'],
): OutputStructureAgentRule {
  return {
    agentType,
    architecture: stringValue(raw.architecture, architecture) as OutputStructureAgentRule['architecture'],
    allowedPatterns: arrayValue(raw.allowedPatterns).map(String),
    requiredPatterns: arrayValue(raw.requiredPatterns).map(String),
    forbiddenPatterns: arrayValue(raw.forbiddenPatterns).map(String),
    notes: arrayValue(raw.notes).map(String),
  };
}

function isAllowedByOutputStructure(
  agentType: GeneratedArtifact['agentType'],
  filePath: string,
): boolean {
  if (agentType === 'frontend') return isAllowedFrontendPath(filePath);
  if (agentType === 'backend') return isAllowedBackendPath(filePath);
  if (agentType === 'database') return isAllowedDatabasePath(filePath);
  if (agentType === 'architecture') return isAllowedArchitecturePath(filePath);
  // 'mobile' has no OUTPUT_STRUCTURE contract authored yet. Until one exists, mobile
  // artifacts go unvalidated rather than falling through to the architecture-doc rules,
  // which would reject every generated mobile file.
  return true;
}

function isAllowedFrontendPath(filePath: string): boolean {
  return /^src\/features\/[^/]+\/(?:model|view-model|view)\/.+\.(?:ts|tsx|jsx)$/i.test(filePath) ||
    /^src\/app\/(?:.+\/)?page\.tsx$/i.test(filePath) ||
    /^src\/app\/layout\.tsx$/i.test(filePath) ||
    /^src\/shared\/ui\/.+\.(?:ts|tsx|jsx)$/i.test(filePath) ||
    /^src\/components\/ui\/.+\.(?:ts|tsx|jsx)$/i.test(filePath) ||
    /^src\/styles\/.+\.(?:css|scss)$/i.test(filePath) ||
    filePath === 'README-frontend.md';
}

function isAllowedBackendPath(filePath: string): boolean {
  return filePath === 'src/main.ts' ||
    filePath === 'src/app.module.ts' ||
    /^src\/modules\/[^/]+\/[^/]+\.module\.ts$/i.test(filePath) ||
    /^src\/modules\/[^/]+\/[^/]+\.controller\.ts$/i.test(filePath) ||
    /^src\/modules\/[^/]+\/[^/]+\.service\.ts$/i.test(filePath) ||
    /^src\/modules\/[^/]+\/dto\/.+\.dto\.ts$/i.test(filePath) ||
    /^src\/modules\/core\/.+\.(?:ts|md)$/i.test(filePath) ||
    filePath === 'README-backend.md';
}

function isAllowedDatabasePath(filePath: string): boolean {
  return filePath === 'prisma/schema.prisma' ||
    /^prisma\/migrations\/.+\.sql$/i.test(filePath) ||
    filePath === 'prisma/seed.ts' ||
    filePath === 'README-database.md';
}

function isAllowedArchitecturePath(filePath: string): boolean {
  return ['ARCHITECTURE.md', 'API.md', 'DEPLOYMENT.md', 'ADRS.md', 'ARCHITECTURE_REVIEW.md'].includes(filePath);
}

function isNonShellAppRoute(artifact: GeneratedArtifact): boolean {
  const filePath = normalizeArtifactPath(artifact.filePath);
  if (!/^src\/app\/(?:.+\/)?page\.tsx$/i.test(filePath)) return false;
  const content = artifact.content;
  const importsFeatureView = /from\s+['"`](?:@\/|\.\.?\/)*features\/[^'"`]+\/view(?:\/[^'"`]*)?['"`]/i.test(content) ||
    /from\s+['"`](?:@\/|\.\.?\/)*src\/features\/[^'"`]+\/view(?:\/[^'"`]*)?['"`]/i.test(content);
  return !importsFeatureView;
}

function patternsForAgent(
  contract: OutputStructureContractTemplate,
  agentType: GeneratedArtifact['agentType'],
): string[] {
  // Agent types without an authored contract entry (currently 'mobile') have no
  // expected patterns to report.
  const rule = contract.agents[agentType as keyof OutputStructureContractTemplate['agents']];
  return rule?.allowedPatterns ?? [];
}

function buildRoutes(resource: string): BackendApiRouteTemplate[] {
  const names = namesFor(resource);
  return [
    {
      resource,
      action: 'list',
      method: 'GET',
      path: `/api/${resource}`,
      controller: names.controller,
      handler: 'list',
      serviceMethod: 'findAll',
      prismaModel: names.prismaAccessor,
      responseDto: names.listResponseDto,
      auth: 'project-default',
      pagination: {
        enabled: true,
        queryParams: ['page', 'limit'],
        responseFields: ['items', 'total', 'page', 'limit', 'totalPages'],
      },
      errors: ['400 validation error', '401 unauthorized'],
    },
    {
      resource,
      action: 'create',
      method: 'POST',
      path: `/api/${resource}`,
      controller: names.controller,
      handler: 'create',
      serviceMethod: 'create',
      prismaModel: names.prismaAccessor,
      requestDto: names.createDto,
      responseDto: names.responseDto,
      auth: 'project-default',
      errors: ['400 validation error', '401 unauthorized'],
    },
    {
      resource,
      action: 'update',
      method: 'PATCH',
      path: `/api/${resource}/:id`,
      controller: names.controller,
      handler: 'update',
      serviceMethod: 'update',
      prismaModel: names.prismaAccessor,
      requestDto: names.updateDto,
      responseDto: names.responseDto,
      auth: 'project-default',
      errors: ['400 validation error', '401 unauthorized', '404 not found'],
    },
    {
      resource,
      action: 'delete',
      method: 'DELETE',
      path: `/api/${resource}/:id`,
      controller: names.controller,
      handler: 'remove',
      serviceMethod: 'remove',
      prismaModel: names.prismaAccessor,
      responseDto: 'DeleteResultDto',
      auth: 'project-default',
      errors: ['401 unauthorized', '404 not found'],
    },
  ];
}

function buildDtos(resource: string): BackendDtoTemplate[] {
  const names = namesFor(resource);
  const baseFields = [
    { name: 'name', type: 'string', required: true, validators: ['z.string().min(1)'] },
    { name: 'status', type: 'string', required: false, validators: ['z.string().optional()'] },
  ];
  return [
    { name: names.createDto, kind: 'request', fields: baseFields },
    { name: names.updateDto, kind: 'request', fields: baseFields.map((field) => ({ ...field, required: false })) },
    {
      name: names.responseDto,
      kind: 'response',
      fields: [
        { name: 'id', type: 'string', required: true, validators: [] },
        ...baseFields,
        { name: 'createdAt', type: 'string', required: true, validators: [] },
        { name: 'updatedAt', type: 'string', required: true, validators: [] },
      ],
    },
    {
      name: names.listResponseDto,
      kind: 'response',
      fields: [
        { name: 'items', type: `${names.responseDto}[]`, required: true, validators: [] },
        { name: 'total', type: 'number', required: true, validators: [] },
        { name: 'page', type: 'number', required: true, validators: [] },
        { name: 'limit', type: 'number', required: true, validators: [] },
        { name: 'totalPages', type: 'number', required: true, validators: [] },
      ],
    },
  ];
}

function buildModulePlan(resource: string): BackendModuleTemplate {
  const names = namesFor(resource);
  return {
    resource,
    moduleName: names.module,
    controllerName: names.controller,
    serviceName: names.service,
    controllerFile: `src/modules/${resource}/${resource}.controller.ts`,
    serviceFile: `src/modules/${resource}/${resource}.service.ts`,
    dtoFiles: [
      `src/modules/${resource}/dto/create-${resource}.dto.ts`,
      `src/modules/${resource}/dto/update-${resource}.dto.ts`,
    ],
    prismaModel: names.model,
  };
}

function buildEntity(resource: string): DatabaseEntityTemplate {
  const names = namesFor(resource);
  return {
    name: names.model,
    tableName: resource.replace(/-/g, '_'),
    fields: [
      { name: 'id', type: 'String', constraints: ['@id', '@default(cuid())'], required: true },
      { name: 'name', type: 'String', constraints: [], required: true },
      { name: 'status', type: 'String', constraints: ['@default("active")'], required: true },
      { name: 'createdAt', type: 'DateTime', constraints: ['@default(now())'], required: true },
      { name: 'updatedAt', type: 'DateTime', constraints: ['@updatedAt'], required: true },
    ],
    relations: [],
    indexes: [
      { fields: ['status'], unique: false, reason: 'Filter active/draft/archived records.' },
      { fields: ['createdAt'], unique: false, reason: 'Sort newest records first.' },
    ],
    constraints: [
      '@@map("' + resource.replace(/-/g, '_') + '")',
      'status enum is backed by application-level validation',
    ],
  };
}

function renderArchitectureReviewMarkdown(contract: ArchitectureReviewContractTemplate): string {
  return [
    '# Architecture Review Contract',
    '',
    `Project: ${contract.projectName}`,
    `Version: ${contract.version}`,
    '',
    '## Source Contracts',
    ...contract.sourceContracts.map((filePath) => `- ${filePath}`),
    '',
    '## Required Docs',
    ...contract.requiredDocs.map((filePath) => `- ${filePath}`),
    '',
    '## Review Rules',
    ...contract.reviewRules.map((rule) => `- ${rule}`),
    '',
    '## ADR Topics',
    ...contract.adrTopics.map((topic) => `- ${topic}`),
    '',
    '## C4 Views',
    ...contract.c4Views.map((view) => `- ${view}`),
  ].join('\n');
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
    .map((key) => contractError(path, agentType, `${path} is missing required "${key}" domain contract field`));
}

function requireContent(
  path: string,
  artifact: GeneratedArtifact,
  requiredText: string[],
  agentType: ValidationError['agentType'],
): ValidationError[] {
  return requiredText
    .filter((text) => !artifact.content.includes(text))
    .map((text) => contractError(path, agentType, `${path} must include "${text}"`));
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

function namesFor(resource: string): {
  model: string;
  prismaAccessor: string;
  module: string;
  controller: string;
  service: string;
  createDto: string;
  updateDto: string;
  responseDto: string;
  listResponseDto: string;
} {
  const model = pascalCase(singularize(resource));
  const plural = pascalCase(resource);
  return {
    model,
    prismaAccessor: lowerFirst(model),
    module: `${plural}Module`,
    controller: `${plural}Controller`,
    service: `${plural}Service`,
    createDto: `Create${model}Dto`,
    updateDto: `Update${model}Dto`,
    responseDto: `${model}ResponseDto`,
    listResponseDto: `${model}ListResponseDto`,
  };
}

function extractBackendRouteSignatures(content: string): Set<string> {
  const signatures = new Set<string>();
  const controllerRe = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)([\s\S]*?)(?=@Controller\(|$)/g;
  let controllerMatch: RegExpExecArray | null;
  while ((controllerMatch = controllerRe.exec(content)) !== null) {
    const base = controllerMatch[1] ?? '';
    const body = controllerMatch[2] ?? '';
    const methodRe = /@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodRe.exec(body)) !== null) {
      signatures.add(`${methodMatch[1].toUpperCase()} ${normalizeRoutePath(joinPath(base, methodMatch[2] ?? ''))}`);
    }
  }
  return signatures;
}

function modelBodyFor(schema: string, modelName: string): string | null {
  const re = new RegExp(`\\bmodel\\s+${escapeRegExp(modelName)}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
  return re.exec(schema)?.[1] ?? null;
}

function contractError(
  path: string,
  agentType: ValidationError['agentType'],
  message: string,
): ValidationError {
  return {
    code: 'SCHEMA_VIOLATION',
    path,
    agentType,
    message,
  };
}

function objectValue(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function joinPath(base: string, sub: string): string {
  return `/${[...splitPath(base), ...splitPath(sub)].join('/')}`;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function normalizeRoutePath(path: string): string {
  return joinPath('', path).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'items';
}

function singularize(value: string): string {
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ses')) return value.slice(0, -2);
  if (value.endsWith('s') && value.length > 3) return value.slice(0, -1);
  return value;
}

function pascalCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function inferKind(filePath: string): AgentDomainContractKind {
  if (/DESIGN\.md$/i.test(filePath)) return 'frontend-design';
  if (/OUTPUT_STRUCTURE\.json$/i.test(filePath)) return 'output-structure';
  if (/API_CONTRACT\.json$/i.test(filePath)) return 'backend-api';
  if (/DATA_MODEL\.(json|md)$/i.test(filePath)) return 'database-model';
  return 'architecture-review';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
