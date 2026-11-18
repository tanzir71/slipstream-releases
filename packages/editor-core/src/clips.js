// Find clips v2 (ticket A-04): one explainable score from three local signals.
// - transcript: the hook / pace / filler / pause score from highlights.js
// - audio energy: how lively the delivery is compared with the rest of the recording (RMS of peaks)
// - screen activity: how much changes on screen (autozoom activity events per second)
// Pure: no DOM, no media. Tested in test/clips.test.mjs.

import { findHighlights } from './highlights.js';

function rms(peaks, a, b) {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i < Math.min(peaks.length, b); i++) { s += peaks[i] * peaks[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

/** Fraction of 1-second bins in [start,end) that saw on-screen change. */
export function activityRate(activity, start, end, { minArea = 0.0015 } = {}) {
  const secs = Math.max(1, Math.ceil(end - start));
  const hit = new Set();
  for (const e of activity || []) if (e.t >= start && e.t < end && !(e.area != null && e.area < minArea)) hit.add(Math.floor(e.t - start));
  return hit.size / secs;
}

/** Relative loudness of a range vs the whole recording (1 = average). */
export function energyRatio(peaks, peaksPerSec, start, end) {
  if (!peaks || !peaks.length) return 1;
  const all = rms(peaks, 0, peaks.length) || 1e-6;
  return rms(peaks, Math.floor(start * peaksPerSec), Math.ceil(end * peaksPerSec)) / all;
}

/**
 * Score clip candidates with transcript + audio + screen signals.
 * Returns up to `count` non-overlapping [{ start, end, score (0..100), title, reasons, signals }].
 */
export function scoreClips(words, { peaks = null, peaksPerSec = 100, activity = null, minDur = 12, maxDur = 60, count = 5, weights = { text: 0.6, audio: 0.2, screen: 0.2 } } = {}) {
  const pool = findHighlights(words, { minDur, maxDur, count: Math.max(count * 6, 24) });
  if (!pool.length) return [];
  const anyActivity = !!(activity && activity.length);
  const scored = pool.map((c) => {
    const text = (c.score - 55) / 44; // findHighlights normalises to 55..99
    const energy = energyRatio(peaks, peaksPerSec, c.start, c.end);
    const audio = Math.max(0, Math.min(1, (energy - 0.7) / 0.6));
    const rate = anyActivity ? activityRate(activity, c.start, c.end) : 0;
    const screen = Math.max(0, Math.min(1, rate / 0.5));
    const w = anyActivity ? weights : { text: weights.text + weights.screen * 0.5, audio: weights.audio + weights.screen * 0.5, screen: 0 };
    const total = text * w.text + audio * w.audio + screen * w.screen;
    const reasons = [...c.reasons];
    if (energy > 1.15) reasons.unshift('lively delivery');
    if (anyActivity && rate > 0.35) reasons.unshift('lots happening on screen');
    if (anyActivity && rate < 0.05) reasons.push('static screen — try camera layout');
    return { ...c, total, reasons: [...new Set(reasons)].slice(0, 4), signals: { text: round(text), audio: round(audio), screen: round(screen), energy: round(energy), activity: round(rate) } };
  });
  scored.sort((a, b) => b.total - a.total);
  const picked = [];
  for (const c of scored) {
    if (picked.length >= count) break;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    picked.push(c);
  }
  const max = Math.max(...picked.map((p) => p.total)), min = Math.min(...picked.map((p) => p.total));
  return picked.map(({ total, ...p }) => ({ ...p, score: Math.round(60 + 39 * (max - min > 1e-9 ? (total - min) / (max - min) : 1)) }));
}

const round = (x) => Math.round(x * 100) / 100;

/**
 * Thumbnail quality of a luminance frame (A-05): sharp (variance of the Laplacian), contrasty, neither
 * too dark nor blown out. Returns { score, sharpness, contrast, brightness } with score in 0..1.
 */
export function frameQuality(lum, w, h) {
  let sum = 0, sum2 = 0, lap = 0, lap2 = 0, n = 0;
  for (let i = 0; i < lum.length; i++) { sum += lum[i]; sum2 += lum[i] * lum[i]; }
  const count = Math.max(1, lum.length);
  const mean = sum / count;
  const contrast = Math.sqrt(Math.max(0, sum2 / count - mean * mean)) / 128;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w];
      lap += v; lap2 += v * v; n++;
    }
  }
  const lm = lap / Math.max(1, n);
  const sharpness = Math.min(1, Math.sqrt(Math.max(0, lap2 / Math.max(1, n) - lm * lm)) / 60);
  const brightness = mean / 255;
  const exposure = 1 - Math.min(1, Math.abs(brightness - 0.5) / 0.45);
  return { score: round(0.5 * sharpness + 0.3 * Math.min(1, contrast) + 0.2 * exposure), sharpness: round(sharpness), contrast: round(contrast), brightness: round(brightness) };
}

/** Pick `count` frames with the best quality, at least `gap` seconds apart. frames = [{ t, score }]. */
export function pickThumbnails(frames, { count = 3, gap = 4 } = {}) {
  const out = [];
  for (const f of [...frames].sort((a, b) => b.score - a.score)) {
    if (out.length >= count) break;
    if (out.some((o) => Math.abs(o.t - f.t) < gap)) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.t - b.t);
}
