'use client';

import { useActionState, useState } from 'react';
import {
  proposeManualAdjustmentAction,
  type PendingActionState,
} from '@/app/actions/pending-actions';

const CREDIT_DENOMINATED_KINDS = new Set(['topup_credit', 'earnings_pending']);

// Ships dual-approval-gated unconditionally (Phase E piece 2) — this only
// ever proposes, never applies directly. A different admin approves it on
// /dashboard/pending-actions, then either admin applies it from there.
export function ProposeManualAdjustmentForm({
  walletId,
  walletKind,
}: {
  walletId: string;
  walletKind: string;
}) {
  const [state, formAction, pending] = useActionState<PendingActionState, FormData>(
    proposeManualAdjustmentAction,
    null,
  );
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const unit = CREDIT_DENOMINATED_KINDS.has(walletKind) ? 'credits' : 'kobo';

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
      >
        Propose adjustment
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-2 flex flex-col gap-1">
      <input type="hidden" name="wallet_id" value={walletId} />
      <input
        name="amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="numeric"
        pattern="-?[0-9]*"
        placeholder={`Amount in ${unit} (+ credit / − debit)`}
        className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <input
        name="note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why? (required)"
        className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !amount.trim() || !note.trim()}
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40"
        >
          Propose
        </button>
      </div>
      {state && 'error' in state && (
        <p className="text-xs text-[var(--danger)]" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
