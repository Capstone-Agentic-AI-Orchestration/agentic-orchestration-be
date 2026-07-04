import { Injectable } from '@nestjs/common';
import {
  BaseLlmProvider,
  type JsonShape,
  type LlmUsage,
} from './base-llm.provider';
import {
  selectedLlmProvider,
  type LlmProviderName,
} from './llm-runtime';

export interface GraphLlmJsonOptions {
  agentName: string;
  systemPrompt: string;
  userPrompt: string;
  expectedShape: JsonShape;
  maxTokens?: number;
  /**
   * Eve migration: the target Eve subagent directory name (e.g. 'backend', 'contract-negotiator').
   * Used only by the Eve engine to route the turn; the graph engine ignores it. Set explicitly by
   * each node so routing does not depend on `agentName` (which can be a model string under
   * NODE_PROVIDER_OVERRIDES).
   */
  subagent?: string;
  /** Forwarded to the provider: receives each token delta in streaming mode. */
  onToken?: (delta: string) => void;
}

export interface GraphLlmJsonResult<T> {
  value: T;
  model: string;
  usage: LlmUsage;
}

export interface GraphLlmProviderVerification {
  ok: boolean;
  provider: LlmProviderName;
  model: string;
  fallbackModel: string | null;
  baseUrl: string;
  reason: string | null;
  usage: LlmUsage | null;
}

@Injectable()
export class GraphLlmProvider extends BaseLlmProvider {
  providerName(): LlmProviderName {
    return selectedLlmProvider();
  }

  async verifyConnection(): Promise<GraphLlmProviderVerification> {
    const provider = this.providerName();
    const model = this.model();
    const fallbackModel = this.fallbackModel();
    const baseUrl = this.baseUrl();

    if (!this.apiKey()) {
      return {
        ok: false,
        provider,
        model,
        fallbackModel,
        baseUrl,
        reason: `Graph LLM provider requires ${this.apiKeyName()}.`,
        usage: null,
      };
    }

    try {
      const result = await this.generateJson<{ ok?: boolean }>({
        agentName: 'provider_preflight',
        systemPrompt: 'Return one minimal JSON object only.',
        userPrompt: 'Return {"ok":true}.',
        expectedShape: 'object',
        maxTokens: 256,
      });

      return {
        ok: true,
        provider,
        model: result.model,
        fallbackModel,
        baseUrl,
        reason: null,
        usage: result.usage,
      };
    } catch (error) {
      return {
        ok: false,
        provider,
        model,
        fallbackModel,
        baseUrl,
        reason: this.errorMessage(error),
        usage: null,
      };
    }
  }

  async generateJson<T>(options: GraphLlmJsonOptions): Promise<GraphLlmJsonResult<T>> {
    const result = await this.fetchWithFallback<T>(
      options,
      (content) => this.parseJson<T>(content, options.expectedShape),
    );

    return {
      value: result.value,
      model: result.model,
      usage: result.usage,
    };
  }
}
