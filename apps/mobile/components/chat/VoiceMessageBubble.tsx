// Real end-to-end voice notes, sent-bubble playback side
// (docs/17-VOICE-NOTES-SCOPING.md §1/§5/§7/§10) — a real waveform
// (rendered from `message.waveform_samples`, never decorative/random),
// tap to play/pause, tap/drag to scrub, a cycling speed control, and the
// unplayed dot. All playback state comes from the one shared
// `usePlaybackStore` (lib/audio/playbackStore.ts) — this component never
// creates its own player, which is exactly what makes the "only one voice
// note plays at a time" invariant hold across every bubble in the list.
//
// Same PanResponder-over-Gesture.Pan choice as VoiceRecorderButton.tsx,
// for the same reason (see that file's header comment) — the scrub drag
// here is a second, independent place this would otherwise reintroduce
// the one gesture-API ingredient this codebase has already crashed on.

import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { Alert, PanResponder, Pressable, View, type LayoutChangeEvent } from 'react-native';

import { Text } from '@/components/ui/Text';
import { usePlaybackStore, type PlaybackRate } from '@/lib/audio/playbackStore';
import { decryptMediaBytes } from '@/lib/e2ee/mediaCrypto';
import { nativeSodiumProvider } from '@/lib/e2ee/sodiumProviderNative';
import { useChatMediaUrl, useMarkAudioPlayed, type Message } from '@/lib/queries/messages';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme';

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_MAX_HEIGHT = 28;
const BAR_MIN_HEIGHT = 3;

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const RATE_LABELS: Record<PlaybackRate, string> = { 1: '1x', 1.5: '1.5x', 2: '2x' };

export function VoiceMessageBubble({
  message,
  isOwn,
  threadId,
  isE2eeThread,
}: {
  message: Message;
  isOwn: boolean;
  threadId: string;
  /** Same reasoning as MessageBubble's own isE2eeThread prop — distinguishes
   * "a normal plaintext voice note" from "an e2ee voice note whose
   * attachment key couldn't be recovered," which are otherwise
   * indistinguishable once e2eeMediaKeyBase64 is undefined in both cases. */
  isE2eeThread?: boolean;
}) {
  const { colors, spacing } = useTheme();
  const mediaUrl = useChatMediaUrl(message.media_path);
  const markAudioPlayed = useMarkAudioPlayed();

  // Real end-to-end encrypted voice notes (session 37/38 follow-up to
  // docs/21) — mediaUrl above is a signed URL to CIPHERTEXT for one of
  // these; expo-audio can't play that directly (or a data: URI reliably,
  // across both platforms), so this decrypts LAZILY, only on the first
  // tap-to-play, straight to a temp file via expo-file-system's File API,
  // and hands the resulting file:// URI to the shared player instead —
  // matching the exact same "don't do work the user might never ask for"
  // posture the eager (decrypt-on-arrival) choice for photos deliberately
  // does NOT use, because unlike a photo thumbnail a voice note has no
  // useful undecrypted preview to show while idle anyway. Cached in local
  // state (not the plaintext cache used for text/captions — a decrypted
  // audio file living in cache dir already survives until the OS reclaims
  // it) so a second tap on the same note never re-decrypts.
  const isE2eeAudio = !!message.e2eeMediaKeyBase64;
  const isUnavailable = !!isE2eeThread && !!message.media_path && !message.e2eeMediaKeyBase64;
  const [decryptedLocalUri, setDecryptedLocalUri] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  const playingMessageId = usePlaybackStore((s) => s.playingMessageId);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  const rate = usePlaybackStore((s) => s.rate);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seekTo = usePlaybackStore((s) => s.seekTo);
  const cycleRate = usePlaybackStore((s) => s.cycleRate);

  const isThisPlaying = playingMessageId === message.id;
  const samples = message.waveform_samples ?? [];
  const totalSeconds = isThisPlaying && duration > 0 ? duration : (message.duration_seconds ?? 0);
  const elapsedSeconds = isThisPlaying ? currentTime : 0;
  const progressRatio = totalSeconds > 0 ? Math.min(1, elapsedSeconds / totalSeconds) : 0;

  const [barsWidth, setBarsWidth] = useState(0);
  const handleBarsLayout = (e: LayoutChangeEvent) => setBarsWidth(e.nativeEvent.layout.width);

  const markPlayedIfNeeded = () => {
    // The recipient's client marks a note played the first time IT starts
    // playback — never the sender's own device replaying its own sent
    // note (docs/17 §8; fn_mark_audio_played itself also rejects that,
    // this just avoids firing a doomed request).
    if (!isOwn && !message.audio_played_at) {
      markAudioPlayed.mutate({ threadId, messageId: message.id });
    }
  };

  const handleTogglePlay = async () => {
    if (isUnavailable) return;
    if (!isE2eeAudio) {
      if (!mediaUrl.data) return;
      toggle(message.id, mediaUrl.data);
      markPlayedIfNeeded();
      return;
    }

    if (decryptedLocalUri) {
      toggle(message.id, decryptedLocalUri);
      markPlayedIfNeeded();
      return;
    }

    if (!mediaUrl.data || isDecrypting) return;
    setIsDecrypting(true);
    try {
      const response = await fetch(mediaUrl.data);
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      const plaintext = decryptMediaBytes(nativeSodiumProvider, ciphertext, {
        keyBase64: message.e2eeMediaKeyBase64 as string,
        nonceBase64: message.e2eeMediaNonceBase64 as string,
      });
      const file = new File(Paths.cache, `voice-${message.id}.m4a`);
      file.create({ overwrite: true });
      file.write(plaintext);
      setDecryptedLocalUri(file.uri);
      toggle(message.id, file.uri);
      markPlayedIfNeeded();
    } catch (e) {
      console.error('VoiceMessageBubble: failed to decrypt voice note:', e);
      Alert.alert('Could not play voice message', 'This voice message could not be decrypted.');
    } finally {
      setIsDecrypting(false);
    }
  };

  const seekToRatio = (ratio: number) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    if (totalSeconds > 0) seekTo(clamped * totalSeconds);
  };

  // Tap/drag along the waveform to scrub (docs/17 §1) — only meaningful
  // once this note is the one currently loaded; scrubbing a not-yet-
  // playing note starts it from that position instead of no-oping.
  const scrubResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          if (barsWidth <= 0) return;
          if (!isThisPlaying) handleTogglePlay();
          seekToRatio(evt.nativeEvent.locationX / barsWidth);
        },
        onPanResponderMove: (evt) => {
          if (barsWidth <= 0) return;
          seekToRatio(evt.nativeEvent.locationX / barsWidth);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [barsWidth, isThisPlaying, message.id, mediaUrl.data, decryptedLocalUri, isDecrypting],
  );

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 220 }}>
      <Pressable
        onPress={handleTogglePlay}
        disabled={!mediaUrl.data || isDecrypting || isUnavailable}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isOwn ? 'rgba(255,255,255,0.2)' : colors.bgSurface,
        }}
      >
        <Ionicons
          name={isDecrypting ? 'hourglass-outline' : isThisPlaying && isPlaying ? 'pause' : 'play'}
          size={18}
          color={isOwn ? colors.textInverse : colors.textPrimary}
        />
      </Pressable>

      <View style={{ flex: 1, gap: 2 }}>
        <View
          {...scrubResponder.panHandlers}
          onLayout={handleBarsLayout}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            height: BAR_MAX_HEIGHT,
            gap: BAR_GAP,
          }}
        >
          {samples.length > 0 ? (
            samples.map((sample, i) => {
              const played = samples.length > 1 ? i / (samples.length - 1) <= progressRatio : false;
              const height = Math.max(BAR_MIN_HEIGHT, Math.round((sample / 100) * BAR_MAX_HEIGHT));
              return (
                <View
                  key={i}
                  style={{
                    width: BAR_WIDTH,
                    height,
                    borderRadius: BAR_WIDTH / 2,
                    backgroundColor: played
                      ? isOwn
                        ? colors.textInverse
                        : colors.brandPrimary
                      : isOwn
                        ? 'rgba(255,255,255,0.45)'
                        : colors.borderSubtle,
                  }}
                />
              );
            })
          ) : (
            // A note sent before waveform_samples existed, or one that
            // simply had none captured — a flat bar reads as "audio, no
            // detail" rather than pretending there's real shape data.
            <View
              style={{
                flex: 1,
                height: 3,
                borderRadius: 1.5,
                backgroundColor: isOwn ? 'rgba(255,255,255,0.45)' : colors.borderSubtle,
              }}
            />
          )}
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text
            variant="caption"
            color={isOwn ? undefined : 'secondary'}
            style={isOwn ? { color: 'rgba(255,255,255,0.75)' } : undefined}
          >
            {isUnavailable
              ? 'Media unavailable'
              : formatDuration(isThisPlaying ? elapsedSeconds : totalSeconds)}
          </Text>
          {isThisPlaying ? (
            <Pressable onPress={cycleRate} hitSlop={8}>
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={isOwn ? { color: 'rgba(255,255,255,0.75)' } : undefined}
              >
                {RATE_LABELS[rate]}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {!isOwn && !message.audio_played_at ? (
        <View
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brandPrimary }}
        />
      ) : null}
    </View>
  );
}

/** Auto-advance (docs/17 §1/§7) — when a voice note finishes on its own,
 * start the next consecutive audio message further down the same
 * thread. A thin behavior on top of the shared player: no new server
 * call, purely client-side sequencing over whatever's already loaded.
 * Call once, near the top of the thread screen (which already owns the
 * loaded `messages` array `usePlaybackStore` itself has no reason to
 * know about). */
export function useVoiceNoteAutoAdvance(messages: Message[] | undefined) {
  const justFinishedMessageId = usePlaybackStore((s) => s.justFinishedMessageId);
  const clearJustFinished = usePlaybackStore((s) => s.clearJustFinished);
  const toggle = usePlaybackStore((s) => s.toggle);

  useEffect(() => {
    if (!justFinishedMessageId || !messages) return;
    clearJustFinished();

    const finishedIndex = messages.findIndex((m) => m.id === justFinishedMessageId);
    if (finishedIndex === -1) return;

    const next = messages
      .slice(finishedIndex + 1)
      .find((m) => m.media_type === 'audio' && !m.deleted_for_everyone);
    if (!next?.media_path) return;

    // The next note's signed URL isn't necessarily resolved yet (bubbles
    // resolve their own via useChatMediaUrl) — re-signing here directly
    // is simpler than threading a resolved-URL cache up from every bubble
    // just for this one, infrequent case.
    void resolveChatMediaUrlOnce(next.media_path).then((url) => {
      if (url) toggle(next.id, url);
    });
  }, [justFinishedMessageId, messages, clearJustFinished, toggle]);
}

/** One-shot signed-URL fetch for auto-advance — same bucket/path
 * contract `useChatMediaUrl` uses, just not a hook (this runs from
 * inside an effect, not a component's render). */
async function resolveChatMediaUrlOnce(mediaPath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('chat-media')
    .createSignedUrl(mediaPath, 3600);
  if (error) {
    console.error('useVoiceNoteAutoAdvance: failed to resolve next note URL:', error.message);
    return null;
  }
  return data.signedUrl;
}
