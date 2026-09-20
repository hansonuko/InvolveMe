import { redirect } from 'next/navigation';
import { getPendingEnrollment } from '@/app/actions/auth';
import { EnrollForm } from './enroll-form';

export default async function MfaEnrollPage() {
  const pending = await getPendingEnrollment();
  if (!pending) redirect('/login');

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">
          Set up two-factor authentication
        </h1>
        <p className="mt-2 text-sm text-[var(--foreground)]/60">
          Add this account to an authenticator app (Google Authenticator, Authy, 1Password, …), then
          enter the 6-digit code it shows.
        </p>

        <div className="mt-4 rounded border border-[var(--border)] bg-black/20 p-3">
          <p className="text-xs text-[var(--foreground)]/60">Secret (manual entry)</p>
          <p className="mt-1 break-all font-mono text-sm text-[var(--foreground)]">
            {pending.secret}
          </p>
        </div>

        <EnrollForm />
      </div>
    </main>
  );
}
