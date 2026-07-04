import { Injectable } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import type { GeneratedWorkOrderOutput, WorkOrderAgentContext } from '../providers/agent-provider.types';
import type { GeneratedArtifact } from '../graph/devflow.state';
import { AGENT_SCHEMAS } from './schemas/artifact-schemas';
import type { ValidationError, ValidationResult } from './schemas/schema.types';
import { checkSyntax } from './syntax-checkers/index';
import { checkTypeScriptProgram } from './syntax-checkers/typescript.program.checker';
import { checkIntegration } from './cross-artifact/integration.checker';

@Injectable()
export class OutputValidationService {
  validate(
    output: GeneratedWorkOrderOutput,
    context: WorkOrderAgentContext,
  ): ValidationResult {
    const errors: ValidationError[] = [
      ...this.validateBase(output, context),
      ...this.validateSchema(output, context.workOrder.agentType),
      ...this.validateSyntax(output),
    ];

    return {
      valid: errors.length === 0,
      errors,
      summary: errors.length === 0
        ? `${context.workOrder.agentType} output valid`
        : `${context.workOrder.agentType} output failed: ${errors.map(e => e.message).join('; ')}`,
    };
  }

  validateBatch(
    artifacts: GeneratedArtifact[],
    projectId: string,
  ): ValidationError[] {
    const all: ValidationError[] = [];
    // Files that already failed the single-file parser; the program-level
    // type-check is skipped for these because semantic diagnostics cascade
    // unreliably off a syntax error.
    const filesWithSyntaxErrors = new Set<string>();

    for (const artifact of artifacts) {
      const errors = this.validateArtifact(artifact, projectId);
      if (errors.some((e) => e.code === 'TS_SYNTAX')) {
        filesWithSyntaxErrors.add(artifact.filePath);
      }
      all.push(...errors);
    }

    all.push(...this.validateProgram(artifacts, filesWithSyntaxErrors));
    all.push(...this.validateIntegration(artifacts));

    return all;
  }

  /**
   * Cross-artifact integration checking: verifies the seams *between* agents —
   * frontend API calls reach a backend route, backend `prisma.<model>` access
   * resolves to a declared schema model. Findings are `CONTRACT` errors
   * attributed to the agent making the unsatisfied reference.
   *
   * Opt-out via `ORCHESTRATION_INTEGRATION_CHECK=false`.
   */
  private validateIntegration(
    artifacts: GeneratedArtifact[],
  ): ValidationError[] {
    if (process.env.ORCHESTRATION_INTEGRATION_CHECK === 'false') return [];
    return checkIntegration(
      artifacts.map((a) => ({
        agentType: a.agentType,
        filePath: a.filePath,
        content: a.content,
      })),
    );
  }

  private validateArtifact(
    artifact: GeneratedArtifact,
    _projectId: string,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!artifact.filePath?.trim()) {
      errors.push({ code: 'BASE', message: 'Artifact filePath is required' });
    }
    if (!artifact.content?.trim() || artifact.content.trim().length < 40) {
      errors.push({ code: 'BASE', message: `Artifact ${artifact.filePath} content must be at least 40 non-empty characters` });
    }

    errors.push(...checkSyntax(artifact.content, artifact.filePath));

    // Stamp the owning agent so the validator can route retries precisely.
    return errors.map((e) => ({ agentType: artifact.agentType, ...e }));
  }

  /**
   * Type-aware cross-file checking: builds a `ts.Program` over the whole
   * artifact set and reports the high-signal "references something that does
   * not exist" diagnostics the single-file parser cannot see. Each error is
   * attributed back to the agent that owns the offending file.
   *
   * Opt-out via `ORCHESTRATION_TYPECHECK=false` if it proves noisy in a given
   * environment.
   */
  private validateProgram(
    artifacts: GeneratedArtifact[],
    skipPaths: Set<string>,
  ): ValidationError[] {
    if (process.env.ORCHESTRATION_TYPECHECK === 'false') return [];

    const agentByPath = new Map(artifacts.map((a) => [a.filePath, a.agentType]));
    const programErrors = checkTypeScriptProgram(
      artifacts.map((a) => ({ filePath: a.filePath, content: a.content })),
    );

    const out: ValidationError[] = [];
    for (const [filePath, errors] of programErrors) {
      if (skipPaths.has(filePath)) continue;
      for (const error of errors) {
        out.push({ ...error, agentType: agentByPath.get(filePath) });
      }
    }
    return out;
  }

  private validateBase(
    output: GeneratedWorkOrderOutput,
    context: WorkOrderAgentContext,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const expectedPrefix = `work-orders/${context.workOrder.id}/`;

    if (!output.filePath?.trim()) {
      errors.push({ code: 'BASE', message: 'filePath is required' });
    } else if (!output.filePath.startsWith(expectedPrefix)) {
      errors.push({ code: 'BASE', message: `filePath must start with ${expectedPrefix}` });
    }

    if (!output.displayName?.trim()) {
      errors.push({ code: 'BASE', message: 'displayName is required' });
    }

    if (!output.content?.trim() || output.content.trim().length < 40) {
      errors.push({ code: 'BASE', message: 'content must be at least 40 non-empty characters' });
    }

    return errors;
  }

  private validateSchema(
    output: GeneratedWorkOrderOutput,
    agentType: WorkOrderAgentType,
  ): ValidationError[] {
    const schema = AGENT_SCHEMAS[agentType];
    const result = schema.safeParse({
      filePath: output.filePath,
      content: output.content,
    });

    if (result.success) return [];

    return result.error.issues.map(issue => ({
      code: 'SCHEMA_VIOLATION' as const,
      path: issue.path.join('.'),
      message: issue.message,
    }));
  }

  private validateSyntax(output: GeneratedWorkOrderOutput): ValidationError[] {
    return checkSyntax(output.content, output.filePath);
  }
}
