import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { VerifiedBanner } from '@/components/VerifiedBanner';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Get InvolveMe on Android, or as an installable web app for iOS.',
};

// No store listing exists yet (roadmap Phase 7), so this page is honest
// about what's actually possible today per platform, rather than four
// identical "coming soon" boxes: Android can be sideloaded once a build
// exists (no app-store review required for that), iOS fundamentally
// cannot outside TestFlight or a paid enterprise certificate, so the real
// path there is the installable web app once it ships (docs/15's Phase D).
const ANDROID_STEPS = [
  'Download the APK file below.',
  'When prompted, allow your browser to install apps from this source (Settings, then Apps, then Special app access, then Install unknown apps).',
  'Open the downloaded file and tap Install.',
  "Once InvolveMe is on the Play Store, this step won't be needed, updates will just work like any other app.",
];

export default function DownloadPage() {
  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Suspense fallback={null}>
            <VerifiedBanner />
          </Suspense>
          <Eyebrow>Download</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Get InvolveMe
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            We&apos;re not in the app stores yet. Here&apos;s exactly how to get InvolveMe on your
            device today, and what&apos;s next for each platform.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2">
        <AnimatedSection>
          <Card className="flex h-full flex-col">
            <p className="text-caption font-semibold uppercase tracking-wide text-credit">
              Android
            </p>
            <h2 className="mt-2 text-title font-bold text-foreground">Install the app directly</h2>
            <p className="mt-3 text-body text-muted">
              Android lets you install an app outside the Play Store, so you can get InvolveMe
              today, before we&apos;re listed there.
            </p>
            <ol className="mt-4 flex flex-col gap-2 text-caption text-muted">
              {ANDROID_STEPS.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-semibold text-foreground">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div className="mt-6 rounded-card border border-dashed border-border px-5 py-4 text-center text-caption font-semibold text-muted">
              APK download, coming soon
            </div>
            <p className="mt-4 text-caption text-muted">
              Prefer not to install a file? A no-download web app version is also on the way for
              Android.
            </p>
          </Card>
        </AnimatedSection>

        <AnimatedSection delay={0.08}>
          <Card className="flex h-full flex-col">
            <p className="text-caption font-semibold uppercase tracking-wide text-credit">iOS</p>
            <h2 className="mt-2 text-title font-bold text-foreground">
              Use the installable web app
            </h2>
            <p className="mt-3 text-body text-muted">
              Apple only allows installing an app outside the App Store through TestFlight or a paid
              enterprise certificate, neither of which fits a public launch. Until InvolveMe is on
              the App Store, the real path for iPhone and iPad is our installable web app: add it to
              your Home Screen and it opens and feels like a real app icon, no App Store needed.
            </p>
            <div className="mt-auto pt-6">
              <div className="rounded-card border border-dashed border-border px-5 py-4 text-center text-caption font-semibold text-muted">
                Installable web app, coming soon
              </div>
              <p className="mt-4 text-caption text-muted">
                We&apos;ll walk you through Safari&apos;s &quot;Add to Home Screen&quot; step by
                step once it&apos;s live.
              </p>
            </div>
          </Card>
        </AnimatedSection>
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">Want to be first to know?</h2>
          <p className="mx-auto mt-3 max-w-md text-body text-muted">
            Reach out and we&apos;ll let you know the moment either path is ready for your device.
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
