import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { VerifiedBanner } from '@/components/VerifiedBanner';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Get InvolveMe on Android, or install the web app on iOS and other devices.',
};

// Reversed 2026-10-09 (session 44), then reinstated the same day (session
// 45 continued): involveme-web (web.involvemechat.com) became docs/12's
// QR-pairing companion client — reachable only by scanning a code from an
// already-logged-in phone, no path in for a brand-new user — but
// docs/22-FULL-PWA-SCOPING.md's original standalone installable app was
// never meant to disappear, only to stop being conflated with the pairing
// companion's own domain. It now lives at its own subdomain,
// app.involvemechat.com, specifically for devices with no other path in
// (iOS today; anything else without a store listing). See
// lib/webAppMode.ts (apps/mobile) for the hostname split.

// No store listing exists yet (roadmap Phase 7), so this page is honest
// about what's actually possible today per platform, rather than four
// identical "coming soon" boxes: Android can be sideloaded once a build
// exists (no app-store review required for that) — still not wired up,
// no APK hosting exists yet. iOS fundamentally cannot sideload outside
// TestFlight or a paid enterprise certificate, so the installable PWA at
// app.involvemechat.com is its one real path in today — not a consolation
// prize, the literal only option until an App Store listing exists.
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
            <p className="text-caption font-semibold uppercase tracking-wide text-credit">
              iOS, desktop & other devices
            </p>
            <h2 className="mt-2 text-title font-bold text-foreground">Install the web app</h2>
            <p className="mt-3 text-body text-muted">
              Apple only allows installing an app outside the App Store through TestFlight or a paid
              enterprise certificate, neither of which fits a public launch, so this is the real way
              in on iPhone/iPad today, not a stopgap, and it works the same way on desktop. On a
              phone it opens straight away, no install required (though you can still add it to your
              home screen). On a desktop or PC, it installs like a real app: look for the install
              prompt, or use the button below.
            </p>
            <a
              href="https://app.involvemechat.com"
              className="mt-6 inline-block rounded-pill bg-accent px-6 py-3 text-center text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
            >
              Install InvolveMe
            </a>
            <div className="mt-auto pt-6">
              <p className="text-caption text-muted">
                We&apos;ll let you know the moment the native app is ready for your store.
              </p>
            </div>
          </Card>
        </AnimatedSection>

        <AnimatedSection delay={0.12}>
          <Card className="flex h-full flex-col md:col-span-2">
            <p className="text-caption font-semibold uppercase tracking-wide text-credit">
              Already have InvolveMe on your phone?
            </p>
            <h2 className="mt-2 text-title font-bold text-foreground">Link this device instead</h2>
            <p className="mt-3 max-w-2xl text-body text-muted">
              No need for a second account. Open InvolveMe&apos;s web companion, scan the code with
              your phone&apos;s camera from the app&apos;s menu, and this browser links straight to
              your existing account, just like linking a new device on any modern chat app.
            </p>
            <a
              href="https://web.involvemechat.com"
              className="mt-6 inline-block w-fit rounded-pill border border-border px-6 py-3 text-center text-body font-semibold text-foreground transition-colors hover:border-accent"
            >
              Link a device
            </a>
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
