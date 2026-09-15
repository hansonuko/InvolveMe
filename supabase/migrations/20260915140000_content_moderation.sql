-- App-store submission blocker: text content moderation
-- (docs/07-COMPLIANCE-LEGAL.md §3, docs/06-SECURITY-FRAUD-LOOPHOLES.md §6,
-- docs/00-SESSION-HANDOFF.md session 13, continued).
--
-- moderated_content, not fraud_signals: fraud_signals' user_id/
-- related_user_id shape is built around a PAIR (payer/payee, sender/
-- related party) — a moderation outcome is about one piece of content
-- from one user, a materially different shape that would force an
-- awkward null related_user_id on every row. A dedicated small table is
-- cheap and keeps both tables' meaning clean.
--
-- ref_id is nullable on purpose: a hard-blocked message/status is
-- rejected BEFORE fn_send_message/fn_post_status ever runs, so there is
-- no message_id/status_id to reference — only a flagged-but-allowed row
-- has one, since that content really was inserted.

create table public.moderated_content (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  content_type text not null check (content_type in ('message', 'status')),
  ref_id uuid,
  action text not null check (action in ('blocked', 'flagged')),
  categories jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index moderated_content_user_id_idx on public.moderated_content (user_id);

-- No client access of any kind — written only by the SECURITY DEFINER
-- service-role path inside send-message/post-status's Edge Functions,
-- read only by whoever reviews it directly (Supabase Studio), same
-- posture as fraud_signals.
alter table public.moderated_content enable row level security;
