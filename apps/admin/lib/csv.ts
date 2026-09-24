// Minimal CSV writer — no new dependency (CLAUDE.md rule #10: check
// whether existing tooling already covers it before reaching for a
// package; a handful of lines of RFC 4180 quoting doesn't earn one).
// A field needs quoting if it contains a comma, double quote, or newline;
// a literal double quote inside a quoted field is escaped by doubling it.
function escapeCsvField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// docs/14 §8 asks for "a hard cap + async CSV-export job... instead of a
// synchronous 'export everything' button." No job-queue infra exists
// anywhere in this codebase (no pg_cron jobs table, no polling UI) —
// standing one up is disproportionate for an internal tool at current
// scale, so this is a deliberate, reasoned deviation from the doc's
// literal wording (same shape of deviation as Phase A's argon2->scrypt
// call): synchronous but hard-capped, not async. Once matching rows
// exceed this cap, the export is refused rather than silently truncated
// — an admin should never believe they got the full data when they
// didn't, same fail-loud posture as every pricing function that raises on
// an unconfigured currency rather than defaulting quietly.
export const EXPORT_ROW_CAP = 20000;
