// Real end-to-end voice notes, client recorder
// (docs/17-VOICE-NOTES-SCOPING.md §1/§4/§10) — hold-to-record, slide-left-
// to-cancel, slide-up-to-lock, matching WhatsApp's own composer mic
// interaction. A single, deliberately isolated component (§4's own
// recommendation), one instance mounted once in the composer, never
// per-list-row.
//
// **Why PanResponder (react-native core) for the drag tracking, not
// react-native-gesture-handler's `Gesture.Pan()`** — despite §4 naming
// that as the "recommended" build: this codebase has exactly one prior
// instance of combining that library's Gesture API with a Reanimated
// shared value — swipe-to-reply, reverted the same day it shipped after
// a real, confirmed "Maximum update depth exceeded" production crash (see
// thread/[id].tsx's own header comment on `MessageBubble`, right above
// it, for the full postmortem). §4's claim that "StoryViewer's
// hold-to-pause" is a second, already-proven-safe use of that same
// combination does NOT hold up — checked live: StoryViewer.tsx's
// hold-to-pause is plain `Pressable` onPressIn/onPressOut, not
// `Gesture.Pan()` at all. That leaves this codebase with ZERO working
// precedent for `Gesture.Pan()`, only one crashed one — a materially
// different risk picture than §4 assumed. `PanResponder` (React Native's
// own long-stable, non-gesture-handler drag-tracking API) delivers the
// identical hold/slide/cancel/lock interaction WhatsApp itself has no
// particular library requirement for, while avoiding the one specific
// ingredient this app has already crashed on. Reanimated's
// `useSharedValue`/`Animated.View` (this file's actual animation layer,
// below) stays exactly as this codebase already uses it successfully
// elsewhere (Ring.tsx, AnimatedSplash.tsx) — that half of the prior
// incident's combination was never the problem; only `Gesture.Pan()` is
// avoided here. This is a deliberate deviation from §4's literal wording,
// in service of its actual intent (a correct, non-crashing gesture) and
// its own stated bar ("verify it live on a real device") — which this
// environment (no attached device/emulator) genuinely cannot do;
// choosing the lower-risk primitive here is the responsible call given
// that gap, not a shortcut. Real-device confirmation is still owed
// before this is considered fully done — flagged, not silently assumed.
//
// State machine: idle -> recording -> (locked | cancelling) -> idle, with
// locked able to detour through preview -> idle first (listen back before
// actually sending, added by explicit request to match WhatsApp's
// locked-recording toolbar). `phaseRef` mirrors `phase` state for the
// PanResponder callbacks (which close over stale state otherwise — a real,
// well-known RN gotcha, not paranoia) without needing any per-callback
// memoization trick.

import { Ionicons } from '@expo/vector-icons';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, PanResponder, Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { withAppLockSuppressed } from '@/lib/appLock';
import { usePlaybackStore } from '@/lib/audio/playbackStore';
import { downsampleWaveform, normalizeMetering } from '@/lib/audio/waveform';
import { useTheme } from '@/theme';
import { Text } from '@/components/ui/Text';

const CANCEL_THRESHOLD_PX = -80;
const LOCK_THRESHOLD_PX = -80;
const METERING_POLL_MS = 100;
const MIN_SENDABLE_SECONDS = 1;
const PREVIEW_BAR_WIDTH = 3;
const PREVIEW_BAR_GAP = 2;
const PREVIEW_BAR_MAX_HEIGHT = 28;
const PREVIEW_BAR_MIN_HEIGHT = 3;
// The shared player (playbackStore.ts) is keyed by message id everywhere
// else — a not-yet-sent recording has no message id yet, so this sentinel
// fills that slot. Never collides with a real message id (those are
// UUIDs), so `toggle`'s own "starting a different note always restarts
// from 0" behavior can never misfire against a real sent note by mistake.
const PREVIEW_PLAYBACK_ID = '__voice_note_preview__';

export type RecorderPhase = 'idle' | 'recording' | 'locked' | 'cancelling' | 'preview';

function formatTimer(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const RECORDING_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

export interface VoiceRecorderButtonProps {
  onSend: (uri: string, durationSeconds: number, waveformSamples: number[]) => void;
  disabled?: boolean;
  /** The composer (thread/[id].tsx) needs to know when this leaves 'idle'
   * so it can hide the text input/camera/send button and give this
   * component the full composer row — WhatsApp's own behavior once a
   * recording actually starts, not just while it's the idle mic icon. */
  onPhaseChange?: (phase: RecorderPhase) => void;
}

export function VoiceRecorderButton({ onSend, disabled, onPhaseChange }: VoiceRecorderButtonProps) {
  'use no memo';
  const { colors, spacing, radius } = useTheme();
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, METERING_POLL_MS);

  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const phaseRef = useRef<RecorderPhase>('idle');
  const rawSamplesRef = useRef<number[]>([]);
  const startedAtRef = useRef<number>(0);
  // The just-stopped recording, staged for playback review before it's
  // actually sent (docs/17's own recorder never had this step — added by
  // explicit request to match WhatsApp's locked-recording toolbar, which
  // lets you listen back before committing to send, not just trash-or-send
  // blind). `null` outside the 'preview' phase.
  const [preview, setPreview] = useState<{
    uri: string;
    durationSeconds: number;
    waveformSamples: number[];
  } | null>(null);

  const previewPlayingMessageId = usePlaybackStore((s) => s.playingMessageId);
  const previewIsPlaying = usePlaybackStore((s) => s.isPlaying);
  const previewCurrentTime = usePlaybackStore((s) => s.currentTime);
  const previewDuration = usePlaybackStore((s) => s.duration);
  const togglePreviewPlayback = usePlaybackStore((s) => s.toggle);
  const isPreviewThisPlaying = previewPlayingMessageId === PREVIEW_PLAYBACK_ID;

  const translateX = useSharedValue(0);
  const cancelHintOpacity = useSharedValue(1);
  const animatedHintStyle = useAnimatedStyle(() => ({
    opacity: cancelHintOpacity.value,
    transform: [{ translateX: translateX.value }],
  }));

  const setPhaseBoth = useCallback(
    (next: RecorderPhase) => {
      phaseRef.current = next;
      setPhase(next);
      onPhaseChange?.(next);
    },
    [onPhaseChange],
  );

  // Reanimated shared-value writes from a plain event-handler closure
  // (not literally inside a `useEffect`, unlike this codebase's other
  // Reanimated usage — Ring.tsx) trip the React Compiler ESLint rules
  // below, which can't statically prove this only ever runs post-render.
  // It does — `resetVisuals` is only ever called from `finishRecording`
  // (itself only invoked from PanResponder callbacks/button presses) —
  // this is the standard, correct way to drive a shared value from an
  // imperative event, same as every Reanimated app not built exclusively
  // around `useEffect`-triggered animations.
  const resetVisuals = useCallback(() => {
    // eslint-disable-next-line react-hooks/immutability
    translateX.value = 0;
    // eslint-disable-next-line react-hooks/immutability
    cancelHintOpacity.value = 1;
  }, [translateX, cancelHintOpacity]);

  // Accumulates the live metering reading into this recording's own
  // sample history (docs/17 §5) — a plain effect keyed on the polling
  // hook's own state, not a second independent timer duplicating it.
  useEffect(() => {
    if (phaseRef.current !== 'recording' && phaseRef.current !== 'locked') return;
    if (typeof recorderState.metering === 'number') {
      rawSamplesRef.current.push(normalizeMetering(recorderState.metering));
    }
  }, [recorderState.metering, recorderState.durationMillis]);

  const beginRecording = useCallback(async () => {
    if (disabled || phaseRef.current !== 'idle') return;

    const existing = await getRecordingPermissionsAsync();
    let granted = existing.granted;
    if (!granted) {
      const requested = await withAppLockSuppressed(() => requestRecordingPermissionsAsync());
      granted = requested.granted;
    }
    if (!granted) {
      Alert.alert(
        'Microphone access needed',
        "Turn on microphone access in your phone's Settings app to record voice messages.",
      );
      return;
    }

    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'mixWithOthers',
      });
      rawSamplesRef.current = [];
      startedAtRef.current = Date.now();
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhaseBoth('recording');
    } catch (e) {
      console.error('VoiceRecorderButton: failed to start recording:', e);
      setPhaseBoth('idle');
    }
  }, [disabled, recorder, setPhaseBoth]);

  const finishRecording = useCallback(
    async (outcome: 'send' | 'discard' | 'preview') => {
      const wasActive = phaseRef.current === 'recording' || phaseRef.current === 'locked';
      // 'preview' deliberately does NOT flip to 'idle' here — that would
      // flash the idle mic icon for a frame before the preview UI replaces
      // it (recorder.stop() below is async). It goes straight to 'preview'
      // once the stopped recording's real uri/duration/waveform are known.
      if (outcome !== 'preview') {
        setPhaseBoth('idle');
        resetVisuals();
      }
      if (!wasActive) return;

      try {
        await recorder.stop();
      } catch (e) {
        console.error('VoiceRecorderButton: failed to stop recording:', e);
        return;
      } finally {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: 'mixWithOthers',
        }).catch(() => {});
      }

      const uri = recorder.uri;
      const durationSeconds = Math.round((Date.now() - startedAtRef.current) / 1000);
      const waveformSamples = downsampleWaveform(rawSamplesRef.current);
      rawSamplesRef.current = [];

      if (outcome === 'discard' || !uri || durationSeconds < MIN_SENDABLE_SECONDS) {
        // A too-short recording can't be previewed either — same floor
        // send already enforces, applied consistently to preview.
        if (outcome === 'preview') {
          setPhaseBoth('idle');
          resetVisuals();
        }
        return; // no message, no charge, no upload — docs/17 §1
      }

      if (outcome === 'preview') {
        setPreview({ uri, durationSeconds, waveformSamples });
        setPhaseBoth('preview');
        return;
      }

      onSend(uri, durationSeconds, waveformSamples);
    },
    [recorder, onSend, resetVisuals, setPhaseBoth],
  );

  const discardPreview = useCallback(() => {
    usePlaybackStore.getState().stop();
    setPreview(null);
    setPhaseBoth('idle');
  }, [setPhaseBoth]);

  const sendPreview = useCallback(() => {
    if (!preview) return;
    usePlaybackStore.getState().stop();
    const { uri, durationSeconds, waveformSamples } = preview;
    setPreview(null);
    setPhaseBoth('idle');
    onSend(uri, durationSeconds, waveformSamples);
  }, [preview, onSend, setPhaseBoth]);

  // Safety net, not the primary cleanup path (discard/send above already
  // stop it): if this component unmounts entirely mid-preview (the thread
  // screen closes while reviewing a not-yet-sent note), don't leave the
  // one shared player running against a local file nothing references
  // anymore.
  useEffect(() => {
    return () => {
      if (phaseRef.current === 'preview') usePlaybackStore.getState().stop();
    };
  }, []);

  // Memoized once (empty deps) — this component mounts exactly once in
  // the composer, never per list row, so there's no risk of the
  // per-render-recreation hazard this codebase has already hit once with
  // a different gesture API (see this file's own header comment). The
  // callbacks below read `phaseRef`/refs rather than closing over state,
  // so they stay correct despite never being recreated — PanResponder's
  // whole design requires exactly this (every real-world example reads
  // fresh state via refs from callbacks captured once), which is also
  // exactly what trips the React Compiler ESLint rule below: it can't
  // statically prove a ref read inside a function-passed-to-useMemo only
  // ever executes post-render (asynchronously, in response to a real
  // touch), not during the render call itself. It doesn't run during
  // render here — `PanResponder.create`'s handlers are plain callbacks,
  // invoked later by the native responder system, never synchronously.
  const panResponder = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          void beginRecording();
        },
        onPanResponderMove: (_evt, gesture) => {
          if (phaseRef.current !== 'recording' && phaseRef.current !== 'cancelling') return;

          if (gesture.dy < LOCK_THRESHOLD_PX) {
            setPhaseBoth('locked');
            resetVisuals();
            return;
          }

          const clampedX = Math.min(0, gesture.dx);
          // eslint-disable-next-line react-hooks/immutability
          translateX.value = clampedX;
          // eslint-disable-next-line react-hooks/immutability
          cancelHintOpacity.value = Math.max(0, 1 + clampedX / 60);

          if (clampedX < CANCEL_THRESHOLD_PX) {
            if (phaseRef.current !== 'cancelling') setPhaseBoth('cancelling');
          } else if (phaseRef.current === 'cancelling') {
            setPhaseBoth('recording');
          }
        },
        onPanResponderRelease: () => {
          if (phaseRef.current === 'locked') return; // hands-free — the locked toolbar finishes it
          void finishRecording(phaseRef.current === 'cancelling' ? 'discard' : 'send');
        },
        onPanResponderTerminate: () => {
          if (phaseRef.current === 'locked') return;
          void finishRecording('discard');
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const elapsedSeconds = Math.floor(recorderState.durationMillis / 1000);
  const meterLevel =
    typeof recorderState.metering === 'number' ? normalizeMetering(recorderState.metering) : 0;

  if (phase === 'idle') {
    return (
      <View {...panResponder.panHandlers} style={{ paddingBottom: 6 }}>
        <Ionicons
          name="mic-outline"
          size={24}
          color={disabled ? colors.textTertiary : colors.textSecondary}
        />
      </View>
    );
  }

  if (phase === 'locked') {
    return (
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.sm,
        }}
      >
        <Pressable onPress={() => void finishRecording('discard')} hitSlop={8}>
          <Ionicons name="trash-outline" size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger }} />
          <Text variant="body">{formatTimer(elapsedSeconds)}</Text>
          <AmplitudeBars level={meterLevel} color={colors.textSecondary} />
        </View>
        {/* Stops recording and shows a real playback preview instead of
         * sending outright — WhatsApp's own locked-recording toolbar lets
         * you listen back before committing, not just trash-or-send blind. */}
        <Pressable
          onPress={() => void finishRecording('preview')}
          hitSlop={8}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bgSurfaceAlt,
          }}
        >
          <Ionicons name="pause" size={18} color={colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={() => void finishRecording('send')}
          hitSlop={8}
          style={{
            backgroundColor: colors.brandPrimary,
            borderRadius: radius.pill,
            width: 40,
            height: 40,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="send" size={18} color={colors.textInverse} />
        </Pressable>
      </View>
    );
  }

  if (phase === 'preview' && preview) {
    const previewElapsed = isPreviewThisPlaying ? previewCurrentTime : 0;
    const previewTotal =
      isPreviewThisPlaying && previewDuration > 0 ? previewDuration : preview.durationSeconds;
    const previewProgress = previewTotal > 0 ? Math.min(1, previewElapsed / previewTotal) : 0;
    const samples = preview.waveformSamples;

    return (
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Pressable onPress={discardPreview} hitSlop={8}>
          <Ionicons name="trash-outline" size={22} color={colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={() => togglePreviewPlayback(PREVIEW_PLAYBACK_ID, preview.uri)}
          hitSlop={8}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bgSurfaceAlt,
          }}
        >
          <Ionicons
            name={isPreviewThisPlaying && previewIsPlaying ? 'pause' : 'play'}
            size={18}
            color={colors.textPrimary}
          />
        </Pressable>
        <View style={{ flex: 1, gap: 2 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              height: PREVIEW_BAR_MAX_HEIGHT,
              gap: PREVIEW_BAR_GAP,
            }}
          >
            {samples.length > 0 ? (
              samples.map((sample, i) => {
                const played =
                  samples.length > 1 ? i / (samples.length - 1) <= previewProgress : false;
                const height = Math.max(
                  PREVIEW_BAR_MIN_HEIGHT,
                  Math.round((sample / 100) * PREVIEW_BAR_MAX_HEIGHT),
                );
                return (
                  <View
                    key={i}
                    style={{
                      width: PREVIEW_BAR_WIDTH,
                      height,
                      borderRadius: PREVIEW_BAR_WIDTH / 2,
                      backgroundColor: played ? colors.brandPrimary : colors.borderSubtle,
                    }}
                  />
                );
              })
            ) : (
              <View
                style={{
                  flex: 1,
                  height: 3,
                  borderRadius: 1.5,
                  backgroundColor: colors.borderSubtle,
                }}
              />
            )}
          </View>
          <Text variant="caption" color="secondary">
            {formatTimer(Math.floor(isPreviewThisPlaying ? previewElapsed : previewTotal))}
          </Text>
        </View>
        <Pressable
          onPress={sendPreview}
          hitSlop={8}
          style={{
            backgroundColor: colors.brandPrimary,
            borderRadius: radius.pill,
            width: 40,
            height: 40,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="send" size={18} color={colors.textInverse} />
        </Pressable>
      </View>
    );
  }

  // recording | cancelling — held state, hands still on the mic.
  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger }} />
      <Text variant="body">{formatTimer(elapsedSeconds)}</Text>
      <AmplitudeBars level={meterLevel} color={colors.textSecondary} />
      <Animated.View style={[{ flex: 1, alignItems: 'flex-end' }, animatedHintStyle]}>
        <Text variant="caption" color={phase === 'cancelling' ? 'danger' : 'secondary'}>
          {phase === 'cancelling' ? 'Release to cancel' : '◁ Slide to cancel · ▲ Slide up to lock'}
        </Text>
      </Animated.View>
      <View {...panResponder.panHandlers} style={{ paddingBottom: 6 }}>
        <Ionicons name="mic" size={24} color={colors.brandPrimary} />
      </View>
    </View>
  );
}

/** A small fixed set of bars reacting to the live metering level — a real
 * signal (docs/17 §1's "reacting to real mic input", not a looping
 * decorative animation), just a coarser visual than the sent bubble's own
 * full waveform (`VoiceMessageBubble`), which has an actual sample array
 * to render precisely instead of one live scalar. */
function AmplitudeBars({ level, color }: { level: number; color: string }) {
  const bars = [0.4, 0.7, 1, 0.6, 0.3];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 16 }}>
      {bars.map((weight, i) => {
        const height = Math.max(3, Math.round(16 * weight * Math.max(0.15, level / 100)));
        return (
          <View key={i} style={{ width: 3, height, borderRadius: 1.5, backgroundColor: color }} />
        );
      })}
    </View>
  );
}
