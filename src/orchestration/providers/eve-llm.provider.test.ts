import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service';
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

function makeProvider(modelSelection: unknown = null): EveLlmProvider {
  return new EveLlmProvider({
    orchestrationRun: {
      findUnique: vi.fn().mockResolvedValue({ modelSelection }),
    },
  } as unknown as PrismaService);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'session-1', continuationToken: 'continue-1' }), { status: 200 }))
      .mockResolvedValueOnce(
        streamResponse([
          ndjson({ type: 'message.appended', data: { turnId: 'turn-1', stepIndex: 0, messageDelta: '{"ok":' } }),
          ndjson({ type: 'message.appended', data: { turnId: 'turn-1', stepIndex: 0, messageDelta: 'true}' } }),
          ndjson({ type: 'message.completed', data: { turnId: 'turn-1', stepIndex: 0, message: '{"ok":false}' } }),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onToken = vi.fn();

    const result = await makeProvider().generateJson<{ ok: boolean }>({
      agentName: 'backend_agent',
      subagent: 'backend',
      expectedShape: 'object',
      systemPrompt: 'Return JSON.',
      userPrompt: '{}',
      onToken,
      correlation: {
        requestId: 'request-1',
        projectId: 'project-1',
        runId: 'run-1',
        workOrderId: 'work-order-1',
        agent: 'backend',
        attempt: 2,
      },
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.model).toBe('eve:backend');
    expect(result.providerMetadata).toEqual({
      requestId: 'request-1',
      eveSessionId: 'session-1',
      continuationToken: 'continue-1',
    });
    expect(onToken).toHaveBeenCalledWith('{"ok":');
    expect(onToken).toHaveBeenCalledWith('true}');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://eve.example.test/eve/v1/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'X-DevFlow-Request-Id': 'request-1',
          'X-DevFlow-Project-Id': 'project-1',
          'X-DevFlow-Run-Id': 'run-1',
          'X-DevFlow-Work-Order-Id': 'work-order-1',
          'X-DevFlow-Agent': 'backend',
          'X-DevFlow-Attempt': '2',
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      agent: 'backend',
      metadata: {
        requestId: 'request-1',
        projectId: 'project-1',
        runId: 'run-1',
        workOrderId: 'work-order-1',
        agent: 'backend',
        attempt: 2,
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://eve.example.test/eve/v1/session/session-1/stream',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-DevFlow-Request-Id': 'request-1' }),
      }),
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

    const result = await makeProvider().generateJson<Record<string, unknown>>({
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
      makeProvider().generateJson({
        agentName: 'database_agent',
        subagent: 'database',
        expectedShape: 'object',
        systemPrompt: 'Return JSON.',
        userPrompt: '{}',
      }),
    ).rejects.toThrow("Eve subagent 'database' failed (BAD_TOOL): typecheck failed");
  });
});
