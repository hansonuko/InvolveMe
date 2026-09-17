-- Batch F, part 1 — status media pipeline (docs/10-UX-REFINEMENT-BACKLOG.md
-- Batch F's hard prerequisite: "a real Storage/media upload pipeline does
-- not exist anywhere in this app"). Schema, Storage bucket, and RLS only —
-- the Edge Functions and mobile UI are separate, later pieces of this same
-- batch.
--
-- Scope decision, not an oversight: photo + text status only, no video.
-- The refined spec's own wording only ever says "single compressed image"
-- and "Photo viewing" — the "15s video, transcoded to H.264 720p" line in
-- docs/01-ARCHITECTURE.md §5 is an old, aspirational budget target, not
-- something this batch's actual spec (docs/10) asks for. Client-side video
-- transcoding would need a heavy native dependency this app's "stay lite"
-- rule doesn't currently justify — revisit if video status is ever
-- explicitly scoped.

-- =============================================================================
-- status_updates: media_url -> media_path (never populated in production,
-- safe to rename for clarity — it's about to hold a private Storage object
-- path, not a public URL), plus text_style for the fixed-palette templates
-- text-only posts can use (docs/10's "clean background/text-style
-- templates" — the viewer needs to know which one was picked to render the
-- same background back).
-- =============================================================================

alter table public.status_updates rename column media_url to media_path;
alter table public.status_updates add column text_style text;

create policy status_updates_delete_own on public.status_updates
  for delete
  to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- status_views: the poster needs to see their own status's view rows to
-- get a count (docs/10 item 4 — "visible to the poster only"). The
-- existing status_views_select_own policy only ever lets a viewer see
-- their *own* view rows, which is the wrong direction for this — a second
-- permissive policy (Postgres ORs them) grants the poster read access to
-- every view row on their own statuses, which also sets up the "full
-- viewer-list" docs/10 names as a natural later add-on without needing a
-- second RLS change then.
-- =============================================================================

create policy status_views_select_as_poster on public.status_views
  for select
  to authenticated
  using (
    exists (
      select 1 from public.status_updates su
      where su.id = status_views.status_id
        and su.user_id = auth.uid()
    )
  );

-- =============================================================================
-- fn_post_status: signature changes (media_url -> media_path, + text_style)
-- — create or replace can't add a parameter to an existing signature
-- without leaving the old overload behind, so this is drop-then-create,
-- same forward-only convention as every other function change here, just
-- with an explicit drop first because this one is a signature change, not
-- a same-signature redefinition.
-- =============================================================================

drop function public.fn_post_status(uuid, text, text);

create function public.fn_post_status(
  p_user_id uuid,
  p_media_path text,
  p_caption text,
  p_text_style text default null
)
returns table (
  status_id uuid,
  credits_charged bigint,
  payer_balance_after bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text_credits bigint;
  v_media_credits bigint;
  v_credits bigint;
  v_has_media boolean;
  v_wallet_id uuid;
  v_balance bigint;
  v_frozen boolean;
  v_status_id uuid;
begin
  v_has_media := p_media_path is not null and length(trim(both from p_media_path)) > 0;

  if not v_has_media and (p_caption is null or length(trim(both from p_caption)) = 0) then
    raise exception 'empty_status';
  end if;

  select value into v_text_credits from pricing_config where key = 'status_upload_credits_text';
  select value into v_media_credits from pricing_config where key = 'status_upload_credits_media';

  v_credits := case when v_has_media then v_media_credits else v_text_credits end;

  select id, balance, is_frozen into v_wallet_id, v_balance, v_frozen
  from wallets
  where user_id = p_user_id and kind = 'topup_credit'
  for update;

  if not found then
    raise exception 'wallet_not_found';
  end if;

  if v_frozen then
    raise exception 'wallet_frozen';
  end if;

  if v_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_balance;
  end if;

  insert into status_updates (user_id, media_path, caption, text_style, credits_charged, expires_at)
  values (p_user_id, p_media_path, p_caption, p_text_style, v_credits, now() + interval '24 hours')
  returning id into v_status_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_wallet_id, -v_credits, 'status_upload_debit', 'status_update', v_status_id);

  select balance into v_balance from wallets where id = v_wallet_id;

  return query select v_status_id, v_credits, v_balance;
end;
$$;

revoke execute on function public.fn_post_status(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_post_status(uuid, text, text, text) to service_role;

-- =============================================================================
-- Storage: status-media bucket. Private (public = false) — reads go through
-- the RLS policy below via createSignedUrl, never a bare public URL. Never
-- a client-side direct-to-bucket credential for writes either: the only
-- way to write is a signed *upload* URL minted server-side (service role,
-- in the create-status-upload-url Edge Function), which the Storage API
-- authorizes via the signed token itself, not via an INSERT RLS policy —
-- so there is deliberately no INSERT policy for `authenticated` on this
-- bucket at all.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'status-media',
  'status-media',
  false,
  5242880, -- 5 MiB — a client-side-compressed single image should never
           -- approach this; a hard server-side ceiling regardless of
           -- whether the client's own compression step is bypassed.
  array['image/jpeg', 'image/png']
);

-- SELECT: an object is readable if a status_updates row's media_path
-- matches its name AND that status is visible to the caller — same
-- ownership-or-non-blocked-thread-partner-and-unexpired condition
-- status_updates_select_visible_to_thread_partner and
-- fn_mark_status_viewed already each independently encode (RLS can't
-- reference another table's RLS policy, so this is a third, deliberate
-- repetition of the same predicate, not a new pattern — see
-- fn_mark_status_viewed's own comment for why this codebase already
-- accepts that duplication over inventing a shared helper for it).
create policy status_media_select_visible on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'status-media'
    and exists (
      select 1 from public.status_updates su
      where su.media_path = storage.objects.name
        and (
          su.user_id = auth.uid()
          or (
            su.expires_at > now()
            and exists (
              select 1 from public.threads t
              where t.blocked_by is null
                and (
                  (t.participant_a = auth.uid() and t.participant_b = su.user_id)
                  or (t.participant_b = auth.uid() and t.participant_a = su.user_id)
                )
            )
          )
        )
    )
  );

-- DELETE: only the poster's own status media, and only while the owning
-- status_updates row still exists — the mobile client must delete the
-- Storage object BEFORE deleting the status_updates row, not after, or
-- this EXISTS check has nothing left to authorize against by the time it
-- runs (documented again in the client code that does this, since getting
-- the order backwards is a real, easy-to-hit mistake here).
create policy status_media_delete_own on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'status-media'
    and exists (
      select 1 from public.status_updates su
      where su.media_path = storage.objects.name
        and su.user_id = auth.uid()
    )
  );
