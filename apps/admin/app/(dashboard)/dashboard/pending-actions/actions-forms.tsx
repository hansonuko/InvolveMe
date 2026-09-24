'use client';

import { useActionState, useState } from 'react';
import {
  approvePendingActionAction,
  rejectPendingActionAction,
  applyPendingActionAction,
  type PendingActionState,
} from '@/app/actions/pending-actions';

export function ApproveForm({ pendingActionId }: { pendingActionId: string }) {
  const [state, formAction, pending] = useActionState<PendingActionState, FormData>(
    approvePendingActionAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="pending_action_id" value={pendingActionId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-60"
      >
        Approve
      </button>
      {state && 'error' in state && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function RejectForm({
  pendingActionId,
  label = 'Reject',
}: {
  pendingActionId: string;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState<PendingActionState, FormData>(
    rejectPendingActionAction,
    null,
  );
  const [reason, setReason] = useState('');

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="pending_action_id" value={pendingActionId} />
      <input
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground)]/80 hover:text-[var(--foreground)] disabled:opacity-60"
      >
        {label}
      </button>
      {state && 'error' in state && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

// Re-submits exactly the payload the queue page read off
// admin_pending_actions.payload — no editable fields here, see
// app/actions/pending-actions.ts's applyPendingActionAction comment for
// why apply-time input is deliberately not user-editable.
export function ApplyForm({
  pendingActionId,
  actionType,
  payload,
}: {
  pendingActionId: string;
  actionType: string;
  payload: Record<string, unknown>;
}) {
  const [state, formAction, pending] = useActionState<PendingActionState, FormData>(
    applyPendingActionAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="pending_action_id" value={pendingActionId} />
      <input type="hidden" name="action_type" value={actionType} />
      {actionType === 'pricing_config_update' && (
        <>
          <input type="hidden" name="key" value={String(payload.key ?? '')} />
          <input type="hidden" name="currency" value={String(payload.currency ?? '')} />
          <input type="hidden" name="new_value" value={String(payload.new_value ?? '')} />
        </>
      )}
      {actionType === 'manual_ledger_adjustment' && (
        <>
          <input type="hidden" name="wallet_id" value={String(payload.wallet_id ?? '')} />
          <input type="hidden" name="amount" value={String(payload.amount ?? '')} />
          <input type="hidden" name="note" value={String(payload.note ?? '')} />
        </>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-60"
      >
        Apply
      </button>
      {state && 'error' in state && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
