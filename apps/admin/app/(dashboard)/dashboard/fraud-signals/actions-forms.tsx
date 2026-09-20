'use client';

import { useActionState, useState } from 'react';
import {
  resolveFraudSignalAction,
  freezeUserWalletsAction,
  type FraudActionState,
} from '@/app/actions/fraud';

export function ResolveForm({ signalId }: { signalId: string }) {
  const [state, formAction, pending] = useActionState<FraudActionState, FormData>(
    resolveFraudSignalAction,
    null,
  );
  const [note, setNote] = useState('');

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="signal_id" value={signalId} />
      <input
        name="note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="w-48 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          name="resolution"
          value="dismissed"
          disabled={pending}
          className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground)]/80 hover:text-[var(--foreground)] disabled:opacity-60"
        >
          Dismiss
        </button>
        <button
          type="submit"
          name="resolution"
          value="escalated"
          disabled={pending}
          className="rounded bg-red-500/80 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
        >
          Escalate
        </button>
      </div>
      {state && 'error' in state && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function FreezeForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState<FraudActionState, FormData>(
    freezeUserWalletsAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="user_id" value={userId} />
      <input
        name="note"
        placeholder="Freeze reason (optional)"
        className="w-48 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
      >
        Freeze user&apos;s wallets
      </button>
      {state && 'error' in state && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
