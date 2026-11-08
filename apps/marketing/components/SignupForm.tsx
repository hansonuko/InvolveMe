'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase-browser';
import { Turnstile } from '@/components/Turnstile';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = 'email' | 'code';

// Homepage signup (docs/15-MARKETING-SITE-PWA-SCOPING.md §4): reuses the
// same OTP mechanism the mobile app uses (Supabase Auth email OTP), via
// web-send-otp for the abuse-sensitive send step (Turnstile-gated) and a
// direct, no-session-persisted verifyOtp call for the verify step (not the
// abuse surface — see that function's own header comment). On success,
// this does NOT leave the visitor logged in — it only confirms the email
// and hands off to the Download page, per §4.3.
//
// Email, not phone (2026-11-08): phone-number signup is deferred to a
// future pass (SMS delivery isn't reliably wired up yet); email is what's
// actually available today, same reasoning as web-send-otp's own switch.
export function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!EMAIL_PATTERN.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    if (!turnstileToken) {
      setError('Please complete the verification above.');
      return;
    }

    setSubmitting(true);
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/web-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? 'Could not send a code right now. Please try again.');
        return;
      }
      setStep('code');
    } catch {
      setError('Could not send a code right now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (code.trim().length === 0) {
      setError('Enter the code you received.');
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code.trim(),
        type: 'email',
      });
      if (verifyError) {
        setError('That code is invalid or expired. Please try again.');
        return;
      }
      router.push('/download?verified=1');
    } catch {
      setError('Could not verify that code right now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'code') {
    return (
      <form onSubmit={handleVerifyCode} className="mx-auto flex max-w-sm flex-col gap-3">
        <p className="text-caption text-muted">Enter the code sent to {email}</p>
        <input
          type="text"
          inputMode="numeric"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="rounded-pill border border-border bg-surface px-5 py-3 text-center text-body text-foreground"
        />
        {error ? <p className="text-caption text-danger">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed disabled:opacity-50"
        >
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
        <button
          type="button"
          onClick={() => {
            setStep('email');
            setCode('');
            setError(null);
          }}
          className="text-caption text-muted hover:underline"
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSendCode} className="mx-auto flex max-w-sm flex-col gap-3">
      <input
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-pill border border-border bg-surface px-5 py-3 text-center text-body text-foreground"
      />
      <div className="flex justify-center">
        <Turnstile onVerify={setTurnstileToken} />
      </div>
      {error ? <p className="text-caption text-danger">{error}</p> : null}
      <button
        type="submit"
        disabled={submitting || !turnstileToken}
        className="rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed disabled:opacity-50"
      >
        {submitting ? 'Sending…' : 'Send code'}
      </button>
    </form>
  );
}
