'use client';

import { useActionState, useState } from 'react';
import {
  resolveBankAccountNameAction,
  proposePlatformBankAccountRegistrationAction,
  deactivatePlatformBankAccountAction,
  convertPlatformEarningsToCashAction,
  type ResolveBankAccountState,
  type ProposeBankAccountState,
  type DeactivateBankAccountState,
  type ConvertEarningsState,
} from '@/app/actions/platform-bank-accounts';
import {
  proposePlatformWithdrawalAction,
  type PendingActionState,
} from '@/app/actions/pending-actions';

export function ConvertEarningsForm({ currency }: { currency: string }) {
  const [state, formAction, pending] = useActionState<ConvertEarningsState, FormData>(
    convertPlatformEarningsToCashAction,
    null,
  );
  const [credits, setCredits] = useState('');

  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="currency" value={currency} />
      <input
        name="credits"
        value={credits}
        onChange={(e) => setCredits(e.target.value)}
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="Credits to convert"
        className="w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <button
        type="submit"
        disabled={pending || !credits.trim()}
        className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
      >
        Convert to cash
      </button>
      {state && 'error' in state && (
        <p className="w-full text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function DeactivateBankAccountForm({ bankAccountId }: { bankAccountId: string }) {
  const [state, formAction, pending] = useActionState<DeactivateBankAccountState, FormData>(
    deactivatePlatformBankAccountAction,
    null,
  );

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="bank_account_id" value={bankAccountId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-[var(--foreground)]/60 hover:text-red-400 disabled:opacity-60"
      >
        Deactivate
      </button>
      {state && 'error' in state && (
        <p className="mt-1 text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

// Two steps in one form: "Look up" resolves the real registered account
// name from the payment provider (read-only) without proposing anything;
// only once that's shown does "Propose registration" become available,
// and that's the one click that actually creates a transfer recipient at
// the provider and proposes the dual-approved registration (see
// app/actions/platform-bank-accounts.ts's header comment on why the
// live provider call happens at propose time, not apply time, for this
// specific flow).
export function RegisterBankAccountForm({
  currency,
  banks,
}: {
  currency: string;
  banks: { code: string; name: string }[];
}) {
  const [resolveState, resolveAction, resolvePending] = useActionState<
    ResolveBankAccountState,
    FormData
  >(resolveBankAccountNameAction, null);
  const [proposeState, proposeAction, proposePending] = useActionState<
    ProposeBankAccountState,
    FormData
  >(proposePlatformBankAccountRegistrationAction, null);

  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [label, setLabel] = useState('');

  const resolved = resolveState && 'accountName' in resolveState ? resolveState : null;
  // A change to either field after a successful resolve invalidates it —
  // proposing must always use the account that was actually looked up.
  const resolvedStale =
    resolved && (resolved.bankCode !== bankCode || resolved.accountNumber !== accountNumber);
  const bankName = banks.find((b) => b.code === bankCode)?.name ?? '';

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs font-medium text-[var(--foreground)]/60">
        Register a new {currency} payout destination
      </p>
      <form action={resolveAction} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="currency" value={currency} />
        <select
          name="bank_code"
          value={bankCode}
          onChange={(e) => setBankCode(e.target.value)}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="">Select bank…</option>
          {banks.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          name="account_number"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          placeholder="Account number"
          className="w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        />
        <button
          type="submit"
          disabled={resolvePending || !bankCode || !accountNumber}
          className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground)]/80 hover:text-[var(--foreground)] disabled:opacity-40"
        >
          Look up
        </button>
      </form>
      {resolveState && 'error' in resolveState && (
        <p className="mt-1 text-xs text-red-400" role="alert">
          {resolveState.error}
        </p>
      )}

      {resolved && !resolvedStale && (
        <form
          action={proposeAction}
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-3"
        >
          <input type="hidden" name="currency" value={currency} />
          <input type="hidden" name="bank_code" value={resolved.bankCode} />
          <input type="hidden" name="bank_name" value={bankName} />
          <input type="hidden" name="account_number" value={resolved.accountNumber} />
          <input type="hidden" name="account_name" value={resolved.accountName} />
          <div>
            <p className="text-xs text-[var(--foreground)]/60">Registered name at bank</p>
            <p className="text-sm font-medium text-[var(--foreground)]">{resolved.accountName}</p>
          </div>
          <input
            name="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional, e.g. Primary account)"
            className="w-56 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
          />
          <button
            type="submit"
            disabled={proposePending}
            className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Propose registration
          </button>
        </form>
      )}
      {proposeState && 'error' in proposeState && (
        <p className="mt-1 text-xs text-red-400" role="alert">
          {proposeState.error}
        </p>
      )}
    </div>
  );
}

export function ProposeWithdrawalForm({
  currency,
  bankAccounts,
}: {
  currency: string;
  bankAccounts: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState<PendingActionState, FormData>(
    proposePlatformWithdrawalAction,
    null,
  );
  const [amount, setAmount] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');

  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="currency" value={currency} />
      <select
        name="platform_bank_account_id"
        value={bankAccountId}
        onChange={(e) => setBankAccountId(e.target.value)}
        className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      >
        <option value="">Destination account…</option>
        {bankAccounts.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
      <input
        name="amount_minor"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="Amount in kobo"
        className="w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <button
        type="submit"
        disabled={pending || !amount.trim() || !bankAccountId}
        className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
      >
        Propose withdrawal
      </button>
      {state && 'error' in state && (
        <p className="w-full text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
