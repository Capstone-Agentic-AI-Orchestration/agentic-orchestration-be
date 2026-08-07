import { Injectable } from '@nestjs/common';
import {
  AgentProviderMode,
  AgentProviderStatus,
  WorkOrderAgentProvider,
} from './agent-provider.types';
import { LlmAgentProvider } from './llm-agent.provider';
import { MockAgentProvider } from './mock-agent.provider';
import { CompanionAgentProvider } from './companion-agent.provider';
import { llmConcurrencyLimit, llmRequestTimeoutMs } from './llm-runtime';

@Injectable()
export class AgentProviderRegistry {
  constructor(
    private readonly mockAgentProvider: MockAgentProvider,
    private readonly llmAgentProvider: LlmAgentProvider,
    private readonly companionAgentProvider: CompanionAgentProvider,
  ) {}

  getStatus(): AgentProviderStatus {
    const requestedMode = this.requestedMode();
    const llmMissingRequirements = this.llmAgentProvider.missingRequirements();
    const llmAvailable = this.llmAgentProvider.isAvailable();
    const llmReason = this.llmAgentProvider.unavailableReason();
    const providers = [
      {
        mode: this.mockAgentProvider.mode,
        displayName: 'Mock Agent Provider',
        active: requestedMode === this.mockAgentProvider.mode,
        available: true,
        implemented: true,
        missingRequirements: [],
        reason: null,
      },
      {
        // Phase 3: simulation runs the real-shaped graph with deterministic,
        // event-rich nodes. Always available — no keys or external access.
        mode: 'simulation' as AgentProviderMode,
        displayName: 'Simulation Provider',
        active: requestedMode === 'simulation',
        available: true,
        implemented: true,
        missingRequirements: [],
        reason: null,
      },
      {
        mode: this.llmAgentProvider.mode,
        displayName: `${this.providerDisplayName(this.llmAgentProvider.providerName())} LLM Provider`,
        active: requestedMode === this.llmAgentProvider.mode,
        available: llmAvailable,
        implemented: true,
        missingRequirements: llmMissingRequirements,
        reason: llmReason,
        provider: this.llmAgentProvider.providerName(),
        model: this.llmAgentProvider.model(),
        fallbackModel: this.llmAgentProvider.fallbackModel(),
        requestTimeoutMs: llmRequestTimeoutMs(),
        concurrencyLimit: llmConcurrencyLimit(),
      },
      {
        // Whether a machine is actually awake is a live question, and this method is synchronous and
        // called on hot paths. Reporting the mode as available and letting dispatch fail with a
        // precise, actionable message beats making every caller of getStatus() async.
        mode: 'companion' as AgentProviderMode,
        displayName: 'Local Machine (Claude Code / Codex)',
        active: requestedMode === 'companion',
        available: true,
        implemented: true,
        missingRequirements: [],
        reason: null,
        provider: 'companion',
      },
    ];
    const activeProvider = providers.find((provider) => provider.active) ?? providers[0];

    return {
      requestedMode,
      activeMode: activeProvider.mode,
      available: activeProvider.available,
      fallbackMode: activeProvider.available ? null : this.mockAgentProvider.mode,
      missingRequirements: activeProvider.missingRequirements,
      reason: activeProvider.reason,
      provider: activeProvider.provider,
      model: activeProvider.model,
      fallbackModel: activeProvider.fallbackModel,
      requestTimeoutMs: activeProvider.requestTimeoutMs,
      concurrencyLimit: activeProvider.concurrencyLimit,
      providers,
    };
  }

  getActiveProviderOrThrow(): WorkOrderAgentProvider {
    const status = this.getStatus();
    if (!status.available) {
      throw new Error(
        `Agent provider ${status.activeMode} is unavailable: ${status.reason}`,
      );
    }

    if (status.activeMode === 'companion') return this.companionAgentProvider;
    return status.activeMode === this.llmAgentProvider.mode
      ? this.llmAgentProvider
      : this.mockAgentProvider;
  }

  requestedMode(): AgentProviderMode {
    if (process.env.AGENT_PROVIDER === 'llm') return 'llm';
    if (process.env.AGENT_PROVIDER === 'simulation') return 'simulation';
    if (process.env.AGENT_PROVIDER === 'companion') return 'companion';
    return 'mock';
  }

  activeMode(): AgentProviderMode {
    return this.getStatus().activeMode;
  }

  private providerDisplayName(provider: string): string {
    const names: Record<string, string> = {
      openrouter: 'OpenRouter',
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      opencode: 'OpenCode',
      gemini: 'Gemini',
    };

    return names[provider] ?? provider;
  }
}
