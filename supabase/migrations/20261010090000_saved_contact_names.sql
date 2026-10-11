-- Cross-device saved contact names (session 45 continued) — the server
-- has never stored a user's locally-saved contact name for anyone before
-- this; `find-users-by-phones`/`find-user-by-phone` only ever match on
-- phone numbers, never names. Found investigating a real report: a name
-- saved on a user's phone only ever showed on that same phone — web
-- (no bulk-contacts API at all, see lib/contacts.ts's web shim) and any
-- other device always fell back to a raw phone number for the exact same
-- person.
--
-- Deliberately scoped to InvolveMe users only, not every device contact —
-- a real product decision, not a technical shortcut: uploading a name for
-- someone who has never used this app at all is a meaningfully bigger
-- privacy footprint than this. The client already legitimately holds
-- every `contact_user_id` this table will ever get written with, from the
-- existing `find-users-by-phones` response it already calls — no new
-- Edge Function or service-role write path needed, a direct RLS-scoped
-- upsert is sufficient (same "plain authenticated read/write behind RLS"
-- posture `wallets`/`pricing_config` already use for non-financial data).
--
-- `contact_user_id` referencing another real user's own row is not a new
-- privilege over that row — this table only ever expresses "how the owner
-- has chosen to label this person for themselves," never anything the
-- labeled person's own account can see or that changes their own data.
create table public.saved_contact_names (
  owner_user_id uuid not null references public.users (id),
  contact_user_id uuid not null references public.users (id),
  name text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, contact_user_id)
);

create index saved_contact_names_owner_idx on public.saved_contact_names (owner_user_id);

alter table public.saved_contact_names enable row level security;

create policy saved_contact_names_select_own on public.saved_contact_names
  for select
  to authenticated
  using (owner_user_id = auth.uid());

create policy saved_contact_names_insert_own on public.saved_contact_names
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

create policy saved_contact_names_update_own on public.saved_contact_names
  for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create policy saved_contact_names_delete_own on public.saved_contact_names
  for delete
  to authenticated
  using (owner_user_id = auth.uid());
