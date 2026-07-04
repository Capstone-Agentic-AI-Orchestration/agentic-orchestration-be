import {
  withLlmRequest,
  type LlmProviderName,
} from './llm-runtime';

export type JsonShape = 'object' | 'array';

export interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string | number;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface AnthropicMessageResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmGenerateOptions {
  agentName: string;
  systemPrompt: string;
  userPrompt: string;
  expectedShape: JsonShape;
  maxTokens?: number;
  temperature?: number;
  /**
   * When provided (and `LLM_STREAMING` is not `false`), the request is made in
   * streaming mode and each token delta is forwarded here as it arrives. The
   * full content is still assembled and parsed exactly as in the blocking path,
   * so streaming is purely additive — a callback exception never breaks
   * generation.
   */
  onToken?: (delta: string) => void;
}

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
}

export interface LlmGenerateResult<T> {
  value: T;
  model: string;
  usage: LlmUsage;
}

export abstract class BaseLlmProvider {
  abstract providerName(): LlmProviderName;

  model(): string {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
    }
    if (this.providerName() === 'openai') {
      return process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    }
    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
    }
    if (this.providerName() === 'gemini') {
      return process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    }
    return process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free';
  }

  /**
   * Default completion budget applied to every request when a caller does not
   * specify one. Without this, providers cap output at small defaults (which
   * truncates generated files mid-content) and Anthropic rejects the request
   * outright because `max_tokens` is required. Configurable via
   * `LLM_MAX_OUTPUT_TOKENS`.
   *
   * Increased from 8192 to 16384 to reduce truncation of large generated files
   * (multi-file code generation often exceeds 8K tokens).
   */
  defaultMaxTokens(): number {
    const parsed = Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 16384;
  }

  fallbackModel(): string | null {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_FALLBACK_MODEL?.trim() || null;
    }
    if (this.providerName() === 'openai') {
      return process.env.OPENAI_FALLBACK_MODEL?.trim() || null;
    }
    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_FALLBACK_MODEL?.trim() || 'deepseek-v4-flash';
    }
    if (this.providerName() === 'gemini') {
      return process.env.GEMINI_FALLBACK_MODEL?.trim() || null;
    }
    return process.env.OPENROUTER_FALLBACK_MODEL?.trim() || null;
  }

  baseUrl(): string {
    if (this.providerName() === 'anthropic') {
      return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    }
    if (this.providerName() === 'openai') {
      return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    }
    if (this.providerName() === 'opencode') {
      return (process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(/\/$/, '');
    }
    if (this.providerName() === 'gemini') {
      return (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
    }
    return (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey());
  }

  protected apiKey(): string {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_API_KEY?.trim() ?? '';
    }
    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_API_KEY?.trim() ?? '';
    }
    if (this.providerName() === 'gemini') {
      return process.env.GEMINI_API_KEY?.trim() ?? '';
    }
    return this.providerName() === 'openai'
      ? process.env.OPENAI_API_KEY?.trim() ?? ''
      : process.env.OPENROUTER_API_KEY?.trim() ?? '';
  }

  protected apiKeyName(): string {
    if (this.providerName() === 'anthropic') return 'ANTHROPIC_API_KEY';
    if (this.providerName() === 'opencode') return 'OPENCODE_API_KEY';
    if (this.providerName() === 'gemini') return 'GEMINI_API_KEY';
    return this.providerName() === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
  }

  protected headers(): Record<string, string> {
    if (this.providerName() === 'anthropic') {
      return {
        'x-api-key': this.apiKey(),
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
        'Content-Type': 'application/json',
      };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey()}`,
      'Content-Type': 'application/json',
    };

    if (this.providerName() === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'http://localhost:4000';
      headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'DevFlow';
    }

    return headers;
  }

  protected url(): string {
    return this.providerName() === 'anthropic'
      ? `${this.baseUrl()}/messages`
      : `${this.baseUrl()}/chat/completions`;
  }

  protected requestBody(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: LlmGenerateOptions,
    temperature: number,
  ): Record<string, unknown> {
    const maxTokens = options.maxTokens ?? this.defaultMaxTokens();

    if (this.providerName() === 'anthropic') {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n\n');

      return {
        model,
        system,
        messages: [{ role: 'user', content: user }],
        temperature,
        max_tokens: maxTokens,
      };
    }

    return {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...this.responseFormat(options),
    };
  }

  protected responseFormat(options: LlmGenerateOptions): Record<string, unknown> {
    if (this.providerName() === 'openai' || this.providerName() === 'gemini') {
      return {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: `${options.agentName}_${options.expectedShape}`,
            strict: false,
            schema: options.expectedShape === 'array'
              ? { type: 'array', items: { type: 'object', additionalProperties: true } }
              : { type: 'object', additionalProperties: true },
          },
        },
      };
    }

    // OpenRouter supports json_object. Anthropic uses its own format.
    // OpenCode/DeepSeek does not support response_format — rely on prompt instructions.
    if (this.providerName() === 'opencode') return {};

    return options.expectedShape === 'object'
      ? { response_format: { type: 'json_object' } }
      : {};
  }

  protected providerLabel(): string {
    if (this.providerName() === 'anthropic') return 'Anthropic';
    if (this.providerName() === 'opencode') return 'OpenCode';
    if (this.providerName() === 'gemini') return 'Gemini';
    return this.providerName() === 'openai' ? 'OpenAI' : 'OpenRouter';
  }

  protected contentFromPayload(payload: OpenRouterChatResponse | AnthropicMessageResponse | null): string | null {
    if (!payload) return null;
    if ('choices' in payload) return payload.choices?.[0]?.message?.content ?? null;
    if ('content' in payload) {
      return payload.content?.find((block) => block.type === 'text' && block.text)?.text ?? null;
    }
    return null;
  }

  protected usageFromPayload(payload: OpenRouterChatResponse | AnthropicMessageResponse | null): LlmUsage {
    if (!payload?.usage) return { inputTokens: 0, outputTokens: 0 };
    if ('prompt_tokens' in payload.usage || 'completion_tokens' in payload.usage) {
      const usage = payload.usage as OpenRouterChatResponse['usage'];
      return {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      };
    }
    const usage = payload.usage as AnthropicMessageResponse['usage'];
    return {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    };
  }

  protected parseJson<T>(content: string, expectedShape: JsonShape): T {
    const parsed = JSON.parse(this.extractJson(content, expectedShape)) as unknown;
    if (expectedShape === 'array' && !Array.isArray(parsed)) {
      throw new Error('Expected a JSON array.');
    }
    if (expectedShape === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error('Expected a JSON object.');
    }
    return parsed as T;
  }

  protected extractJson(content: string, expectedShape: JsonShape): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) return fenced[1].trim();

    const open = expectedShape === 'array' ? '[' : '{';
    const close = expectedShape === 'array' ? ']' : '}';
    const first = trimmed.indexOf(open);
    const last = trimmed.lastIndexOf(close);
    if (first >= 0 && last > first) {
      return trimmed.slice(first, last + 1);
    }

    return trimmed;
  }

  protected errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  protected async fetchWithFallback<T>(
    options: LlmGenerateOptions,
    parseFn: (content: string) => T,
  ): Promise<LlmGenerateResult<T>> {
    if (!this.apiKey()) {
      throw new Error(`${this.providerLabel()} provider requires ${this.apiKeyName()}.`);
    }

    const primaryResult = await this.tryGenerateWithModel(this.model(), options, parseFn)
      .then((result) => ({ result, error: null }))
      .catch((error: unknown) => ({ result: null, error }));

    if (primaryResult.result) {
      return primaryResult.result;
    }

    const fallbackModel = this.fallbackModel();
    if (!fallbackModel || fallbackModel === this.model()) {
      throw primaryResult.error;
    }

    return this.tryGenerateWithModel(fallbackModel, options, parseFn, primaryResult.error);
  }

  private async tryGenerateWithModel<T>(
    model: string,
    options: LlmGenerateOptions,
    parseFn: (content: string) => T,
    primaryError?: unknown,
  ): Promise<LlmGenerateResult<T>> {
    const temperature = options.temperature ?? 0.2;
    const messages = this.buildMessages(options);

    const { content, usage } = this.streamingEnabled(options)
      ? await this.streamCompletion(model, messages, options, temperature, primaryError)
      : await this.blockingCompletion(model, messages, options, temperature, primaryError);

    if (!content?.trim()) {
      throw new Error(`${this.providerLabel()} ${model} ${options.agentName} returned an empty response.`);
    }

    let value: T;
    try {
      value = parseFn(content);
    } catch (parseError) {
      value = await this.repairJson(model, content, options, parseError);
    }

    return { value, model, usage };
  }

  /** Streaming is opt-in: a caller supplies onToken and it is not disabled. */
  private streamingEnabled(options: LlmGenerateOptions): boolean {
    return Boolean(options.onToken) && process.env.LLM_STREAMING !== 'false';
  }

  private buildMessages(
    options: LlmGenerateOptions,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    return [
      {
        role: 'system',
        content: [
          options.systemPrompt,
          '',
          `Return exactly one valid JSON ${options.expectedShape}.`,
          'Do not include markdown fences, comments, or prose outside JSON.',
        ].join('\n'),
      },
      { role: 'user', content: options.userPrompt },
    ];
  }

  /** Non-streaming request: one POST, parse the whole JSON body. */
  private async blockingCompletion(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: LlmGenerateOptions,
    temperature: number,
    primaryError?: unknown,
  ): Promise<{ content: string | null; usage: LlmUsage }> {
    const response = await withLlmRequest((signal) => fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify(this.requestBody(model, messages, options, temperature)),
    }));

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
    if (!response.ok) {
      throw new Error(this.requestErrorMessage(model, options, response.status, payload, response.statusText, primaryError, 'request'));
    }

    return {
      content: this.contentFromPayload(payload),
      usage: this.usageFromPayload(payload),
    };
  }

  /**
   * Streaming request: POST with `stream: true`, forward each token delta to
   * `onToken` as it arrives, and assemble the full content for the normal
   * parse/repair path.
   */
  private async streamCompletion(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: LlmGenerateOptions,
    temperature: number,
    primaryError?: unknown,
  ): Promise<{ content: string | null; usage: LlmUsage }> {
    const isAnthropic = this.providerName() === 'anthropic';
    const body: Record<string, unknown> = {
      ...this.requestBody(model, messages, options, temperature),
      stream: true,
    };
    if (!isAnthropic) {
      // Ask OpenAI-style providers to emit a final usage chunk.
      body.stream_options = { include_usage: true };
    }

    const response = await withLlmRequest((signal) => fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify(body),
    }));

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
      throw new Error(this.requestErrorMessage(model, options, response.status, payload, response.statusText, primaryError, 'stream'));
    }

    const onToken = options.onToken ?? (() => undefined);
    return isAnthropic
      ? this.consumeAnthropicStream(response.body, onToken)
      : this.consumeOpenAiStream(response.body, onToken);
  }

  private requestErrorMessage(
    model: string,
    options: LlmGenerateOptions,
    status: number,
    payload: OpenRouterChatResponse | AnthropicMessageResponse | null,
    statusText: string,
    primaryError: unknown,
    kind: 'request' | 'stream',
  ): string {
    const detail = payload && 'error' in payload ? payload.error?.message || statusText : statusText;
    const fallbackNote = primaryError
      ? ` Fallback after primary failure: ${this.errorMessage(primaryError)}.`
      : '';
    return `${this.providerLabel()} ${model} ${options.agentName} ${kind} failed (${status}): ${detail}.${fallbackNote}`;
  }

  // ── SSE consumption ─────────────────────────────────────────────────────────

  /** Yields each `data:` payload from a Server-Sent-Events response body. */
  protected async *iterateSse(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) break;
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith('data:')) yield tail.slice(5).trim();
    } finally {
      reader.releaseLock();
    }
  }

  /** OpenAI-compatible SSE: deltas at choices[0].delta.content, `[DONE]` terminates. */
  protected async consumeOpenAiStream(
    body: ReadableStream<Uint8Array>,
    onToken: (delta: string) => void,
  ): Promise<{ content: string; usage: LlmUsage }> {
    let content = '';
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const data of this.iterateSse(body)) {
      if (data === '[DONE]') break;
      if (!data) continue;

      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        content += delta;
        this.safeToken(onToken, delta);
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
          outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
        };
      }
    }

    return { content, usage };
  }

  /** Anthropic SSE: text_delta events; usage split across message_start/_delta. */
  protected async consumeAnthropicStream(
    body: ReadableStream<Uint8Array>,
    onToken: (delta: string) => void,
  ): Promise<{ content: string; usage: LlmUsage }> {
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const data of this.iterateSse(body)) {
      if (!data || data === '[DONE]') continue;

      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        if (typeof text === 'string' && text.length > 0) {
          content += text;
          this.safeToken(onToken, text);
        }
      } else if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? inputTokens;
      } else if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens ?? outputTokens;
      }
    }

    return { content, usage: { inputTokens, outputTokens } };
  }

  private safeToken(onToken: (delta: string) => void, delta: string): void {
    try {
      onToken(delta);
    } catch {
      // A streaming-UI callback must never break code generation.
    }
  }

  private async repairJson<T>(
    model: string,
    content: string,
    options: LlmGenerateOptions,
    originalError: unknown,
  ): Promise<T> {
    const response = await withLlmRequest((signal) => fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify(this.requestBody(model, [
        {
          role: 'system',
          content: [
            `Repair this ${options.agentName} output into one valid JSON ${options.expectedShape}.`,
            'Preserve useful file content and data from the invalid output.',
            'Do not include markdown fences, comments, or prose outside JSON.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            parseError: this.errorMessage(originalError),
            invalidOutput: content.slice(0, 12000),
          }),
        },
      ], options, 0)),
    }));

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
    if (!response.ok) {
      const detail = payload && 'error' in payload ? payload.error?.message || response.statusText : response.statusText;
      throw new Error(
        `${this.providerLabel()} ${model} ${options.agentName} repair failed (${response.status}): ${detail}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    const repaired = this.contentFromPayload(payload);
    if (!repaired?.trim()) {
      throw new Error(
        `${this.providerLabel()} ${model} ${options.agentName} repair returned an empty response. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    try {
      return this.parseJson<T>(repaired, options.expectedShape);
    } catch (repairError) {
      throw new Error(
        `${this.providerLabel()} ${model} ${options.agentName} repair returned invalid JSON: ${this.errorMessage(repairError)}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }
  }
}

export function resolveModelForNode(nodeName: string, defaultModel: string): string {
  const raw = process.env.NODE_PROVIDER_OVERRIDES;
  if (!raw) return defaultModel;
  try {
    const map = JSON.parse(raw) as Record<string, { model?: string }>;
    const override = map[nodeName];
    return override?.model?.trim() || defaultModel;
  } catch {
    return defaultModel;
  }
}
