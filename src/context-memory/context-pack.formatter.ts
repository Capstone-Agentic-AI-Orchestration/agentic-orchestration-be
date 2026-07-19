import {
  ContextMemoryRecord,
  ContextMemoryType,
} from './context-memory.types';
import { rankContextMemories } from './context-memory-ranker';
import { BuildContextPackDto } from './dto/context-memory.dto';

const SECTIONS: Array<[ContextMemoryType, string, number]> = [
  ['decision', 'Critical Decisions', 6],
  ['progress_event', 'Live Progress', 4],
  ['handoff', 'Handoffs', 6],
  ['error', 'Errors To Avoid', 6],
  ['agent_output', 'Relevant Agent Outputs', 6],
  ['artifact', 'Artifacts', 6],
  ['project_memory', 'Project Memory', 6],
];

export function formatContextPack(records: ContextMemoryRecord[], input: RequiredPackInput) {
  const included = Object.fromEntries(
    SECTIONS.map(([type]) => [type, [] as string[]]),
  ) as Record<ContextMemoryType, string[]>;

  const lines = [
    '# MEMORY CONTEXT PACK',
    `projectId: ${input.projectId}`,
    input.runId ? `runId: ${input.runId}` : null,
    `agentType: ${input.agentType}`,
    `task: ${input.task}`,
    `generatedAt: ${new Date().toISOString()}`,
    '',
    'Instruction: Use this as context. Treat Critical Decisions as authoritative, Errors To Avoid as constraints, and Handoffs as active cross-agent obligations.',
  ].filter((line): line is string => Boolean(line));

  for (const [type, title, limit] of SECTIONS) {
    const ranked = rankContextMemories(records, {
      projectId: input.projectId,
      runId: input.runId,
      agentType: input.agentType,
      query: input.task,
      tags: input.tags,
      types: [type],
      limit,
    });
    if (ranked.length === 0) continue;

    lines.push('', `## ${title}`);
    for (const result of ranked) {
      included[type].push(result.record.id);
      lines.push(formatRecord(result.record));
    }
  }

  return {
    projectId: input.projectId,
    runId: input.runId ?? null,
    agentType: input.agentType,
    task: input.task,
    maxChars: input.maxChars,
    text: fitToBudget(lines.join('\n'), input.maxChars),
    included,
  };
}

export interface RequiredPackInput extends BuildContextPackDto {
  runId?: string;
  tags: string[];
  maxChars: number;
}

function formatRecord(record: ContextMemoryRecord): string {
  const meta = [
    record.agentType ? `agent=${record.agentType}` : null,
    record.runId ? `run=${record.runId}` : null,
    `importance=${record.importance.toFixed(2)}`,
    record.tags.length ? `tags=${record.tags.join(',')}` : null,
  ].filter(Boolean).join(' ');
  const progress = record.progress
    ? ` progress=${[
        record.progress.status,
        record.progress.node,
        typeof record.progress.percent === 'number' ? `${record.progress.percent}%` : null,
      ].filter(Boolean).join('/')}`
    : '';
  const artifact = record.artifact?.path ? ` artifact=${record.artifact.path}` : '';

  return `- ${record.title} (${meta}${progress}${artifact})\n  ${compact(record.content, 900)}`;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function fitToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n\n[Context pack truncated to fit requested budget.]';
  return `${text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}
