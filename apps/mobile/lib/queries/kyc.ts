import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

/** The current user's KYC tier (0 = unverified, 1 = BVN/NIN verified) —
 * per docs/02-DATA-MODEL.md. A plain read, not a money-affecting call, so
 * this goes straight through the Supabase client rather than an Edge
 * Function, same as wallets/threads/messages elsewhere in this app. */
export function useKycTier(userId: string | undefined) {
  return useQuery({
    queryKey: ['kyc_tier', userId],
    enabled: !!userId,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase
        .from('users')
        .select('kyc_tier')
        .eq('id', userId)
        .single();

      if (error) throw error;
      return data.kyc_tier ?? 0;
    },
  });
}

interface SubmitKycResponse {
  verified: boolean;
  tier: number;
}

/** Wraps POST /functions/v1/submit-kyc. Tier 1 only — plain BVN/NIN number
 * verification, no camera/liveness. Every call costs the platform real
 * money (~₦45, win or lose) — see that function's own header comment —
 * which is exactly why this screen doesn't auto-retry or resubmit
 * speculatively; the user submits once per deliberate attempt. */
export function useSubmitKyc() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { type: 'bvn' | 'nin'; number: string }) =>
      callEdgeFunction<SubmitKycResponse>('submit-kyc', params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kyc_tier'] });
    },
  });
}
