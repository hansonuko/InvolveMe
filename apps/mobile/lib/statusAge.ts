/** Short relative age for a status, e.g. "5m ago"/"2h ago" — shared by
 * status.tsx's carousel/viewed-list rows and StoryViewer's own header, so
 * the two don't drift into slightly different wording. Statuses expire at
 * 24h (docs/03-ECONOMY-LEDGER.md §7), so day-level granularity is never
 * actually needed the way chats.tsx's own timestamp helper needs it for
 * messages that can be arbitrarily old. */
export function formatStatusAge(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
