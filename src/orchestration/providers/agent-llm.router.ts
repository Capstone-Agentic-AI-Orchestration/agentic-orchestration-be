import { Injectable, Logger, Optional } from '@nestjs/common';
import { GraphLlmProvider, type GraphLlmJsonOptions, type GraphLlmJsonResult } from './graph-llm.provider';
import { EveLlmProvider } from './eve-llm.provider';
import type { AgentLlmEngine, AgentLlmEngineStatus } from './agent-provider.types';

/**
 * Eve migration — the LLM access point every agent node injects.
 *
 * Routes a generation turn to either the in-process provider ({@link GraphLlmProvider}, raw
 * fetch with multi-provider fallback + JSON repair) or the external Eve agent service
 * ({@link EveLlmProvider}), selected by `ORCHESTRATION_LLM_ENGINE`. The two providers expose an
 * identical `generateJson` contract, so nodes are engine-agnostic — they call
 * `this.llm.generateJson(...)` and never know which backend served the turn.
 *
 * Safety: Eve is used only when `ORCHESTRATION_LLM_ENGINE=eve` AND the Eve service is configured
 * (EVE_SERVICE_URL). Otherwise it transparently falls back to the graph provider, so flipping the
 * flag without a deployed Eve service degrades gracefully instead of failing runs.
 */
@Injectable()
export class AgentLlmRouter {
  private readonly logger = new Logger(AgentLlmRouter.name);

  constructor(
    private readonly graph: GraphLlmProvider,
    @Optional() private readonly eve: EveLlmProvider | null,
  ) {}

  requestedEngine(): AgentLlmEngine {
    return process.env.ORCHESTRATION_LLM_ENGINE === 'graph' ? 'graph' : 'eve';
  }

  getStatus(): AgentLlmEngineStatus {
    const requestedEngine = this.requestedEngine();
    const eveServiceConfigured = Boolean(this.eve?.isConfigured());
    const fallbackReason =
      requestedEngine === 'eve' && !eveServiceConfigured
        ? 'EVE_SERVICE_URL is not configured; using the in-process graph provider.'
        : null;

    return {
      requestedEngine,
      activeEngine: requestedEngine === 'eve' && eveServiceConfigured ? 'eve' : 'graph',
      fallbackReason,
      eveServiceConfigured,
      model:
        requestedEngine === 'eve' && eveServiceConfigured
          ? `eve:${process.env.EVE_MODEL ?? 'ai-gateway'}`
          : this.graph.model(),
    };
  }

  /** Whether this turn should be delegated to the Eve service. */
  private useEve(): boolean {
    if (this.requestedEngine() !== 'eve') return false;
    if (!this.eve?.isConfigured()) {
      this.logger.warn(
        'ORCHESTRATION_LLM_ENGINE=eve but EVE_SERVICE_URL is not set — falling back to the in-process graph provider.',
      );
      return false;
    }
    return true;
  }

  /** Label of the active backend/model, used for log lines. */
  model(): string {
    return this.getStatus().model;
  }

  /** Delegates JSON generation to the selected engine. Identical signature on both providers. */
  generateJson<T>(options: GraphLlmJsonOptions): Promise<GraphLlmJsonResult<T>> {
    return this.useEve() && this.eve
      ? this.eve.generateJson<T>(options)
      : this.graph.generateJson<T>(options);
  }
}
