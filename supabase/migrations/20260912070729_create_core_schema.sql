-- InvolveMe — core schema (Phase 1, item 1)
--
-- Implements every table in docs/02-DATA-MODEL.md. RLS is enabled on every
-- table with ZERO policies in this migration — that's deliberate, not an
-- oversight: Supabase grants anon/authenticated broad default privileges on
-- public-schema tables, and RLS-enabled-with-no-policies is what actually
-- closes that off (deny-by-default) until docs/02-DATA-MODEL.md's real
-- policies land in the next migration (Phase 1 item 2). service_role
-- (Edge Functions only) bypasses RLS as normal — nothing here restricts it.
--
-- Three schema-level integrity guarantees beyond the doc's literal table
-- list, added here because they belong at the schema layer, not as
-- application discipline (see CLAUDE.md rules #3/#4):
--   1. ledger_entries is enforced append-only by trigger (blocks UPDATE/
--      DELETE outright, including for service_role).
--   2. wallets.balance is derived automatically from ledger_entries by
--      trigger — the only way to move a balance is to insert a ledger row.
--   3. Signup bootstrap: auth.users -> public.users -> three wallet rows,
--      since nothing currently creates a public.users row when someone
--      completes phone/OTP signup (see docs/00-SESSION-HANDOFF.md).

-- =============================================================================
-- users (extends auth.users)
-- =============================================================================

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  phone text unique,
  display_name text,
  avatar_url text,
  kyc_tier smallint not null default 0,
  status_text text,
  is_suspended boolean not null default false,
  device_fingerprint_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

comment on table public.users is 'Extends auth.users. Row is created automatically by handle_new_auth_user() below.';

-- =============================================================================
-- wallets
-- =============================================================================

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id) on delete cascade,
  kind text not null check (kind in ('topup_credit', 'earnings_pending', 'withdrawable_cash', 'platform_revenue')),
  balance bigint not null default 0,
  is_frozen boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint wallets_user_kind_unique unique (user_id, kind),
  constraint wallets_platform_wallet_has_no_user check (
    (kind = 'platform_revenue' and user_id is null) or
    (kind <> 'platform_revenue' and user_id is not null)
  )
);

-- Only one platform_revenue wallet may exist (user_id is null so the regular
-- unique constraint above doesn't apply — NULLs are distinct from each other
-- in a standard UNIQUE constraint).
create unique index wallets_platform_revenue_singleton
  on public.wallets (kind)
  where user_id is null;

create index wallets_user_id_idx on public.wallets (user_id);

comment on column public.wallets.balance is 'Derived — do not UPDATE directly. Maintained by apply_ledger_entry_to_wallet() from ledger_entries. See docs/02-DATA-MODEL.md §4.';

-- =============================================================================
-- ledger_entries (append-only, source of truth)
-- =============================================================================

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id),
  amount bigint not null,
  reason text not null check (reason in (
    'topup_purchase',
    'topup_platform_fee',
    'message_debit',
    'escrow_hold',
    'escrow_release_earning',
    'escrow_release_platform_cut',
    'escrow_refund_unanswered',
    'earnings_conversion',
    'withdrawal_platform_fee',
    'withdrawal_payout',
    'status_upload_debit',
    'manual_adjustment'
  )),
  ref_type text check (ref_type in ('message', 'topup', 'withdrawal', 'escrow', 'status_update')),
  ref_id uuid,
  created_by text not null default 'system',
  created_at timestamptz not null default now()
);

create index ledger_entries_wallet_id_idx on public.ledger_entries (wallet_id);
create index ledger_entries_ref_idx on public.ledger_entries (ref_type, ref_id);

-- =============================================================================
-- pricing_config (+ audit history)
-- =============================================================================

create table public.pricing_config (
  key text primary key,
  value bigint not null,
  description text,
  updated_at timestamptz not null default now()
);

create table public.pricing_config_history (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  old_value bigint,
  new_value bigint not null,
  changed_by text not null default 'system',
  changed_at timestamptz not null default now()
);

-- =============================================================================
-- threads / messages / escrows
-- =============================================================================

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  participant_a uuid not null references public.users (id), -- payer / "seeker"
  participant_b uuid not null references public.users (id), -- payee / "sought"
  is_blocked boolean not null default false,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  constraint threads_participants_unique unique (participant_a, participant_b),
  constraint threads_participants_distinct check (participant_a <> participant_b)
);

create index threads_participant_a_idx on public.threads (participant_a);
create index threads_participant_b_idx on public.threads (participant_b);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id),
  sender_id uuid not null references public.users (id),
  body text not null,
  word_count integer not null check (word_count > 0),
  credits_charged bigint not null check (credits_charged > 0),
  status text not null check (status in ('escrowed', 'released', 'refunded')),
  created_at timestamptz not null default now()
);

create index messages_thread_id_idx on public.messages (thread_id);
create index messages_sender_id_idx on public.messages (sender_id);

create table public.escrows (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id),
  message_id uuid not null references public.messages (id),
  payer_id uuid not null references public.users (id),
  payee_id uuid not null references public.users (id),
  credits_held bigint not null check (credits_held > 0),
  status text not null check (status in ('pending', 'released', 'refunded')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index escrows_thread_id_idx on public.escrows (thread_id);
-- Used by the escrow-expiry-sweep cron job (docs/05-API-REALTIME-SPEC.md §2).
create index escrows_pending_expiry_idx on public.escrows (expires_at) where status = 'pending';

-- =============================================================================
-- topups / withdrawals / bank_accounts
-- =============================================================================

create table public.topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  amount_kobo_paid bigint not null check (amount_kobo_paid > 0),
  platform_fee_kobo bigint not null check (platform_fee_kobo >= 0),
  credits_issued bigint not null check (credits_issued >= 0),
  provider text not null check (provider in ('flutterwave', 'paystack')),
  provider_ref text,
  status text not null check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

create index topups_user_id_idx on public.topups (user_id);
create index topups_status_idx on public.topups (status);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  provider_account_id text,
  account_number_last4 text,
  bank_name text,
  account_name text,
  name_match_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create index bank_accounts_user_id_idx on public.bank_accounts (user_id);

create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  amount_kobo bigint not null check (amount_kobo > 0),
  platform_fee_kobo bigint not null default 0 check (platform_fee_kobo >= 0),
  bank_account_id uuid not null references public.bank_accounts (id),
  provider text check (provider in ('flutterwave', 'paystack')),
  provider_ref text,
  status text not null check (status in ('pending', 'processing', 'paid', 'failed', 'held_for_review')),
  triggered_by text not null check (triggered_by in ('manual', 'auto_sweep')),
  created_at timestamptz not null default now()
);

create index withdrawals_user_id_idx on public.withdrawals (user_id);
create index withdrawals_status_idx on public.withdrawals (status);

-- =============================================================================
-- kyc_records / fraud_signals / status_updates
-- =============================================================================

create table public.kyc_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  tier smallint not null,
  provider text,
  provider_ref text,
  bvn_or_nin_hash text,
  status text not null check (status in ('pending', 'verified', 'failed', 'expired')),
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index kyc_records_user_id_idx on public.kyc_records (user_id);

create table public.fraud_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id),
  related_user_id uuid references public.users (id),
  signal_type text not null,
  severity text not null default 'low' check (severity in ('low', 'medium', 'high')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index fraud_signals_user_id_idx on public.fraud_signals (user_id);
create index fraud_signals_related_user_id_idx on public.fraud_signals (related_user_id);

create table public.status_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  media_url text,
  caption text,
  credits_charged bigint not null check (credits_charged >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index status_updates_user_id_idx on public.status_updates (user_id);
create index status_updates_expires_at_idx on public.status_updates (expires_at);

-- =============================================================================
-- Trigger: ledger_entries is append-only (blocks UPDATE/DELETE outright)
-- =============================================================================

create function public.prevent_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger_entries is append-only — % is not permitted (row id: %)',
    tg_op, coalesce(old.id, new.id);
end;
$$;

create trigger ledger_entries_no_update
  before update on public.ledger_entries
  for each row execute function public.prevent_ledger_mutation();

create trigger ledger_entries_no_delete
  before delete on public.ledger_entries
  for each row execute function public.prevent_ledger_mutation();

-- =============================================================================
-- Trigger: wallets.balance is derived from ledger_entries, never written
-- directly. This is what makes "sum(ledger_entries) == wallet.balance" true
-- by construction instead of by application discipline alone.
-- =============================================================================

create function public.apply_ledger_entry_to_wallet()
returns trigger
language plpgsql
as $$
begin
  update public.wallets
  set balance = balance + new.amount,
      updated_at = now()
  where id = new.wallet_id;

  return new;
end;
$$;

create trigger ledger_entries_apply_to_wallet
  after insert on public.ledger_entries
  for each row execute function public.apply_ledger_entry_to_wallet();

-- =============================================================================
-- Trigger: pricing_config changes are audited
-- =============================================================================

create function public.record_pricing_config_change()
returns trigger
language plpgsql
as $$
begin
  insert into public.pricing_config_history (key, old_value, new_value)
  values (new.key, old.value, new.value);

  new.updated_at = now();
  return new;
end;
$$;

create trigger pricing_config_audit
  before update on public.pricing_config
  for each row execute function public.record_pricing_config_change();

-- =============================================================================
-- Signup bootstrap: auth.users -> public.users -> three wallet rows
--
-- Nothing in Phase 0's auth flow creates a public.users row today (see
-- docs/00-SESSION-HANDOFF.md). Without this, threads/messages/wallets would
-- have no public.users row to reference for anyone who signs up.
-- =============================================================================

create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, phone, created_at)
  values (new.id, new.phone, new.created_at);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create function public.create_default_wallets_for_user()
returns trigger
language plpgsql
as $$
begin
  insert into public.wallets (user_id, kind)
  values
    (new.id, 'topup_credit'),
    (new.id, 'earnings_pending'),
    (new.id, 'withdrawable_cash');

  return new;
end;
$$;

create trigger on_public_user_created
  after insert on public.users
  for each row execute function public.create_default_wallets_for_user();

-- =============================================================================
-- Row Level Security: enabled everywhere, zero policies yet (deny-by-default
-- for anon/authenticated). Real policies land in Phase 1 item 2.
-- service_role bypasses RLS as normal — used only from Edge Functions.
-- =============================================================================

alter table public.users enable row level security;
alter table public.wallets enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.pricing_config enable row level security;
alter table public.pricing_config_history enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.escrows enable row level security;
alter table public.topups enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.withdrawals enable row level security;
alter table public.kyc_records enable row level security;
alter table public.fraud_signals enable row level security;
alter table public.status_updates enable row level security;
