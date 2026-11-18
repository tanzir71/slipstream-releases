// Background music (ticket S-04). Pure: no DOM, no media.
//
// A project has at most one music bed, stored as `edit.music` / plan `music`. It plays on the OUTPUT timeline
// (after cuts), so cutting words never chops the song: it starts at output 0 (plus `start`), loops if it's
// shorter than the video, fades in and out, and ducks under speech so the voice stays clear. The preview, both
// web exporters, the engine and the macOS app all use these numbers.

import { srcToOut } from './edl.js';

export const MUSIC_DEFAULTS = Object.freeze({
  start: 0,        // output seconds where the music begins
  trimIn: 0,       // seconds into the song to start from
  volume: 0.22,    // linear gain relative to the voice (≈ −13 dB)
  loop: true,
  fadeIn: 1,       // seconds
  fadeOut: 2.5,    // seconds, ending at the end of the video
  duck: true,      // lower under speech
  duckLevel: 0.35, // multiplier while someone talks (≈ −9 dB more)
  duckAttack: 0.25,
  duckRelease: 0.6,
});

/** Music settings with defaults filled in (does not modify `music`). */
export function musicSettings(music) {
  return { ...MUSIC_DEFAULTS, ...(music || {}) };
}

/**
 * Speech on the output timeline: kept words mapped through the cuts, with gaps shorter than `gap` seconds merged
 * so the music doesn't pump between words. Returns sorted [{ start, end }] in output seconds.
 */
export function speechIntervals(words, kept, gap = 0.5) {
  const out = [];
  for (const w of words || []) {
    if (!w || w.deleted || !(w.end > w.start)) continue;
    const s = srcToOut(kept, w.start), e = srcToOut(kept, w.end);
    if (e - s <= 0.01) continue;
    const last = out[out.length - 1];
    if (last && s - last.end <= gap) last.end = Math.max(last.end, e);
    else out.push({ start: s, end: e });
  }
  return out;
}

/** 0..1: how far the music is ducked at output time t (smooth attack before speech and release after it). */
export function duckAmount(t, intervals, attack = MUSIC_DEFAULTS.duckAttack, release = MUSIC_DEFAULTS.duckRelease) {
  let k = 0;
  // Intervals are sorted; only the neighbours of t matter.
  let lo = 0, hi = intervals.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (intervals[mid].end < t - release) lo = mid + 1; else hi = mid - 1; }
  for (let i = lo; i < intervals.length; i++) {
    const r = intervals[i];
    if (r.start - attack > t) break;
    if (t >= r.start && t <= r.end) return 1;
    if (t < r.start) k = Math.max(k, smooth(1 - (r.start - t) / attack));
    else k = Math.max(k, smooth(1 - (t - r.end) / release));
  }
  return k;
}

const smooth = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

/**
 * Linear music gain at output time t. `total` is the output duration (the fade-out ends there).
 * Returns 0 before `start`.
 */
export function musicGainAt(t, music, total, intervals = []) {
  const m = musicSettings(music);
  if (t < m.start || t > total) return 0;
  let g = Math.max(0, m.volume);
  const into = t - m.start;
  if (m.fadeIn > 0 && into < m.fadeIn) g *= into / m.fadeIn;
  const left = total - t;
  if (m.fadeOut > 0 && left < m.fadeOut) g *= Math.max(0, left / m.fadeOut);
  if (m.duck && intervals.length) g *= 1 - duckAmount(t, intervals, m.duckAttack, m.duckRelease) * (1 - Math.max(0, Math.min(1, m.duckLevel)));
  return g;
}

/**
 * Where in the song output time t falls: seconds into the audio file, or null when silent (before `start`, or
 * after the song ends without looping). `length` is the song's duration in seconds.
 */
export function musicSourceTime(t, music, length) {
  const m = musicSettings(music);
  if (!(length > 0) || t < m.start) return null;
  const span = Math.max(0.05, length - Math.max(0, Math.min(length - 0.05, m.trimIn)));
  const into = t - m.start;
  if (!m.loop && into >= span) return null;
  return Math.max(0, Math.min(length - 0.05, m.trimIn)) + (m.loop ? into % span : into);
}

/** Gain values every `step` seconds over [0, total], for Web Audio `setValueCurveAtTime` and FFmpeg expressions. */
export function musicGainCurve(music, total, intervals = [], step = 0.05) {
  const n = Math.max(2, Math.ceil(total / step) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = musicGainAt(Math.min(total, i * step), music, total, intervals);
  return out;
}
