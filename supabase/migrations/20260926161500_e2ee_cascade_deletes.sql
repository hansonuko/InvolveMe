-- Fix forward: e2ee_devices.user_id (and everything hanging off a device)
-- had no ON DELETE behavior, so deleting a user whose account had ever
-- registered a device would fail outright on the FK constraint. Unlike
-- ledger_entries/kyc_records (docs/07-COMPLIANCE-LEGAL.md §2 — retained
-- deliberately, AML/audit trail), E2EE key material has no reason to
-- survive account deletion at all — it's pure cryptographic identity, not
-- a financial or audit record, so cascading here is the actually-correct
-- real-world behavior, not just a convenience. Caught by
-- e2ee-schema-functions.test.js's own cleanup hitting this FK live, not
-- assumed.

alter table public.e2ee_devices
  drop constraint e2ee_devices_user_id_fkey,
  add constraint e2ee_devices_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

alter table public.e2ee_signed_prekeys
  drop constraint e2ee_signed_prekeys_device_id_fkey,
  add constraint e2ee_signed_prekeys_device_id_fkey
    foreign key (device_id) references public.e2ee_devices (id) on delete cascade;

alter table public.e2ee_one_time_prekeys
  drop constraint e2ee_one_time_prekeys_device_id_fkey,
  add constraint e2ee_one_time_prekeys_device_id_fkey
    foreign key (device_id) references public.e2ee_devices (id) on delete cascade;

alter table public.e2ee_message_envelopes
  drop constraint e2ee_message_envelopes_recipient_device_id_fkey,
  add constraint e2ee_message_envelopes_recipient_device_id_fkey
    foreign key (recipient_device_id) references public.e2ee_devices (id) on delete cascade;
-- message_id stays RESTRICT (the default) — an envelope's parent message
-- is never deleted independently of the whole message-deletion path
-- (fn_delete_message_for_everyone), which doesn't touch e2ee_devices at
-- all, so no cascade conflict there.
