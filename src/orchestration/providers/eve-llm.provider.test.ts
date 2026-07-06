import { afterEach, describe, expect, it, vi } from 'vitest';
import { EveLlmProvider } from './eve-llm.provider';

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join('')));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function ndjson(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

describe('EveLlmProvider', () => {
  const originalUrl = process.env.EVE_SERVICE_URL;
  const originalToken = process.env.EVE_SERVICE_TOKEN;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) {
      delete process.env.EVE_SERVICE_URL;
    } else {
      process.env.EVE_SERVICE_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.EVE_SERVICE_TOKEN;
    } else {
      process.env.EVE_SERVICE_TOKEN = originalToken;
    }
  });

  it('creates a session, streams message deltas, and parses the assembled JSON', async () => {
    process.env.EVE_SERVICE_URL = 'https://eve.example.test';
    process.env.EVE_SERVICE_TOKEN = 'secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'session-1' }), { status: 200 }))
      .mockResolvedValueOnce(
        streamResponse([
          ndjson({ type: 'message.appended', data: { turnId: 'turn-1', stepIndex: 0, messageDelta: '{"ok":' } }),
          ndjson({ type: 'message.appended', data: { turnId: 'turn-1', stepIndex: 0, messageDelta: 'true}' } }),
          ndjson({ type: 'message.completed', data: { turnId: 'turn-1', stepIndex: 0, message: '{"ok":false}' } }),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onToken = vi.fn();

    const result = await new EveLlmProvider().generateJson<{ ok: boolean }>({
      agentName: 'backend_agent',
      subagent: 'backend',
      expectedShape: 'object',
      systemPrompt: 'Return JSON.',
      userPrompt: '{}',
      onToken,
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.model).toBe('eve:backend');
    expect(onToken).toHaveBeenCalledWith('{"ok":');
    expect(onToken).toHaveBeenCalledWith('true}');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://eve.example.test/eve/v1/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://eve.example.test/eve/v1/session/session-1/stream',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('accepts structured result.completed events', async () => {
    process.env.EVE_SERVICE_URL = 'https://eve.example.test';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'session-2' }), { status: 200 }))
        .mockResolvedValueOnce(
          streamResponse([
            ndjson({
              type: 'result.completed',
              data: {
                result: {
                  filePath: 'work-orders/1/output.ts',
                  content: 'export {};',
                  language: 'typescript',
                },
              },
            }),
          ]),
        ),
    );

    const result = await new EveLlmProvider().generateJson<Record<string, unknown>>({
      agentName: 'frontend_agent',
      subagent: 'frontend',
      expectedShape: 'object',
      systemPrompt: 'Return JSON.',
      userPrompt: '{}',
    });

    expect(result.value).toMatchObject({
      filePath: 'work-orders/1/output.ts',
      language: 'typescript',
    });
  });

  it('throws on Eve failure events', async () => {
    process.env.EVE_SERVICE_URL = 'https://eve.example.test';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'session-3' }), { status: 200 }))
        .mockResolvedValueOnce(
          streamResponse([
            ndjson({ type: 'step.failed', data: { code: 'BAD_TOOL', message: 'typecheck failed' } }),
          ]),
        ),
    );

    await expect(
      new EveLlmProvider().generateJson({
        agentName: 'database_agent',
        subagent: 'database',
        expectedShape: 'object',
        systemPrompt: 'Return JSON.',
        userPrompt: '{}',
      }),
    ).rejects.toThrow("Eve subagent 'database' failed (BAD_TOOL): typecheck failed");
  });
});
