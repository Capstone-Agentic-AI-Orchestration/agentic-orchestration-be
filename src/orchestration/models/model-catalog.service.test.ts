import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelCatalogService,
  normalizeGatewayModels,
} from './model-catalog.service';

const gatewayModels = [
  {
    id: 'paid/strong-model',
    name: 'Strong Model',
    type: 'language',
    modalities: { input: ['text'], output: ['text'] },
    context_window: 128_000,
    max_tokens: 16_000,
    pricing: { input: '0.000001', output: '0.000002' },
  },
  {
    id: 'free/fast-model',
    name: 'Fast Model',
    type: 'language',
    modalities: { input: ['text'], output: ['text'] },
    context_window: 64_000,
    pricing: { input: '0', output: '0' },
  },
  {
    id: 'media/image-model',
    name: 'Image Model',
    type: 'image',
    modalities: { input: ['text'], output: ['image'] },
    pricing: { input: '0', output: '0' },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORCHESTRATION_DEFAULT_MODEL;
});

describe('ModelCatalogService', () => {
  it('keeps text-generation models, marks free models, and orders them first', () => {
    const models = normalizeGatewayModels(gatewayModels);

    expect(models.map((model) => model.id)).toEqual([
      'free/fast-model',
      'paid/strong-model',
    ]);
    expect(models[0]).toMatchObject({
      free: true,
      provider: 'free',
      contextWindow: 64_000,
    });
  });

  it('validates a default model and specialist overrides against the live catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: gatewayModels }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    process.env.ORCHESTRATION_DEFAULT_MODEL = 'free/fast-model';
    const service = new ModelCatalogService();

    await expect(service.validateSelection({
      defaultModel: 'free/fast-model',
      overrides: {
        backend: 'paid/strong-model',
        frontend: 'free/fast-model',
      },
    })).resolves.toEqual({
      defaultModel: 'free/fast-model',
      overrides: { backend: 'paid/strong-model' },
    });
  });

  it('rejects a model that disappeared from the Gateway catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: gatewayModels }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const service = new ModelCatalogService();

    await expect(service.validateSelection({
      defaultModel: 'removed/old-model',
    })).rejects.toThrow('no longer available');
  });
});
