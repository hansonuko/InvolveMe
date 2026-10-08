-- docs/22-FULL-PWA-SCOPING.md Phase B item 4 (voice notes on web).
--
-- expo-audio's real web recording path (confirmed live against the
-- installed package's own source, RecordingPresets.HIGH_QUALITY.web)
-- produces audio/webm, not the .m4a/AAC container native produces — a
-- genuinely different output, not a labeling choice this app controls.
-- apps/mobile/lib/queries/messages.ts's uploadChatAudio now trusts the
-- real recorded Blob's own `.type` on web instead of hardcoding
-- 'audio/m4a' (which would otherwise silently lie in the stored
-- Content-Type — this app has an explicit standing rule against exactly
-- that, see the e2ee media migration's own header comment).
--
-- Widened defensively to cover the realistic range of what different
-- browsers' MediaRecorder implementations actually produce for audio,
-- since exactly which string a given browser reports isn't something
-- this app's code chooses: Chrome/Edge/Firefox commonly report
-- 'audio/webm' or 'audio/webm;codecs=opus' (both with and without the
-- codecs parameter have been observed across versions); Safari's
-- MediaRecorder support is narrower and historically favors MP4/AAC
-- containers, which are already covered by the existing audio/mp4 entry.
--
-- Explicitly NOT verified on a real Safari/iOS device this session —
-- iOS is this whole PWA effort's primary motivating platform (docs/22
-- §1), so this allowlist should be revisited once a real recording from
-- an actual iOS Safari device is observed, rather than assumed correct
-- from this list alone.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp',
  'audio/m4a', 'audio/mp4',
  'audio/webm', 'audio/webm;codecs=opus',
  'application/octet-stream'
]
where id = 'chat-media';
