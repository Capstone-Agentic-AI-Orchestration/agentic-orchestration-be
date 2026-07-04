import { describe, it, expect } from 'vitest';
import { WorkOrderAgentType } from '@prisma/client';
import { ProjectScaffolderService } from './project-scaffolder.service';
import type { ProjectContract, GeneratedArtifact } from '../graph/devflow.state';

function mockContract(overrides?: Partial<ProjectContract>): ProjectContract {
  return {
    projectId: 'proj-test-1',
    projectName: 'TestApp',
    description: 'A test application',
    requirements: {
      projectType: 'web-app',
      features: ['User auth', 'Dashboard'],
      techStack: { frontend: 'Next.js', backend: 'NestJS', database: 'PostgreSQL', styling: 'Tailwind' },
      complexity: 'medium',
      estimatedFiles: 12,
    },
    fileManifest: ['src/app/page.tsx', 'src/main.ts', 'prisma/schema.prisma'],
    acceptanceCriteria: ['Must compile', 'Must run'],
    lockedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ProjectScaffolderService', () => {
  const service = new ProjectScaffolderService();
  const contract = mockContract();

  describe('scaffold', () => {
    it('returns frontend templates for FRONTEND agent type', () => {
      const files = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.FRONTEND,
        contract,
        companyName: 'TestCo',
      });
      const paths = files.map((f) => f.filePath);
      expect(paths).toContain('package.json');
      expect(paths).toContain('tsconfig.json');
      expect(paths).toContain('next.config.ts');
      expect(paths).toContain('postcss.config.mjs');
      expect(paths).toContain('src/app/layout.tsx');
      expect(paths).toContain('src/styles/globals.css');
      expect(paths).toContain('README-frontend.md');
      expect(files).toHaveLength(7);
    });

    it('returns backend templates for BACKEND agent type', () => {
      const files = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.BACKEND,
        contract,
        companyName: 'TestCo',
      });
      const paths = files.map((f) => f.filePath);
      expect(paths).toContain('package.json');
      expect(paths).toContain('tsconfig.json');
      expect(paths).toContain('nest-cli.json');
      expect(paths).toContain('tsconfig.build.json');
      expect(paths).toContain('README-backend.md');
      expect(files).toHaveLength(5);
    });

    it('returns database templates for DATABASE agent type', () => {
      const files = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.DATABASE,
        contract,
        companyName: 'TestCo',
      });
      const paths = files.map((f) => f.filePath);
      expect(paths).toContain('prisma/schema.prisma');
      expect(paths).toContain('README-database.md');
      expect(files).toHaveLength(2);
    });

    it('returns empty for ARCHITECTURE agent type', () => {
      const files = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.ARCHITECTURE,
        contract,
        companyName: 'TestCo',
      });
      expect(files).toHaveLength(0);
    });

    it('returns empty for CONTRACT agent type', () => {
      const files = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.CONTRACT,
        contract,
        companyName: 'TestCo',
      });
      expect(files).toHaveLength(0);
    });

    it('produces non-empty content for every template', () => {
      const allTypes = Object.values(WorkOrderAgentType);
      for (const agentType of allTypes) {
        const files = service.scaffold({
          projectId: 'proj-1',
          agentType,
          contract,
          companyName: 'TestCo',
        });
        for (const file of files) {
          expect(file.content, `${file.filePath} should have content`).toBeTruthy();
          expect(file.content.length, `${file.filePath} should be > 20 chars`).toBeGreaterThan(20);
          expect(file.source).toBe('scaffold');
        }
      }
    });

    it('includes project name in frontend layout and readme', () => {
      const files = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.FRONTEND,
        contract: mockContract({ projectName: 'MyCoolProject' }),
        companyName: 'TestCo',
      });
      const layout = files.find((f) => f.filePath === 'src/app/layout.tsx');
      expect(layout?.content).toContain('MyCoolProject');
      const readme = files.find((f) => f.filePath === 'README-frontend.md');
      expect(readme?.content).toContain('MyCoolProject');
    });
  });

  describe('merge', () => {
    it('overlays scaffold files on LLM artifacts', () => {
      const llmArtifacts: GeneratedArtifact[] = [
        { agentType: 'backend', filePath: 'src/main.ts', content: '// LLM main', language: 'typescript' },
        { agentType: 'frontend', filePath: 'package.json', content: '{"name":"llm-generated"}', language: 'json' },
      ];
      const scaffoldFiles = service.scaffold({
        projectId: 'proj-1',
        agentType: WorkOrderAgentType.FRONTEND,
        contract,
        companyName: 'TestCo',
      });

      const merged = service.merge(llmArtifacts, scaffoldFiles, 'frontend');
      const pkg = merged.find((a) => a.filePath === 'package.json');
      expect(pkg?.content).not.toBe('{"name":"llm-generated"}');
      expect(pkg?.content).toContain('next');
      const main = merged.find((a) => a.filePath === 'src/main.ts');
      expect(main?.content).toBe('// LLM main');
    });
  });
});
