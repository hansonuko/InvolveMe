// Cursor-based pagination, not offset — docs/14-ADMIN-DASHBOARD-SCOPING.md
// §8 explicitly rules out offset pagination for exactly this class of
// table (large, frequently-changing). The cursor is a (created_at, id)
// pair (the "seek method"): id breaks ties when two rows share a
// created_at timestamp, which a created_at-only cursor could otherwise
// skip or duplicate across a page boundary.

export type PageCursor = { createdAt: string; id: string };

export function encodeCursor(row: PageCursor): string {
  return Buffer.from(JSON.stringify(row)).toString('base64url');
}

export function decodeCursor(raw: string | string[] | undefined): PageCursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // malformed/tampered cursor — treat as "no cursor" rather than erroring,
    // same as any other bad query-string input.
  }
  return null;
}

// PostgREST `or=` filter string for "strictly before this cursor" in a
// `<column> desc, id desc` ordering. `column` defaults to `created_at`
// (every table this was originally written for) but some tables — e.g.
// `pricing_config_history.changed_at` — use a different name for the same
// role, so the column is overridable rather than duplicating this function.
export function cursorFilter(cursor: PageCursor, column: string = 'created_at'): string {
  return `${column}.lt.${cursor.createdAt},and(${column}.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

// `,`, `(`, `)` are structural in PostgREST's `or=` filter grammar — a
// search term containing one would either break the filter or (worse)
// silently change its grouping. None of those characters are meaningful in
// a phone number or display name for this app, so stripping them is a
// harmless, safe-by-construction fix rather than trying to escape/quote
// correctly per PostgREST's own quoting rules.
export function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[,()]/g, '').trim();
}
