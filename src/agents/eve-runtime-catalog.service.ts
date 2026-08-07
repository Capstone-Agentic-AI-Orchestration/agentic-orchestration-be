import { Injectable, Logger } from '@nestjs/common';

/**
 * What the deployed Eve service says it can actually run.
 *
 * The roster used to be seeded from a hand-maintained constant written by reading the agent
 * package's source. That list could not detect the difference between "in the repository" and
 * "deployed", and the two had already diverged when it was written: it claimed twelve subagents
 * while the deployed service exposed eight. Four keys the orchestration dispatches by name had no
 * runtime behind them, which surfaces as an opaque empty-response error at run time.
 *
 * `GET /eve/v1/info` is the authority on capability. This reads it, caches briefly, and fails
 * soft: if Eve is unreachable the caller gets `null` and falls back to the compiled-in list
 * rather than losing its roster.
 */

export interface EveRuntimeAgent {
  name: string;
  description: string | null;
  toolCount: number;
  hasInstructions: boolean;
}

/** Eve is polled rarely; the manifest only changes on deploy. */
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

@Injectable()
export class EveRuntimeCatalogService {
  private readonly logger = new Logger(EveRuntimeCatalogService.name);
  private cache: { at: number; agents: EveRuntimeAgent[] } | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.EVE_SERVICE_URL?.trim());
  }

  /**
   * @returns the deployed subagents, or null when Eve is not configured or unreachable.
   *
   * Null and empty are deliberately different: null means "we do not know", which must not be
   * read as "nothing is deployed" and used to mark every agent as missing its runtime.
   */
  async listDeployedAgents(): Promise<EveRuntimeAgent[] | null> {
    if (!this.isConfigured()) return null;

    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.agents;
    }

    const baseUrl = (process.env.EVE_SERVICE_URL ?? '').replace(/\/$/, '');
    const token = process.env.EVE_SERVICE_TOKEN?.trim();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(`${baseUrl}/eve/v1/info`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        this.logger.warn(`Eve /info returned ${response.status}; runtime catalog unavailable.`);
        return null;
      }

      const agents = parseEveInfo(await response.json());
      this.cache = { at: Date.now(), agents };
      return agents;
    } catch (error) {
      this.logger.warn(
        `Eve /info unreachable; runtime catalog unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

/**
 * Narrows the `/eve/v1/info` body to the fields the roster needs.
 *
 * Written defensively rather than typed against the Eve version: the installed package and the
 * deployed one are not guaranteed to match, and a shape change should degrade the roster to
 * "unknown" rather than throw inside a request.
 */
export function parseEveInfo(body: unknown): EveRuntimeAgent[] {
  if (!body || typeof body !== 'object') return [];
  const subagents = (body as Record<string, unknown>).subagents;
  if (!subagents || typeof subagents !== 'object') return [];

  const local = (subagents as Record<string, unknown>).local;
  if (!Array.isArray(local)) return [];

  const agents: EveRuntimeAgent[] = [];
  for (const entry of local) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;

    const summary =
      record.summary && typeof record.summary === 'object'
        ? (record.summary as Record<string, unknown>)
        : {};

    agents.push({
      name,
      description: typeof record.description === 'string' ? record.description : null,
      toolCount: typeof summary.tools === 'number' ? summary.tools : 0,
      hasInstructions: summary.instructions === true,
    });
  }
  return agents;
}
