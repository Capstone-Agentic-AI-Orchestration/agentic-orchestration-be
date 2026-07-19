import { describe, expect, it } from 'vitest';
import type { DevFlowStateType, ProjectContract } from './graph/devflow.state';
import {
  buildArchitectureReviewContract,
  buildBackendApiContract,
  buildDatabaseModelContract,
  buildOutputStructureContract,
  createBackendApiContractArtifact,
} from './domain-contracts';

function contract(features = ['Invoice tracking']): ProjectContract {
  return {
    projectId: 'proj-1',
    projectName: 'Operations Hub',
    description: 'Track project invoices and approvals.',
    requirements: {
      projectType: 'internal tool',
      features,
      techStack: {
        frontend: 'Next.js',
        backend: 'NestJS',
        database: 'PostgreSQL',
        styling: 'Tailwind',
      },
      complexity: 'medium',
      estimatedFiles: 6,
    },
    fileManifest: [],
    acceptanceCriteria: ['Users can create and list invoices'],
    lockedAt: new Date('2026-07-09T00:00:00.000Z').toISOString(),
  };
}

function state(features = ['Invoice tracking']): DevFlowStateType {
  return {
    projectId: 'proj-1',
    runId: 'run-1',
    companyName: 'TestCo',
    stackKey: 'next-nest-pg',
    contract: contract(features),
    artifacts: [],
  } as unknown as DevFlowStateType;
}

describe('domain contract templates', () => {
  it('builds an output structure contract with frontend MVVM and agent-native rules', () => {
    const output = buildOutputStructureContract(state(['Invoice tracking', 'Client portal']));

    expect(output.kind).toBe('output-structure');
    expect(output.agents.frontend.architecture).toBe('mvvm');
    expect(output.agents.frontend.features[0]).toMatchObject({
      feature: 'invoice-tracking',
      modelPath: 'src/features/invoice-tracking/model/types.ts',
      viewModelPath: 'src/features/invoice-tracking/view-model/use-invoice-tracking.ts',
      viewPath: 'src/features/invoice-tracking/view/InvoiceTrackingView.tsx',
      routePath: 'src/app/invoice-tracking/page.tsx',
    });
    expect(output.agents.frontend.allowedPatterns).toContain('src/features/<feature>/view-model/**');
    expect(output.agents.backend.allowedPatterns).toContain('src/modules/<resource>/<resource>.service.ts');
    expect(output.agents.database.allowedPatterns).toContain('prisma/schema.prisma');
    expect(output.agents.architecture.allowedPatterns).toContain('ADRS.md');
  });

  it('builds a rich backend API contract from the project contract', () => {
    const api = buildBackendApiContract(state());

    expect(api.kind).toBe('backend-api');
    expect(api.routeGroups[0]).toMatchObject({
      resource: 'invoice-tracking',
      basePath: '/api/invoice-tracking',
    });
    expect(api.routes.map((route) => route.method)).toEqual(['GET', 'POST', 'PATCH', 'DELETE']);
    expect(api.routes[0]).toMatchObject({
      controller: 'InvoiceTrackingController',
      serviceMethod: 'findAll',
      pagination: { enabled: true },
    });
    expect(api.dtos.map((dto) => dto.name)).toContain('CreateInvoiceTrackingDto');
    expect(api.dtos.map((dto) => dto.name)).toContain('InvoiceTrackingResponseDto');
    expect(api.authPolicy.guard).toContain('Supabase');
    expect(api.errorPolicy.standardErrors).toContain('NOT_FOUND');
    expect(api.modulePlan[0]).toMatchObject({
      moduleName: 'InvoiceTrackingModule',
      serviceName: 'InvoiceTrackingService',
    });
    expect(api.prismaPolicy.access).toContain('PrismaService');
    expect(api.repairHints).toContain('Add or rename NestJS route decorators until every API_CONTRACT.json route is present.');
  });

  it('builds a database model contract with entities, indexes, seeds, and migration policy', () => {
    const apiArtifact = createBackendApiContractArtifact(state());
    const data = buildDatabaseModelContract({
      ...state(),
      artifacts: [apiArtifact],
    } as DevFlowStateType);

    expect(data.kind).toBe('database-model');
    expect(data.entities[0]).toMatchObject({
      name: 'InvoiceTracking',
      tableName: 'invoice_tracking',
    });
    expect(data.entities[0].fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['id', 'name', 'status', 'createdAt', 'updatedAt']),
    );
    expect(data.entities[0].indexes.map((index) => index.fields.join(','))).toContain('status');
    expect(data.entities[0].constraints).toContain('status enum is backed by application-level validation');
    expect(data.queryPatterns[0].access).toContain('GET /api/invoice-tracking');
    expect(data.seedPolicy.relationCoverage).toContain('Every required relation gets at least one linked seed record.');
    expect(data.migrationPolicy).toContain('Never drop or rename columns without an explicit migration note.');
  });

  it('builds an architecture review contract that lists sibling source contracts', () => {
    const review = buildArchitectureReviewContract({
      ...state(),
      artifacts: [
        {
          agentType: 'frontend',
          filePath: 'DESIGN.md',
          content: '# DESIGN.md\n\n## Color\nBlack.\n\n## Components\nTables.',
          language: 'markdown',
          source: 'scaffold',
          domainContract: { kind: 'frontend-design', version: 'v1', summary: 'visual contract' },
        },
      ],
    } as DevFlowStateType);

    expect(review.sourceContracts).toEqual(expect.arrayContaining([
      'DESIGN.md',
      'OUTPUT_STRUCTURE.json',
      'API_CONTRACT.json',
      'DATA_MODEL.json',
    ]));
    expect(review.requiredDocs).toEqual(['ARCHITECTURE.md', 'API.md', 'DEPLOYMENT.md', 'ADRS.md']);
    expect(review.adrTopics).toEqual(expect.arrayContaining(['api-contract', 'data-model', 'deployment']));
    expect(review.c4Views).toEqual(expect.arrayContaining(['system-context', 'container', 'component']));
  });
});
