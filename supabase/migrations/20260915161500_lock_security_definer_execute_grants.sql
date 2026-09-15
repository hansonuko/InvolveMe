-- CRITICAL SECURITY FIX — every SECURITY DEFINER function this codebase
-- defines has been directly callable by any client holding just the
-- project's public anon key since the very first migration
-- (20260912072753_security_definer_functions.sql). Confirmed live against
-- the dev DB, not assumed: has_function_privilege('anon', ..., 'execute')
-- and the same for 'authenticated' both returned true on every one of
-- them, including fn_transfer_credit, fn_initiate_withdrawal,
-- fn_send_message.
--
-- Root cause: every `revoke execute on function ... from public` statement
-- in this codebase's history has been a no-op. Confirmed via pg_default_acl
-- — this Supabase project has a default-privileges rule (set up by the
-- platform at provisioning, not by any migration here) that grants EXECUTE
-- on every NEW function in the public schema DIRECTLY to anon,
-- authenticated, and service_role at CREATE FUNCTION time. That's a
-- separate grant path from the PUBLIC pseudo-role — revoking from PUBLIC
-- never touches it. (Tables were already protected against this same
-- platform default via RLS-enabled-with-zero-policies, per
-- 20260912070729_create_core_schema.sql's own header comment — this gap
-- was specific to functions, which have no RLS equivalent.)
--
-- Practical impact: any client with the anon key (embedded in the mobile
-- app, not secret) could call fn_transfer_credit / fn_send_message /
-- fn_initiate_withdrawal / fn_buy_credit / etc. directly via PostgREST
-- RPC, passing ANY p_sender_id / p_user_id / p_recipient_id — the "you can
-- only ever act as yourself" check lives ONLY in the Edge Function layer
-- (pulled from a verified JWT) and is entirely bypassable by calling the
-- underlying DB function directly. Concretely:
-- fn_transfer_credit(victim_id, attacker_id, victim_balance) would drain
-- any user's credit with no auth beyond the public anon key.
--
-- This is exactly the invariant docs/02-DATA-MODEL.md §2 already claims as
-- true ("No client INSERT/UPDATE/DELETE grants at all — every write is via
-- SECURITY DEFINER functions invoked by Edge Functions using the service
-- role") — it just was never actually enforced for functions, only tables.
--
-- Fix, two parts:
--   1. Explicitly revoke EXECUTE from public, anon, and authenticated on
--      every existing money/business-logic SECURITY DEFINER function this
--      codebase defines — verified, this closes the gap for each one.
--   2. Attempted to also fix the default-privileges rule so this couldn't
--      recur on a future migration's new function — see the important
--      caveat below before trusting that part.
--
-- Excluded from the list below: trigger functions (handle_new_auth_user,
-- rls_auto_enable, apply_ledger_entry_to_wallet, etc. — `returns trigger`,
-- not callable via a direct RPC call regardless of grants) and the
-- pg_trgm extension's own functions (not this codebase's to manage).
--
-- IMPORTANT, confirmed live by direct testing, not assumed: `ALTER DEFAULT
-- PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` (attempted
-- below) did NOT actually prevent a freshly-created test function from
-- getting PUBLIC execute anyway — its real proacl still showed
-- `{=X/postgres,...}` (the blank name before `=` is the PUBLIC
-- pseudo-role) even after this statement ran and pg_default_acl showed no
-- PUBLIC entry for postgres/public/f. Root cause not fully pinned down in
-- reasonable time (a Supabase-platform-level mechanism this project
-- doesn't have full visibility into is the leading suspect) — kept below
-- as defense-in-depth since it's harmless, but **do not rely on it**.
-- The ONLY verified-reliable fix, confirmed by the same direct testing:
-- explicitly `revoke ... from public, anon, authenticated` +
-- `grant ... to service_role` immediately after every single `create
-- function` for a SECURITY DEFINER function, in every future migration,
-- no exceptions. This is now a documented rule (CLAUDE.md).
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Part 1: lock down every existing one. Loop + EXECUTE rather than 21
-- repetitive statement pairs — same effect, easier to audit as a single
-- list, and the list itself becomes documentation of exactly what's
-- covered.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'fn_buy_credit(uuid, bigint, text)',
    'fn_complete_withdrawal(uuid, text)',
    'fn_confirm_topup(uuid, text)',
    'fn_credit_platform_revenue(text, text, bigint, text, text, uuid)',
    'fn_fail_withdrawal(uuid)',
    'fn_initiate_withdrawal(uuid, uuid, bigint, boolean)',
    'fn_link_device_fingerprint(uuid, text)',
    'fn_mark_thread_read(uuid, uuid)',
    'fn_post_status(uuid, text, text)',
    'fn_process_chargeback(uuid, text)',
    'fn_refund_expired_escrows()',
    'fn_release_escrow(uuid)',
    'fn_run_auto_withdraw_sweep()',
    'fn_run_collusion_detection()',
    'fn_run_reconciliation_check()',
    'fn_send_group_message(uuid, uuid, text)',
    'fn_send_message(uuid, uuid, text)',
    'fn_set_thread_blocked(uuid, uuid, boolean)',
    'fn_start_thread(uuid, uuid)',
    'fn_transfer_credit(uuid, uuid, bigint, text)'
  ]
  loop
    execute format('revoke execute on function public.%s from anon, authenticated, public', v_fn);
    execute format('grant execute on function public.%s to service_role', v_fn);
  end loop;
end $$;

-- fn_is_withdrawal_trusted deliberately excluded from the list above: it's
-- mid-flight in a paused feature branch, not in git on main yet, so
-- referencing it here would break this migration for anyone applying it
-- against a clean main-only checkout (including CI's migrate-staging
-- step). It already exists in this dev DB (applied ahead of this fix
-- being discovered, so it was equally exposed in the meantime) — its own
-- migration gets a correct revoke/grant directly when that branch
-- resumes and lands, using the same anon+authenticated+public pattern
-- established here, not the insufficient from-public-only pattern that
-- branch was originally written with before this fix was found.
