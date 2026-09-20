'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase-admin';
import { getCurrentAdmin } from '@/lib/auth';

export type FraudActionState = { error: string } | null;

async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  return admin;
}

export async function resolveFraudSignalAction(
  _prev: FraudActionState,
  formData: FormData,
): Promise<FraudActionState> {
  const admin = await requireAdmin();
  const signalId = String(formData.get('signal_id') ?? '');
  const resolution = String(formData.get('resolution') ?? '');
  const note = String(formData.get('note') ?? '').trim();

  if (!signalId || !['dismissed', 'escalated'].includes(resolution)) {
    return { error: 'Invalid request.' };
  }

  const { error } = await db().rpc('fn_admin_resolve_fraud_signal', {
    p_actor_admin_id: admin.id,
    p_signal_id: signalId,
    p_resolution: resolution,
    p_note: note || null,
  });
  if (error)
    return {
      error: error.message.includes('not_authorized')
        ? 'You do not have permission to do that.'
        : 'Could not resolve that signal.',
    };

  redirect('/dashboard/fraud-signals');
}

// Freezes every one of a user's own wallets in one action — the fraud
// queue's whole point is to let an admin act on the flagged USER, and
// freezing only one of their three wallets would leave the other two
// spendable, defeating the purpose. fn_admin_set_wallet_frozen itself
// stays scoped to a single wallet (that's the schema's real unit); this
// loops it, same as a human would have to click three separate freeze
// buttons on the user detail page otherwise.
export async function freezeUserWalletsAction(
  _prev: FraudActionState,
  formData: FormData,
): Promise<FraudActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('user_id') ?? '');
  const note = String(formData.get('note') ?? '').trim();

  if (!userId) return { error: 'Invalid request.' };

  const { data: wallets, error: walletsError } = await db()
    .from('wallets')
    .select('id')
    .eq('user_id', userId);
  if (walletsError) return { error: "Could not load that user's wallets." };

  for (const wallet of wallets ?? []) {
    const { error } = await db().rpc('fn_admin_set_wallet_frozen', {
      p_actor_admin_id: admin.id,
      p_wallet_id: wallet.id,
      p_frozen: true,
      p_reason: note || null,
    });
    if (error) {
      return {
        error: error.message.includes('not_authorized')
          ? 'You do not have permission to do that.'
          : 'Could not freeze one or more wallets.',
      };
    }
  }

  redirect('/dashboard/fraud-signals');
}

export async function setWalletFrozenAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const walletId = String(formData.get('wallet_id') ?? '');
  const frozen = formData.get('frozen') === 'true';
  const userId = String(formData.get('user_id') ?? '');

  if (!walletId) return;

  await db().rpc('fn_admin_set_wallet_frozen', {
    p_actor_admin_id: admin.id,
    p_wallet_id: walletId,
    p_frozen: frozen,
    p_reason: frozen ? 'Frozen from user detail page' : 'Unfrozen from user detail page',
  });

  redirect(`/dashboard/users/${userId}`);
}
