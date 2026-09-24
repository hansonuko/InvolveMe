'use client';

import { useActionState, useState } from 'react';
import {
  proposeMessagePricingStrategyChangeAction,
  type PendingActionState,
} from '@/app/actions/pending-actions';

const STRATEGY_OPTIONS: { value: string; label: string }[] = [
  { value: 'tiered_word_block', label: 'Tiered word block' },
  { value: 'flat_per_message', label: 'Flat per message' },
  { value: 'linear_per_word', label: 'Linear per word' },
];

export function ProposeStrategyChangeForm({
  currency,
  currentStrategy,
}: {
  currency: string;
  currentStrategy: string;
}) {
  const [state, formAction, pending] = useActionState<PendingActionState, FormData>(
    proposeMessagePricingStrategyChangeAction,
    null,
  );
  const [strategy, setStrategy] = useState(currentStrategy);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="currency" value={currency} />
      <div className="flex items-center gap-2">
        <select
          name="active_strategy"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          {STRATEGY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending || strategy === currentStrategy}
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          Propose switch
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
