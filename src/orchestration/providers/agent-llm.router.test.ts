import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLlmRouter } from './agent-llm.router';
import type { EveLlmProvider } from './eve-llm.provider';
import type { GraphLlmProvider } from './graph-llm.provider';

function makeRouter(eveConfigured: boolean) {
  const graph = {
    model: vi.fn(() => 'openrouter/test-model'),
    generateJson: vi.fn(async () => ({
      value: { engine: 'graph' },
      model: 'openrouter/test-model',
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
  } as unknown as GraphLlmProvider;

  const eve = {
    isConfigured: vi.fn(() => eveConfigured),
    generateJson: vi.fn(async () => ({
      value: { engine: 'eve' },
      model: 'eve:backend',
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
  } as unknown as EveLlmProvider;

  return { router: new AgentLlmRouter(graph, eve), graph, eve };
}

describe('AgentLlmRouter', () => {
  const originalEngine = process.env.ORCHESTRATION_LLM_ENGINE;
  const originalModel = process.env.EVE_MODEL;

  afterEach(() => {
    if (originalEngine === undefined) {
      delete process.env.ORCHESTRATION_LLM_ENGINE;
    } else {
      process.env.ORCHESTRATION_LLM_ENGINE = originalEngine;
    }
    if (originalModel === undefined) {
      delete process.env.EVE_MODEL;
    } else {
      process.env.EVE_MODEL = originalModel;
    }
  });

  it('selects Eve when requested and configured', async () => {
    process.env.ORCHESTRATION_LLM_ENGINE = 'eve';
    process.env.EVE_MODEL = 'openai/gpt-5.4-mini';
    const { router, graph, eve } = makeRouter(true);

    expect(router.getStatus()).toEqual({
      requestedEngine: 'eve',
      activeEngine: 'eve',
      fallbackReason: null,
      eveServiceConfigured: true,
      model: 'eve:openai/gpt-5.4-mini',
    });

    const result = await router.generateJson({
      agentName: 'backend_agent',
      expectedShape: 'object',
      systemPrompt: 'Return JSON.',
      userPrompt: '{}',
    });

    expect(result.value).toEqual({ engine: 'eve' });
    expect(eve.generateJson).toHaveBeenCalledOnce();
    expect(graph.generateJson).not.toHaveBeenCalled();
  });

  it('falls back to graph when Eve is requested but not configured', async () => {
    process.env.ORCHESTRATION_LLM_ENGINE = 'eve';
    const { router, graph, eve } = makeRouter(false);

    expect(router.getStatus()).toMatchObject({
      requestedEngine: 'eve',
      activeEngine: 'graph',
      eveServiceConfigured: false,
    });
    expect(router.getStatus().fallbackReason).toContain('EVE_SERVICE_URL');

    const result = await router.generateJson({
      agentName: 'backend_agent',
      expectedShape: 'object',
      systemPrompt: 'Return JSON.',
      userPrompt: '{}',
    });

    expect(result.value).toEqual({ engine: 'graph' });
    expect(graph.generateJson).toHaveBeenCalledOnce();
    expect(eve.generateJson).not.toHaveBeenCalled();
  });

  it('uses graph when explicitly requested', () => {
    process.env.ORCHESTRATION_LLM_ENGINE = 'graph';
    const { router } = makeRouter(true);

    expect(router.getStatus()).toMatchObject({
      requestedEngine: 'graph',
      activeEngine: 'graph',
      fallbackReason: null,
      eveServiceConfigured: true,
      model: 'openrouter/test-model',
    });
  });
});
