-- Multi-currency schema (E2, docs/10-UX-REFINEMENT-BACKLOG.md Batch E, paused
-- end of session 16 for a fresh session to actually start). Full reasoning —
-- the real Flutterwave NGN/GHS capability check, why every other currency
-- gets an honest "not supported yet" fallback rather than a faked rail — is
-- in docs/03-ECONOMY-LEDGER.md §12; the schema-level detail mirrored here is
-- docs/02-DATA-MODEL.md §9.
--
-- Deliberately additive and zero-behavior-change for every existing user:
-- every new NOT NULL column defaults/backfills to 'NGN', no existing kind's
-- row count changes, and no second-currency `pricing_config` or platform
-- `wallets` row is inserted by this migration. That last point is a real,
-- load-bearing hazard, not caution for its own sake:
--
-- **DO NOT insert a pricing_config row or a platform-owned wallets row for
-- any currency other than 'NGN' until every read-site of both tables is
-- re-threaded to filter by currency.** Every `select value into v_x from
-- pricing_config where key = 'foo'` call across this codebase's
-- SECURITY DEFINER functions (fn_send_message, fn_confirm_topup,
-- fn_release_escrow, fn_transfer_credit, fn_initiate_withdrawal, every cron
-- job, ...) has no currency filter today. Plain (non-STRICT) `SELECT ...
-- INTO` in PL/pgSQL does NOT error when a query matches more than one row —
-- it silently picks one, arbitrarily. Adding a second currency row before
-- those call sites are updated would not fail loudly; it would risk a
-- function silently reading the wrong currency's price for some fraction of
-- calls. This migration's own PK change on pricing_config (see below) is
-- safe only because it never inserts a row that could collide.

-- =============================================================================
-- users: country / nickname / currency
-- =============================================================================

alter table public.users
  add column country text,
  add column nickname text,
  add column currency text not null default 'NGN';

-- currency backfills 'NGN' via the column default above for every existing
-- row (matches reality — every user today is NGN whether this column
-- existed or not). country/nickname stay NULL for existing users — genuinely
-- unknown, filled in by the (not-yet-built) onboarding flow only for new
-- signups; no bulk backfill guess is safe or useful here.
--
-- No client UPDATE grant on any of the three (unlike display_name/
-- avatar_url/status_text below) — all three are written by
-- fn_complete_onboarding only. currency in particular determines which
-- pricing_config/wallet rows apply to a user for the rest of their account's
-- life, a bigger blast radius than a self-serve profile field, so it isn't a
-- bare column grant a client could set directly.

-- =============================================================================
-- wallets: currency tag, uniqueness widened to include it
-- =============================================================================

alter table public.wallets
  add column currency text not null default 'NGN';

alter table public.wallets drop constraint wallets_user_kind_unique;
alter table public.wallets add constraint wallets_user_kind_currency_unique
  unique (user_id, kind, currency);

-- The platform-singleton index similarly widens from "one row per kind" to
-- "one row per (kind, currency)" — once a second currency's platform wallet
-- is ever inserted (not by this migration — see the header hazard note), the
-- platform holds one revenue/reserve wallet per currency, never a single
-- pooled figure, per CLAUDE.md rule #4.
drop index public.wallets_platform_revenue_singleton;
create unique index wallets_platform_revenue_singleton
  on public.wallets (kind, currency)
  where user_id is null;

-- =============================================================================
-- ledger_entries: currency tag
-- =============================================================================

alter table public.ledger_entries
  add column currency text not null default 'NGN';

-- Every balance-mutating function must write this as the same value as the
-- wallet_id row it targets — the two are never independently chosen. A
-- mismatch here would silently break the per-currency reconciliation
-- invariant CLAUDE.md rule #4 requires once a second currency is live.

-- =============================================================================
-- pricing_config (+ history): currency dimension
-- =============================================================================

alter table public.pricing_config
  add column currency text not null default 'NGN';

alter table public.pricing_config drop constraint pricing_config_pkey;
alter table public.pricing_config add constraint pricing_config_pkey
  primary key (key, currency);

alter table public.pricing_config_history
  add column currency text not null default 'NGN';

create or replace function public.record_pricing_config_change()
returns trigger
language plpgsql
as $$
begin
  insert into public.pricing_config_history (key, currency, old_value, new_value)
  values (new.key, new.currency, old.value, new.value);

  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- country_currency_config — onboarding's country/currency picker source
-- =============================================================================
--
-- Config, not a hardcoded NGN/GHS check in app code (CLAUDE.md rule #9).
-- payments_live reflects real, confirmed Flutterwave capability (docs/03
-- §12), not aspiration: true only for NG today. GH flips to true only once
-- the Flutterwave GHS virtual-account activation request is actually
-- granted — an ops step tracked outside this repo, not a code deploy.
--
-- Seed below is a starter set (major/regional markets), not an exhaustive
-- ISO-3166 list — hand-listing all ~195 countries' currencies here risks
-- silently getting an obscure one wrong, which this project's own "verify
-- live, don't guess" discipline weighs heavier than picker completeness on
-- day one. Adding more countries later is a plain data insert into an
-- ops-controlled config table, not a migration.

create table public.country_currency_config (
  country_code text primary key,
  currency text not null,
  payments_live boolean not null default false
);

alter table public.country_currency_config enable row level security;

create policy country_currency_config_select_authenticated on public.country_currency_config
  for select
  to authenticated
  using (true);

insert into public.country_currency_config (country_code, currency, payments_live) values
  ('NG', 'NGN', true),
  ('GH', 'GHS', false),
  ('KE', 'KES', false),
  ('ZA', 'ZAR', false),
  ('TZ', 'TZS', false),
  ('UG', 'UGX', false),
  ('RW', 'RWF', false),
  ('ZM', 'ZMW', false),
  ('CM', 'XAF', false),
  ('CI', 'XOF', false),
  ('SN', 'XOF', false),
  ('EG', 'EGP', false),
  ('US', 'USD', false),
  ('GB', 'GBP', false),
  ('CA', 'CAD', false),
  ('DE', 'EUR', false),
  ('FR', 'EUR', false),
  ('IE', 'EUR', false),
  ('ES', 'EUR', false),
  ('IT', 'EUR', false),
  ('NL', 'EUR', false),
  ('AE', 'AED', false),
  ('IN', 'INR', false);

-- =============================================================================
-- fn_complete_onboarding — the one write path for country/nickname/currency
-- =============================================================================
--
-- SECURITY DEFINER, locked to service_role like every other money-adjacent
-- function (CLAUDE.md rule #11) — the Edge Function layer is what confirms
-- p_user_id is actually the caller (same trust boundary as fn_transfer_credit
-- etc., see 20260912072753_security_definer_functions.sql's header comment).
--
-- Resolves currency from country_currency_config rather than trusting a
-- client-supplied currency directly — a country whose payments_live is still
-- false resolves to 'NGN' (the honest "not supported yet, NGN only for
-- payments" fallback docs/10-UX-REFINEMENT-BACKLOG.md's E2 section
-- anticipated), never the country's real, not-yet-live currency. Returns
-- which happened so the client can render the right message.
--
-- Guarded by users.display_name is null — the same "first-time" signal E2's
-- own spec names as the natural detection method, reused here as a replay
-- guard: onboarding is shown once, not re-runnable to silently change an
-- already-set country/currency later.

create function public.fn_complete_onboarding(
  p_user_id uuid,
  p_country text,
  p_display_name text,
  p_nickname text
)
returns table (
  resolved_currency text,
  payments_live boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_onboarded boolean;
  v_country_currency text;
  v_payments_live boolean;
  v_resolved_currency text;
begin
  select display_name is not null into v_already_onboarded
  from public.users where id = p_user_id;

  if v_already_onboarded is null then
    raise exception 'unknown user';
  end if;

  if v_already_onboarded then
    raise exception 'onboarding already completed for this user';
  end if;

  select currency, country_currency_config.payments_live
    into v_country_currency, v_payments_live
    from public.country_currency_config
    where country_code = p_country;

  if v_country_currency is null then
    raise exception 'unknown country code: %', p_country;
  end if;

  v_resolved_currency := case when v_payments_live then v_country_currency else 'NGN' end;

  update public.users
    set country = p_country,
        nickname = p_nickname,
        display_name = p_display_name,
        currency = v_resolved_currency
    where id = p_user_id;

  return query select v_resolved_currency, v_payments_live;
end;
$$;

revoke execute on function public.fn_complete_onboarding(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_complete_onboarding(uuid, text, text, text) to service_role;
