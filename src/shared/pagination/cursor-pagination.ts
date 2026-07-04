export interface CursorPageInput {
  cursor?: string;
  limit?: number | string;
}

export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function hasCursorPage(input?: CursorPageInput): boolean {
  return Boolean(input?.cursor || input?.limit !== undefined);
}

export function normalizeCursorPage(input?: CursorPageInput): { cursor?: string; limit: number } {
  const limitValue = Number(input?.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitValue)
    ? Math.min(Math.max(Math.trunc(limitValue), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const cursor = input?.cursor?.trim() || undefined;

  return { cursor, limit };
}

export function cursorQueryArgs(input?: CursorPageInput): {
  take: number;
  cursor?: { id: string };
  skip?: number;
} {
  const page = normalizeCursorPage(input);

  return {
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  };
}

export function toCursorPage<TItem extends { id: string }>(
  rows: TItem[],
  input?: CursorPageInput,
): CursorPage<TItem> {
  const { limit } = normalizeCursorPage(input);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? rows[limit]?.id ?? null : null;

  return { items, nextCursor };
}
