import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { VerifiedBanner } from '@/components/VerifiedBanner';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Get InvolveMe on Android, or as an installable web app for iOS.',
};

// docs/22-FULL-PWA-SCOPING.md §7 Phase C — the PWA (apps/mobile's web
// export) is live at this URL, a separate Cloudflare Pages origin from
// this marketing site. Swap the env var once a custom domain is pointed
// at that project; nothing else here needs to change.
const WEB_APP_URL = process.env.NEXT_PUBLIC_WEB_APP_URL ?? 'https://involveme-web.pages.dev';

// No store listing exists yet (roadmap Phase 7), so this page is honest
// about what's actually possible today per platform, rather than four
// identical "coming soon" boxes: Android can be sideloaded once a build
// exists (no app-store review required for that) — still not wired up,
// no APK hosting exists yet. iOS fundamentally cannot sideload outside
// TestFlight or a paid enterprise certificate, so the real path there is
// the installable web app, which now genuinely exists (docs/22 Phase A/B).
const ANDROID_STEPS = [
  'Download the APK file below.',
  'When prompted, allow your browser to install apps from this source (Settings, then Apps, then Special app access, then Install unknown apps).',
  'Open the downloaded file and tap Install.',
  "Once InvolveMe is on the Play Store, this step won't be needed, updates will just work like any other app.",
];

function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v12m0-12 4 4m-4-4-4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OpenAppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M9 15l6-6m0 0h-4m4 0v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AddToHomeScreenIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 8v8M8 12h8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const IOS_STEPS: { icon: React.ReactNode; text: React.ReactNode }[] = [
  {
    icon: <OpenAppIcon />,
    text: (
      <>
        Tap <span className="font-semibold text-foreground">Open InvolveMe</span> below — it opens
        in Safari.
      </>
    ),
  },
  {
    icon: <ShareIcon />,
    text: (
      <>
        Tap the <span className="font-semibold text-foreground">Share</span> icon in Safari&apos;s
        toolbar.
      </>
    ),
  },
  {
    icon: <AddToHomeScreenIcon />,
    text: (
      <>
        Scroll down and tap{' '}
        <span className="font-semibold text-foreground">Add to Home Screen</span>.
      </>
    ),
  },
];

function StepList({ steps }: { steps: { icon: React.ReactNode; text: React.ReactNode }[] }) {
  return (
    <ol className="mt-5 flex flex-col gap-3">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-pill bg-surface-alt text-foreground-accent">
            {step.icon}
          </span>
          <span className="text-caption text-muted">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

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
            <div className="mt-6 border-t border-border pt-6">
              <p className="text-caption text-muted">
                Prefer not to install a file? Use the installable web app instead — tap below, then
                tap <span className="font-semibold text-foreground">Install</span> when Chrome
                prompts you.
              </p>
              <a
                href={WEB_APP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block rounded-pill bg-surface-alt px-6 py-3 text-caption font-semibold text-foreground transition-colors hover:bg-border"
              >
                Open the web app
              </a>
            </div>
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
              enterprise certificate, neither of which fits a public launch. The real path for
              iPhone and iPad is our installable web app: add it to your Home Screen and it opens
              and feels like a real app icon, no App Store needed.
            </p>
            <div className="mt-auto pt-6">
              <a
                href={WEB_APP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block w-full rounded-pill bg-accent px-7 py-3.5 text-center text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
              >
                Open InvolveMe
              </a>
              <StepList steps={IOS_STEPS} />
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
