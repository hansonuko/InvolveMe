'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase-browser';
import { Turnstile } from '@/components/Turnstile';
import { Modal } from '@/components/Modal';
import { isPrelaunch, PRELAUNCH_SIGNUP_MESSAGE } from '@/lib/prelaunch';

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

type Step = 'phone' | 'code';

// Homepage signup (docs/15-MARKETING-SITE-PWA-SCOPING.md §4): reuses the
// same OTP mechanism the mobile app uses (Supabase Auth phone OTP), via
// web-send-otp for the abuse-sensitive send step (Turnstile-gated) and a
// direct, no-session-persisted verifyOtp call for the verify step (not the
// abuse surface — see that function's own header comment). On success,
// this does NOT leave the visitor logged in — it only confirms the number
// and hands off to the Download page, per §4.3.
export function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prelaunchGateMessage, setPrelaunchGateMessage] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!E164_PATTERN.test(phone)) {
      setError('Enter your number in international format, e.g. +2348012345678.');
      return;
    }
    if (!turnstileToken) {
      setError('Please complete the verification above.');
      return;
    }

    // Signup genuinely can't complete yet — SMS delivery isn't wired up
    // before launch (docs/00-SESSION-HANDOFF.md), so without this check
    // the real web-send-otp call below would just fail with a raw
    // "Could not send a code" error. Checked client-side first so the
    // visitor never even sees that failed network round trip; web-send-otp
    // itself (see that function's own header comment) carries the same
    // gate server-side as a fail-closed backstop.
    if (isPrelaunch()) {
      setPrelaunchGateMessage(PRELAUNCH_SIGNUP_MESSAGE);
      return;
    }

    setSubmitting(true);
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/web-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, turnstileToken }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (body?.error === 'prelaunch') {
          setPrelaunchGateMessage(body?.message ?? PRELAUNCH_SIGNUP_MESSAGE);
          return;
        }
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
        phone,
        token: code.trim(),
        type: 'sms',
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

  const gateModal = (
    <Modal
      open={prelaunchGateMessage !== null}
      onClose={() => setPrelaunchGateMessage(null)}
      labelledBy="signup-prelaunch-title"
    >
      <p className="mx-auto flex h-14 w-14 items-center justify-center rounded-pill bg-accent/15 text-2xl">
        ⏳
      </p>
      <h2 id="signup-prelaunch-title" className="mt-4 text-title font-extrabold text-foreground">
        Not open just yet
      </h2>
      <p className="mx-auto mt-3 max-w-sm text-body text-muted">{prelaunchGateMessage}</p>
      <button
        type="button"
        onClick={() => setPrelaunchGateMessage(null)}
        className="mt-6 w-full rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
      >
        Got it
      </button>
    </Modal>
  );

  if (step === 'code') {
    return (
      <>
        {gateModal}
        <form onSubmit={handleVerifyCode} className="mx-auto flex max-w-sm flex-col gap-3">
          <p className="text-caption text-muted">Enter the code sent to {phone}</p>
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
              setStep('phone');
              setCode('');
              setError(null);
            }}
            className="text-caption text-muted hover:underline"
          >
            Use a different number
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      {gateModal}
      <form onSubmit={handleSendCode} className="mx-auto flex max-w-sm flex-col gap-3">
        <input
          type="tel"
          placeholder="+2348012345678"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
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
    </>
  );
}
