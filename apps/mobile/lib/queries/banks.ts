import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';

export interface Bank {
  code: string;
  name: string;
}

/** Wraps GET /functions/v1/list-banks — reference data for the bank
 * picker, routed through the same provider-backed endpoint
 * link-bank-account itself uses, not a hardcoded list (see that
 * function's own header comment for why). */
export function useBanks() {
  return useQuery({
    queryKey: ['banks'],
    queryFn: async (): Promise<Bank[]> => {
      const data = await callEdgeFunction<{ banks: Bank[] }>('list-banks', undefined, 'GET');
      return data.banks;
    },
    // Bank codes don't change often enough to refetch every time this
    // screen mounts.
    staleTime: 1000 * 60 * 60,
  });
}

interface LinkBankAccountResponse {
  bank_account_id: string;
  bank_name: string | null;
  account_name: string;
  account_number_last4: string;
}

/** Wraps POST /functions/v1/link-bank-account. Requires KYC tier >= 1 —
 * the server rejects otherwise, this hook doesn't duplicate that check. */
export function useLinkBankAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { bankCode: string; bankName: string; accountNumber: string }) =>
      callEdgeFunction<LinkBankAccountResponse>('link-bank-account', {
        bank_code: params.bankCode,
        bank_name: params.bankName,
        account_number: params.accountNumber,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank_accounts'] });
    },
  });
}
