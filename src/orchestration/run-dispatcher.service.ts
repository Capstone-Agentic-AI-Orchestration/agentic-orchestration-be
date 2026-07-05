import { Injectable, Logger } from '@nestjs/common';

export interface OrchestrationDispatchOptions {
  label: string;
  projectId: string;
  runId: string;
  task: () => Promise<unknown>;
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * Owns the async handoff between the API control plane and long-running
 * orchestration execution. Today this dispatches in-process; the interface is
 * intentionally narrow so a durable queue can replace the implementation later.
 */
@Injectable()
export class OrchestrationRunDispatcher {
  private readonly logger = new Logger(OrchestrationRunDispatcher.name);
  private warnedUnsupportedMode = false;

  dispatch(options: OrchestrationDispatchOptions): void {
    const mode = process.env.ORCHESTRATION_DISPATCHER_MODE ?? 'in-process';

    if (mode !== 'in-process' && !this.warnedUnsupportedMode) {
      this.warnedUnsupportedMode = true;
      this.logger.warn(
        `Unsupported ORCHESTRATION_DISPATCHER_MODE="${mode}"; falling back to in-process dispatch.`,
      );
    }

    setImmediate(() => {
      void options.task().catch((error: unknown) => {
        void this.handleError(options, error);
      });
    });
  }

  private async handleError(
    options: OrchestrationDispatchOptions,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `Dispatched orchestration task "${options.label}" failed for project ${options.projectId} run ${options.runId}: ${message}`,
    );

    try {
      await options.onError?.(error);
    } catch (handlerError) {
      const handlerMessage = handlerError instanceof Error
        ? handlerError.message
        : String(handlerError);
      this.logger.error(
        `Error handler for orchestration task "${options.label}" failed for project ${options.projectId} run ${options.runId}: ${handlerMessage}`,
      );
    }
  }
}
