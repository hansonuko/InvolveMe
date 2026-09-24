'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase-admin';
import { getCurrentAdmin } from '@/lib/auth';

export type PricingActionState = { error: string } | null;

// The only client-side "logic" here is parsing the input back into an
// integer for the RPC call — no arithmetic on it, no derived cost/fee
// computation (CLAUDE.md rule #1). fn_admin_update_pricing_config
// (20260920160000_admin_pricing_config_attribution.sql) does every real
// check: permission, non-negative, _bps <= 10000, key/currency exists.
export async function updatePricingConfigAction(
  _prev: PricingActionState,
  formData: FormData,
): Promise<PricingActionState> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const key = String(formData.get('key') ?? '');
  const currency = String(formData.get('currency') ?? '');
  const rawValue = String(formData.get('value') ?? '').trim();

  if (!key || !currency || !/^-?\d+$/.test(rawValue)) {
    return { error: 'Enter a whole number.' };
  }

  const newValue = Number(rawValue);
  if (!Number.isSafeInteger(newValue)) {
    return { error: 'That value is out of range.' };
  }

  const { error } = await db().rpc('fn_admin_update_pricing_config', {
    p_actor_admin_id: admin.id,
    p_key: key,
    p_currency: currency,
    p_new_value: newValue,
  });

  if (error) {
    if (error.message.includes('not_authorized')) {
      return { error: 'You do not have permission to do that.' };
    }
    if (error.message.includes('negative_value_not_allowed')) {
      return { error: 'Value cannot be negative.' };
    }
    if (error.message.includes('bps_value_out_of_range')) {
      return { error: 'Basis-point values cannot exceed 10000 (100%).' };
    }
    if (error.message.includes('pricing_config_key_not_found')) {
      return { error: 'That config key no longer exists.' };
    }
    // Should not normally be reachable from the UI — PricingConfigForm
    // routes any _bps key to proposePricingConfigChangeAction below
    // instead of here — but the DB is the real gate (Phase E piece 2), so
    // this stays a clear message rather than the generic fallback if it
    // is ever hit some other way (e.g. a stale/cached client).
    if (error.message.includes('dual_approval_required')) {
      return {
        error: 'This key requires dual approval — propose the change instead of saving directly.',
      };
    }
    return { error: 'Could not update that value.' };
  }

  redirect('/dashboard/pricing');
}

// Phase E piece 2's dual-approval gate on _bps keys (docs/14 §4.2/§4.4):
// proposes the change instead of applying it — a different admin approves
// it, then either admin applies it from /dashboard/pending-actions.
export async function proposePricingConfigChangeAction(
  _prev: PricingActionState,
  formData: FormData,
): Promise<PricingActionState> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const key = String(formData.get('key') ?? '');
  const currency = String(formData.get('currency') ?? '');
  const rawValue = String(formData.get('value') ?? '').trim();

  if (!key || !currency || !/^-?\d+$/.test(rawValue)) {
    return { error: 'Enter a whole number.' };
  }

  const newValue = Number(rawValue);
  if (!Number.isSafeInteger(newValue)) {
    return { error: 'That value is out of range.' };
  }

  const { error } = await db().rpc('fn_admin_propose_pending_action', {
    p_actor_admin_id: admin.id,
    p_action_type: 'pricing_config_update',
    p_payload: { key, currency, new_value: newValue },
  });

  if (error) {
    if (error.message.includes('not_authorized')) {
      return { error: 'You do not have permission to do that.' };
    }
    return { error: 'Could not propose that change.' };
  }

  redirect('/dashboard/pending-actions');
}
