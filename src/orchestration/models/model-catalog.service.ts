import { BadRequestException, Injectable, Logger } from '@nestjs/common';

const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
const FALLBACK_MODEL = 'inclusionai/ling-3.0-flash-free';
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export const ORCHESTRATION_MODEL_TARGETS = [
  'requirements',
  'contract',
  'frontend',
  'backend',
  'database',
  'architecture',
  'mobile',
  'qa',
  'security',
  'critique',
] as const;

export type OrchestrationModelTarget = (typeof ORCHESTRATION_MODEL_TARGETS)[number];

export interface OrchestrationModelSelectionInput {
  defaultModel: string;
  overrides?: Partial<Record<OrchestrationModelTarget, string>>;
}

export interface OrchestrationModelSelection {
  defaultModel: string;
  overrides: Partial<Record<OrchestrationModelTarget, string>>;
}

export interface GatewayModelCatalogItem {
  id: string;
  name: string;
  provider: string;
  description: string;
  contextWindow: number | null;
  maxTokens: number | null;
  pricing: {
    input: string | null;
    output: string | null;
  };
  free: boolean;
}

export interface GatewayModelCatalog {
  models: GatewayModelCatalogItem[];
  defaultModel: string;
  source: 'live' | 'cache' | 'fallback';
  fetchedAt: string;
  warning: string | null;
}

interface GatewayModelsResponse {
  data?: unknown;
}

@Injectable()
export class ModelCatalogService {
  private readonly logger = new Logger(ModelCatalogService.name);
  private cached: { catalog: GatewayModelCatalog; expiresAt: number } | null = null;
  private inFlight: Promise<GatewayModelCatalog> | null = null;

  async getCatalog(): Promise<GatewayModelCatalog> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return { ...this.cached.catalog, source: 'cache' };
    }

    if (!this.inFlight) {
      this.inFlight = this.fetchCatalog().finally(() => {
        this.inFlight = null;
      });
    }

    try {
      return await this.inFlight;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Vercel AI Gateway model catalog unavailable: ${reason}`);
      if (this.cached) {
        return {
          ...this.cached.catalog,
          source: 'cache',
          warning: 'The live Gateway catalog is temporarily unavailable. Showing the last successful model list.',
        };
      }
      return this.fallbackCatalog();
    }
  }

  async validateSelection(
    input?: OrchestrationModelSelectionInput,
  ): Promise<OrchestrationModelSelection> {
    const catalog = await this.getCatalog();
    const available = new Set(catalog.models.map((model) => model.id));
    const defaultModel = input?.defaultModel?.trim() || catalog.defaultModel;
    const requested = [
      defaultModel,
      ...Object.values(input?.overrides ?? {}).map((model) => model?.trim()).filter(Boolean),
    ] as string[];
    const unavailable = requested.filter((model) => !available.has(model));

    if (unavailable.length > 0) {
      throw new BadRequestException(
        `The selected Gateway model${unavailable.length === 1 ? ' is' : 's are'} no longer available: ${unavailable.join(', ')}. Refresh the model list and choose again.`,
      );
    }

    const overrides: Partial<Record<OrchestrationModelTarget, string>> = {};
    for (const target of ORCHESTRATION_MODEL_TARGETS) {
      const model = input?.overrides?.[target]?.trim();
      if (model && model !== defaultModel) overrides[target] = model;
    }

    return { defaultModel, overrides };
  }

  private async fetchCatalog(): Promise<GatewayModelCatalog> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(GATEWAY_MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Gateway catalog returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as GatewayModelsResponse;
    const models = normalizeGatewayModels(body.data);
    if (models.length === 0) {
      throw new Error('Gateway catalog did not contain any text-generation models');
    }

    const configuredDefault = process.env.ORCHESTRATION_DEFAULT_MODEL?.trim();
    const defaultModel = configuredDefault && models.some((model) => model.id === configuredDefault)
      ? configuredDefault
      : models.some((model) => model.id === FALLBACK_MODEL)
        ? FALLBACK_MODEL
        : models[0].id;
    const catalog: GatewayModelCatalog = {
      models,
      defaultModel,
      source: 'live',
      fetchedAt: new Date().toISOString(),
      warning: null,
    };
    this.cached = { catalog, expiresAt: Date.now() + CACHE_TTL_MS };
    return catalog;
  }

  private fallbackCatalog(): GatewayModelCatalog {
    return {
      models: [{
        id: FALLBACK_MODEL,
        name: 'Ling 3.0 Flash Free',
        provider: 'inclusionai',
        description: 'Fallback model shown while the Vercel AI Gateway catalog is unavailable.',
        contextWindow: null,
        maxTokens: null,
        pricing: { input: '0', output: '0' },
        free: true,
      }],
      defaultModel: FALLBACK_MODEL,
      source: 'fallback',
      fetchedAt: new Date().toISOString(),
      warning: 'The live Gateway catalog is temporarily unavailable. You can use the fallback model or try again shortly.',
    };
  }
}

export function normalizeGatewayModels(value: unknown): GatewayModelCatalogItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isRecord)
    .filter((model) => model.type === 'language')
    .filter((model) => hasTextOutput(model.modalities))
    .map((model): GatewayModelCatalogItem | null => {
      const id = stringValue(model.id);
      if (!id || !id.includes('/')) return null;
      const pricing = isRecord(model.pricing) ? model.pricing : {};
      const input = nullableString(pricing.input);
      const output = nullableString(pricing.output);
      return {
        id,
        name: stringValue(model.name) || id,
        provider: id.split('/')[0],
        description: stringValue(model.description),
        contextWindow: positiveInteger(model.context_window),
        maxTokens: positiveInteger(model.max_tokens),
        pricing: { input, output },
        free: numericPrice(input) === 0 && numericPrice(output) === 0,
      };
    })
    .filter((model): model is GatewayModelCatalogItem => model !== null)
    .sort((left, right) => {
      if (left.free !== right.free) return left.free ? -1 : 1;
      return left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name);
    });
}

function hasTextOutput(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.output)) return false;
  return value.output.includes('text');
}

function numericPrice(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
