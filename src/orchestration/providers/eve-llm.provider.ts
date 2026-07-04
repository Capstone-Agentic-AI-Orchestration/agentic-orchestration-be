import { Injectable, Logger } from '@nestjs/common';
import { withLlmRequest } from './llm-runtime';
import type { JsonShape, LlmUsage } from './base-llm.provider';
import type { GraphLlmJsonOptions, GraphLlmJsonResult } from './graph-llm.provider';

/**
 * Eve delegation provider (Hybrid migration — see docs/architecture/EVE_MIGRATION.md §6.2).
 *
 * Drop-in replacement for {@link GraphLlmProvider.generateJson}: identical input/output shape
 * so an agent node can switch engines with a one-line selector and no other change. Instead of
 * calling an LLM endpoint directly, it posts a turn to the external Eve agent service
 * (POST {EVE_SERVICE_URL}/eve/v1/session), streams the SSE response, forwards token deltas to
 * `onToken`, and parses the assembled JSON.
 *
 * ADDITIVE: nothing routes through this provider until ORCHESTRATION_LLM_ENGINE=eve and a node
 * is switched to inject it. The LangGraph path is untouched.
 *
 * `agentName` carries the target subagent (the existing nodes already pass the node name here,
 * e.g. resolveModelForNode('backend_agent', ...)); the leading segment maps to an Eve subagent.
 */
@Injectable()
export class EveLlmProvider {
  private readonly logger = new Logger(EveLlmProvider.name);

  isConfigured(): boolean {
    return Boolean(process.env.EVE_SERVICE_URL?.trim());
  }

  private baseUrl(): string {
    return (process.env.EVE_SERVICE_URL ?? '').replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = process.env.EVE_SERVICE_TOKEN?.trim();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  /**
   * Resolves the Eve subagent directory name. Prefers the explicit `subagent` option (set by each
   * node); falls back to deriving it from `agentName` for callers that don't set it.
   */
  private subagentFor(options: GraphLlmJsonOptions): string {
    if (options.subagent?.trim()) return options.subagent.trim();
    const base = options.agentName.replace(/_agent$/, '').replace(/_/g, '-');
    return base || 'backend';
  }

  async generateJson<T>(options: GraphLlmJsonOptions): Promise<GraphLlmJsonResult<T>> {
    if (!this.isConfigured()) {
      throw new Error('EveLlmProvider requires EVE_SERVICE_URL to be set.');
    }

    const subagent = this.subagentFor(options);
    const message = [options.systemPrompt, '', options.userPrompt].join('\n');

    const content = await withLlmRequest((signal) => this.streamSession(subagent, message, options, signal));
    if (!content?.trim()) {
      throw new Error(`Eve subagent '${subagent}' returned an empty response.`);
    }

    const value = this.parseJson<T>(content, options.expectedShape);
    return {
      value,
      model: `eve:${subagent}`,
      // Eve reports usage via its Agent Runs dashboard; per-turn token usage is not exposed on
      // the session stream, so we report zeros here. Telemetry lives in the Vercel dashboard.
      usage: { inputTokens: 0, outputTokens: 0 } satisfies LlmUsage,
    };
  }

  /**
   * Creates an Eve session for the chosen subagent, attaches to its stream, forwards token
   * deltas to onToken, and returns the assembled final text.
   */
  private async streamSession(
    subagent: string,
    message: string,
    options: GraphLlmJsonOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl()}/eve/v1/session`, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({ agent: subagent, message, stream: true }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`Eve session for '${subagent}' failed (${response.status}): ${detail}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const onToken = options.onToken ?? (() => undefined);
    let buffer = '';
    let content = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          const delta = this.extractDelta(line);
          if (delta) {
            content += delta;
            try {
              onToken(delta);
            } catch {
              // A streaming-UI callback must never break generation.
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return content;
  }

  /**
   * Extracts a text delta from one SSE line. Eve streams lifecycle events; we only accumulate
   * text-delta payloads. Tolerant of both `data: {json}` and plain `data: text` forms.
   */
  private extractDelta(line: string): string | null {
    if (!line.startsWith('data:')) return null;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return null;
    try {
      const event = JSON.parse(data) as { type?: string; delta?: string; text?: string };
      if (typeof event.delta === 'string') return event.delta;
      if (event.type === 'text' && typeof event.text === 'string') return event.text;
      return null;
    } catch {
      return data;
    }
  }

  private parseJson<T>(content: string, expectedShape: JsonShape): T {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const open = expectedShape === 'array' ? '[' : '{';
    const close = expectedShape === 'array' ? ']' : '}';
    let candidate = fenced?.[1]?.trim() ?? trimmed;
    const first = candidate.indexOf(open);
    const last = candidate.lastIndexOf(close);
    if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1);

    const parsed = JSON.parse(candidate) as unknown;
    if (expectedShape === 'array' && !Array.isArray(parsed)) {
      throw new Error("Expected a JSON array from Eve subagent.");
    }
    if (expectedShape === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error('Expected a JSON object from Eve subagent.');
    }
    return parsed as T;
  }
}
