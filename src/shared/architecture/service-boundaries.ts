import {
  IntegrationEventContracts,
  IntegrationEvents,
  type ServiceBoundary,
} from '../events/integration-event';

export interface ServiceBoundaryDefinition {
  name: ServiceBoundary;
  owns: string[];
  publishes: string[];
  dependsOn: ServiceBoundary[];
  extractionReadiness: 'internal-module' | 'contract-ready' | 'external-ready';
}

export interface SourceFileForBoundaryCheck {
  path: string;
  text: string;
}

export interface BoundaryImportViolation {
  sourcePath: string;
  sourceBoundary: ServiceBoundary;
  targetBoundary: ServiceBoundary;
  importPath: string;
  line: number;
}

export interface SourceDirectoryClassificationInput {
  boundaryDirectories?: Partial<Record<ServiceBoundary, string[]>>;
  platformDirectories?: Iterable<string>;
}

export interface DuplicateSourceDirectoryClassification {
  sourceDirectory: string;
  owners: string[];
}

export type BoundaryDefinitionViolationReason =
  | 'missing-definition'
  | 'duplicate-definition'
  | 'missing-source-directory'
  | 'unknown-dependency'
  | 'self-dependency'
  | 'duplicate-dependency';

export interface BoundaryDefinitionInput {
  name: string;
  owns: string[];
  publishes: string[];
  dependsOn: string[];
  extractionReadiness: ServiceBoundaryDefinition['extractionReadiness'];
}

export interface BoundaryDefinitionViolation {
  boundary: string;
  dependency?: string;
  reason: BoundaryDefinitionViolationReason;
}

export interface MutationRouteIdempotencyOptions {
  ignoredRouteFragments?: string[];
}

export interface MutationRouteIdempotencyViolation {
  sourcePath: string;
  httpMethod: 'Post' | 'Patch' | 'Delete';
  route: string;
  line: number;
}

export interface RawOffsetPaginationViolation {
  sourcePath: string;
  line: number;
}

export type PrismaModelOwner = ServiceBoundary | 'platform';

export interface PrismaModelOwnershipViolation {
  sourcePath: string;
  sourceBoundary: ServiceBoundary;
  model: string;
  owner: Exclude<PrismaModelOwner, 'platform'>;
  line: number;
}

export interface CrossBoundaryPrismaModelException {
  model: string;
  reason: string;
  replaceWith: string;
}

export type CrossBoundaryPrismaModelExceptionInput = Partial<
  Record<ServiceBoundary, Array<Partial<CrossBoundaryPrismaModelException> & { model: string }>>
>;

export interface UndocumentedCrossBoundaryPrismaException {
  sourceBoundary: ServiceBoundary;
  model: string;
  missing: Array<'reason' | 'replaceWith'>;
}

export type InvalidCrossBoundaryPrismaExceptionReason =
  | 'unknown-model'
  | 'same-boundary-owner'
  | 'platform-model';

export interface InvalidCrossBoundaryPrismaException {
  sourceBoundary: ServiceBoundary;
  model: string;
  owner?: PrismaModelOwner;
  reason: InvalidCrossBoundaryPrismaExceptionReason;
}

export interface CrossBoundaryPrismaExceptionDependencyViolation {
  sourceBoundary: ServiceBoundary;
  model: string;
  owner: Exclude<PrismaModelOwner, 'platform'>;
  reason: 'missing-dependency';
}

export interface PrismaModelSchemaViolation {
  model: string;
  expectedSchema?: string;
  actualSchema?: string;
  reason: 'missing-schema' | 'unknown-model' | 'schema-mismatch';
}

export type IntegrationEventContractViolationReason =
  | 'invalid-format'
  | 'unknown-producer'
  | 'undeclared-publisher'
  | 'aggregate-type-mismatch';

export interface IntegrationEventContractViolation {
  eventType: string;
  producer?: string;
  reason: IntegrationEventContractViolationReason;
}

export interface IntegrationEventPublisherDeclaration {
  name: ServiceBoundary;
  publishes: string[];
}

export type IntegrationEventRegistryViolationReason =
  | 'missing-contract'
  | 'producer-mismatch'
  | 'duplicate-contract'
  | 'invalid-aggregate-type';

export interface IntegrationEventRegistryContract {
  eventType: string;
  producer: string;
  aggregateType: string;
}

export interface IntegrationEventRegistryViolation {
  eventType: string;
  producer?: string;
  reason: IntegrationEventRegistryViolationReason;
}

export const serviceBoundarySourceDirectories: Record<ServiceBoundary, string[]> = {
  identity: ['auth', 'profiles', 'developers'],
  intake: ['inquiries', 'client-invites', 'intake'],
  'project-delivery': ['projects', 'reports', 'schedule', 'groups', 'repositories'],
  collaboration: ['collaboration'],
  notifications: ['notifications'],
  orchestration: ['orchestration', 'supervisor', 'memory', 'context-memory', 'gateway'],
  admin: ['admin'],
};

export const platformSourceDirectories = new Set([
  'common',
  'config',
  'github',
  'health',
  'prisma',
  'shared',
]);

export const serviceBoundaries: ServiceBoundaryDefinition[] = [
  {
    name: 'identity',
    owns: ['profiles', 'project_members', 'developer_profiles', 'Supabase JWT verification'],
    publishes: [],
    dependsOn: ['intake'],
    extractionReadiness: 'contract-ready',
  },
  {
    name: 'intake',
    owns: ['client_inquiries', 'client_invites', 'project_intakes', 'project_intake_snapshots', 'document_extractions', 'project kickoffs from approved inquiries'],
    publishes: [
      IntegrationEvents.inquirySubmitted,
      IntegrationEvents.inquiryApproved,
      IntegrationEvents.inquiryRejected,
      IntegrationEvents.clientInviteAccepted,
    ],
    dependsOn: ['identity', 'project-delivery', 'notifications', 'collaboration'],
    extractionReadiness: 'contract-ready',
  },
  {
    name: 'project-delivery',
    owns: [
      'Project',
      'project_tasks',
      'work_orders',
      'artifacts',
      'project_timeline_events',
      'project_delivery_reviews',
      'groups',
      'group_members',
      'group_invitations',
      'group_activity_events',
      'repositories',
      'repository_assignments',
    ],
    publishes: [],
    dependsOn: ['identity', 'intake', 'collaboration', 'notifications', 'orchestration'],
    extractionReadiness: 'internal-module',
  },
  {
    name: 'collaboration',
    owns: ['project_conversations', 'project_messages', 'conversation_reads', 'collaboration_documents'],
    publishes: [],
    dependsOn: ['identity', 'project-delivery', 'notifications'],
    extractionReadiness: 'internal-module',
  },
  {
    name: 'notifications',
    owns: ['notifications', 'notification fanout policy'],
    publishes: [IntegrationEvents.notificationRequested],
    dependsOn: ['identity', 'project-delivery'],
    extractionReadiness: 'contract-ready',
  },
  {
    name: 'orchestration',
    owns: [
      'orchestration_runs',
      'work_order_executions',
      'event_logs',
      'run_budgets',
      'agent_memories',
      'memory_context_events',
      'memory_context_handoffs',
      'memory_context_snapshots',
    ],
    publishes: [],
    dependsOn: ['identity', 'intake', 'project-delivery', 'notifications', 'admin'],
    extractionReadiness: 'internal-module',
  },
  {
    name: 'admin',
    owns: ['admin_domains', 'admin_audit_logs', 'platform_settings', 'GitHub app configuration'],
    publishes: [],
    dependsOn: ['identity', 'project-delivery', 'orchestration'],
    extractionReadiness: 'contract-ready',
  },
];

const importFromPattern = /^\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gm;
const sideEffectImportPattern = /^\s*import\s+['"]([^'"]+)['"]/gm;
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const requirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const mutationRouteDecoratorPattern = /^\s*@(Post|Patch|Delete)(?:\(\s*([^)]*)\s*\))?/gm;
const rawOffsetPaginationPattern = /^\s*skip\s*:/gm;
const prismaModelAccessPattern = /\b(?:(?:this\.)?prisma|tx)\.(\w+)\b/gm;
const integrationEventTypePattern = /^([a-z][a-z-]*)\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\.v([1-9]\d*)$/;
const integrationEventAggregateTypePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const defaultIgnoredMutationRouteFragments = ['orchestration'];
const allowedRawOffsetPaginationFiles = new Set([
  'src/shared/pagination/cursor-pagination.ts',
]);
export const prismaModelOwners: Record<string, PrismaModelOwner> = {
  project: 'project-delivery',
  clientInquiry: 'intake',
  clientInvite: 'intake',
  projectIntake: 'intake',
  projectIntakeComment: 'intake',
  projectIntakeSnapshot: 'intake',
  documentExtraction: 'intake',
  projectKickoff: 'project-delivery',
  gateEvent: 'orchestration',
  artifact: 'project-delivery',
  profile: 'identity',
  scheduleEvent: 'project-delivery',
  developerProfile: 'identity',
  projectMember: 'identity',
  group: 'project-delivery',
  groupMember: 'project-delivery',
  groupInvitation: 'project-delivery',
  groupActivityEvent: 'project-delivery',
  repository: 'project-delivery',
  repositoryAssignment: 'project-delivery',
  projectTask: 'project-delivery',
  projectTaskActivity: 'project-delivery',
  projectDeliveryReview: 'project-delivery',
  projectConversation: 'collaboration',
  projectMessage: 'collaboration',
  conversationRead: 'collaboration',
  collaborationDocument: 'collaboration',
  workOrder: 'project-delivery',
  orchestrationRun: 'orchestration',
  workOrderExecution: 'orchestration',
  projectTimelineEvent: 'project-delivery',
  notification: 'notifications',
  agentMemory: 'orchestration',
  agentProfile: 'orchestration',
  eventLog: 'orchestration',
  runBudget: 'orchestration',
  adminDomain: 'admin',
  adminAuditLog: 'admin',
  platformSetting: 'admin',
  integrationOutbox: 'platform',
  idempotencyRecord: 'platform',
};

export const prismaModelSchemas: Record<string, string> = {
  project: 'projects',
  clientInquiry: 'intake',
  clientInvite: 'intake',
  projectIntake: 'intake',
  projectIntakeComment: 'intake',
  projectIntakeSnapshot: 'intake',
  documentExtraction: 'intake',
  projectKickoff: 'projects',
  gateEvent: 'projects',
  artifact: 'projects',
  profile: 'identity',
  scheduleEvent: 'scheduling',
  developerProfile: 'identity',
  projectMember: 'projects',
  group: 'projects',
  groupMember: 'projects',
  groupInvitation: 'projects',
  groupActivityEvent: 'projects',
  repository: 'projects',
  repositoryAssignment: 'projects',
  projectTask: 'projects',
  projectTaskActivity: 'projects',
  projectDeliveryReview: 'projects',
  projectConversation: 'collaboration',
  projectMessage: 'collaboration',
  conversationRead: 'collaboration',
  collaborationDocument: 'collaboration',
  workOrder: 'orchestration',
  orchestrationRun: 'orchestration',
  workOrderExecution: 'orchestration',
  projectTimelineEvent: 'projects',
  notification: 'notifications',
  agentMemory: 'memory',
  agentProfile: 'memory',
  eventLog: 'orchestration',
  runBudget: 'orchestration',
  adminDomain: 'admin',
  adminAuditLog: 'admin',
  platformSetting: 'admin',
  integrationOutbox: 'integration',
  idempotencyRecord: 'integration',
};

export const allowedCrossBoundaryPrismaModels: Partial<Record<ServiceBoundary, CrossBoundaryPrismaModelException[]>> = {
  admin: [
    crossBoundaryPrismaException('eventLog', 'Admin dashboard reads orchestration event volume.', 'Orchestration admin read model.'),
    crossBoundaryPrismaException('orchestrationRun', 'Admin dashboard reads run status.', 'Orchestration admin read model.'),
    crossBoundaryPrismaException('profile', 'Admin user management reads identity profiles.', 'Identity admin API.'),
    crossBoundaryPrismaException('project', 'Admin repository and handoff views read project state.', 'Project delivery admin read model.'),
    crossBoundaryPrismaException('projectTimelineEvent', 'Admin handoff override writes project timeline context.', 'Project delivery timeline API.'),
    crossBoundaryPrismaException('runBudget', 'Admin dashboard reads run budget status.', 'Orchestration admin read model.'),
  ],
  collaboration: [
    crossBoundaryPrismaException('artifact', 'Collaboration document review resolves linked delivery artifacts.', 'Project delivery artifact read model.'),
    crossBoundaryPrismaException('project', 'Collaboration access checks require project visibility.', 'Project delivery project access API.'),
    crossBoundaryPrismaException('projectMember', 'Collaboration access checks require membership state.', 'Identity membership read model.'),
    crossBoundaryPrismaException('projectTimelineEvent', 'Collaboration writes project activity timeline entries.', 'Project delivery timeline event API.'),
  ],
  identity: [
    crossBoundaryPrismaException('clientInvite', 'Auth bootstrap links pending invites during sign-in.', 'Intake invite lookup API.'),
  ],
  intake: [
    crossBoundaryPrismaException('collaborationDocument', 'Inquiry approval seeds the initial collaboration document.', 'Collaboration kickoff API.'),
    crossBoundaryPrismaException('profile', 'Inquiry approval links an existing client profile when available.', 'Identity profile lookup API.'),
    crossBoundaryPrismaException('project', 'Inquiry approval creates the project handoff aggregate.', 'Project delivery project creation API.'),
    crossBoundaryPrismaException('projectConversation', 'Inquiry approval seeds the kickoff conversation.', 'Collaboration kickoff API.'),
    crossBoundaryPrismaException('projectMember', 'Inquiry approval and invite acceptance create project membership.', 'Identity membership command API.'),
    crossBoundaryPrismaException('projectMessage', 'Inquiry approval seeds the kickoff conversation message.', 'Collaboration kickoff API.'),
    crossBoundaryPrismaException('projectTimelineEvent', 'Inquiry and invite transitions write project timeline entries.', 'Project delivery timeline event API.'),
  ],
  notifications: [
    crossBoundaryPrismaException('profile', 'Notification fanout resolves recipient profile metadata.', 'Identity recipient read model.'),
    crossBoundaryPrismaException('project', 'Notification fanout includes project context.', 'Project delivery notification context event.'),
    crossBoundaryPrismaException('projectMember', 'Notification fanout resolves project recipients.', 'Identity membership read model.'),
    crossBoundaryPrismaException('projectTimelineEvent', 'Notification fanout mirrors project activity timeline entries.', 'Project delivery timeline event API.'),
  ],
  orchestration: [
    crossBoundaryPrismaException('artifact', 'Orchestration writes generated delivery artifacts.', 'Project delivery artifact command API.'),
    crossBoundaryPrismaException('project', 'Orchestration advances project execution state.', 'Project delivery orchestration callback API.'),
    crossBoundaryPrismaException('repository', 'Orchestration reuses the PM-provisioned repository for artifact delivery.', 'Project delivery repository read model.'),
    crossBoundaryPrismaException('projectTask', 'Orchestration updates task execution status.', 'Project delivery task command API.'),
    crossBoundaryPrismaException('projectTaskActivity', 'Orchestration records task execution activity.', 'Project delivery task activity API.'),
    crossBoundaryPrismaException('projectTimelineEvent', 'Orchestration records project execution milestones.', 'Project delivery timeline event API.'),
    crossBoundaryPrismaException('workOrder', 'Orchestration claims and updates executable work orders.', 'Project delivery work-order command API.'),
  ],
  'project-delivery': [
    crossBoundaryPrismaException('clientInquiry', 'Project reports include intake conversion data.', 'Intake reporting read model.'),
    crossBoundaryPrismaException('clientInvite', 'Project summaries include pending invite state.', 'Intake invite read model.'),
    crossBoundaryPrismaException('collaborationDocument', 'Project readiness summarizes collaboration deliverables.', 'Collaboration document read model.'),
    crossBoundaryPrismaException('eventLog', 'Project execution views show orchestration event history.', 'Orchestration event read model.'),
    crossBoundaryPrismaException('orchestrationRun', 'Project execution views show orchestration run state.', 'Orchestration run read model.'),
    crossBoundaryPrismaException('profile', 'Project membership commands resolve profile metadata.', 'Identity profile lookup API.'),
    crossBoundaryPrismaException('projectMember', 'Project delivery authorization reads membership.', 'Identity membership read model.'),
  ],
};

export function serviceBoundaryForSourcePath(filePath: string): ServiceBoundary | null {
  const sourceDirectory = firstSourceDirectory(filePath);
  if (!sourceDirectory || platformSourceDirectories.has(sourceDirectory)) {
    return null;
  }

  for (const [boundary, directories] of Object.entries(serviceBoundarySourceDirectories)) {
    if (directories.includes(sourceDirectory)) {
      return boundary as ServiceBoundary;
    }
  }

  return null;
}

export function findBoundaryImportViolations(
  files: SourceFileForBoundaryCheck[],
): BoundaryImportViolation[] {
  return files.flatMap((file) => {
    const sourceBoundary = serviceBoundaryForSourcePath(file.path);
    if (!sourceBoundary) {
      return [];
    }

    const allowedBoundaries = new Set<ServiceBoundary>([
      sourceBoundary,
      ...boundaryDefinition(sourceBoundary).dependsOn,
    ]);
    const violations: BoundaryImportViolation[] = [];

    for (const importMatch of extractImportPaths(file.text)) {
      const importPath = importMatch.importPath;
      const resolvedImportPath = resolveRelativeImportPath(file.path, importPath);
      if (!resolvedImportPath) {
        continue;
      }

      const targetBoundary = serviceBoundaryForSourcePath(resolvedImportPath);
      if (!targetBoundary || allowedBoundaries.has(targetBoundary)) {
        continue;
      }

      violations.push({
        sourcePath: normalizePath(file.path),
        sourceBoundary,
        targetBoundary,
        importPath,
        line: lineNumberForIndex(file.text, importMatch.index),
      });
    }

    return violations;
  });
}

export function findUnclassifiedSourceDirectories(
  files: SourceFileForBoundaryCheck[],
): string[] {
  const classifiedDirectories = new Set([
    ...platformSourceDirectories,
    ...Object.values(serviceBoundarySourceDirectories).flat(),
  ]);

  const sourceDirectories = new Set<string>();
  for (const file of files) {
    const sourceDirectory = firstSourceDirectory(file.path);
    if (sourceDirectory) {
      sourceDirectories.add(sourceDirectory);
    }
  }

  return Array.from(sourceDirectories)
    .filter((sourceDirectory) => !classifiedDirectories.has(sourceDirectory))
    .sort();
}

export function findDuplicateSourceDirectoryClassifications(
  input: SourceDirectoryClassificationInput = {},
): DuplicateSourceDirectoryClassification[] {
  const boundaryDirectories = input.boundaryDirectories ?? serviceBoundarySourceDirectories;
  const platformDirectories = input.platformDirectories ?? platformSourceDirectories;
  const ownersByDirectory = new Map<string, string[]>();

  for (const [boundary, directories] of Object.entries(boundaryDirectories)) {
    for (const sourceDirectory of directories ?? []) {
      addSourceDirectoryOwner(
        ownersByDirectory,
        sourceDirectory,
        `boundary:${boundary}`,
      );
    }
  }

  for (const sourceDirectory of platformDirectories) {
    addSourceDirectoryOwner(ownersByDirectory, sourceDirectory, 'platform');
  }

  return Array.from(ownersByDirectory.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([sourceDirectory, owners]) => ({ sourceDirectory, owners }))
    .sort((left, right) => left.sourceDirectory.localeCompare(right.sourceDirectory));
}

export function findBoundaryDefinitionViolations(
  definitions: BoundaryDefinitionInput[] = serviceBoundaries,
  boundaryDirectories: Partial<Record<string, string[]>> = serviceBoundarySourceDirectories,
): BoundaryDefinitionViolation[] {
  const violations: BoundaryDefinitionViolation[] = [];
  const knownBoundaryNames = new Set(Object.keys(boundaryDirectories));
  const definitionCounts = new Map<string, number>();

  for (const definition of definitions) {
    definitionCounts.set(definition.name, (definitionCounts.get(definition.name) ?? 0) + 1);
  }

  for (const boundary of knownBoundaryNames) {
    if (!definitionCounts.has(boundary)) {
      violations.push({ boundary, reason: 'missing-definition' });
    }
  }

  for (const [boundary, count] of definitionCounts) {
    if (count > 1) {
      violations.push({ boundary, reason: 'duplicate-definition' });
    }
    if (!knownBoundaryNames.has(boundary)) {
      violations.push({ boundary, reason: 'missing-source-directory' });
    }
  }

  for (const definition of definitions) {
    const seenDependencies = new Set<string>();

    for (const dependency of definition.dependsOn) {
      if (seenDependencies.has(dependency)) {
        violations.push({
          boundary: definition.name,
          dependency,
          reason: 'duplicate-dependency',
        });
        continue;
      }
      seenDependencies.add(dependency);

      if (dependency === definition.name) {
        violations.push({
          boundary: definition.name,
          dependency,
          reason: 'self-dependency',
        });
        continue;
      }

      if (!knownBoundaryNames.has(dependency)) {
        violations.push({
          boundary: definition.name,
          dependency,
          reason: 'unknown-dependency',
        });
      }
    }
  }

  return violations.sort(compareBoundaryDefinitionViolations);
}

export function findMutationRouteIdempotencyViolations(
  files: SourceFileForBoundaryCheck[],
  options: MutationRouteIdempotencyOptions = {},
): MutationRouteIdempotencyViolation[] {
  const ignoredRouteFragments = options.ignoredRouteFragments ?? defaultIgnoredMutationRouteFragments;

  return files.flatMap((file) => {
    const violations: MutationRouteIdempotencyViolation[] = [];

    for (const routeMatch of file.text.matchAll(mutationRouteDecoratorPattern)) {
      const route = routeFromDecoratorArgument(routeMatch[2]);
      if (ignoredRouteFragments.some((fragment) => route.includes(fragment))) {
        continue;
      }

      const handlerText = handlerTextAfterDecorator(file.text, routeMatch.index ?? 0);
      if (hasIdempotentMutationHandling(handlerText)) {
        continue;
      }

      violations.push({
        sourcePath: normalizePath(file.path),
        httpMethod: routeMatch[1] as MutationRouteIdempotencyViolation['httpMethod'],
        route,
        line: lineNumberForIndex(file.text, routeMatch.index ?? 0),
      });
    }

    return violations;
  });
}

export function findRawOffsetPaginationViolations(
  files: SourceFileForBoundaryCheck[],
): RawOffsetPaginationViolation[] {
  return files.flatMap((file) => {
    const sourcePath = normalizePath(file.path);
    if (allowedRawOffsetPaginationFiles.has(sourcePath)) {
      return [];
    }

    return Array.from(file.text.matchAll(rawOffsetPaginationPattern), (match) => ({
      sourcePath,
      line: lineNumberForIndex(file.text, match.index ?? 0),
    }));
  });
}

export function findPrismaModelOwnershipViolations(
  files: SourceFileForBoundaryCheck[],
): PrismaModelOwnershipViolation[] {
  return files.flatMap((file) => {
    const sourceBoundary = serviceBoundaryForSourcePath(file.path);
    if (!sourceBoundary) {
      return [];
    }

    const allowedModels = new Set(
      (allowedCrossBoundaryPrismaModels[sourceBoundary] ?? []).map(({ model }) => model),
    );

    return Array.from(file.text.matchAll(prismaModelAccessPattern)).flatMap((match) => {
      const model = match[1];
      const owner = prismaModelOwners[model];
      if (!owner || owner === 'platform' || owner === sourceBoundary || allowedModels.has(model)) {
        return [];
      }

      return [{
        sourcePath: normalizePath(file.path),
        sourceBoundary,
        model,
        owner,
        line: lineNumberForIndex(file.text, match.index ?? 0),
      }];
    });
  });
}

export function findMissingPrismaModelOwnerDeclarations(
  prismaModelNames: string[],
  ownerDeclarations: Record<string, PrismaModelOwner> = prismaModelOwners,
): string[] {
  return prismaModelNames
    .filter((modelName) => !ownerDeclarations[prismaClientPropertyForModel(modelName)])
    .sort();
}

export function findPrismaModelSchemaViolations(
  prismaSchemaText: string,
  expectedSchemas: Record<string, string> = prismaModelSchemas,
): PrismaModelSchemaViolation[] {
  const violations: PrismaModelSchemaViolation[] = [];
  const seenModels = new Set<string>();

  for (const model of parsePrismaModelSchemas(prismaSchemaText)) {
    seenModels.add(model.clientProperty);
    const expectedSchema = expectedSchemas[model.clientProperty];

    if (!model.schema) {
      violations.push({
        model: model.name,
        expectedSchema,
        reason: 'missing-schema',
      });
      continue;
    }

    if (!expectedSchema) {
      violations.push({
        model: model.name,
        actualSchema: model.schema,
        reason: 'unknown-model',
      });
      continue;
    }

    if (model.schema !== expectedSchema) {
      violations.push({
        model: model.name,
        expectedSchema,
        actualSchema: model.schema,
        reason: 'schema-mismatch',
      });
    }
  }

  for (const clientProperty of Object.keys(expectedSchemas)) {
    if (seenModels.has(clientProperty)) {
      continue;
    }

    violations.push({
      model: clientProperty,
      expectedSchema: expectedSchemas[clientProperty],
      reason: 'unknown-model',
    });
  }

  return violations.sort((left, right) => `${left.model}:${left.reason}`.localeCompare(`${right.model}:${right.reason}`));
}

export function findPublicPrismaSchemaModels(prismaSchemaText: string): string[] {
  return parsePrismaModelSchemas(prismaSchemaText)
    .filter((model) => model.schema === 'public')
    .map((model) => model.name)
    .sort();
}

export function findUndocumentedCrossBoundaryPrismaExceptions(
  exceptions: CrossBoundaryPrismaModelExceptionInput = allowedCrossBoundaryPrismaModels,
): UndocumentedCrossBoundaryPrismaException[] {
  return Object.entries(exceptions).flatMap(([sourceBoundary, boundaryExceptions]) => (
    boundaryExceptions ?? []
  ).flatMap((exception) => {
    const missing: Array<'reason' | 'replaceWith'> = [];
    if (!exception.reason?.trim()) {
      missing.push('reason');
    }
    if (!exception.replaceWith?.trim()) {
      missing.push('replaceWith');
    }

    if (missing.length === 0) {
      return [];
    }

    return [{
      sourceBoundary: sourceBoundary as ServiceBoundary,
      model: exception.model,
      missing,
    }];
  })).sort((left, right) => (
    `${left.sourceBoundary}:${left.model}`.localeCompare(`${right.sourceBoundary}:${right.model}`)
  ));
}

export function findInvalidCrossBoundaryPrismaExceptions(
  exceptions: CrossBoundaryPrismaModelExceptionInput = allowedCrossBoundaryPrismaModels,
  ownerDeclarations: Record<string, PrismaModelOwner> = prismaModelOwners,
): InvalidCrossBoundaryPrismaException[] {
  return Object.entries(exceptions).flatMap(([sourceBoundary, boundaryExceptions]) => (
    boundaryExceptions ?? []
  ).flatMap((exception): InvalidCrossBoundaryPrismaException[] => {
    const boundary = sourceBoundary as ServiceBoundary;
    const owner = ownerDeclarations[exception.model];

    if (!owner) {
      return [{
        sourceBoundary: boundary,
        model: exception.model,
        reason: 'unknown-model',
      }];
    }

    if (owner === 'platform') {
      return [{
        sourceBoundary: boundary,
        model: exception.model,
        owner,
        reason: 'platform-model',
      }];
    }

    if (owner === boundary) {
      return [{
        sourceBoundary: boundary,
        model: exception.model,
        owner,
        reason: 'same-boundary-owner',
      }];
    }

    return [];
  })).sort((left, right) => (
    `${left.sourceBoundary}:${left.model}:${left.reason}`
      .localeCompare(`${right.sourceBoundary}:${right.model}:${right.reason}`)
  ));
}

export function findCrossBoundaryPrismaExceptionDependencyViolations(
  exceptions: CrossBoundaryPrismaModelExceptionInput = allowedCrossBoundaryPrismaModels,
  boundaryDefinitions: Partial<Record<ServiceBoundary, ServiceBoundaryDefinition>> = serviceBoundaryDefinitionsByName(),
  ownerDeclarations: Record<string, PrismaModelOwner> = prismaModelOwners,
): CrossBoundaryPrismaExceptionDependencyViolation[] {
  return Object.entries(exceptions).flatMap(([sourceBoundary, boundaryExceptions]) => {
    const boundary = sourceBoundary as ServiceBoundary;
    const definition = boundaryDefinitions[boundary];
    const declaredDependencies = new Set(definition?.dependsOn ?? []);

    return (boundaryExceptions ?? []).flatMap((exception): CrossBoundaryPrismaExceptionDependencyViolation[] => {
      const owner = ownerDeclarations[exception.model];
      if (!owner || owner === 'platform' || owner === boundary || declaredDependencies.has(owner)) {
        return [];
      }

      return [{
        sourceBoundary: boundary,
        model: exception.model,
        owner,
        reason: 'missing-dependency',
      }];
    });
  }).sort((left, right) => (
    `${left.sourceBoundary}:${left.owner}:${left.model}`
      .localeCompare(`${right.sourceBoundary}:${right.owner}:${right.model}`)
  ));
}

export function findIntegrationEventContractViolations(
  eventTypes: string[],
  publisherDeclarations: IntegrationEventPublisherDeclaration[] = serviceBoundaries,
): IntegrationEventContractViolation[] {
  const publisherByBoundary = new Map(
    publisherDeclarations.map((declaration) => [declaration.name, declaration]),
  );

  return eventTypes.flatMap((eventType): IntegrationEventContractViolation[] => {
    const match = eventType.match(integrationEventTypePattern);
    if (!match) {
      return [{ eventType, reason: 'invalid-format' as const }];
    }

    const producer = match[1];
    const declaration = publisherByBoundary.get(producer as ServiceBoundary);
    if (!declaration) {
      return [{ eventType, producer, reason: 'unknown-producer' as const }];
    }

    if (!declaration.publishes.includes(eventType)) {
      return [{ eventType, producer, reason: 'undeclared-publisher' as const }];
    }

    return [];
  });
}

export function findIntegrationEventRegistryViolations(
  publisherDeclarations: IntegrationEventPublisherDeclaration[] = serviceBoundaries,
  contracts: readonly IntegrationEventRegistryContract[] = Object.values(IntegrationEventContracts),
): IntegrationEventRegistryViolation[] {
  const violations: IntegrationEventRegistryViolation[] = [];
  const contractEventTypes = new Set<string>();

  for (const contract of contracts) {
    const match = contract.eventType.match(integrationEventTypePattern);
    const eventProducer = match?.[1];

    if (eventProducer && eventProducer !== contract.producer) {
      violations.push({
        eventType: contract.eventType,
        producer: contract.producer,
        reason: 'producer-mismatch',
      });
    }

    if (!integrationEventAggregateTypePattern.test(contract.aggregateType)) {
      violations.push({
        eventType: contract.eventType,
        producer: contract.producer,
        reason: 'invalid-aggregate-type',
      });
    }

    if (contractEventTypes.has(contract.eventType)) {
      violations.push({
        eventType: contract.eventType,
        producer: contract.producer,
        reason: 'duplicate-contract',
      });
      continue;
    }

    contractEventTypes.add(contract.eventType);
  }

  for (const declaration of publisherDeclarations) {
    for (const eventType of declaration.publishes) {
      if (contractEventTypes.has(eventType)) {
        continue;
      }

      violations.push({
        eventType,
        producer: declaration.name,
        reason: 'missing-contract',
      });
    }
  }

  return violations;
}

function addSourceDirectoryOwner(
  ownersByDirectory: Map<string, string[]>,
  sourceDirectory: string,
  owner: string,
): void {
  const owners = ownersByDirectory.get(sourceDirectory) ?? [];
  owners.push(owner);
  ownersByDirectory.set(sourceDirectory, owners);
}

function compareBoundaryDefinitionViolations(
  left: BoundaryDefinitionViolation,
  right: BoundaryDefinitionViolation,
): number {
  const boundaryComparison = left.boundary.localeCompare(right.boundary);
  if (boundaryComparison !== 0) {
    return boundaryComparison;
  }

  const reasonComparison = boundaryDefinitionViolationReasonOrder(left.reason)
    - boundaryDefinitionViolationReasonOrder(right.reason);
  if (reasonComparison !== 0) {
    return reasonComparison;
  }

  return (left.dependency ?? '').localeCompare(right.dependency ?? '');
}

function boundaryDefinitionViolationReasonOrder(reason: BoundaryDefinitionViolationReason): number {
  return [
    'missing-source-directory',
    'duplicate-definition',
    'unknown-dependency',
    'self-dependency',
    'duplicate-dependency',
    'missing-definition',
  ].indexOf(reason);
}

function routeFromDecoratorArgument(argument: string | undefined): string {
  if (!argument) {
    return '';
  }

  const stringLiteral = argument.match(/['"`]([^'"`]*)['"`]/);
  return stringLiteral?.[1] ?? '';
}

function handlerTextAfterDecorator(text: string, decoratorIndex: number): string {
  const handlerStart = indexAfterDecoratorStack(text, decoratorIndex);
  const bodyStart = text.indexOf('{', handlerStart);
  if (bodyStart === -1) {
    return '';
  }

  const bodyEnd = matchingBraceIndex(text, bodyStart);
  return text.slice(handlerStart, bodyEnd === -1 ? undefined : bodyEnd + 1);
}

function indexAfterDecoratorStack(text: string, decoratorIndex: number): number {
  let index = lineStartForIndex(text, decoratorIndex);

  while (index < text.length) {
    const lineEnd = text.indexOf('\n', index);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(index, end);
    const trimmedLine = line.trim();

    if (trimmedLine === '' || trimmedLine.startsWith('@')) {
      index = end;
      continue;
    }

    return index;
  }

  return decoratorIndex;
}

function matchingBraceIndex(text: string, openingBraceIndex: number): number {
  let depth = 0;

  for (let index = openingBraceIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character !== '}') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return -1;
}

function hasIdempotentMutationHandling(handlerText: string): boolean {
  return /idempotency-key/i.test(handlerText)
    && /\b(?:this\.)?runIdempotent\s*\(|\bexecuteIdempotentCommand\s*\(/.test(handlerText);
}

function extractImportPaths(text: string): Array<{ importPath: string; index: number }> {
  return [
    ...Array.from(text.matchAll(importFromPattern), (match) => ({
      importPath: match[1],
      index: match.index ?? 0,
    })),
    ...Array.from(text.matchAll(sideEffectImportPattern), (match) => ({
      importPath: match[1],
      index: match.index ?? 0,
    })),
    ...Array.from(text.matchAll(dynamicImportPattern), (match) => ({
      importPath: match[1],
      index: match.index ?? 0,
    })),
    ...Array.from(text.matchAll(requirePattern), (match) => ({
      importPath: match[1],
      index: match.index ?? 0,
    })),
  ].sort((left, right) => left.index - right.index);
}

function boundaryDefinition(boundary: ServiceBoundary): ServiceBoundaryDefinition {
  const definition = serviceBoundaryDefinitionsByName()[boundary];
  if (!definition) {
    throw new Error(`Unknown service boundary: ${boundary}`);
  }

  return definition;
}

function serviceBoundaryDefinitionsByName(): Record<ServiceBoundary, ServiceBoundaryDefinition> {
  return Object.fromEntries(
    serviceBoundaries.map((definition) => [definition.name, definition]),
  ) as Record<ServiceBoundary, ServiceBoundaryDefinition>;
}

function firstSourceDirectory(filePath: string): string | null {
  const normalized = normalizePath(filePath);
  const sourceIndex = normalized.indexOf('src/');
  if (sourceIndex === -1) {
    return null;
  }

  const firstSegment = normalized.slice(sourceIndex + 'src/'.length).split('/')[0] || null;
  if (!firstSegment || firstSegment.includes('.')) {
    return null;
  }

  return firstSegment;
}

function resolveRelativeImportPath(
  sourcePath: string,
  importPath: string,
): string | null {
  if (!importPath.startsWith('.')) {
    return null;
  }

  const sourceSegments = normalizePath(sourcePath).split('/');
  sourceSegments.pop();

  for (const segment of importPath.split('/')) {
    if (segment === '.' || segment === '') {
      continue;
    }

    if (segment === '..') {
      sourceSegments.pop();
      continue;
    }

    sourceSegments.push(segment);
  }

  const resolvedPath = sourceSegments.join('/');
  return resolvedPath.includes('src/') ? resolvedPath : null;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function lineNumberForIndex(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function lineStartForIndex(text: string, index: number): number {
  return text.lastIndexOf('\n', index) + 1;
}

function prismaClientPropertyForModel(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

function parsePrismaModelSchemas(schemaText: string): Array<{ name: string; clientProperty: string; schema?: string }> {
  return Array.from(schemaText.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm), (match) => ({
    name: match[1],
    clientProperty: prismaClientPropertyForModel(match[1]),
    schema: match[2].match(/@@schema\("([^"]+)"\)/)?.[1],
  }));
}

function crossBoundaryPrismaException(
  model: string,
  reason: string,
  replaceWith: string,
): CrossBoundaryPrismaModelException {
  return { model, reason, replaceWith };
}
