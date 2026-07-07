import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseLlmProvider, type LlmGenerateOptions, type LlmGenerateResult } from './base-llm.provider';
import type { LlmProviderName } from './llm-runtime';

class TestProvider extends BaseLlmProvider {
  constructor(private readonly name: LlmProviderName) {
    super();
  }

  providerName(): LlmProviderName {
    return this.name;
  }

  // Expose the protected request builder for assertions.
  build(options: LlmGenerateOptions): Record<string, unknown> {
    return this.requestBody(
      this.model(),
      [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt },
      ],
      options,
      0.2,
    );
  }

  // Expose the protected generation entrypoint for streaming tests.
  generate<T>(options: LlmGenerateOptions, parse: (content: string) => T): Promise<LlmGenerateResult<T>> {
    return this.fetchWithFallback(options, parse);
  }
}

/** Builds a ReadableStream that emits the given strings as separate chunks. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function controlledTextStream(): {
  stream: ReadableStream<Uint8Array>;
  enqueue: (chunk: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });

  return {
    stream,
    enqueue: (chunk) => controllerRef?.enqueue(encoder.encode(chunk)),
    close: () => controllerRef?.close(),
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function parseJson<T>(content: string): T {
  return JSON.parse(content) as T;
}

const baseOptions: LlmGenerateOptions = {
  agentName: 'test',
  systemPrompt: 'sys',
  userPrompt: 'usr',
  expectedShape: 'object',
};

describe('BaseLlmProvider max_tokens budget', () => {
  const originalEnv = process.env.LLM_MAX_OUTPUT_TOKENS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LLM_MAX_OUTPUT_TOKENS;
    } else {
      process.env.LLM_MAX_OUTPUT_TOKENS = originalEnv;
    }
  });

  it('defaults to 16384 output tokens when unset', () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    expect(new TestProvider('openrouter').defaultMaxTokens()).toBe(16384);
  });

  it('respects a valid LLM_MAX_OUTPUT_TOKENS override', () => {
    process.env.LLM_MAX_OUTPUT_TOKENS = '16000';
    expect(new TestProvider('openrouter').defaultMaxTokens()).toBe(16000);
  });

  it('ignores invalid LLM_MAX_OUTPUT_TOKENS values', () => {
    process.env.LLM_MAX_OUTPUT_TOKENS = 'not-a-number';
    expect(new TestProvider('openrouter').defaultMaxTokens()).toBe(16384);
  });

  it('always includes max_tokens for non-anthropic providers even when caller omits it', () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    const body = new TestProvider('openrouter').build(baseOptions);
    expect(body.max_tokens).toBe(16384);
  });

  it('always includes max_tokens for anthropic (which requires it)', () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    const body = new TestProvider('anthropic').build(baseOptions);
    expect(body.max_tokens).toBe(16384);
  });

  it('honors an explicit caller-provided maxTokens over the default', () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    const body = new TestProvider('openrouter').build({ ...baseOptions, maxTokens: 512 });
    expect(body.max_tokens).toBe(512);
  });
});

describe('BaseLlmProvider streaming', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.LLM_STREAMING;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  it('streams OpenAI-style deltas, assembles content, and reports usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf([
        // Split one SSE line across two chunks to exercise buffering.
        'data: {"choices":[{"delta":{"content":"{\\"ok\\""',
        '}}]}\n',
        'data: {"choices":[{"delta":{"content":":true}"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n',
        'data: [DONE]\n',
      ]),
    }));

    const tokens: string[] = [];
    const result = await new TestProvider('openrouter').generate<{ ok: boolean }>(
      { ...baseOptions, onToken: (d) => tokens.push(d) },
      parseJson,
    );

    expect(tokens).toEqual(['{"ok"', ':true}']);
    expect(result.value).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it('emits OpenAI-style token deltas before the response stream closes', async () => {
    const controlled = controlledTextStream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: controlled.stream,
    }));

    const tokens: string[] = [];
    const resultPromise = new TestProvider('openrouter').generate<{ live: boolean }>(
      { ...baseOptions, onToken: (d) => tokens.push(d) },
      parseJson,
    );

    await flushMicrotasks();
    controlled.enqueue('data: {"choices":[{"delta":{"content":"{\\"live\\""');
    controlled.enqueue('}}]}\n');
    await flushMicrotasks();

    expect(tokens).toEqual(['{"live"']);

    controlled.enqueue('data: {"choices":[{"delta":{"content":":true}"}}]}\n');
    controlled.enqueue('data: [DONE]\n');
    controlled.close();

    await expect(resultPromise).resolves.toMatchObject({
      value: { live: true },
    });
  });

  it('streams Anthropic text_delta events and splits usage across events', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"a\\":"}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"1}"}}\n',
        'data: {"type":"message_delta","usage":{"output_tokens":4}}\n',
      ]),
    }));

    const tokens: string[] = [];
    const result = await new TestProvider('anthropic').generate<{ a: number }>(
      { ...baseOptions, onToken: (d) => tokens.push(d) },
      parseJson,
    );

    expect(tokens.join('')).toBe('{"a":1}');
    expect(result.value).toEqual({ a: 1 });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 4 });
  });

  it('does not let a token-callback exception break generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf([
        'data: {"choices":[{"delta":{"content":"{\\"x\\":1}"}}]}\n',
        'data: [DONE]\n',
      ]),
    }));

    const result = await new TestProvider('openrouter').generate<{ x: number }>(
      { ...baseOptions, onToken: () => { throw new Error('UI blew up'); } },
      parseJson,
    );

    expect(result.value).toEqual({ x: 1 });
  });

  it('uses the blocking path (no stream flag) when no onToken is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"y":2}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new TestProvider('openrouter').generate<{ y: number }>(
      baseOptions,
      parseJson,
    );

    expect(result.value).toEqual({ y: 2 });
    const requestInit = fetchMock.mock.calls[0][1] as { body: string };
    const body = parseJson<{ stream?: unknown }>(requestInit.body);
    expect(body.stream).toBeUndefined();
  });

  it('repairs malformed JSON before returning a generated value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Here is the object: {"needsRepair": true' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"needsRepair":true}' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new TestProvider('openrouter').generate<{ needsRepair: boolean }>(
      baseOptions,
      parseJson,
    );

    expect(result.value).toEqual({ needsRepair: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = parseJson<{ messages: Array<{ content: string }> }>(
      (fetchMock.mock.calls[1][1] as { body: string }).body,
    );
    expect(repairBody.messages[0].content).toContain('Repair this test output');
    expect(repairBody.messages[1].content).toContain('invalidOutput');
  });

  it('honors LLM_STREAMING=false by falling back to the blocking path', async () => {
    process.env.LLM_STREAMING = 'false';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"z":3}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const result = await new TestProvider('openrouter').generate<{ z: number }>(
      { ...baseOptions, onToken: (d) => tokens.push(d) },
      parseJson,
    );

    expect(result.value).toEqual({ z: 3 });
    expect(tokens).toEqual([]);
    const requestInit = fetchMock.mock.calls[0][1] as { body: string };
    const body = parseJson<{ stream?: unknown }>(requestInit.body);
    expect(body.stream).toBeUndefined();
  });
});
