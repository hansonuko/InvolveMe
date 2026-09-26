import { createAudioPlayer, setAudioModeAsync, type AudioStatus } from 'expo-audio';
import { create } from 'zustand';

// One-global-player invariant (docs/17-VOICE-NOTES-SCOPING.md §7) — a
// single module-scope `AudioPlayer`, not one instance improvised per
// bubble, so starting note B reliably stops note A. Created via
// `createAudioPlayer` (the non-hook variant), not `useAudioPlayer`: a hook
// ties the player's lifecycle to whichever component calls it, which is
// exactly the "one per bubble" shape this must avoid. This instance lives
// for the app's lifetime and is never `.remove()`-d, the same posture the
// Supabase client singleton already takes.
const player = createAudioPlayer(null, { updateInterval: 200 });

// iOS: voice notes should audibly play even with the physical silent
// switch on, the same behavior every real media/messaging app uses
// (docs/17 §7) — `playsInSilentMode` is expo-audio's equivalent of the
// old `AVAudioSession` `playback` (not `ambient`) category.
// `mixWithOthers` rather than `doNotMix`: a voice note playing shouldn't
// forcibly duck/stop whatever else (e.g. music) the user already had
// going, matching WhatsApp's own non-exclusive playback behavior.
void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(
  (e) => {
    console.error('playbackStore: setAudioModeAsync failed:', e);
  },
);

const PLAYBACK_RATES = [1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

interface PlaybackState {
  playingMessageId: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  rate: PlaybackRate;
  /** Set exactly once when a note finishes on its own (not on a manual
   * pause) — auto-advance (thread/[id].tsx) consumes this once, via
   * `clearJustFinished`, to start the next audio message in the thread.
   * Never set on a manual pause/stop, since those aren't "finished". */
  justFinishedMessageId: string | null;
  /** Tap-to-play/pause: starting a *different* note always restarts it
   * from position 0 (matching WhatsApp — reopening a voice note doesn't
   * resume mid-way through); tapping the note already loaded toggles
   * play/pause in place. */
  toggle: (messageId: string, uri: string) => void;
  seekTo: (seconds: number) => void;
  /** Cycles 1x -> 1.5x -> 2x -> 1x (docs/17 §1) — applies to whatever's
   * currently loaded, and the new rate carries forward to the next note
   * played too (matching WhatsApp: the speed choice persists across
   * notes in a session, not reset every time). */
  cycleRate: () => void;
  stop: () => void;
  clearJustFinished: () => void;
}

// The `AudioStatus` event carries no concept of "which chat message this
// is" (expo-audio has no idea messages exist) — tracked here, alongside
// the player, updated only by `toggle`/`stop` below.
let loadedMessageId: string | null = null;

export const usePlaybackStore = create<PlaybackState>((set, get) => {
  player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
    set({
      currentTime: status.currentTime,
      duration: status.duration,
      isPlaying: status.playing,
      ...(status.didJustFinish
        ? { playingMessageId: null, justFinishedMessageId: loadedMessageId }
        : {}),
    });
  });

  return {
    playingMessageId: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    rate: 1,
    justFinishedMessageId: null,

    toggle: (messageId, uri) => {
      const state = get();
      if (state.playingMessageId === messageId) {
        if (state.isPlaying) {
          player.pause();
        } else {
          player.play();
        }
        return;
      }

      loadedMessageId = messageId;
      player.replace(uri);
      player.setPlaybackRate(state.rate);
      player.play();
      set({ playingMessageId: messageId, currentTime: 0, justFinishedMessageId: null });
    },

    seekTo: (seconds) => {
      void player.seekTo(seconds);
    },

    cycleRate: () => {
      set((state) => {
        const currentIndex = PLAYBACK_RATES.indexOf(state.rate);
        const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length];
        player.setPlaybackRate(nextRate);
        return { rate: nextRate };
      });
    },

    stop: () => {
      player.pause();
      loadedMessageId = null;
      set({ playingMessageId: null, isPlaying: false });
    },

    clearJustFinished: () => set({ justFinishedMessageId: null }),
  };
});
