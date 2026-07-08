import { describe, it, expect } from 'vitest';
import { WorkOrderAgentType } from '@prisma/client';
import { OutputValidationService } from './output-validation.service';
import type { GeneratedWorkOrderOutput, WorkOrderAgentContext } from '../providers/agent-provider.types';
import type { DevFlowStateType, GeneratedArtifact, ProjectContract } from '../graph/devflow.state';
import {
  createArchitectureReviewContractArtifact,
  createBackendApiContractArtifact,
  createDatabaseModelContractArtifact,
} from '../domain-contracts';

function mockContext(overrides?: Partial<WorkOrderAgentContext>): WorkOrderAgentContext {
  return {
    project: { id: 'proj-1', companyName: 'TestCo', brief: 'Build app', stackKey: 'next-nest-pg' },
    workOrder: {
      id: 'wo-1',
      title: 'Build user auth',
      instructions: 'Create login flow',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: 'HIGH' as any,
    },
    task: null,
    sourceArtifact: null,
    executionRunId: 'exec-1',
    ...overrides,
  };
}

function domainContract(features = ['Invoice tracking']): ProjectContract {
  return {
    projectId: 'proj-1',
    projectName: 'Operations Hub',
    description: 'Track operational invoices.',
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
    acceptanceCriteria: ['Users can list and create invoices'],
    lockedAt: new Date('2026-07-09T00:00:00.000Z').toISOString(),
  };
}

function domainState(features = ['Invoice tracking']): DevFlowStateType {
  return {
    projectId: 'proj-1',
    runId: 'run-1',
    stackKey: 'next-nest-pg',
    companyName: 'TestCo',
    contract: domainContract(features),
    artifacts: [],
  } as unknown as DevFlowStateType;
}

describe('OutputValidationService', () => {
  const service = new OutputValidationService();

  describe('validate (work-order path)', () => {
    it('passes valid frontend output', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'work-orders/wo-1/login.tsx',
        displayName: 'Login component',
        content: `export function Login() { return <section><div>Login form</div></section>; }`,
        language: 'typescript',
      };
      const result = service.validate(output, mockContext());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes valid backend output', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'work-orders/wo-1/user.service.ts',
        displayName: 'User service',
        content: `import { Injectable } from '@nestjs/common'; @Injectable() export class UserService { describeWorkOrder() { return {}; } }`,
        language: 'typescript',
      };
      const result = service.validate(output, mockContext({ workOrder: { ...mockContext().workOrder, agentType: WorkOrderAgentType.BACKEND } }));
      expect(result.valid).toBe(true);
    });

    it('fails when filePath does not start with expected prefix', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'src/login.tsx',
        displayName: 'Login',
        content: `export function Login() { return <section><div>Login</div></section>; }`,
        language: 'typescript',
      };
      const result = service.validate(output, mockContext());
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'BASE')).toBe(true);
    });

    it('fails when content is too short', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'work-orders/wo-1/short.tsx',
        displayName: 'Short',
        content: 'short',
        language: 'typescript',
      };
      const result = service.validate(output, mockContext());
      expect(result.valid).toBe(false);
    });

    it('fails when frontend output lacks an export', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'work-orders/wo-1/no-export.tsx',
        displayName: 'No export',
        content: `const x = 42;`.padEnd(50, ' '),
        language: 'typescript',
      };
      const result = service.validate(output, mockContext());
      expect(result.errors.some(e => e.code === 'SCHEMA_VIOLATION')).toBe(true);
    });

    it('fails when backend output lacks export and @Injectable', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'work-orders/wo-1/bad-backend.ts',
        displayName: 'Bad backend',
        content: `const api = 'noop';`.padEnd(50, ' '),
        language: 'typescript',
      };
      const result = service.validate(output, mockContext({ workOrder: { ...mockContext().workOrder, agentType: WorkOrderAgentType.BACKEND } }));
      expect(result.errors.some(e => e.code === 'SCHEMA_VIOLATION')).toBe(true);
    });

    it('fails when database output lacks DDL', () => {
      const output: GeneratedWorkOrderOutput = {
        filePath: 'work-orders/wo-1/noddl.sql',
        displayName: 'No DDL',
        content: `SELECT * FROM users;`.padEnd(50, ' '),
        language: 'sql',
      };
      const result = service.validate(output, mockContext({ workOrder: { ...mockContext().workOrder, agentType: WorkOrderAgentType.DATABASE } }));
      expect(result.errors.some(e => e.code === 'SCHEMA_VIOLATION')).toBe(true);
    });
  });

  describe('TypeScript syntax check', () => {
    it('passes valid TypeScript', () => {
      const errors = service.validate({
        filePath: 'work-orders/wo-1/valid.ts',
        displayName: 'Valid',
        content: `export function greet(name: string): string { return "Hello " + name; }`,
        language: 'typescript',
      }, mockContext());
      expect(errors.errors.filter(e => e.code === 'TS_SYNTAX')).toHaveLength(0);
    });

    it('rejects TypeScript with unclosed brace', () => {
      const errors = service.validate({
        filePath: 'work-orders/wo-1/broken.ts',
        displayName: 'Broken',
        content: `export function broken() { const x = 1;`.padEnd(50, ' '),
        language: 'typescript',
      }, mockContext().workOrder.agentType === WorkOrderAgentType.FRONTEND ? mockContext() : mockContext({ workOrder: { ...mockContext().workOrder, agentType: WorkOrderAgentType.BACKEND } }));
      // The error codes include TS_SYNTAX for brace issues
      expect(errors.errors.some(e => e.code === 'TS_SYNTAX' || e.code === 'SCHEMA_VIOLATION')).toBe(true);
    });
  });

  describe('validateBatch (main graph path)', () => {
    it('passes valid artifacts', () => {
      const artifacts: GeneratedArtifact[] = [
        { agentType: 'frontend', filePath: 'src/app/page.tsx', content: 'export default function Page() { return <div>Hi</div>; }', language: 'typescript' },
        { agentType: 'backend', filePath: 'src/main.ts', content: 'import { Injectable } from "@nestjs/common"; export class AppModule {}', language: 'typescript' },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors).toHaveLength(0);
    });

    it('reports error for artifact with short content', () => {
      const artifacts: GeneratedArtifact[] = [
        { agentType: 'frontend', filePath: 'src/app/page.tsx', content: 'short', language: 'typescript' },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors.some(e => e.code === 'BASE')).toBe(true);
    });

    it('reports TS syntax errors in batch', () => {
      const artifacts: GeneratedArtifact[] = [
        { agentType: 'backend', filePath: 'src/broken.ts', content: `function broken() { const x = 1;`, language: 'typescript' },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors.some(e => e.code === 'TS_SYNTAX')).toBe(true);
    });

    it('rejects duplicate generated file paths', () => {
      const artifacts: GeneratedArtifact[] = [
        { agentType: 'frontend', filePath: 'src/app/page.tsx', content: 'export default function Page() { return <div>One</div>; }', language: 'typescript' },
        { agentType: 'frontend', filePath: 'src/app/page.tsx', content: 'export default function PageTwo() { return <div>Two</div>; }', language: 'typescript' },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors.some(e => e.code === 'BASE' && e.message.includes('Duplicate generated filePath'))).toBe(true);
    });

    it('rejects scaffolded config files from generated artifacts', () => {
      const artifacts: GeneratedArtifact[] = [
        { agentType: 'backend', filePath: 'package.json', content: '{"scripts":{"build":"nest build"}}'.padEnd(50, ' '), language: 'json' },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors.some(e => e.code === 'BASE' && e.message.includes('scaffolded by DevFlow'))).toBe(true);
    });

    it('rejects placeholder content in generated artifacts', () => {
      const artifacts: GeneratedArtifact[] = [
        {
          agentType: 'backend',
          filePath: 'src/orders.service.ts',
          content: 'import { Injectable } from "@nestjs/common"; @Injectable() export class OrdersService { list() { throw new Error("TODO: implementation goes here"); } }',
          language: 'typescript',
        },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors.some(e => e.code === 'BASE' && e.message.includes('placeholder or stub'))).toBe(true);
    });

    it('rejects frontend artifacts that use forbidden design patterns', () => {
      const artifacts: GeneratedArtifact[] = [
        {
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <main><h1>Project dashboard</h1><p>Gradient orb background</p></main>; }',
          language: 'typescript',
        },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1', {
        designGuidance: {
          theme: 'black',
          productFeel: 'operational',
          layoutDensity: 'balanced',
          accessibilityLevel: 'strict',
          forbiddenPatterns: ['gradient orb'],
        },
      });
      expect(errors.some(e => e.agentType === 'frontend' && e.message.includes('forbidden design pattern'))).toBe(true);
    });

    it('rejects frontend artifacts that use design-system anti-patterns', () => {
      const artifacts: GeneratedArtifact[] = [
        {
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <main><h1>Project dashboard</h1><p>Oversized hero intro</p></main>; }',
          language: 'typescript',
        },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1', {
        designGuidance: {
          theme: 'black',
          productFeel: 'operational',
          layoutDensity: 'balanced',
          accessibilityLevel: 'strict',
          forbiddenPatterns: [],
          designSystem: {
            presetId: 'devflow-black-ops',
            palette: 'Black operational cockpit.',
            typography: 'Compact system sans.',
            spacing: '8px grid.',
            layout: 'Dashboard layout.',
            components: 'Tables and panels.',
            motion: 'Subtle feedback.',
            voice: 'Direct PM language.',
            brand: 'DevFlow black theme.',
            antiPatterns: ['oversized hero'],
          },
        },
      });
      expect(errors.some(e => e.agentType === 'frontend' && e.message.includes('oversized hero'))).toBe(true);
    });

    it('requires loading, empty, and error states for data-fetching frontend artifacts', () => {
      const artifacts: GeneratedArtifact[] = [
        {
          agentType: 'frontend',
          filePath: 'src/app/projects/page.tsx',
          content: 'export default async function Page() { const response = await fetch("/api/projects"); const data = await response.json(); return <main>{data.items.map((item) => <div key={item.id}>{item.name}</div>)}</main>; }',
          language: 'typescript',
        },
      ];
      const errors = service.validateBatch(artifacts, 'proj-1', {
        designGuidance: {
          theme: 'black',
          productFeel: 'operational',
          layoutDensity: 'balanced',
          accessibilityLevel: 'strict',
          forbiddenPatterns: [],
        },
      });
      expect(errors.filter(e => e.agentType === 'frontend').map(e => e.message).join('\n')).toContain('loading state');
      expect(errors.filter(e => e.agentType === 'frontend').map(e => e.message).join('\n')).toContain('error state');
      expect(errors.filter(e => e.agentType === 'frontend').map(e => e.message).join('\n')).toContain('empty state');
    });

    it('accepts valid domain contract artifacts', () => {
      const state = domainState();
      const artifacts: GeneratedArtifact[] = [
        {
          agentType: 'frontend',
          filePath: 'DESIGN.md',
          content: '# DESIGN.md\n\n## Color\nBlack cockpit.\n\n## Components\nTables and forms.',
          language: 'markdown',
          source: 'scaffold',
          domainContract: {
            kind: 'frontend-design',
            version: 'v1',
            summary: 'visual contract',
          },
        },
        createBackendApiContractArtifact(state),
        createDatabaseModelContractArtifact(state),
        createArchitectureReviewContractArtifact(state),
      ];

      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors).toHaveLength(0);
    });

    it('rejects malformed domain contract artifacts', () => {
      const artifacts: GeneratedArtifact[] = [
        {
          agentType: 'backend',
          filePath: 'API_CONTRACT.json',
          content: '{not-json',
          language: 'json',
          source: 'scaffold',
        },
      ];

      const errors = service.validateBatch(artifacts, 'proj-1');
      expect(errors.some(e => e.agentType === 'backend' && e.message.includes('valid JSON'))).toBe(true);
    });

    it('reports API and data model contract drift to the owning agents', () => {
      process.env.ORCHESTRATION_TYPECHECK = 'false';
      try {
        const state = domainState(['Invoice tracking']);
        const apiContractArtifact = createBackendApiContractArtifact(state);
        const dataModelArtifact = createDatabaseModelContractArtifact({
          ...state,
          artifacts: [apiContractArtifact],
        } as DevFlowStateType);
        const artifacts: GeneratedArtifact[] = [
          apiContractArtifact,
          {
            agentType: 'backend',
            filePath: 'src/orders.controller.ts',
            content: 'import { Controller, Get } from "@nestjs/common"; @Controller("orders") export class OrdersController { @Get() list(): string { return "orders"; } }',
            language: 'typescript',
          },
          dataModelArtifact,
          {
            agentType: 'database',
            filePath: 'prisma/schema.prisma',
            content: 'model Order {\n  id String @id @default(cuid())\n}',
            language: 'prisma',
          },
        ];

        const errors = service.validateBatch(artifacts, 'proj-1');
        expect(errors.some(e => e.agentType === 'backend' && e.message.includes('invoice-tracking'))).toBe(true);
        expect(errors.some(e => e.agentType === 'database' && e.message.includes('InvoiceTracking'))).toBe(true);
      } finally {
        delete process.env.ORCHESTRATION_TYPECHECK;
      }
    });

    it('reports missing ADR coverage to the architecture owner', () => {
      const state = domainState(['Invoice tracking']);
      const errors = service.validateBatch([
        createArchitectureReviewContractArtifact(state),
        {
          agentType: 'architecture',
          filePath: 'ARCHITECTURE.md',
          content: '# Architecture\n\nSystem overview for the operations hub with components and data flow.',
          language: 'markdown',
        },
        {
          agentType: 'architecture',
          filePath: 'ADRS.md',
          content: '# ADRS\n\n## ADR: Stack\n\nWe use the selected stack for implementation consistency.',
          language: 'markdown',
        },
      ], 'proj-1');

      expect(errors.some(e => e.agentType === 'architecture' && e.message.includes('must cover api decisions'))).toBe(true);
    });
  });
});
