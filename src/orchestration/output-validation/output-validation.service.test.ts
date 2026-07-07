import { describe, it, expect } from 'vitest';
import { WorkOrderAgentType } from '@prisma/client';
import { OutputValidationService } from './output-validation.service';
import type { GeneratedWorkOrderOutput, WorkOrderAgentContext } from '../providers/agent-provider.types';
import type { GeneratedArtifact } from '../graph/devflow.state';

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
  });
});
