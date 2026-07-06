import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLlmRouter } from './agent-llm.router';
import type { EveLlmProvider } from './eve-llm.provider';
import type { DirectLlmProvider } from './direct-llm.provider';

function makeRouter(eveConfigured: boolean) {
  const direct = {
    model: vi.fn(() => 'openrouter/test-model'),
    generateJson: vi.fn(async () => ({
      value: { engine: 'direct' },
      model: 'openrouter/test-model',
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
  } as unknown as DirectLlmProvider;

  const eve = {
    isConfigured: vi.fn(() => eveConfigured),
    generateJson: vi.fn(async () => ({
      value: { engine: 'eve' },
      model: 'eve:backend',
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
  } as unknown as EveLlmProvider;

  return { router: new AgentLlmRouter(direct, eve), direct, eve };
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
    const { router, direct, eve } = makeRouter(true);

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
    expect(direct.generateJson).not.toHaveBeenCalled();
  });

  it('falls back to direct when Eve is requested but not configured', async () => {
    process.env.ORCHESTRATION_LLM_ENGINE = 'eve';
    const { router, direct, eve } = makeRouter(false);

    expect(router.getStatus()).toMatchObject({
      requestedEngine: 'eve',
      activeEngine: 'direct',
      eveServiceConfigured: false,
    });
    expect(router.getStatus().fallbackReason).toContain('EVE_SERVICE_URL');

    const result = await router.generateJson({
      agentName: 'backend_agent',
      expectedShape: 'object',
      systemPrompt: 'Return JSON.',
      userPrompt: '{}',
    });

    expect(result.value).toEqual({ engine: 'direct' });
    expect(direct.generateJson).toHaveBeenCalledOnce();
    expect(eve.generateJson).not.toHaveBeenCalled();
  });

  it('uses direct when explicitly requested', () => {
    process.env.ORCHESTRATION_LLM_ENGINE = 'direct';
    const { router } = makeRouter(true);

    expect(router.getStatus()).toMatchObject({
      requestedEngine: 'direct',
      activeEngine: 'direct',
      fallbackReason: null,
      eveServiceConfigured: true,
      model: 'openrouter/test-model',
    });
  });

  it('accepts graph as a deprecated alias for direct', () => {
    process.env.ORCHESTRATION_LLM_ENGINE = 'graph';
    const { router } = makeRouter(true);

    expect(router.getStatus()).toMatchObject({
      requestedEngine: 'direct',
      activeEngine: 'direct',
      fallbackReason: 'ORCHESTRATION_LLM_ENGINE=graph is deprecated; use direct.',
      eveServiceConfigured: true,
      model: 'openrouter/test-model',
    });
  });
});
