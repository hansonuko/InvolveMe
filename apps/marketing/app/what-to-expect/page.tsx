import type { Metadata } from 'next';
import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { CountdownTimer } from '@/components/CountdownTimer';
import { Card, Eyebrow, Section } from '@/components/Section';
import { LAUNCH_DATE_LABEL } from '@/lib/prelaunch';

export const metadata: Metadata = {
  title: 'What to Expect from InvolveMe',
  description:
    'What ships on InvolveMe’s soft launch, the three ways to use it, and what makes it different from every other chat app.',
};

// Linked from the homepage's PrelaunchPopup (and from the equivalent
// announcement modal on app.involvemechat.com / web.involvemechat.com —
// apps/mobile/components/PrelaunchAnnouncementModal.tsx) — the landing spot
// for "tell me more" rather than cramming all of this into the popup
// itself. Every specific claim below (escrow, the ledger, KYC-gated
// withdrawals, optional E2EE, groups/status/voice notes, multi-device) is a
// real, already-shipped mechanism described elsewhere on this site
// (how-it-works, security, download) — nothing here is a roadmap promise
// dressed up as a launch-day fact.
const LAUNCH_FEATURES = [
  {
    title: 'Pay-per-message chat',
    body: 'Message anyone, and your credits are held safely in escrow the instant you hit send. The moment they reply, it becomes real income for them — no chasing anyone for payment.',
  },
  {
    title: 'A real wallet, not a fake balance',
    body: 'Top up with a bank transfer, watch your balance update live, and withdraw to a verified bank account. Every kobo is tracked in a double-entry ledger, the same discipline a real financial app uses.',
  },
  {
    title: 'Optional end-to-end encryption',
    body: 'Turn on encryption for any conversation and only the two of you can read it — the app itself can’t. Chat Credits still work exactly the same way underneath.',
  },
  {
    title: 'Groups, status & voice notes',
    body: 'Group threads, 24-hour status updates, and voice messages all ship on day one — the full shape of a modern chat app, not a stripped-down beta.',
  },
  {
    title: 'Multi-device, done right',
    body: 'Link your phone, a browser, and a desktop app to the same account at the same time, the real WhatsApp Web model — not one login at a time.',
  },
  {
    title: 'KYC-gated withdrawals',
    body: 'Your earnings only ever leave to a verified bank account in your name — real identity verification, not an honor system, protecting your money from day one.',
  },
];

const VERSIONS = [
  {
    eyebrow: 'Android',
    title: 'The mobile app',
    body: 'Install InvolveMe directly on Android — the full native app experience, before we’re even listed on the Play Store.',
  },
  {
    eyebrow: 'iOS, and everyone else',
    title: 'The mobile web app',
    body: 'Not on Android? Install InvolveMe as a web app instead — it looks and feels like a native app on your home screen, works fully offline-tolerant, and needs no app store at all. This is the real way in on iPhone today, not a stopgap.',
  },
  {
    eyebrow: 'PC & Mac',
    title: 'The desktop app',
    body: 'Install the same web app on a desktop or laptop and it runs like a real app in its own window. Already have InvolveMe on your phone? Link your desktop to that same account instead — and keep linking more devices whenever you want, all staying in sync.',
  },
];

const WHY_IT_MATTERS = [
  {
    title: 'Every reply is a paycheck',
    body: 'No other mainstream chat app pays you to use it. WhatsApp, Telegram, Instagram DMs — all free to send, none of it pays you back. InvolveMe flips that: the person messaging you pays, and replying is how you earn.',
  },
  {
    title: 'No ads, no data-harvesting business model',
    body: 'Free chat apps make money by selling attention or data. InvolveMe’s business model is the credits themselves — which means it’s never incentivized to keep you scrolling or sell what you type.',
  },
  {
    title: 'Your money is protected like a bank’s, not a chat toy’s',
    body: 'Escrowed credits, a double-entry ledger that has to reconcile to the kobo, real fraud monitoring, and KYC-gated withdrawals — the financial plumbing underneath feels like a bank, even though the app on top feels exactly like the messenger you already use.',
  },
  {
    title: 'Zero learning curve',
    body: 'If you’ve used WhatsApp, you already know how to use InvolveMe. We didn’t reinvent chat — we made the exact same experience actually pay you.',
  },
];

export default function WhatToExpectPage() {
  return (
    <>
      <Section className="pb-8 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>What to expect</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold leading-tight text-foreground md:text-[44px]">
            What to Expect from InvolveMe
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-body text-muted">
            We soft-launch on <strong className="text-foreground">{LAUNCH_DATE_LABEL}</strong> —
            here’s exactly what ships, how to get in on day one, and why InvolveMe isn’t just
            another messaging app.
          </p>
          <div className="mt-8">
            <CountdownTimer />
          </div>
        </AnimatedSection>
      </Section>

      <Section className="pt-6">
        <AnimatedSection>
          <Eyebrow>On launch day</Eyebrow>
          <h2 className="mt-3 max-w-2xl text-title font-extrabold text-foreground md:text-display">
            What ships, day one
          </h2>
        </AnimatedSection>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {LAUNCH_FEATURES.map((item, i) => (
            <AnimatedSection key={item.title} delay={i * 0.06}>
              <Card className="h-full">
                <h3 className="text-title font-bold text-foreground">{item.title}</h3>
                <p className="mt-3 text-body text-muted">{item.body}</p>
              </Card>
            </AnimatedSection>
          ))}
        </div>
      </Section>

      <Section className="rounded-sheet bg-surface-alt">
        <AnimatedSection>
          <Eyebrow>Three ways in</Eyebrow>
          <h2 className="mt-3 max-w-2xl text-title font-extrabold text-foreground md:text-display">
            Every device, one account
          </h2>
          <p className="mt-4 max-w-2xl text-body text-muted">
            However you reach us first, you’re covered — and every version stays linked to the same
            account and wallet.
          </p>
        </AnimatedSection>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {VERSIONS.map((v, i) => (
            <AnimatedSection key={v.title} delay={i * 0.08}>
              <Card className="h-full">
                <p className="text-caption font-semibold uppercase tracking-wide text-credit">
                  {v.eyebrow}
                </p>
                <h3 className="mt-2 text-title font-bold text-foreground">{v.title}</h3>
                <p className="mt-3 text-body text-muted">{v.body}</p>
              </Card>
            </AnimatedSection>
          ))}
        </div>
      </Section>

      <Section>
        <AnimatedSection>
          <Eyebrow>Why it matters</Eyebrow>
          <h2 className="mt-3 max-w-2xl text-title font-extrabold text-foreground md:text-display">
            Why InvolveMe is a game-changer
          </h2>
        </AnimatedSection>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {WHY_IT_MATTERS.map((item, i) => (
            <AnimatedSection key={item.title} delay={i * 0.08}>
              <Card className="h-full">
                <h3 className="text-title font-bold text-foreground">{item.title}</h3>
                <p className="mt-3 text-body text-muted">{item.body}</p>
              </Card>
            </AnimatedSection>
          ))}
        </div>
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <Eyebrow>Be here on day one</Eyebrow>
          <h2 className="mx-auto mt-3 max-w-2xl text-display font-extrabold text-foreground">
            Sign up the moment we open, {LAUNCH_DATE_LABEL}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            Signup opens the moment we go live — be one of the first to confirm your number and
            you’ll get 100 non-withdrawable chat credits to start with, on us.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
            >
              Sign up
            </Link>
            <Link
              href="/guide"
              className="rounded-pill border border-border px-7 py-3.5 text-body font-semibold text-foreground transition-colors hover:border-accent"
            >
              Read the full guide
            </Link>
          </div>
        </AnimatedSection>
      </Section>
    </>
  );
}
