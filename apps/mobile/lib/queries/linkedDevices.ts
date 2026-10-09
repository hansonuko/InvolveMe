import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';

/** docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 5 — backs the mobile
 * "Linked Devices" settings screen and the QR-scanner confirm flow. */

export interface LinkedDevice {
  id: string;
  user_id: string;
  label: string;
  platform: string | null;
  linked_at: string;
  last_active_at: string;
  revoked_at: string | null;
}

/** Wraps POST /functions/v1/list-linked-devices — always the caller's own
 * devices, no id needed. Only unrevoked devices (the RPC's own scope). */
export function useLinkedDevices() {
  return useQuery({
    queryKey: ['linked-devices'],
    queryFn: async (): Promise<LinkedDevice[]> => {
      const data = await callEdgeFunction<{ devices: LinkedDevice[] }>('list-linked-devices');
      return data.devices;
    },
  });
}

/** Wraps POST /functions/v1/revoke-linked-device. Omitting `linkedDeviceId`
 * revokes every linked device at once (the RPC's own "log out of all
 * other devices" contract — see that function's header comment). */
export function useRevokeLinkedDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (linkedDeviceId?: string) =>
      callEdgeFunction<{ ok: true }>('revoke-linked-device', {
        linked_device_id: linkedDeviceId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['linked-devices'] });
    },
  });
}

/** Wraps POST /functions/v1/confirm-device-pairing — the phone's half of
 * the QR handshake, called right after the scanner decodes a pairing id. */
export function useConfirmDevicePairing() {
  return useMutation({
    mutationFn: (params: { pairingId: string; platform?: string }) =>
      callEdgeFunction<{ linked_device_id: string }>('confirm-device-pairing', {
        pairing_id: params.pairingId,
        platform: params.platform,
      }),
  });
}
