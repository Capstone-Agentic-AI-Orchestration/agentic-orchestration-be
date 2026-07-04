import { WorkOrderAgentType } from '@prisma/client';

export const ORCHESTRATION_CONTRACT_VERSION = 'mock-work-order-v1';

export type AgentArtifactContract = {
  agentType: WorkOrderAgentType;
  slug: string;
  nodeName: string;
  displayName: string;
  language: string;
  fileName: string;
  requiredExtensions: string[];
  requiredSignals: {
    anyOf: string[];
    message: string;
  }[];
  handoffChecklist: string[];
};

export const AGENT_ARTIFACT_CONTRACTS = {
  [WorkOrderAgentType.FRONTEND]: {
    agentType: WorkOrderAgentType.FRONTEND,
    slug: 'frontend',
    nodeName: 'work_order_frontend',
    displayName: 'Frontend Agent',
    language: 'typescript',
    fileName: 'frontend-output.tsx',
    requiredExtensions: ['.tsx', '.jsx'],
    requiredSignals: [
      {
        anyOf: ['export function', 'export default'],
        message: 'frontend output must export a component',
      },
      {
        anyOf: ['<section', '<div', 'React'],
        message: 'frontend output must contain renderable UI',
      },
    ],
    handoffChecklist: [
      'Renderable UI entry point',
      'Client-facing copy derived from work-order instructions',
      'Ready for PM output review before client publication',
    ],
  },
  [WorkOrderAgentType.BACKEND]: {
    agentType: WorkOrderAgentType.BACKEND,
    slug: 'backend',
    nodeName: 'work_order_backend',
    displayName: 'Backend Agent',
    language: 'typescript',
    fileName: 'backend-output.ts',
    requiredExtensions: ['.ts'],
    requiredSignals: [
      {
        anyOf: ['export class', 'export function'],
        message: 'backend output must export a service or function',
      },
      {
        anyOf: ['@Injectable', 'describeWorkOrder', 'Controller'],
        message: 'backend output must include a NestJS-compatible contract signal',
      },
    ],
    handoffChecklist: [
      'NestJS-compatible service or controller contract',
      'Work-order and project identifiers included',
      'Ready for PM output review before client publication',
    ],
  },
  [WorkOrderAgentType.DATABASE]: {
    agentType: WorkOrderAgentType.DATABASE,
    slug: 'database',
    nodeName: 'work_order_database',
    displayName: 'Database Agent',
    language: 'sql',
    fileName: 'database-output.sql',
    requiredExtensions: ['.sql'],
    requiredSignals: [
      {
        anyOf: ['CREATE TABLE', 'ALTER TABLE'],
        message: 'database output must include DDL',
      },
      {
        anyOf: [';'],
        message: 'database output must include SQL statement terminators',
      },
    ],
    handoffChecklist: [
      'DDL statement with terminators',
      'Project-scoped schema identifiers',
      'Ready for PM output review before client publication',
    ],
  },
  [WorkOrderAgentType.ARCHITECTURE]: {
    agentType: WorkOrderAgentType.ARCHITECTURE,
    slug: 'architecture',
    nodeName: 'work_order_architecture',
    displayName: 'Architecture Agent',
    language: 'markdown',
    fileName: 'architecture-output.md',
    requiredExtensions: ['.md'],
    requiredSignals: [
      {
        anyOf: ['# ', '## Objective'],
        message: 'architecture output must be markdown with sections',
      },
      {
        anyOf: ['Delivery Notes', 'Objective'],
        message: 'architecture output must include delivery guidance',
      },
    ],
    handoffChecklist: [
      'Architecture objective',
      'Delivery guidance',
      'Ready for PM output review before client publication',
    ],
  },
  [WorkOrderAgentType.CONTRACT]: {
    agentType: WorkOrderAgentType.CONTRACT,
    slug: 'contract',
    nodeName: 'work_order_contract',
    displayName: 'Contract Agent',
    language: 'markdown',
    fileName: 'contract-output.md',
    requiredExtensions: ['.md'],
    requiredSignals: [
      {
        anyOf: ['Acceptance Checklist', 'Acceptance'],
        message: 'contract output must include acceptance criteria',
      },
      {
        anyOf: ['Scope', 'Delivery Contract'],
        message: 'contract output must include scope',
      },
    ],
    handoffChecklist: [
      'Scope statement',
      'Acceptance checklist',
      'Ready for PM output review before client publication',
    ],
  },
} satisfies Record<WorkOrderAgentType, AgentArtifactContract>;

export function agentArtifactContractFor(
  agentType: WorkOrderAgentType,
): AgentArtifactContract {
  return AGENT_ARTIFACT_CONTRACTS[agentType];
}
