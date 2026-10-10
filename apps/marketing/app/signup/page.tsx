import type { Metadata } from 'next';
import { Card, Eyebrow, Section } from '@/components/Section';
import { SignupForm } from '@/components/SignupForm';
import { LAUNCH_DATE_LABEL } from '@/lib/prelaunch';

export const metadata: Metadata = {
  title: 'Sign up',
  description: 'Confirm your phone number to get started with InvolveMe.',
};

// A dedicated, unblended page (docs/15-MARKETING-SITE-PWA-SCOPING.md §4) —
// signup is its own destination, not a form competing with the homepage's
// marketing content. This is the only thing on this page.
export default function SignupPage() {
  return (
    <Section className="pb-24 pt-16 text-center">
      <Eyebrow>Sign up</Eyebrow>
      <h1 className="mx-auto mt-4 max-w-xl text-display font-extrabold text-foreground">
        Create your account
      </h1>
      <p className="mx-auto mt-4 max-w-md text-body text-muted">
        Confirm your phone number to get started. Once verified, we&apos;ll take you to the download
        page to finish setting up in the app.
      </p>
      <p className="mx-auto mt-2 max-w-md text-caption text-muted">
        Signup opens for our soft launch on {LAUNCH_DATE_LABEL}.
      </p>
      <Card className="mx-auto mt-10 max-w-md">
        <SignupForm />
      </Card>
    </Section>
  );
}
