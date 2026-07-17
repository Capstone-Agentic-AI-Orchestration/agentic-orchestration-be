import { createHash } from 'crypto';

const SECRET_LINE = /(?:api[_-]?key|secret|token|password|authorization|service[_-]?role|private[_-]?key|database_url|supabase[_-]?key)\s*(?:[:=]|\b)/i;
const ENV_ASSIGNMENT = /^[A-Z][A-Z0-9_]{2,}\s*=\s*.+$/;
const HIDDEN_PROMPT = /(?:system prompt|hidden prompt|chain[- ]of[- ]thought|internal reasoning)/i;

/** Removes information that must never be put into an index or prompt. */
export function sanitizeRagText(value: string | null | undefined, maxChars = 40_000): string {
  if (!value) return '';
  const safeLines = value
    .split('\0').join('')
    .split(/\r?\n/)
    .filter((line) => !SECRET_LINE.test(line))
    .filter((line) => !ENV_ASSIGNMENT.test(line))
    .filter((line) => !HIDDEN_PROMPT.test(line));
  return safeLines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

export function compactText(value: string, maxChars = 900): string {
  const cleaned = sanitizeRagText(value, maxChars * 3).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  const boundary = cleaned.lastIndexOf(' ', maxChars - 1);
  return `${cleaned.slice(0, boundary > 120 ? boundary : maxChars).trim()}…`;
}

export function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function chunkRagText(value: string, maxChars = 4_000): string[] {
  const safe = sanitizeRagText(value);
  if (!safe) return [];
  if (safe.length <= maxChars) return [safe];

  const chunks: string[] = [];
  let remaining = safe;
  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars);
    const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('. '), candidate.lastIndexOf(' '));
    const cut = boundary > maxChars / 2 ? boundary + 1 : maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function ragSummary(value: string): string {
  return compactText(value, 700);
}
