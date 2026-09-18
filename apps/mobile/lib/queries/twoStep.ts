import { useMutation, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction, EdgeFunctionError } from '@/lib/edgeFunctions';

interface SetTwoStepPinRequest {
  pin: string;
  currentPin?: string;
  recoveryEmail?: string;
}

/** Wraps POST /functions/v1/set-two-step-pin — first-time setup needs
 * only `pin`; changing an already-set PIN needs `currentPin` too (the
 * function itself enforces this, not just the UI). */
export function useSetTwoStepPin() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, SetTwoStepPinRequest>({
    mutationFn: (request) =>
      callEdgeFunction('set-two-step-pin', {
        pin: request.pin,
        current_pin: request.currentPin,
        recovery_email: request.recoveryEmail,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

/** Wraps POST /functions/v1/disable-two-step. */
export function useDisableTwoStep() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, { currentPin: string }>({
    mutationFn: (request) =>
      callEdgeFunction('disable-two-step', { current_pin: request.currentPin }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

interface VerifyTwoStepPinResponse {
  verified: boolean;
  locked_until?: string | null;
}

/** Wraps POST /functions/v1/verify-two-step-pin — the login-time gate
 * (see lib/twoStepGateStore.ts). */
export function useVerifyTwoStepPin() {
  return useMutation<VerifyTwoStepPinResponse, EdgeFunctionError, { pin: string }>({
    mutationFn: (request) => callEdgeFunction('verify-two-step-pin', { pin: request.pin }),
  });
}

interface RequestTwoStepResetResponse {
  requested_at: string;
  available_at: string;
}

/** Wraps POST /functions/v1/request-two-step-reset — the "Forgot PIN?"
 * entry point. Starts (or re-reads, if already pending) the cooldown;
 * never itself clears two-step verification — see that function's own
 * header comment for why an instant bypass isn't safe here. */
export function useRequestTwoStepReset() {
  return useMutation<RequestTwoStepResetResponse, EdgeFunctionError, void>({
    mutationFn: () => callEdgeFunction('request-two-step-reset'),
  });
}

/** Wraps POST /functions/v1/complete-two-step-reset — only succeeds once
 * the cooldown has genuinely elapsed (re-checked server-side regardless
 * of what the client's own clock says). */
export function useCompleteTwoStepReset() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, void>({
    mutationFn: () => callEdgeFunction('complete-two-step-reset'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}
