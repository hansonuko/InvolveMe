-- Product decision (2026-10-08): status postings are free, non-chargeable,
-- same posture as a status's first reply (docs/18 §B1,
-- 20260926130000_free_status_reply_first_message.sql). `fn_post_status`
-- already reads `status_upload_credits_text`/`status_upload_credits_media`
-- from pricing_config at call time (never hardcoded, CLAUDE.md rule #9) and
-- already treats `v_balance < v_credits` correctly when `v_credits = 0` —
-- insufficient_credit can never fire — so this is a pure config change, no
-- function logic to touch.
--
-- Rows are updated, not re-seeded, so `pricing_config_history`'s existing
-- trigger (20260912070729_create_core_schema.sql) captures this as a real
-- old-value/new-value change, same as any other pricing_config edit.

update public.pricing_config
set value = 0
where key in ('status_upload_credits_text', 'status_upload_credits_media');
