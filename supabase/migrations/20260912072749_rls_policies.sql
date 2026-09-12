-- RLS policies per docs/02-DATA-MODEL.md §2. Everything not covered by a
-- policy stays denied by default (RLS was enabled with zero policies in the
-- item-1 migration) — this migration only ever ADDS access, never widens
-- beyond what's listed there.
--
-- All money mutations happen through the SECURITY DEFINER functions in the
-- next migration, which are owned by the migration role and therefore
-- bypass RLS entirely when they run — that's what lets a single function
-- call move credits between two different users' wallets. Nothing here
-- grants direct INSERT/UPDATE/DELETE on money tables to anon/authenticated;
-- that absence is the control, not an oversight.
--
-- Known v1 simplification (documented, not hidden): users_select policy
-- below exposes the FULL users row to thread partners, not just a
-- column-limited subset — docs/02-DATA-MODEL.md's "limited columns via a
-- view" is deferred as a follow-up privacy hardening item.

-- =============================================================================
-- users
-- =============================================================================

create policy users_select_own_or_thread_partner on public.users
  for select
  to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.threads t
      where (t.participant_a = auth.uid() and t.participant_b = users.id)
         or (t.participant_b = auth.uid() and t.participant_a = users.id)
    )
  );

create policy users_update_own on public.users
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Column-level restriction: profile fields only. kyc_tier, is_suspended,
-- and device_fingerprint_ids stay service_role-only regardless of the
-- policy above (RLS governs rows, not columns — this is what governs columns).
revoke update on public.users from authenticated;
grant update (display_name, avatar_url, status_text) on public.users to authenticated;

-- =============================================================================
-- wallets / ledger_entries — read own, write via functions only
-- =============================================================================

create policy wallets_select_own on public.wallets
  for select
  to authenticated
  using (user_id = auth.uid());

create policy ledger_entries_select_own on public.ledger_entries
  for select
  to authenticated
  using (
    exists (
      select 1 from public.wallets w
      where w.id = ledger_entries.wallet_id and w.user_id = auth.uid()
    )
  );

-- =============================================================================
-- threads / messages / escrows
-- =============================================================================

create policy threads_select_participant on public.threads
  for select
  to authenticated
  using (participant_a = auth.uid() or participant_b = auth.uid());

create policy messages_select_participant on public.messages
  for select
  to authenticated
  using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id
        and (t.participant_a = auth.uid() or t.participant_b = auth.uid())
    )
  );

create policy escrows_select_participant on public.escrows
  for select
  to authenticated
  using (payer_id = auth.uid() or payee_id = auth.uid());

-- =============================================================================
-- topups / withdrawals / bank_accounts / kyc_records — read own only.
-- Bank-account linking and KYC submission flows aren't built yet (Phase 3),
-- so there's deliberately no write policy for either table in this pass.
-- =============================================================================

create policy topups_select_own on public.topups
  for select
  to authenticated
  using (user_id = auth.uid());

create policy withdrawals_select_own on public.withdrawals
  for select
  to authenticated
  using (user_id = auth.uid());

create policy bank_accounts_select_own on public.bank_accounts
  for select
  to authenticated
  using (user_id = auth.uid());

create policy kyc_records_select_own on public.kyc_records
  for select
  to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- status_updates — read own only for now. Visibility to contacts/thread
-- partners is a Status-feature product decision (Phase 6), not assumed here.
-- =============================================================================

create policy status_updates_select_own on public.status_updates
  for select
  to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- pricing_config — readable by any authenticated user (needed for the
-- client-side cost preview while composing a message). No write policy:
-- changes go through an ops tool using service_role, not through client roles.
-- =============================================================================

create policy pricing_config_select_authenticated on public.pricing_config
  for select
  to authenticated
  using (true);

-- fraud_signals, pricing_config_history: intentionally no policies at all —
-- fully internal, service_role (and staff tooling) only.
