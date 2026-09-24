import type { LegalSection } from '@involveme/legal-content';

// Dense-reading renderer, deliberately plain (no card/motion wrapping like
// the marketing sections use) — same LegalSection[] shape
// apps/mobile/components/LegalDocumentScreen.tsx renders natively, just
// with this app's own web-appropriate presentation.
export function LegalDocument({
  title,
  lastUpdated,
  sections,
}: {
  title: string;
  lastUpdated: string;
  sections: LegalSection[];
}) {
  return (
    <article className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-display font-extrabold text-foreground">{title}</h1>
      <p className="mt-2 text-caption text-muted">Last updated {lastUpdated}</p>

      {sections.map((section) => (
        <section key={section.heading} className="mt-10">
          <h2 className="text-title font-bold text-foreground">{section.heading}</h2>
          {section.body.map((paragraph, i) => (
            <p key={i} className="mt-3 text-body leading-relaxed text-muted">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
