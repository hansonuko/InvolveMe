import type { Metadata } from 'next';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Get InvolveMe on Android, iOS, or as a web app.',
};

// All four paths are honest "coming soon" states (docs/15-MARKETING-SITE-
// PWA-SCOPING.md §5) — a real store listing needs roadmap Phase 7, and the
// PWA needs this doc's own Phase D, neither of which exist yet. A
// placeholder badge that links nowhere is a worse first impression than an
// honest wait-list, per that section's own framing.
const INSTALL_PATHS = [
  {
    title: 'Android',
    body: "Coming soon to the Play Store. In the meantime, reach out and we'll add you to the beta list.",
  },
  {
    title: 'iOS',
    body: "Coming soon to the App Store. In the meantime, reach out and we'll add you to the beta list.",
  },
  {
    title: 'Web app (iPhone/iPad)',
    body: 'An installable web version is on the way, with a step-by-step "Add to Home Screen" walkthrough for Safari.',
  },
  {
    title: 'Web app (Android)',
    body: 'A one-tap installable web version is on the way for Chrome on Android.',
  },
];

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string }>;
}) {
  const { verified } = await searchParams;

  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          {verified === '1' ? (
            <p className="mx-auto mb-6 inline-block rounded-pill bg-surface-alt px-5 py-2 text-caption font-semibold text-success">
              ✓ Your number is confirmed
            </p>
          ) : null}
          <Eyebrow>Download</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Get InvolveMe
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            We&apos;re not in the app stores yet — here&apos;s the honest status of every way to get
            InvolveMe.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2">
        {INSTALL_PATHS.map((path, i) => (
          <AnimatedSection key={path.title} delay={i * 0.08}>
            <Card className="h-full">
              <p className="text-caption font-semibold uppercase tracking-wide text-credit">
                Coming soon
              </p>
              <h2 className="mt-2 text-title font-bold text-foreground">{path.title}</h2>
              <p className="mt-3 text-body text-muted">{path.body}</p>
            </Card>
          </AnimatedSection>
        ))}
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">Want to be first to know?</h2>
          <p className="mx-auto mt-3 max-w-md text-body text-muted">
            Reach out and we&apos;ll let you know the moment InvolveMe is available for your device.
          </p>
          <a
            href="/contact"
            className="mt-6 inline-block rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
          >
            Contact us
          </a>
        </AnimatedSection>
      </Section>
    </>
  );
}
