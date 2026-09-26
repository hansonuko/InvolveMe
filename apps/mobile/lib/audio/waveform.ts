// Real (not decorative) waveform generation, client-side
// (docs/17-VOICE-NOTES-SCOPING.md §5) — pure functions, no expo-audio
// dependency, so these are trivially unit-testable and reused by both the
// recorder (live sampling while recording) and, indirectly, by the bubble
// (rendering whatever array the server handed back).

/** expo-audio's recorder metering (`RecorderState.metering`) is a dBFS
 * value — 0 is the loudest possible sample, more negative is quieter, with
 * silence approaching (but rarely exactly reaching) -160. In practice,
 * normal speech recorded on a phone mic rarely drops below about -60dB
 * even in quiet rooms, so clamping the floor there (rather than the
 * theoretical -160) is what keeps a real voice note's bars looking
 * "alive" instead of pinned near zero the whole time — a floor tuned for
 * how this actually looks on a real recording, not just numerically
 * correct against the raw dB range. */
const METERING_FLOOR_DB = -60;
const METERING_CEILING_DB = 0;

/** Maps one live metering reading to the 0-100 range
 * `messages.waveform_samples` stores (`smallint[]`, DB-checked 0-100 —
 * see 20260926110000_chat_audio_messages_pipeline.sql). */
export function normalizeMetering(db: number): number {
  const clamped = Math.max(METERING_FLOOR_DB, Math.min(METERING_CEILING_DB, db));
  const ratio = (clamped - METERING_FLOOR_DB) / (METERING_CEILING_DB - METERING_FLOOR_DB);
  return Math.round(ratio * 100);
}

/** A recording of any length ends up with one raw sample per poll
 * interval (docs/17 §5 — ~60-100ms) — a 5-minute note at 80ms would be
 * ~3750 samples, far past the server's own 64-element cap. Downsamples
 * to at most `targetBuckets` by averaging equal-sized chunks, preserving
 * the recording's overall shape rather than just truncating its tail. */
export function downsampleWaveform(rawSamples: number[], targetBuckets = 48): number[] {
  if (rawSamples.length === 0) return [];
  if (rawSamples.length <= targetBuckets) return rawSamples;

  const bucketed: number[] = [];
  const bucketSize = rawSamples.length / targetBuckets;
  for (let i = 0; i < targetBuckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    const slice = rawSamples.slice(start, end);
    const average = slice.reduce((sum, v) => sum + v, 0) / slice.length;
    bucketed.push(Math.round(average));
  }
  return bucketed;
}
