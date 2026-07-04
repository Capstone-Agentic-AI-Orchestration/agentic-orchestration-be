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
  });
});
