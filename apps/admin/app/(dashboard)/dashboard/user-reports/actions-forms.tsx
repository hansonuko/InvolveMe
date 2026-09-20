'use client';

import { useActionState } from 'react';
import { resolveUserReportAction, type FraudActionState } from '@/app/actions/fraud';

export function ResolveReportForm({ reportId }: { reportId: string }) {
  const [state, formAction, pending] = useActionState<FraudActionState, FormData>(
    resolveUserReportAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="report_id" value={reportId} />
      <input
        name="note"
        placeholder="Note (optional)"
        className="w-48 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
      />
      <div className="flex flex-wrap justify-end gap-2">
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
          value="warned"
          disabled={pending}
          className="rounded border border-[var(--border)] px-3 py-1 text-xs text-yellow-400 hover:text-yellow-300 disabled:opacity-60"
        >
          Warn
        </button>
        <button
          type="submit"
          name="resolution"
          value="suspended"
          disabled={pending}
          className="rounded bg-orange-600 px-3 py-1 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-60"
        >
          Suspend
        </button>
        <button
          type="submit"
          name="resolution"
          value="banned"
          disabled={pending}
          className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
        >
          Ban
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
