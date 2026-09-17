import { useMutation, useQuery } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

export interface CountryCurrencyOption {
  country_code: string;
  currency: string;
  payments_live: boolean;
}

/** country_currency_config — authenticated-readable, no client write (see
 * 20260917130000_multicurrency_schema.sql). Starter set, not exhaustive ISO
 * 3166-1 — docs/02-DATA-MODEL.md §9. */
export function useCountryCurrencyOptions() {
  return useQuery({
    queryKey: ['country_currency_config'],
    queryFn: async (): Promise<CountryCurrencyOption[]> => {
      const { data, error } = await supabase
        .from('country_currency_config')
        .select('country_code, currency, payments_live')
        .order('country_code', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
    // This is ops config, not per-user data — happy to cache it for the
    // session rather than refetch on every onboarding screen mount.
    staleTime: Infinity,
  });
}

interface CompleteOnboardingResponse {
  currency: string;
  payments_live: boolean;
}

/** Wraps POST /functions/v1/complete-onboarding. */
export function useCompleteOnboarding() {
  return useMutation({
    mutationFn: (params: { country: string; display_name: string; nickname: string }) =>
      callEdgeFunction<CompleteOnboardingResponse>('complete-onboarding', params),
  });
}
