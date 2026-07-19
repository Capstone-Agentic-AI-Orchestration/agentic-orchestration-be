import type { ValidationError } from '../schemas/schema.types';

/**
 * Cross-artifact integration checking.
 *
 * Where {@link checkTypeScriptProgram} verifies references *within* the generated
 * TypeScript, this verifies references *between* the agents' outputs — the
 * integration seams that no single-agent check can see:
 *
 *  1. Frontend → Backend: a UI `fetch`/`axios` call to a resource family the
 *     backend never exposes as a route (the classic "frontend talks to an
 *     endpoint the backend didn't build").
 *  2. Backend → Database: a `prisma.<model>` access for a model the generated
 *     Prisma schema never declares.
 *
 * Both checks are deliberately conservative — they only fire when the "source of
 * truth" set is non-empty (there are backend routes / schema models to check
 * against) and use resource-segment matching rather than exact-path matching, so
 * differences in path shape (`/api` prefixes, path params, query strings) do not
 * produce false retries. Findings are emitted as `CONTRACT` errors attributed to
 * the agent making the unsatisfied reference, so they flow into the validator's
 * per-agent retry fan-out.
 */

export interface IntegrationArtifact {
  agentType: 'frontend' | 'backend' | 'database' | 'architecture' | 'mobile';
  filePath: string;
  content: string;
}

/** Path segments that carry no resource meaning and must not drive matching. */
const SEGMENT_STOPLIST = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'graphql']);

/** Prisma client members that are not models. */
const NON_MODEL_PRISMA_MEMBERS = new Set([
  'prototype',
  'constructor',
  'length',
  'name',
]);

const MAX_ISSUES_PER_CHECK = 12;

export function checkIntegration(
  artifacts: IntegrationArtifact[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  errors.push(...checkFrontendToBackend(artifacts));
  errors.push(...checkBackendToDatabase(artifacts));
  errors.push(...checkDtoConsistency(artifacts));
  errors.push(...checkAuthGuardPresence(artifacts));
  return errors;
}

// ─── Frontend → Backend ─────────────────────────────────────────────────────────

function checkFrontendToBackend(
  artifacts: IntegrationArtifact[],
): ValidationError[] {
  const backendFiles = artifacts.filter((a) => a.agentType === 'backend');
  const frontendFiles = artifacts.filter((a) => a.agentType === 'frontend');
  if (backendFiles.length === 0 || frontendFiles.length === 0) return [];

  const routes = backendFiles.flatMap((f) => extractBackendRoutes(f.content));
  if (routes.length === 0) return [];

  const backendVocab = new Set<string>();
  for (const route of routes) {
    for (const segment of resourceSegments(route)) backendVocab.add(segment);
  }
  if (backendVocab.size === 0) return [];

  const errors: ValidationError[] = [];
  const seen = new Set<string>();

  for (const file of frontendFiles) {
    for (const call of extractFrontendApiCalls(file.content)) {
      const segments = resourceSegments(call);
      if (segments.length === 0) continue; // nothing concrete to match on
      if (seen.has(call)) continue;

      const reachable = segments.some((s) => backendVocab.has(s));
      if (!reachable) {
        seen.add(call);
        errors.push({
          code: 'CONTRACT',
          agentType: 'frontend',
          path: file.filePath,
          message: `frontend calls "${call}" but no backend route exposes a matching resource (backend exposes: ${[...backendVocab].slice(0, 8).join(', ')})`,
        });
        if (errors.length >= MAX_ISSUES_PER_CHECK) return errors;
      }
    }
  }

  return errors;
}

// ─── Backend → Database ─────────────────────────────────────────────────────────

function checkBackendToDatabase(
  artifacts: IntegrationArtifact[],
): ValidationError[] {
  const backendFiles = artifacts.filter((a) => a.agentType === 'backend');
  const dbFiles = artifacts.filter((a) => a.agentType === 'database');
  if (backendFiles.length === 0 || dbFiles.length === 0) return [];

  const models = new Set<string>();
  for (const file of dbFiles) {
    for (const model of extractPrismaModels(file.content)) {
      models.add(model.toLowerCase());
    }
  }
  if (models.size === 0) return [];

  const errors: ValidationError[] = [];
  const seen = new Set<string>();

  for (const file of backendFiles) {
    for (const accessor of extractPrismaModelAccess(file.content)) {
      const normalized = accessor.toLowerCase();
      if (seen.has(normalized)) continue;
      if (modelExists(normalized, models)) continue;

      seen.add(normalized);
      errors.push({
        code: 'CONTRACT',
        agentType: 'backend',
        path: file.filePath,
        message: `backend references Prisma model "${accessor}" via prisma.${accessor}, but no such model is defined in the schema (schema defines: ${[...models].slice(0, 8).join(', ')})`,
      });
      if (errors.length >= MAX_ISSUES_PER_CHECK) return errors;
    }
  }

  return errors;
}

// ─── DTO Consistency ──────────────────────────────────────────────────────────

/**
 * Checks that DTOs referenced in frontend form fields / request bodies match
 * the DTO classes defined in backend artifacts. Catches mismatches between
 * what the frontend sends and what the backend expects.
 */
function checkDtoConsistency(
  artifacts: IntegrationArtifact[],
): ValidationError[] {
  const backendFiles = artifacts.filter((a) => a.agentType === 'backend');
  const frontendFiles = artifacts.filter((a) => a.agentType === 'frontend');
  if (backendFiles.length === 0 || frontendFiles.length === 0) return [];

  // Extract backend DTO field names
  const dtoFields = new Map<string, Set<string>>();
  for (const file of backendFiles) {
    const dtoRe = /(?:class|interface)\s+(\w*(?:Dto|DTO|Input|Request))\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = dtoRe.exec(file.content)) !== null) {
      const name = m[1];
      const body = m[2];
      const fields = new Set<string>();
      const fieldRe = /(?:readonly\s+|public\s+|private\s+)?(\w+)\s*[:?]/g;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        fields.add(fm[1].toLowerCase());
      }
      if (fields.size > 0) dtoFields.set(name.toLowerCase(), fields);
    }
  }
  if (dtoFields.size === 0) return [];

  // Check frontend for form field names / request body shapes that don't match any DTO
  const errors: ValidationError[] = [];
  const seen = new Set<string>();

  for (const file of frontendFiles) {
    // Check for form submission field names
    const formFieldRe = /(?:name|id)\s*[:=]\s*['"`]([a-zA-Z_][a-zA-Z0-9_]*)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = formFieldRe.exec(file.content)) !== null) {
      const field = m[1].toLowerCase();
      if (seen.has(field)) continue;
      // Check if any DTO has this field
      const inAnyDto = [...dtoFields.values()].some((fields) => fields.has(field));
      if (!inAnyDto && field.length > 2 && !/^(submit|reset|button|form|input|select|textarea|email|password|text|hidden|search)$/.test(field)) {
        seen.add(field);
        errors.push({
          code: 'CONTRACT',
          agentType: 'frontend',
          path: file.filePath,
          message: `frontend references field "${m[1]}" but no backend DTO declares this field (backend DTOs: ${[...dtoFields.keys()].slice(0, 5).join(', ')})`,
        });
        if (errors.length >= MAX_ISSUES_PER_CHECK) return errors;
      }
    }
  }

  return errors;
}

// ─── Auth Guard Presence ──────────────────────────────────────────────────────

/**
 * Checks that if backend controllers define protected routes (with @UseGuards,
 * @Roles, or auth-related decorators), there's a corresponding auth guard
 * implementation in the artifacts.
 */
function checkAuthGuardPresence(
  artifacts: IntegrationArtifact[],
): ValidationError[] {
  const backendFiles = artifacts.filter((a) => a.agentType === 'backend');
  if (backendFiles.length === 0) return [];

  const hasAuthDecorator = backendFiles.some((f) =>
    /@(?:UseGuards|Roles|ApiBearerAuth|RequireAuth)/.test(f.content),
  );
  if (!hasAuthDecorator) return [];

  const hasAuthGuard = backendFiles.some((f) =>
    /(?:AuthGuard|CanActivate|guard\.ts|auth\.guard)/i.test(f.filePath) ||
    /implements\s+CanActivate/.test(f.content),
  );

  if (!hasAuthGuard) {
    return [{
      code: 'CONTRACT',
      agentType: 'backend',
      path: backendFiles[0].filePath,
      message: 'backend uses auth decorators (@UseGuards/@Roles/@ApiBearerAuth) but no auth guard implementation was found in the generated artifacts',
    }];
  }

  return [];
}

// ─── Extraction helpers ─────────────────────────────────────────────────────────

/** Builds full route paths from a NestJS controller file. */
export function extractBackendRoutes(content: string): string[] {
  const controllerMatch = content.match(
    /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/,
  );
  const base = controllerMatch?.[1] ?? '';

  const routes: string[] = [];
  const methodRe =
    /@(?:Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:['"`]([^'"`]*)['"`])?/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(content)) !== null) {
    routes.push(joinPath(base, m[1] ?? ''));
  }
  return routes;
}

/** Extracts candidate API call paths from fetch/axios usage in frontend code. */
export function extractFrontendApiCalls(content: string): string[] {
  const calls: string[] = [];
  const patterns = [
    /fetch\(\s*[`'"]([^`'"]+)[`'"]/g,
    /axios\s*\.\s*(?:get|post|put|patch|delete|request)\(\s*[`'"]([^`'"]+)[`'"]/g,
    /axios\(\s*[`'"]([^`'"]+)[`'"]/g,
    /\burl\s*:\s*[`'"]([^`'"]+)[`'"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1];
      if (/^https?:\/\//i.test(raw)) continue; // external URL — out of scope
      if (!raw.includes('/')) continue; // not a path
      calls.push(raw);
    }
  }
  return calls;
}

/** Extracts model names declared in a Prisma schema. */
export function extractPrismaModels(content: string): string[] {
  const models: string[] = [];
  const re = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) models.push(m[1]);
  return models;
}

/** Extracts the model accessors used on a Prisma client (`prisma.user` → user). */
export function extractPrismaModelAccess(content: string): string[] {
  const accessors: string[] = [];
  const re = /\bprisma\.([a-zA-Z][a-zA-Z0-9]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const accessor = m[1];
    if (NON_MODEL_PRISMA_MEMBERS.has(accessor)) continue;
    accessors.push(accessor);
  }
  return accessors;
}

// ─── Path / name normalization ──────────────────────────────────────────────────

function joinPath(base: string, sub: string): string {
  const parts = [...splitPath(base), ...splitPath(sub)];
  return `/${parts.join('/')}`;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * The meaningful, matchable segments of a path: static (non-parameter) segments,
 * lowercased, with framework/version noise removed. Template holes (`${...}`) and
 * route params (`:id`) collapse away.
 */
function resourceSegments(path: string): string[] {
  const cleaned = path
    .replace(/\?[^]*$/, '') // query string
    .replace(/#[^]*$/, '') // hash
    .replace(/\$\{[^}]*\}/g, '/') // template holes
    .replace(/:[A-Za-z0-9_]+/g, '/'); // route params

  return splitPath(cleaned)
    .map((s) => s.toLowerCase())
    .filter((s) => /^[a-z][a-z0-9_-]*$/.test(s)) // word-like segments only
    .filter((s) => !SEGMENT_STOPLIST.has(s));
}

/** True if a prisma accessor resolves to a declared model (with plural tolerance). */
function modelExists(accessor: string, models: Set<string>): boolean {
  if (models.has(accessor)) return true;
  if (accessor.endsWith('s') && models.has(accessor.slice(0, -1))) return true;
  if (accessor.endsWith('es') && models.has(accessor.slice(0, -2))) return true;
  return false;
}
