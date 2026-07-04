import type { ProjectContract, RequirementsDocument } from '../../graph/devflow.state';

export interface TemplateContext {
  projectId: string;
  projectName: string;
  companyName: string;
  description: string;
  brief: string;
  stackKey: string;
  contract: ProjectContract;
  requirements: RequirementsDocument;
  features: string[];
  acceptanceCriteria: string[];
  fileManifest: string[];
}
