import { Injectable } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import type { ProjectContract, GeneratedArtifact } from '../graph/devflow.state';
import type { TemplateContext } from './templates/types';

import { frontendPackageJson } from './templates/frontend/package.json';
import { frontendTsconfig } from './templates/frontend/tsconfig.json';
import { frontendNextConfig } from './templates/frontend/next.config.ts';
import { frontendPostcssConfig } from './templates/frontend/postcss.config.mjs';
import { frontendLayout } from './templates/frontend/layout.tsx';
import { frontendGlobalsCss } from './templates/frontend/globals.css';
import { frontendReadme } from './templates/frontend/readme';

import { backendPackageJson } from './templates/backend/package.json';
import { backendTsconfig } from './templates/backend/tsconfig.json';
import { backendNestCli } from './templates/backend/nest-cli.json';
import { backendTsconfigBuild } from './templates/backend/tsconfig.build.json';
import { backendReadme } from './templates/backend/readme';

import { databasePrismaSchema } from './templates/database/schema.prisma';
import { databaseReadme } from './templates/database/readme';

export interface ScaffoldRequest {
  projectId: string;
  agentType: WorkOrderAgentType;
  contract: ProjectContract;
  companyName: string;
}

export interface ScaffoldedFile {
  filePath: string;
  content: string;
  language: string;
  source: 'scaffold';
}

type ScaffoldGenerator = (ctx: TemplateContext) => string;

interface ScaffoldTemplate {
  filePath: string;
  language: string;
  generate: ScaffoldGenerator;
}

const FRONTEND_TEMPLATES: ScaffoldTemplate[] = [
  { filePath: 'package.json', language: 'json', generate: frontendPackageJson },
  { filePath: 'tsconfig.json', language: 'json', generate: frontendTsconfig },
  { filePath: 'next.config.ts', language: 'typescript', generate: () => frontendNextConfig() },
  { filePath: 'postcss.config.mjs', language: 'javascript', generate: () => frontendPostcssConfig() },
  { filePath: 'src/app/layout.tsx', language: 'typescript', generate: frontendLayout },
  { filePath: 'src/styles/globals.css', language: 'css', generate: () => frontendGlobalsCss() },
  { filePath: 'README-frontend.md', language: 'markdown', generate: frontendReadme },
];

const BACKEND_TEMPLATES: ScaffoldTemplate[] = [
  { filePath: 'package.json', language: 'json', generate: backendPackageJson },
  { filePath: 'tsconfig.json', language: 'json', generate: () => backendTsconfig() },
  { filePath: 'nest-cli.json', language: 'json', generate: () => backendNestCli() },
  { filePath: 'tsconfig.build.json', language: 'json', generate: () => backendTsconfigBuild() },
  { filePath: 'README-backend.md', language: 'markdown', generate: backendReadme },
];

const DATABASE_TEMPLATES: ScaffoldTemplate[] = [
  { filePath: 'prisma/schema.prisma', language: 'prisma', generate: () => databasePrismaSchema() },
  { filePath: 'README-database.md', language: 'markdown', generate: databaseReadme },
];

const AGENT_TEMPLATES: Partial<Record<WorkOrderAgentType, ScaffoldTemplate[]>> = {
  [WorkOrderAgentType.FRONTEND]: FRONTEND_TEMPLATES,
  [WorkOrderAgentType.BACKEND]: BACKEND_TEMPLATES,
  [WorkOrderAgentType.DATABASE]: DATABASE_TEMPLATES,
  [WorkOrderAgentType.ARCHITECTURE]: [],
  [WorkOrderAgentType.CONTRACT]: [],
};

@Injectable()
export class ProjectScaffolderService {
  scaffold(req: ScaffoldRequest): ScaffoldedFile[] {
    const templates = AGENT_TEMPLATES[req.agentType];
    if (!templates || templates.length === 0) {
      return [];
    }

    const ctx = this.buildContext(req);
    return templates.map((t) => ({
      filePath: t.filePath,
      content: t.generate(ctx),
      language: t.language,
      source: 'scaffold' as const,
    }));
  }

  /**
   * Merge LLM-generated artifacts with scaffolded files.
   * Scaffold wins on its filePaths; LLM wins on everything else.
   */
  merge(
    llmArtifacts: GeneratedArtifact[],
    scaffoldFiles: ScaffoldedFile[],
    agentType: 'frontend' | 'backend' | 'database' | 'architecture',
  ): GeneratedArtifact[] {
    const scaffoldPaths = new Set(scaffoldFiles.map((f) => f.filePath));
    const artifactMap = new Map<string, GeneratedArtifact>();

    for (const artifact of llmArtifacts) {
      if (!scaffoldPaths.has(artifact.filePath)) {
        artifactMap.set(artifact.filePath, artifact);
      }
    }

    for (const s of scaffoldFiles) {
      artifactMap.set(s.filePath, {
        agentType,
        filePath: s.filePath,
        content: s.content,
        language: s.language,
        source: 'scaffold',
      });
    }

    return Array.from(artifactMap.values());
  }

  private buildContext(req: ScaffoldRequest): TemplateContext {
    return {
      projectId: req.projectId,
      projectName: req.contract.projectName,
      companyName: req.companyName,
      description: req.contract.description,
      brief: req.companyName,
      stackKey: req.contract.requirements.techStack.frontend,
      contract: req.contract,
      requirements: req.contract.requirements,
      features: req.contract.requirements.features,
      acceptanceCriteria: req.contract.acceptanceCriteria,
      fileManifest: req.contract.fileManifest,
    };
  }
}
