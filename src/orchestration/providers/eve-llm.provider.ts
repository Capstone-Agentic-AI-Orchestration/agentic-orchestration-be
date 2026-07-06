import { Injectable, Logger } from '@nestjs/common';
import { withLlmRequest } from './llm-runtime';
import type { JsonShape, LlmUsage } from './base-llm.provider';
import type { GraphLlmJsonOptions, GraphLlmJsonResult } from './graph-llm.provider';

/**
 * Eve delegation provider (Hybrid migration — see docs/architecture/EVE_MIGRATION.md §6.2).
 *
 * Drop-in replacement for {@link GraphLlmProvider.generateJson}: identical input/output shape
 * so an agent node can switch engines with a one-line selector and no other change. Instead of
 * calling an LLM endpoint directly, it posts a turn to the external Eve agent service,
 * attaches to the session NDJSON stream, forwards text deltas to `onToken`, and parses the
 * assembled JSON.
 *
 * The in-process provider remains available as a fallback when ORCHESTRATION_LLM_ENGINE=graph
 * or the Eve service is not configured.
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
    const session = await this.createSession(subagent, message, signal);
    return this.readSessionStream(subagent, session.sessionId, options, signal);
  }

  private async createSession(
    subagent: string,
    message: string,
    signal: AbortSignal,
  ): Promise<{ sessionId: string; continuationToken?: string }> {
    const response = await fetch(`${this.baseUrl()}/eve/v1/session`, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({ agent: subagent, message }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`Eve session for '${subagent}' failed (${response.status}): ${detail}`);
    }

    const body = (await response.json().catch(() => null)) as {
      sessionId?: unknown;
      continuationToken?: unknown;
    } | null;
    if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      throw new Error(`Eve session for '${subagent}' did not return a sessionId.`);
    }
    return {
      sessionId: body.sessionId,
      continuationToken: typeof body.continuationToken === 'string' ? body.continuationToken : undefined,
    };
  }

  private async readSessionStream(
    subagent: string,
    sessionId: string,
    options: GraphLlmJsonOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl()}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
      method: 'GET',
      headers: this.headers(),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`Eve stream for '${subagent}' failed (${response.status}): ${detail}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const onToken = options.onToken ?? (() => undefined);
    const completedStepsWithDeltas = new Set<string>();
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
          const event = this.parseStreamEvent(line);
          if (!event) continue;
          this.throwIfFailureEvent(subagent, event);
          const delta = this.extractDelta(event);
          if (delta) {
            content += delta;
            const stepKey = this.stepKey(event);
            if (stepKey) completedStepsWithDeltas.add(stepKey);
            try {
              onToken(delta);
            } catch {
              // A streaming-UI callback must never break generation.
            }
            continue;
          }
          const completed = this.extractCompletedMessage(event, completedStepsWithDeltas);
          if (completed) {
            content += completed;
            continue;
          }
          const result = this.extractStructuredResult(event);
          if (result !== null) {
            content = JSON.stringify(result);
          }
        }
      }

      const tail = buffer.trim();
      if (tail) {
        const event = this.parseStreamEvent(tail);
        if (event) {
          this.throwIfFailureEvent(subagent, event);
          const result = this.extractStructuredResult(event);
          if (result !== null) content = JSON.stringify(result);
        }
      }
    } finally {
      reader.releaseLock();
    }

    return content;
  }

  /**
   * Extracts a text delta from one Eve NDJSON event. Eve emits lifecycle events as newline-delimited
   * JSON; `message.appended` carries the incremental assistant text we mirror to the UI.
   */
  private extractDelta(event: EveStreamEvent): string | null {
    if (event.type !== 'message.appended') return null;
    const data = this.objectData(event);
    return typeof data.messageDelta === 'string' ? data.messageDelta : null;
  }

  private parseStreamEvent(line: string): EveStreamEvent | null {
    if (!line.trim()) return null;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const event = parsed as { type?: unknown; data?: unknown };
      return typeof event.type === 'string' ? { type: event.type, data: event.data } : null;
    } catch {
      return null;
    }
  }

  private extractCompletedMessage(event: EveStreamEvent, completedStepsWithDeltas: Set<string>): string | null {
    if (event.type !== 'message.completed') return null;
    const stepKey = this.stepKey(event);
    if (stepKey && completedStepsWithDeltas.has(stepKey)) return null;
    const data = this.objectData(event);
    return typeof data.message === 'string' ? data.message : null;
  }

  private extractStructuredResult(event: EveStreamEvent): unknown | null {
    if (event.type !== 'result.completed') return null;
    const data = this.objectData(event);
    return Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
  }

  private throwIfFailureEvent(subagent: string, event: EveStreamEvent): void {
    if (event.type !== 'step.failed' && event.type !== 'turn.failed' && event.type !== 'session.failed') return;
    const data = this.objectData(event);
    const code = typeof data.code === 'string' ? data.code : 'EVE_RUN_FAILED';
    const message = typeof data.message === 'string' ? data.message : `Eve subagent '${subagent}' failed.`;
    throw new Error(`Eve subagent '${subagent}' failed (${code}): ${message}`);
  }

  private stepKey(event: EveStreamEvent): string | null {
    const data = this.objectData(event);
    if (typeof data.turnId !== 'string' || typeof data.stepIndex !== 'number') return null;
    return `${data.turnId}:${data.stepIndex}`;
  }

  private objectData(event: EveStreamEvent): Record<string, unknown> {
    return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};
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

interface EveStreamEvent {
  readonly type: string;
  readonly data?: unknown;
}
