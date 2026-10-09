import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { VerifiedBanner } from '@/components/VerifiedBanner';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Get InvolveMe on Android. iOS is coming once we launch on the App Store.',
};

// Reversed 2026-10-09 (session 44): this used to also point at
// involveme-web as an installable standalone PWA for brand-new users on
// both platforms (docs/22-FULL-PWA-SCOPING.md Phase A/B). That
// architecture got replaced with docs/12-LINKED-DEVICES-WEB-SCOPING.md's
// real WhatsApp-Web model, per explicit product correction — involveme-
// web is now a QR-pairing companion client only, reachable exclusively by
// scanning a code from an already-logged-in phone. It has no path in for
// someone who doesn't have the app yet, so it's no longer offered as an
// install target on this page at all; see that doc's own §1 for the full
// finding behind the pivot.

// No store listing exists yet (roadmap Phase 7), so this page is honest
// about what's actually possible today per platform, rather than four
// identical "coming soon" boxes: Android can be sideloaded once a build
// exists (no app-store review required for that) — still not wired up,
// no APK hosting exists yet. iOS fundamentally cannot sideload outside
// TestFlight or a paid enterprise certificate, and (per the reversal
// above) there is no installable-web-app fallback anymore either — so,
// honestly, iOS has no path in at all yet. Same "say so plainly" posture
// as the Android card below, not four different ways of hiding the gap.
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
          </Card>
        </AnimatedSection>

        <AnimatedSection delay={0.08}>
          <Card className="flex h-full flex-col">
            <p className="text-caption font-semibold uppercase tracking-wide text-credit">iOS</p>
            <h2 className="mt-2 text-title font-bold text-foreground">Not available yet</h2>
            <p className="mt-3 text-body text-muted">
              Apple only allows installing an app outside the App Store through TestFlight or a paid
              enterprise certificate, neither of which fits a public launch — so there&apos;s no way
              to get InvolveMe on iPhone or iPad before we&apos;re listed on the App Store.
              We&apos;d rather tell you that plainly than point you at something that won&apos;t
              actually work.
            </p>
            <div className="mt-auto pt-6">
              <p className="text-caption text-muted">
                Reach out below and we&apos;ll let you know the moment iOS is ready.
              </p>
            </div>
          </Card>
        </AnimatedSection>
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">Want to be first to know?</h2>
          <p className="mx-auto mt-3 max-w-md text-body text-muted">
            Reach out and we&apos;ll let you know the moment the Android app is ready to install
            directly.
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
