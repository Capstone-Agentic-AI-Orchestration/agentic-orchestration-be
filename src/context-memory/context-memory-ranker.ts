import {
  ContextMemoryRecord,
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
    .map((record) => ({
      record,
      score: scoreRecord(record, {
        documentCount,
        documentFrequency,
        input,
        querySet,
      }),
    }))
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
): number {
  const tokens = tokenize(recordText(record));
  const tf = termFrequency(tokens);
  let lexical = 0;

  for (const token of context.querySet) {
    const count = tf.get(token) ?? 0;
    if (count === 0) continue;
    const df = context.documentFrequency.get(token) ?? 1;
    const idf = Math.log(1 + (context.documentCount - df + 0.5) / (df + 0.5));
    lexical += (1 + Math.log(count)) * (1 + idf);
  }

  const phrase = context.input.query?.toLowerCase().trim();
  const text = `${record.title} ${record.content}`.toLowerCase();
  const phraseBonus = phrase && text.includes(phrase) ? 3 : 0;
  const agentBonus = context.input.agentType && record.agentType === context.input.agentType ? 1.5 : 0;
  const tagBonus = (context.input.tags ?? [])
    .filter((tag) => record.tags.includes(tag.toLowerCase())).length * 1.2;
  const runBonus = context.input.runId && record.runId === context.input.runId ? 0.5 : 0;
  const importanceBonus = record.importance * 2;
  const recencyBonus = recencyScore(record.createdAt);

  return (
    lexical +
    phraseBonus +
    agentBonus +
    tagBonus +
    runBonus +
    importanceBonus +
    recencyBonus
  ) * TYPE_WEIGHT[record.type];
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
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:/.-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
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

function normalizeLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.round(value)));
}
