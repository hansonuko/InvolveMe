'use client';

import { useActionState } from 'react';
import { updatePricingConfigAction, type PricingActionState } from '@/app/actions/pricing';

// A dedicated toggle, not the generic free-text PricingConfigForm — a
// kill-switch only ever has two valid values, so there's no reason to let
// an admin type an arbitrary number here. Goes through the exact same
// updatePricingConfigAction (and therefore fn_admin_update_pricing_config)
// every other non-_bps key already uses — no new write path for this
// page, purely a friendlier control over an existing one.
export function ServiceToggleForm({
  configKey,
  currency,
  currentValue,
}: {
  configKey: string;
  currency: string;
  currentValue: number;
}) {
  const [state, formAction, pending] = useActionState<PricingActionState, FormData>(
    updatePricingConfigAction,
    null,
  );
  const nextValue = currentValue === 1 ? 0 : 1;

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="key" value={configKey} />
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="value" value={String(nextValue)} />
      <button
        type="submit"
        disabled={pending}
        className={
          nextValue === 1
            ? 'rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40'
            : 'rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground)]/80 hover:text-[var(--foreground)] disabled:opacity-40'
        }
      >
        {nextValue === 1 ? 'Enable' : 'Disable'}
      </button>
      {state && 'error' in state && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
