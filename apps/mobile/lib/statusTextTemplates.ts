/**
 * Fixed background/text-style templates for text-only status posts
 * (docs/10-UX-REFINEMENT-BACKLOG.md Batch F item 2 — "a small set of clean
 * background/text-style templates... a fixed palette from the design
 * tokens, not a free-color picker, keeps it clean and modern without
 * ballooning scope"). Literal values lifted straight from
 * `theme/tokens.ts`'s own already-defined colors, not new decorative
 * hues invented for this screen — this app's palette is deliberately just
 * wine + gold + a few neutrals, not a broad multi-hue system.
 *
 * Deliberately theme-invariant (doesn't read from `useTheme()`/light-dark
 * mode) — a story background is the poster's own creative choice, not
 * something that should silently repaint if the viewer's device is in a
 * different theme, same as Instagram/WhatsApp story backgrounds don't
 * follow system theme either.
 *
 * `key` is what's persisted in `status_updates.text_style` — stable, never
 * renamed once shipped (a rename would silently break every unexpired
 * status already posted with the old key, which the viewer would then
 * have no template match for).
 */
export interface StatusTextTemplate {
  key: string;
  label: string;
  background: string;
  foreground: string;
}

export const STATUS_TEXT_TEMPLATES: StatusTextTemplate[] = [
  { key: 'wine', label: 'Wine', background: '#5F1B31', foreground: '#FDFFF7' },
  { key: 'ink', label: 'Ink', background: '#0E0407', foreground: '#FDFFF7' },
  { key: 'gold', label: 'Gold', background: '#F5A623', foreground: '#0E0407' },
  { key: 'forest', label: 'Forest', background: '#0D874E', foreground: '#FDFFF7' },
  { key: 'cream', label: 'Cream', background: '#FDFFF7', foreground: '#0E0407' },
];

export const DEFAULT_STATUS_TEXT_TEMPLATE = STATUS_TEXT_TEMPLATES[0];

export function getStatusTextTemplate(key: string | null): StatusTextTemplate {
  return STATUS_TEXT_TEMPLATES.find((t) => t.key === key) ?? DEFAULT_STATUS_TEXT_TEMPLATE;
}
