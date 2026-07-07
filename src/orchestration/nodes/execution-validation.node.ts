import { Injectable, Logger } from '@nestjs/common';
import type { DevFlowStateType } from '../graph/devflow.state';
import { NODE } from '../graph/topology';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { ExecutionValidationService } from '../execution-validation/execution-validation.service';

@Injectable()
export class ExecutionValidationNode {
  private readonly logger = new Logger(ExecutionValidationNode.name);
  private static readonly MAX_RETRIES = 5;

  constructor(
    private readonly executionValidation: ExecutionValidationService,
    private readonly streamEmitter: StreamEmitter,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    const mode = this.executionValidation.mode();
    this.logger.log(`[${projectId}] Running sandbox execution validation (${mode})`);

    try {
      this.streamEmitter.emit(
        projectId,
        NODE.EXECUTION_VALIDATE_OUTPUTS,
        runId ?? '',
        'decision',
        mode === 'off'
          ? 'Sandbox execution validation is disabled.'
          : 'Materializing generated artifacts for build validation...',
      );
      this.streamEmitter.progress(
        projectId,
        NODE.EXECUTION_VALIDATE_OUTPUTS,
        runId ?? '',
        30,
        'Preparing sandbox',
      );

      const report = await this.executionValidation.validate(state);

      this.streamEmitter.progress(
        projectId,
        NODE.EXECUTION_VALIDATE_OUTPUTS,
        runId ?? '',
        90,
        'Collecting execution results',
      );

      const failed = report.checks.filter((check) => check.status === 'failed');
      if (report.valid || mode === 'advisory') {
        this.streamEmitter.emit(
          projectId,
          NODE.EXECUTION_VALIDATE_OUTPUTS,
          runId ?? '',
          'decision',
          report.valid
            ? `Sandbox execution validation passed (${report.checks.length} checks).`
            : `Sandbox execution validation found ${failed.length} failure(s), but advisory mode will not block delivery.`,
        );
        return {
          executionValidation: report,
          retryPlan: [],
          error: null,
        };
      }

      const retryPlan = report.retryPlan ?? [];
      this.streamEmitter.emit(
        projectId,
        NODE.EXECUTION_VALIDATE_OUTPUTS,
        runId ?? '',
        'decision',
        `Sandbox execution validation failed: ${failed.length} check(s) failed for ${retryPlan.map((d) => d.agentType).join(', ') || 'generated artifacts'}.`,
      );

      if (state.retryCount < ExecutionValidationNode.MAX_RETRIES - 1) {
        return {
          executionValidation: report,
          retryPlan,
          retryCount: state.retryCount + 1,
          error: null,
        };
      }

      return {
        executionValidation: report,
        retryPlan: [],
        error: `Execution validation exceeded max retries. Failed checks: ${failed
          .map((check) => `${check.agentType}:${check.name}:${check.summary}`)
          .join('; ')}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${projectId}] Execution validation failed: ${message}`);
      this.streamEmitter.emit(
        projectId,
        NODE.EXECUTION_VALIDATE_OUTPUTS,
        runId ?? '',
        'error',
        `Execution validation failed: ${humanReadableError(message)}`,
      );
      return { error: `ExecutionValidationNode failed: ${message}` };
    }
  }
}
