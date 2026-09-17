-- ledger_entries_chat_counterparty — per-counterparty view of a user's own
-- 1:1-chat-and-transfer ledger activity (docs/10-UX-REFINEMENT-BACKLOG.md
-- Batch D), separating "money that moved with another person" from
-- everything else (top-ups, withdrawals, status posts, adjustments) that
-- the wallet tab's existing flat `useLedgerEntries` query already covers
-- with no counterparty to group by.
--
-- `security_invoker = true` is load-bearing, same reason
-- `thread_unread_counts` (20260914080000_thread_read_cursor.sql) already
-- documents: without it, a view created by a privileged migration role
-- runs with THAT role's RLS context, not the querying user's — this view
-- would leak every user's ledger activity to every authenticated caller.
-- With it, `ledger_entries_select_own`'s existing RLS (join through
-- `wallets.user_id = auth.uid()`) is what actually scopes this, exactly as
-- it already scopes the flat query this view sits alongside — nothing
-- here needs its own `auth.uid()` filter.
--
-- Two source shapes, unioned:
--   1. Message-thread activity (`message_debit`, `escrow_release_earning`,
--      `escrow_refund_unanswered` — the only three of the escrow/message
--      reasons that ever land on a normal user's own wallet;
--      `escrow_release_platform_cut` only ever lands on the platform's
--      own wallet, and `escrow_hold` is declared but never actually
--      inserted, per that reason's own migration comment). Counterparty
--      resolved via `ledger_entries.ref_id` -> `messages.id` ->
--      `messages.thread_id` -> `threads.participant_a/b` (whichever isn't
--      the wallet's own owner).
--   2. Peer-to-peer credit transfers (`credit_transfer_sent`/`received`/
--      `conversion` — `credit_transfer_platform_cut` is the same
--      platform-only-wallet story as escrow's cut). `credit_transfers`
--      already has direct `sender_id`/`recipient_id` columns, no further
--      join needed.
-- Every other reason (topups, withdrawals, status posts, manual
-- adjustments, reserve/chargeback bookkeeping, group-message reasons —
-- group chat has no single counterparty and is kill-switched off anyway)
-- has no real counterparty and is deliberately not included here — the
-- client filters the existing flat query to that complementary reason set
-- instead of this needing a second view.
create view public.ledger_entries_chat_counterparty
with (security_invoker = true)
as
select
  le.id as ledger_entry_id,
  le.amount,
  le.reason,
  le.created_at,
  w.kind as wallet_kind,
  case when t.participant_a = w.user_id then t.participant_b else t.participant_a end as counterparty_id
from public.ledger_entries le
join public.wallets w on w.id = le.wallet_id
join public.messages m on m.id = le.ref_id
join public.threads t on t.id = m.thread_id
where le.ref_type = 'message'
  and le.reason in ('message_debit', 'escrow_release_earning', 'escrow_refund_unanswered')

union all

select
  le.id as ledger_entry_id,
  le.amount,
  le.reason,
  le.created_at,
  w.kind as wallet_kind,
  case when ct.sender_id = w.user_id then ct.recipient_id else ct.sender_id end as counterparty_id
from public.ledger_entries le
join public.wallets w on w.id = le.wallet_id
join public.credit_transfers ct on ct.id = le.ref_id
where le.ref_type = 'credit_transfer'
  and le.reason in ('credit_transfer_sent', 'credit_transfer_received', 'credit_transfer_conversion');

grant select on public.ledger_entries_chat_counterparty to authenticated;
