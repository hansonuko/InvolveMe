-- Linked Devices Milestone 2. The session confirm-device-pairing mints
-- (docs/02-DATA-MODEL.md's linked_devices/device_pairings entry) is a
-- stateless, self-signed JWT with no real refresh-token backing — there's
-- no auth.sessions row to silently renew against, so its expiry is a real,
-- hard boundary, not a soft one a refresh call quietly extends. Tunable
-- (not a hardcoded constant in the Edge Function) for the same reason
-- device_pairing_expiry_seconds/device_pairing_max_linked_devices already
-- are — ops may want to shorten or lengthen this without a redeploy.
insert into public.pricing_config (key, currency, value, description) values
  ('linked_device_session_ttl_seconds', 'NGN', 604800,
   'How long a linked (companion) web device''s self-signed session stays valid before it hard-expires and the device must be re-paired via QR code — there is no refresh-token-backed renewal for a linked session (docs/02-DATA-MODEL.md). Defaults to 7 days.')
on conflict (key, currency) do nothing;
