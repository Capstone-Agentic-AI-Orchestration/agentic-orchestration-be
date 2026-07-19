import { Injectable, Logger, Optional } from '@nestjs/common';
import { DirectLlmProvider, type DirectLlmJsonOptions, type DirectLlmJsonResult } from './direct-llm.provider';
import { EveLlmProvider } from './eve-llm.provider';
import type { AgentLlmEngine, AgentLlmEngineStatus } from './agent-provider.types';
import { ProviderInvocationService } from './provider-invocation.service';

/**
 * Eve migration — the LLM access point every agent node injects.
 *
 * Routes a generation turn to either the in-process provider ({@link DirectLlmProvider}, raw
 * fetch with multi-provider fallback + JSON repair) or the external Eve agent service
 * ({@link EveLlmProvider}), selected by `ORCHESTRATION_LLM_ENGINE`. The two providers expose an
 * identical `generateJson` contract, so nodes are engine-agnostic — they call
 * `this.llm.generateJson(...)` and never know which backend served the turn.
 *
 * Safety: Eve is used only when `ORCHESTRATION_LLM_ENGINE=eve` AND the Eve service is configured
 * (EVE_SERVICE_URL). Otherwise it transparently falls back to the direct provider, so flipping the
 * flag without a deployed Eve service degrades gracefully instead of failing runs.
 */
@Injectable()
export class AgentLlmRouter {
  private readonly logger = new Logger(AgentLlmRouter.name);
  private warnedGraphAlias = false;

  constructor(
    private readonly direct: DirectLlmProvider,
    @Optional() private readonly eve: EveLlmProvider | null,
    @Optional() private readonly invocations: ProviderInvocationService | null = null,
  ) {}

  requestedEngine(): AgentLlmEngine {
    return this.rawRequestedEngine() === 'eve' ? 'eve' : 'direct';
  }

  getStatus(): AgentLlmEngineStatus {
    const requestedEngine = this.requestedEngine();
    const deprecatedAlias = this.rawRequestedEngine() === 'graph';
    const eveServiceConfigured = Boolean(this.eve?.isConfigured());
    const fallbackReason = requestedEngine === 'eve' && !eveServiceConfigured
      ? 'EVE_SERVICE_URL is not configured; using the in-process direct provider.'
      : deprecatedAlias
        ? 'ORCHESTRATION_LLM_ENGINE=graph is deprecated; use direct.'
        : null;

    return {
      requestedEngine,
      activeEngine: requestedEngine === 'eve' && eveServiceConfigured ? 'eve' : 'direct',
      fallbackReason,
      eveServiceConfigured,
      model:
        requestedEngine === 'eve' && eveServiceConfigured
          ? `eve:${process.env.EVE_MODEL ?? 'ai-gateway'}`
          : this.direct.model(),
    };
  }

  /** Whether this turn should be delegated to the Eve service. */
  private useEve(): boolean {
    if (this.requestedEngine() !== 'eve') return false;
    if (!this.eve?.isConfigured()) {
      this.logger.warn(
        'ORCHESTRATION_LLM_ENGINE=eve but EVE_SERVICE_URL is not set — falling back to the in-process direct provider.',
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
  async generateJson<T>(options: DirectLlmJsonOptions): Promise<DirectLlmJsonResult<T>> {
    const useEve = this.useEve() && this.eve;
    const engine = useEve ? 'eve' : 'direct';
    const provider = engine === 'eve' ? 'eve' : this.direct.providerName();
    const requestId = this.invocations?.ensureRequestId(options.correlation) ?? options.correlation?.requestId;
    const correlation = { ...options.correlation, requestId };
    const agent = correlation.agent ?? options.subagent ?? options.agentName;
    const invocation = await this.invocations?.start({
      correlation,
      agent,
      engine,
      provider,
      model: engine === 'eve' ? this.getStatus().model : this.direct.model(),
    }) ?? null;
    const routedOptions = { ...options, correlation: { ...correlation, requestId: invocation?.requestId ?? requestId } };

    try {
      const result = useEve
        ? await this.eve!.generateJson<T>(routedOptions)
        : await this.direct.generateJson<T>(routedOptions);
      await this.invocations?.succeed(invocation, result);
      return result;
    } catch (error) {
      await this.invocations?.fail(invocation, error);
      throw error;
    }
  }

  private rawRequestedEngine(): 'eve' | 'direct' | 'graph' {
    const raw = process.env.ORCHESTRATION_LLM_ENGINE;
    if (raw === 'eve' || raw === 'direct') return raw;
    if (raw === 'graph') {
      if (!this.warnedGraphAlias) {
        this.warnedGraphAlias = true;
        this.logger.warn('ORCHESTRATION_LLM_ENGINE=graph is deprecated; use direct.');
      }
      return 'graph';
    }
    return 'eve';
  }
}
