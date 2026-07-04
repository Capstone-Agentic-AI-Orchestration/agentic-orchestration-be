import { Injectable } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { GeneratedWorkOrderOutput, WorkOrderAgentContext } from './agent-provider.types';
import {
  agentArtifactContractFor,
  ORCHESTRATION_CONTRACT_VERSION,
} from './agent-contracts';

export interface ArtifactContractValidationResult {
  valid: boolean;
  summary: string;
  errors: string[];
}

@Injectable()
export class ArtifactContractValidator {
  validate(
    output: GeneratedWorkOrderOutput,
    context: WorkOrderAgentContext,
  ): ArtifactContractValidationResult {
    const errors = [
      ...this.validateBase(output, context),
      ...this.validateByAgent(output, context.workOrder.agentType),
    ];

    return {
      valid: errors.length === 0,
      summary: errors.length === 0
        ? `${context.workOrder.agentType} artifact contract ${ORCHESTRATION_CONTRACT_VERSION} passed`
        : `${context.workOrder.agentType} artifact contract ${ORCHESTRATION_CONTRACT_VERSION} failed`,
      errors,
    };
  }

  private validateBase(
    output: GeneratedWorkOrderOutput,
    context: WorkOrderAgentContext,
  ): string[] {
    const errors: string[] = [];
    const expectedPrefix = `work-orders/${context.workOrder.id}/`;

    if (!output.filePath?.trim()) {
      errors.push('filePath is required');
    } else if (!output.filePath.startsWith(expectedPrefix)) {
      errors.push(`filePath must start with ${expectedPrefix}`);
    }

    if (!output.displayName?.trim()) {
      errors.push('displayName is required');
    }

    if (!output.content?.trim() || output.content.trim().length < 40) {
      errors.push('content must be at least 40 non-empty characters');
    }

    return errors;
  }

  private validateByAgent(
    output: GeneratedWorkOrderOutput,
    agentType: WorkOrderAgentType,
  ): string[] {
    const contract = agentArtifactContractFor(agentType);
    return [
      ...this.expectExtension(output.filePath, contract.requiredExtensions),
      ...contract.requiredSignals.flatMap((signal) =>
        this.expectAny(output.content, signal.anyOf, signal.message),
      ),
    ];
  }

  private expectExtension(filePath: string, extensions: string[]): string[] {
    const lower = filePath.toLowerCase();
    return extensions.some((extension) => lower.endsWith(extension))
      ? []
      : [`filePath must end with ${extensions.join(' or ')}`];
  }

  private expectAny(content: string, needles: string[], message: string): string[] {
    return needles.some((needle) => content.includes(needle)) ? [] : [message];
  }
}
