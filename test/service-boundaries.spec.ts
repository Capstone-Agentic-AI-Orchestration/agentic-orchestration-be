import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  findBoundaryDefinitionViolations,
  findBoundaryImportViolations,
  findCrossBoundaryPrismaExceptionDependencyViolations,
  findDuplicateSourceDirectoryClassifications,
  findIntegrationEventContractViolations,
  findIntegrationEventRegistryViolations,
  findInvalidCrossBoundaryPrismaExceptions,
  findMissingPrismaModelOwnerDeclarations,
  findPrismaModelSchemaViolations,
  findPublicPrismaSchemaModels,
  findMutationRouteIdempotencyViolations,
  findUndocumentedCrossBoundaryPrismaExceptions,
  findPrismaModelOwnershipViolations,
  findRawOffsetPaginationViolations,
  findUnclassifiedSourceDirectories,
  serviceBoundaries,
} from '../src/shared/architecture/service-boundaries';
import { IntegrationEventContracts, IntegrationEvents } from '../src/shared/events/integration-event';

function collectSourceFiles(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(fullPath);
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      return [];
    }

    return [{
      path: fullPath.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'),
      text: readFileSync(fullPath, 'utf8'),
    }];
  });
}

function prismaSchemaModelNames(): string[] {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  return Array.from(schema.matchAll(/^model\s+(\w+)\s+\{/gm), (match) => match[1]);
}

function prismaSchemaText(): string {
  return readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
}

describe('service boundary imports', () => {
  it('flags invalid service boundary definition maps', () => {
    expect(findBoundaryDefinitionViolations(
      [
        {
          name: 'identity',
          owns: [],
          publishes: [],
          dependsOn: ['identity', 'billing', 'intake', 'intake'],
          extractionReadiness: 'contract-ready',
        },
        {
          name: 'identity',
          owns: [],
          publishes: [],
          dependsOn: [],
          extractionReadiness: 'contract-ready',
        },
        {
          name: 'admin',
          owns: [],
          publishes: [],
          dependsOn: [],
          extractionReadiness: 'contract-ready',
        },
      ],
      {
        identity: ['auth'],
        intake: ['inquiries'],
        notifications: ['notifications'],
      },
    )).toEqual([
      {
        boundary: 'admin',
        reason: 'missing-source-directory',
      },
      {
        boundary: 'identity',
        reason: 'duplicate-definition',
      },
      {
        boundary: 'identity',
        dependency: 'billing',
        reason: 'unknown-dependency',
      },
      {
        boundary: 'identity',
        dependency: 'identity',
        reason: 'self-dependency',
      },
      {
        boundary: 'identity',
        dependency: 'intake',
        reason: 'duplicate-dependency',
      },
      {
        boundary: 'intake',
        reason: 'missing-definition',
      },
      {
        boundary: 'notifications',
        reason: 'missing-definition',
      },
    ]);
  });

  it('keeps current service boundary definitions complete and internally valid', () => {
    expect(findBoundaryDefinitionViolations()).toEqual([]);
  });

  it('flags direct imports into boundaries that are not declared dependencies', () => {
    const violations = findBoundaryImportViolations([
      {
        path: 'src/notifications/notifications.service.ts',
        text: "import { AdminService } from '../admin/admin.service';\n",
      },
      {
        path: 'src/admin/admin.service.ts',
        text: '',
      },
    ]);

    expect(violations).toEqual([
      expect.objectContaining({
        sourceBoundary: 'notifications',
        targetBoundary: 'admin',
        sourcePath: 'src/notifications/notifications.service.ts',
        importPath: '../admin/admin.service',
      }),
    ]);
  });

  it('flags side-effect imports into boundaries that are not declared dependencies', () => {
    const violations = findBoundaryImportViolations([
      {
        path: 'src/notifications/notifications.module.ts',
        text: "import '../admin/admin.module';\n",
      },
    ]);

    expect(violations).toEqual([
      expect.objectContaining({
        sourceBoundary: 'notifications',
        targetBoundary: 'admin',
        sourcePath: 'src/notifications/notifications.module.ts',
        importPath: '../admin/admin.module',
      }),
    ]);
  });

  it('flags dynamic imports and require calls into boundaries that are not declared dependencies', () => {
    const violations = findBoundaryImportViolations([
      {
        path: 'src/notifications/notifications.service.ts',
        text: [
          "await import('../admin/admin.service');",
          "const { AdminModule } = require('../admin/admin.module');",
        ].join('\n'),
      },
    ]);

    expect(violations).toEqual([
      expect.objectContaining({
        sourceBoundary: 'notifications',
        targetBoundary: 'admin',
        sourcePath: 'src/notifications/notifications.service.ts',
        importPath: '../admin/admin.service',
      }),
      expect.objectContaining({
        sourceBoundary: 'notifications',
        targetBoundary: 'admin',
        sourcePath: 'src/notifications/notifications.service.ts',
        importPath: '../admin/admin.module',
      }),
    ]);
  });

  it('allows imports into shared/platform code and declared boundary dependencies', () => {
    const violations = findBoundaryImportViolations([
      {
        path: 'src/projects/projects.service.ts',
        text: [
          "import { NotificationsService } from '../notifications/notifications.service';",
          "import { PrismaService } from '../prisma/prisma.service';",
          "import { AuthUser } from '../auth/auth.types';",
        ].join('\n'),
      },
    ]);

    expect(violations).toEqual([]);
  });

  it('keeps current source imports aligned with the boundary map', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'));

    expect(findBoundaryImportViolations(files)).toEqual([]);
  });

  it('flags source directories that are neither boundary-owned nor platform-owned', () => {
    const files = [
      { path: 'src/billing/billing.service.ts', text: '' },
      { path: 'src/projects/projects.service.ts', text: '' },
      { path: 'src/shared/events/outbox.service.ts', text: '' },
    ];

    expect(findUnclassifiedSourceDirectories(files)).toEqual(['billing']);
  });

  it('keeps current top-level source directories classified', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'));

    expect(findUnclassifiedSourceDirectories(files)).toEqual([]);
  });

  it('flags source directories assigned to multiple owners', () => {
    const duplicateClassifications = findDuplicateSourceDirectoryClassifications({
      boundaryDirectories: {
        identity: ['auth', 'profiles'],
        intake: ['inquiries', 'profiles'],
      },
      platformDirectories: ['shared', 'auth'],
    });

    expect(duplicateClassifications).toEqual([
      {
        sourceDirectory: 'auth',
        owners: ['boundary:identity', 'platform'],
      },
      {
        sourceDirectory: 'profiles',
        owners: ['boundary:identity', 'boundary:intake'],
      },
    ]);
  });

  it('keeps current source directory ownership unique', () => {
    expect(findDuplicateSourceDirectoryClassifications()).toEqual([]);
  });

  it('flags non-orchestrator mutation routes without idempotency handling', () => {
    const violations = findMutationRouteIdempotencyViolations([
      {
        path: 'src/projects/projects.controller.ts',
        text: [
          "import { Controller, Delete, Headers, Post } from '@nestjs/common';",
          '',
          "@Controller('projects')",
          'export class ProjectsController {',
          "  @Post(':id/tasks')",
          '  createTask() {',
          '    return this.projectsService.createTask();',
          '  }',
          '',
          "  @Delete(':id/members/:userId')",
          "  removeMember(@Headers('idempotency-key') idempotencyKey?: string) {",
          '    return this.runIdempotent(idempotencyKey, "scope", {}, 200, () => this.projectsService.removeMember());',
          '  }',
          '',
          "  @Post(':id/orchestration/start')",
          '  startOrchestration() {',
          '    return this.projectsService.startOrchestration();',
          '  }',
          '}',
        ].join('\n'),
      },
    ]);

    expect(violations).toEqual([
      expect.objectContaining({
        sourcePath: 'src/projects/projects.controller.ts',
        httpMethod: 'Post',
        route: ':id/tasks',
      }),
    ]);
  });

  it('keeps current non-orchestrator mutation routes idempotent', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'))
      .filter((file) => file.path.endsWith('.controller.ts'));

    expect(findMutationRouteIdempotencyViolations(files)).toEqual([]);
  });

  it('flags raw offset pagination outside the shared cursor pagination helper', () => {
    const violations = findRawOffsetPaginationViolations([
      {
        path: 'src/projects/projects.service.ts',
        text: [
          'export class ProjectsService {',
          '  list(page: number) {',
          '    return this.prisma.project.findMany({',
          '      skip: page * 50,',
          '      take: 50,',
          '    });',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        path: 'src/shared/pagination/cursor-pagination.ts',
        text: [
          'export function cursorQueryArgs(cursor?: string) {',
          '  return {',
          '    take: 51,',
          '    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),',
          '  };',
          '}',
        ].join('\n'),
      },
    ]);

    expect(violations).toEqual([
      {
        sourcePath: 'src/projects/projects.service.ts',
        line: 4,
      },
    ]);
  });

  it('keeps production pagination routed through the cursor helper', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'));

    expect(findRawOffsetPaginationViolations(files)).toEqual([]);
  });

  it('flags direct Prisma access to models owned by another service boundary', () => {
    const violations = findPrismaModelOwnershipViolations([
      {
        path: 'src/notifications/notifications.service.ts',
        text: [
          'export class NotificationsService {',
          '  listAdminDomains() {',
          '    return this.prisma.adminDomain.findMany();',
          '  }',
          '',
          '  listNotifications() {',
          '    return this.prisma.notification.findMany();',
          '  }',
          '}',
        ].join('\n'),
      },
    ]);

    expect(violations).toEqual([
      {
        sourcePath: 'src/notifications/notifications.service.ts',
        sourceBoundary: 'notifications',
        model: 'adminDomain',
        owner: 'admin',
        line: 3,
      },
    ]);
  });

  it('keeps current Prisma model access within owned models or documented exceptions', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'));

    expect(findPrismaModelOwnershipViolations(files)).toEqual([]);
  });

  it('flags Prisma schema models without declared service owners', () => {
    expect(findMissingPrismaModelOwnerDeclarations(
      ['Project', 'BillingAccount', 'IntegrationOutbox'],
      {
        project: 'project-delivery',
        integrationOutbox: 'platform',
      },
    )).toEqual(['BillingAccount']);
  });

  it('keeps every current Prisma schema model assigned to an owner', () => {
    expect(findMissingPrismaModelOwnerDeclarations(prismaSchemaModelNames())).toEqual([]);
  });

  it('flags Prisma models missing physical service schemas or mapped to the wrong schema', () => {
    expect(findPrismaModelSchemaViolations([
      'model Project {',
      '  id String @id',
      '  @@schema("projects")',
      '}',
      '',
      'model ClientInvite {',
      '  id String @id',
      '}',
      '',
      'model Notification {',
      '  id String @id',
      '  @@schema("projects")',
      '}',
      '',
      'model BillingAccount {',
      '  id String @id',
      '  @@schema("billing")',
      '}',
    ].join('\n'), {
      project: 'projects',
      clientInvite: 'intake',
      notification: 'notifications',
    })).toEqual([
      {
        model: 'BillingAccount',
        actualSchema: 'billing',
        reason: 'unknown-model',
      },
      {
        model: 'ClientInvite',
        expectedSchema: 'intake',
        reason: 'missing-schema',
      },
      {
        model: 'Notification',
        expectedSchema: 'notifications',
        actualSchema: 'projects',
        reason: 'schema-mismatch',
      },
    ]);
  });

  it('keeps every current Prisma model mapped to its physical service schema', () => {
    expect(findPrismaModelSchemaViolations(prismaSchemaText())).toEqual([]);
  });

  it('flags application models mapped to the public schema', () => {
    expect(findPublicPrismaSchemaModels([
      'model Project {',
      '  id String @id',
      '  @@schema("projects")',
      '}',
      '',
      'model BillingAccount {',
      '  id String @id',
      '  @@schema("public")',
      '}',
    ].join('\n'))).toEqual(['BillingAccount']);
  });

  it('keeps application Prisma models out of the public schema', () => {
    expect(findPublicPrismaSchemaModels(prismaSchemaText())).toEqual([]);
  });

  it('flags cross-boundary Prisma exceptions without extraction-debt metadata', () => {
    expect(findUndocumentedCrossBoundaryPrismaExceptions({
      notifications: [
        {
          model: 'project',
          reason: 'Notification fanout includes project context.',
          replaceWith: 'Project delivery read model.',
        },
        {
          model: 'profile',
          reason: '',
          replaceWith: 'Identity profile lookup API.',
        },
        {
          model: 'projectMember',
          reason: 'Fanout resolves project members.',
          replaceWith: '',
        },
      ],
    })).toEqual([
      {
        sourceBoundary: 'notifications',
        model: 'profile',
        missing: ['reason'],
      },
      {
        sourceBoundary: 'notifications',
        model: 'projectMember',
        missing: ['replaceWith'],
      },
    ]);
  });

  it('keeps current cross-boundary Prisma exceptions documented as extraction debt', () => {
    expect(findUndocumentedCrossBoundaryPrismaExceptions()).toEqual([]);
  });

  it('flags cross-boundary Prisma exceptions that do not describe actual cross-boundary business model access', () => {
    expect(findInvalidCrossBoundaryPrismaExceptions({
      notifications: [
        {
          model: 'notification',
          reason: 'Already owned by notifications.',
          replaceWith: 'Notification API.',
        },
        {
          model: 'integrationOutbox',
          reason: 'Platform outbox write.',
          replaceWith: 'Shared outbox service.',
        },
        {
          model: 'billingAccount',
          reason: 'Unknown future billing model.',
          replaceWith: 'Billing API.',
        },
      ],
    })).toEqual([
      {
        sourceBoundary: 'notifications',
        model: 'billingAccount',
        reason: 'unknown-model',
      },
      {
        sourceBoundary: 'notifications',
        model: 'integrationOutbox',
        owner: 'platform',
        reason: 'platform-model',
      },
      {
        sourceBoundary: 'notifications',
        model: 'notification',
        owner: 'notifications',
        reason: 'same-boundary-owner',
      },
    ]);
  });

  it('keeps current cross-boundary Prisma exceptions limited to real cross-boundary business model debt', () => {
    expect(findInvalidCrossBoundaryPrismaExceptions()).toEqual([]);
  });

  it('flags cross-boundary Prisma exceptions whose model owners are missing from dependsOn', () => {
    expect(findCrossBoundaryPrismaExceptionDependencyViolations(
      {
        notifications: [
          {
            model: 'project',
            reason: 'Notification fanout includes project context.',
            replaceWith: 'Project delivery read model.',
          },
          {
            model: 'adminDomain',
            reason: 'Notification fanout reads admin domain policy.',
            replaceWith: 'Admin domain policy event.',
          },
        ],
      },
      {
        notifications: {
          name: 'notifications',
          owns: [],
          publishes: [],
          dependsOn: ['project-delivery'],
          extractionReadiness: 'contract-ready',
        },
      },
    )).toEqual([
      {
        sourceBoundary: 'notifications',
        model: 'adminDomain',
        owner: 'admin',
        reason: 'missing-dependency',
      },
    ]);
  });

  it('keeps current cross-boundary Prisma exception owners reflected in the boundary dependency graph', () => {
    expect(findCrossBoundaryPrismaExceptionDependencyViolations()).toEqual([]);
  });

  it('flags integration events without versioned names or declared producer ownership', () => {
    const violations = findIntegrationEventContractViolations(
      [
        'intake.inquiry.submitted',
        'billing.invoice.created.v1',
        'notifications.notification.requested.v1',
      ],
      [
        { name: 'intake', publishes: ['intake.inquiry.submitted.v1'] },
        { name: 'notifications', publishes: [] },
      ],
    );

    expect(violations).toEqual([
      {
        eventType: 'intake.inquiry.submitted',
        reason: 'invalid-format',
      },
      {
        eventType: 'billing.invoice.created.v1',
        producer: 'billing',
        reason: 'unknown-producer',
      },
      {
        eventType: 'notifications.notification.requested.v1',
        producer: 'notifications',
        reason: 'undeclared-publisher',
      },
    ]);
  });

  it('keeps current integration event constants versioned and declared by their producer boundary', () => {
    expect(findIntegrationEventContractViolations(Object.values(IntegrationEvents))).toEqual([]);
  });

  it('flags published events that are missing from the shared event contract registry', () => {
    expect(findIntegrationEventRegistryViolations(
      [
        {
          name: 'intake',
          publishes: [
            'intake.inquiry.submitted.v1',
            'intake.inquiry.escalated.v1',
          ],
        },
      ],
      [
        {
          eventType: 'intake.inquiry.submitted.v1',
          producer: 'intake',
          aggregateType: 'client_inquiry',
        },
      ],
    )).toEqual([
      {
        eventType: 'intake.inquiry.escalated.v1',
        producer: 'intake',
        reason: 'missing-contract',
      },
    ]);
  });

  it('flags shared event contracts with duplicate event types or mismatched producer metadata', () => {
    expect(findIntegrationEventRegistryViolations(
      [
        {
          name: 'intake',
          publishes: ['intake.inquiry.submitted.v1'],
        },
      ],
      [
        {
          eventType: 'intake.inquiry.submitted.v1',
          producer: 'notifications',
          aggregateType: 'client_inquiry',
        },
        {
          eventType: 'intake.inquiry.submitted.v1',
          producer: 'intake',
          aggregateType: 'client_inquiry',
        },
      ],
    )).toEqual([
      {
        eventType: 'intake.inquiry.submitted.v1',
        producer: 'notifications',
        reason: 'producer-mismatch',
      },
      {
        eventType: 'intake.inquiry.submitted.v1',
        producer: 'intake',
        reason: 'duplicate-contract',
      },
    ]);
  });

  it('flags shared event contracts with invalid aggregate type metadata', () => {
    expect(findIntegrationEventRegistryViolations(
      [
        {
          name: 'intake',
          publishes: [
            'intake.inquiry.submitted.v1',
            'intake.client_invite.accepted.v1',
            'intake.inquiry.rejected.v1',
          ],
        },
      ],
      [
        {
          eventType: 'intake.inquiry.submitted.v1',
          producer: 'intake',
          aggregateType: '',
        },
        {
          eventType: 'intake.client_invite.accepted.v1',
          producer: 'intake',
          aggregateType: 'clientInvite',
        },
        {
          eventType: 'intake.inquiry.rejected.v1',
          producer: 'intake',
          aggregateType: 'client-inquiry',
        },
      ],
    )).toEqual([
      {
        eventType: 'intake.inquiry.submitted.v1',
        producer: 'intake',
        reason: 'invalid-aggregate-type',
      },
      {
        eventType: 'intake.client_invite.accepted.v1',
        producer: 'intake',
        reason: 'invalid-aggregate-type',
      },
      {
        eventType: 'intake.inquiry.rejected.v1',
        producer: 'intake',
        reason: 'invalid-aggregate-type',
      },
    ]);
  });

  it('keeps current published integration events backed by shared contract metadata', () => {
    expect(findIntegrationEventRegistryViolations(
      serviceBoundaries,
      Object.values(IntegrationEventContracts),
    )).toEqual([]);
  });
});
