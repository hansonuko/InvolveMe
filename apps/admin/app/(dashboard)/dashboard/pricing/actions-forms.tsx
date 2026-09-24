'use client';

import { useActionState, useState } from 'react';
import {
  updatePricingConfigAction,
  proposePricingConfigChangeAction,
  type PricingActionState,
} from '@/app/actions/pricing';

export function PricingConfigForm({
  configKey,
  currency,
  currentValue,
  isMaterial,
}: {
  configKey: string;
  currency: string;
  currentValue: number;
  isMaterial: boolean;
}) {
  // _bps keys propose a dual-approved change instead of applying directly
  // (docs/14 §4.2/§4.4, Phase E piece 2) — same form, different action and
  // button copy, so this isn't two near-duplicate components.
  const [state, formAction, pending] = useActionState<PricingActionState, FormData>(
    isMaterial ? proposePricingConfigChangeAction : updatePricingConfigAction,
    null,
  );
  const [value, setValue] = useState(String(currentValue));

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="key" value={configKey} />
      <input type="hidden" name="currency" value={currency} />
      <div className="flex items-center gap-2">
        <input
          name="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          pattern="-?[0-9]*"
          className="w-28 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-right text-xs text-[var(--foreground)]"
        />
        <button
          type="submit"
          disabled={pending || value === String(currentValue) || value.trim() === ''}
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40"
        >
          {isMaterial ? 'Propose change' : 'Save'}
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
