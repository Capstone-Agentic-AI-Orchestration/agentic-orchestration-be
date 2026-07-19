import {
  ContextMemoryRecord,
  ContextMemorySearchReason,
  ContextMemorySearchResult,
  ContextMemoryType,
} from './context-memory.types';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with',
]);

const TYPE_WEIGHT: Record<ContextMemoryType, number> = {
  decision: 1.25,
  error: 1.2,
  handoff: 1.15,
  progress_event: 1.05,
  agent_output: 1,
  artifact: 0.95,
  project_memory: 1.1,
};

const EMBEDDING_DIMENSIONS = 64;

const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  auth: ['authorization', 'guard', 'membership', 'access', 'secure', 'verify'],
  authorization: ['auth', 'guard', 'membership', 'access', 'secure', 'verify'],
  authorize: ['auth', 'guard', 'membership', 'access', 'secure', 'verify'],
  guard: ['auth', 'authorization', 'protect', 'verify', 'membership', 'access'],
  guards: ['auth', 'authorization', 'protect', 'verify', 'membership', 'access'],
  protect: ['guard', 'secure', 'verify', 'authorization', 'membership'],
  verify: ['guard', 'protect', 'check', 'authorization', 'membership'],
  check: ['verify', 'guard', 'membership', 'authorization'],
  membership: ['authorization', 'auth', 'access', 'guard', 'project'],
  permission: ['authorization', 'auth', 'access', 'membership'],
  permissions: ['authorization', 'auth', 'access', 'membership'],
  artifact: ['file', 'source', 'output', 'delivery'],
  artifacts: ['artifact', 'file', 'source', 'output', 'delivery'],
  endpoint: ['route', 'api'],
  endpoints: ['endpoint', 'route', 'api'],
  api: ['endpoint', 'route'],
  route: ['endpoint', 'api'],
  routes: ['endpoint', 'api'],
};

export interface RankInput {
  projectId?: string | null;
  runId?: string | null;
  agentType?: string | null;
  query?: string | null;
  tags?: string[];
  types?: ContextMemoryType[];
  limit?: number;
}

export function rankContextMemories(
  records: ContextMemoryRecord[],
  input: RankInput,
): ContextMemorySearchResult[] {
  const candidates = records.filter((record) => matchesFilters(record, input));
  const queryTokens = tokenize([
    input.query ?? '',
    input.agentType ?? '',
    ...(input.tags ?? []),
  ].join(' '));
  const documentFrequency = buildDocumentFrequency(candidates);
  const documentCount = Math.max(candidates.length, 1);
  const querySet = new Set(queryTokens);

  return candidates
    .map((record) => {
      const reason = scoreRecord(record, {
        documentCount,
        documentFrequency,
        input,
        querySet,
      });
      return {
        record,
        score: totalScore(reason),
        reason,
      };
    })
    .filter((result) => result.score > 0 || queryTokens.length === 0)
    .sort((a, b) => (
      b.score - a.score ||
      b.record.createdAt.getTime() - a.record.createdAt.getTime()
    ))
    .slice(0, normalizeLimit(input.limit));
}

function matchesFilters(record: ContextMemoryRecord, input: RankInput): boolean {
  if (input.projectId && record.projectId !== input.projectId) return false;
  if (input.runId && record.runId && record.runId !== input.runId) return false;
  if (input.types?.length && !input.types.includes(record.type)) return false;
  if (!record.pinned) {
    if (record.status !== 'active') return false;
    if (record.archivedAt) return false;
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return false;
  }
  for (const tag of input.tags ?? []) {
    if (!record.tags.includes(tag.toLowerCase())) return false;
  }
  return true;
}

function scoreRecord(
  record: ContextMemoryRecord,
  context: {
    documentCount: number;
    documentFrequency: Map<string, number>;
    input: RankInput;
    querySet: Set<string>;
  },
): ContextMemorySearchReason {
  const tokens = tokenize(recordText(record));
  const tf = termFrequency(tokens);
  let lexical = 0;
  const matchedTerms: string[] = [];

  for (const token of context.querySet) {
    const count = tf.get(token) ?? 0;
    if (count === 0) continue;
    matchedTerms.push(token);
    const df = context.documentFrequency.get(token) ?? 1;
    const idf = Math.log(1 + (context.documentCount - df + 0.5) / (df + 0.5));
    lexical += (1 + Math.log(count)) * (1 + idf);
  }

  const phrase = context.input.query?.toLowerCase().trim();
  const text = `${record.title} ${record.content}`.toLowerCase();
  const phraseBonus = phrase && text.includes(phrase) ? 3 : 0;
  const agentBonus = context.input.agentType && record.agentType === context.input.agentType ? 1.5 : 0;
  const matchedTags = (context.input.tags ?? [])
    .filter((tag) => record.tags.includes(tag.toLowerCase()));
  const tagBonus = matchedTags.length * 1.2;
  const runBonus = context.input.runId && record.runId === context.input.runId ? 0.5 : 0;
  const importanceBonus = record.importance * 2;
  const semanticScore = semanticSimilarity(
    context.input.query ?? '',
    record.embedding ?? localEmbedding(recordText(record)),
  ) * 4;
  const recencyBonus = recencyScore(record.createdAt);
  const lifecycleScore = record.pinned ? 0.75 : 0;

  return {
    lexicalScore: lexical + phraseBonus,
    semanticScore,
    tagScore: tagBonus,
    agentScore: agentBonus + runBonus,
    importanceScore: importanceBonus,
    recencyScore: recencyBonus,
    lifecycleScore,
    typeWeight: TYPE_WEIGHT[record.type],
    matchedTags,
    matchedTerms,
  };
}

function buildDocumentFrequency(records: ContextMemoryRecord[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const record of records) {
    for (const token of new Set(tokenize(recordText(record)))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return frequency;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return frequency;
}

function tokenize(value: string): string[] {
  const baseTokens = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:/.-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const expanded = new Set<string>();
  for (const token of baseTokens) {
    expanded.add(token);
    for (const synonym of SEMANTIC_EXPANSIONS[token] ?? []) {
      expanded.add(normalizeToken(synonym));
    }
  }
  return [...expanded];
}

function recordText(record: ContextMemoryRecord): string {
  return [
    record.title,
    record.content,
    record.agentType ?? '',
    record.type,
    ...record.tags,
    record.artifact?.path ?? '',
    record.artifact?.kind ?? '',
    JSON.stringify(record.metadata),
  ].join(' ');
}

function recencyScore(createdAt: Date): number {
  const ageDays = Math.max(0, (Date.now() - createdAt.getTime()) / 86_400_000);
  return Math.max(0, 1 - ageDays / 30);
}

export function localEmbedding(value: string): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const token of tokenize(value)) {
    const index = stableHash(token) % EMBEDDING_DIMENSIONS;
    vector[index] += 1;
  }
  return normalizeVector(vector);
}

export function serializeEmbedding(value: string): string {
  return `[${localEmbedding(value).map((component) => component.toFixed(6)).join(',')}]`;
}

function semanticSimilarity(query: string, recordEmbedding: number[]): number {
  const queryEmbedding = localEmbedding(query);
  return cosineSimilarity(queryEmbedding, recordEmbedding);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  if (norm === 0) return vector;
  return vector.map((component) => component / norm);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function totalScore(reason: ContextMemorySearchReason): number {
  return (
    reason.lexicalScore +
    reason.semanticScore +
    reason.tagScore +
    reason.agentScore +
    reason.importanceScore +
    reason.recencyScore +
    reason.lifecycleScore
  ) * reason.typeWeight;
}

function normalizeToken(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function normalizeLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.round(value)));
}
