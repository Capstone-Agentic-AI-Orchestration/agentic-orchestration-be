import { Logger } from '@nestjs/common';
import { DevFlowStateType } from './devflow.state';
import { RequirementsParserNode } from '../nodes/requirements-parser.node';
import { ContractNegotiatorNode } from '../nodes/contract-negotiator.node';
import { FrontendAgentNode } from '../nodes/frontend-agent.node';
import { MobileAgentNode } from '../nodes/mobile-agent.node';
import { BackendAgentNode } from '../nodes/backend-agent.node';
import { DatabaseAgentNode } from '../nodes/database-agent.node';
import { ArchitectureAgentNode } from '../nodes/architecture-agent.node';
import { ValidatorNode } from '../nodes/validator.node';
import { ExecutionValidationNode } from '../nodes/execution-validation.node';
import { GithubCommitNode } from '../nodes/github-commit.node';
import { SelfCritiqueNode } from '../nodes/self-critique.node';
import { QualityReviewNode } from '../nodes/quality-review.node';
import { OrchestrationEmitter } from '../streaming/orchestration-emitter.service';
import { NODE } from './topology';

export { NODE } from './topology';

/**
 * Eve migration: this module previously compiled a LangGraph `StateGraph`. LangGraph is gone;
 * the pipeline is now executed by {@link OrchestrationSequencer}. This module's remaining job
 * is to (a) define the swappable processing-node implementation map and (b) provide the
 * per-node instrumentation wrapper the sequencer applies for lifecycle/telemetry. The wiring of
 * impls to live agent instances is unchanged, so the live and simulation runs still share one
 * builder + one topology.
 */

/** A swappable processing-node implementation (real LLM agents or simulation). */
export type NodeImpl = (
  state: DevFlowStateType,
) => Partial<DevFlowStateType> | Promise<Partial<DevFlowStateType>>;

/**
 * The processing nodes whose behavior varies by run mode. Gate checks and mark_delivered are
 * infrastructure (executed identically for every mode by the sequencer) and are NOT part of
 * this map.
 */
export interface DevFlowNodeImpls {
  [NODE.PARSE_REQUIREMENTS]: NodeImpl;
  [NODE.NEGOTIATE_CONTRACT]: NodeImpl;
  [NODE.FRONTEND_AGENT]: NodeImpl;
  /** Only dispatched for projects with a MOBILE repository — see `codeAgentsFor`. */
  [NODE.MOBILE_AGENT]: NodeImpl;
  [NODE.BACKEND_AGENT]: NodeImpl;
  [NODE.DATABASE_AGENT]: NodeImpl;
  [NODE.ARCHITECTURE_AGENT]: NodeImpl;
  [NODE.QA_REVIEW]: NodeImpl;
  [NODE.SELF_CRITIQUE]: NodeImpl;
  [NODE.SECURITY_REVIEW]: NodeImpl;
  [NODE.VALIDATE_OUTPUTS]: NodeImpl;
  [NODE.EXECUTION_VALIDATE_OUTPUTS]: NodeImpl;
  [NODE.COMMIT_TO_GITHUB]: NodeImpl;
}

const logger = new Logger('DevFlowGraph');

/**
 * Wraps a node implementation to emit precise lifecycle (entering/exiting/error) and wall-time
 * telemetry on the typed protocol channel. Unlike the LangGraph version there is no
 * NodeInterrupt to special-case — gate pauses are handled by the sequencer as explicit control
 * flow, not thrown signals.
 */
export function instrument(
  nodeId: string,
  action: NodeImpl,
  emitter?: OrchestrationEmitter | null,
): NodeImpl {
  return async (state: DevFlowStateType): Promise<Partial<DevFlowStateType>> => {
    const { projectId, runId } = state ?? ({} as DevFlowStateType);
    emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, 'entering');
    const startedAt = Date.now();
    try {
      const result = await action(state);
      emitter?.nodeTelemetry(projectId, nodeId, {
        runId: runId ?? undefined,
        wallMs: Date.now() - startedAt,
      });
      const phase = result && result.error ? 'error' : 'exiting';
      emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, phase);
      return result;
    } catch (error) {
      emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, 'error');
      logger.error(`[${state?.projectId}] Node ${nodeId} threw: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

/**
 * Builds the live node-implementation map from the injected agent node instances. Thin mapping
 * layer — the sequencer consumes this map and the topology to execute the run.
 */
export function buildDevFlowNodeImpls(
  requirementsParser: RequirementsParserNode,
  contractNegotiator: ContractNegotiatorNode,
  frontendAgent: FrontendAgentNode,
  mobileAgent: MobileAgentNode,
  backendAgent: BackendAgentNode,
  databaseAgent: DatabaseAgentNode,
  architectureAgent: ArchitectureAgentNode,
  qualityReview: Pick<QualityReviewNode, 'executeQa' | 'executeSecurity'>,
  selfCritique: SelfCritiqueNode,
  validator: ValidatorNode,
  executionValidation: ExecutionValidationNode,
  githubCommit: GithubCommitNode,
): DevFlowNodeImpls {
  return {
    [NODE.PARSE_REQUIREMENTS]: (state) => requirementsParser.execute(state),
    [NODE.NEGOTIATE_CONTRACT]: (state) => contractNegotiator.execute(state),
    [NODE.FRONTEND_AGENT]: (state) => frontendAgent.execute(state),
    [NODE.MOBILE_AGENT]: (state) => mobileAgent.execute(state),
    [NODE.BACKEND_AGENT]: (state) => backendAgent.execute(state),
    [NODE.DATABASE_AGENT]: (state) => databaseAgent.execute(state),
    [NODE.ARCHITECTURE_AGENT]: (state) => architectureAgent.execute(state),
    [NODE.QA_REVIEW]: (state) => qualityReview.executeQa(state),
    [NODE.SELF_CRITIQUE]: (state) => selfCritique.execute(state),
    [NODE.SECURITY_REVIEW]: (state) => qualityReview.executeSecurity(state),
    [NODE.VALIDATE_OUTPUTS]: (state) => validator.execute(state),
    [NODE.EXECUTION_VALIDATE_OUTPUTS]: (state) => executionValidation.execute(state),
    [NODE.COMMIT_TO_GITHUB]: (state) => githubCommit.execute(state),
  };
}
