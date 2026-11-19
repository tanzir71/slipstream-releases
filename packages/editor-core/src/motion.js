// Motion in a clip, from sampled luma (Auto edit, ticket AE-03). Pure: no DOM, no media decoding. The sampler worker
// (app/js/motion-worker.js) decodes each clip to 64×36 luma at 10 Hz and calls analyzeMotion(); results are cached by
// the asset's hash (motionCacheKey). The Swift and Rust ports re-implement this against test/parity/autoedit.json
// (section "motion"). Everything is integer arithmetic up to the energy values, so ports match exactly.
//
// Public API
//   MOTION_W = 64, MOTION_H = 36, MOTION_FPS = 10, MOTION_VERSION = 1
//   analyzeMotion(frames, opts?) -> MotionAnalysis                frames: Uint8Array luma (w·h each), one per 1/fps s
//   frameMotion(a, b, w, h, opts?) -> { energy, dx, dy, cx, cy, weight }   one frame pair (b after a)
//   findMoves(curve, opts?) -> Move[]                               moves ("visual beats") on a normalised curve
//   percentile(values, p) -> number                                 sorted[floor(p·(n−1))]
//   lumaFromRGBA(data, w, h) -> Uint8Array                          (r·77 + g·150 + b·29) >> 8, like media.js
//   motionCacheKey(hash, opts?) -> string                           'motion:v1:<hash>:64x36@10'
//
// Types
//   MotionAnalysis = {
//     version: 1, fps, w, h, duration (= frames / fps),
//     raw: number[]      energy per sample in luma levels (sample 0 is 0; sample i compares frame i with frame i−1),
//     scale: number      max(P95(raw), NOISE_FLOOR): raw / scale is the normalised curve,
//     curve: number[]    raw / scale (≈ 0..1, can exceed 1),
//     centroid: Array<[x, y, weight] | null>   where the subject motion is, 0..1 of the frame (null when too little),
//     moves: Move[]
//   }
//   Move = { i, t (s), peak (normalised), start (s), settle (s), strength (0..1, raw peak / STRONG_MOVE) }
//
// How it works
//   1. Camera motion: for each pair, the integer shift (dx, dy) in −3..3 that minimises the sum of absolute
//      differences over the inner region x ∈ [3, w−3), y ∈ [3, h−3) (candidates in order of |dx|+|dy|, then dy, then
//      dx; strict < keeps the first). A pan or handheld shake is followed, so it doesn't count as subject motion.
//   2. Residual r_p = |b[x, y] − a[x+dx, y+dy]| over the inner region; the frame's median residual m (histogram, the
//      lower middle for even counts) is subtracted: energy = Σ max(0, r_p − m) / count. Brightness changes and noise
//      that touch every pixel cancel.
//   3. Normalised per clip: curve = raw / max(P95(raw), NOISE_FLOOR).
//   4. Moves: local peaks (curve[i] > curve[i−1] and ≥ curve[i+1]) above 40 % of P95(curve) whose raw energy is at least
//      NOISE_FLOOR and which rise at least that 40 % above the higher of the minima within 1 s on either side (so a
//      noisy plateau isn't a string of moves), kept by height (ties: earlier) when ≥ 0.6 s from every kept move. A move starts at the first
//      sample of the run (backwards from the peak) staying ≥ 30 % of the peak, and settles at the first sample after
//      the peak that begins 0.3 s (3 samples) under 30 % of the peak (the clip's end if never).

export const MOTION_W = 64;
export const MOTION_H = 36;
export const MOTION_FPS = 10;
export const MOTION_VERSION = 1;
export const NOISE_FLOOR = 1;    // luma levels: below this mean residual nothing is moving
export const STRONG_MOVE = 8;    // luma levels: a move this strong (or more) has strength 1
const SEARCH = 3;
const MIN_CENTROID_WEIGHT = 0.25; // energy (luma levels) needed for a centroid

/** sorted[floor(p·(n−1))] of a copy (0 for an empty list). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = Array.from(values).sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
}

/** Luma bytes from RGBA pixels, (r·77 + g·150 + b·29) >> 8 (media.js uses the same weights). */
export function lumaFromRGBA(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let p = 0, q = 0; q < out.length; p += 4, q++) out[q] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  return out;
}

/** Cache key for a clip's motion analysis: changes when the algorithm version or sampling changes. */
export function motionCacheKey(hash, { w = MOTION_W, h = MOTION_H, fps = MOTION_FPS } = {}) {
  return `motion:v${MOTION_VERSION}:${hash}:${w}x${h}@${fps}`;
}

let SHIFTS = null;
function shifts() {
  if (SHIFTS) return SHIFTS;
  const out = [];
  for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) out.push([dx, dy]);
  out.sort((p, q) => (Math.abs(p[0]) + Math.abs(p[1])) - (Math.abs(q[0]) + Math.abs(q[1])) || p[1] - q[1] || p[0] - q[0]);
  SHIFTS = out;
  return out;
}

/**
 * Subject motion between frame a and the next frame b (Uint8Array luma, w·h). Returns the energy (luma levels), the
 * camera shift (dx, dy) and the motion centroid (cx, cy in 0..1, weight = energy) of the residual above the median.
 */
export function frameMotion(a, b, w, h) {
  const x0 = SEARCH, x1 = w - SEARCH, y0 = SEARCH, y1 = h - SEARCH;
  let best = Infinity, bdx = 0, bdy = 0;
  for (const [dx, dy] of shifts()) {
    let sad = 0;
    for (let y = y0; y < y1 && sad < best; y++) {
      const rb = y * w, ra = (y + dy) * w + dx;
      for (let x = x0; x < x1; x++) { const d = b[rb + x] - a[ra + x]; sad += d < 0 ? -d : d; }
    }
    if (sad < best) { best = sad; bdx = dx; bdy = dy; }
  }
  const hist = new Uint32Array(256);
  const count = (x1 - x0) * (y1 - y0);
  for (let y = y0; y < y1; y++) {
    const rb = y * w, ra = (y + bdy) * w + bdx;
    for (let x = x0; x < x1; x++) { const d = b[rb + x] - a[ra + x]; hist[d < 0 ? -d : d]++; }
  }
  // Median: the value at sorted index floor((count − 1) / 2).
  const target = Math.floor((count - 1) / 2);
  let med = 0;
  for (let acc = 0; med < 256; med++) { acc += hist[med]; if (acc > target) break; }
  let sum = 0, sx = 0, sy = 0;
  for (let y = y0; y < y1; y++) {
    const rb = y * w, ra = (y + bdy) * w + bdx;
    for (let x = x0; x < x1; x++) {
      let d = b[rb + x] - a[ra + x];
      if (d < 0) d = -d;
      const e = d - med;
      if (e > 0) { sum += e; sx += e * x; sy += e * y; }
    }
  }
  const energy = sum / count;
  return {
    energy, dx: bdx, dy: bdy,
    cx: sum > 0 ? (sx / sum + 0.5) / w : 0.5,
    cy: sum > 0 ? (sy / sum + 0.5) / h : 0.5,
    weight: energy,
  };
}

/**
 * Moves on a normalised curve (see the header, step 4). opts: { fps = 10, raw = null (raw energies, for the noise
 * floor), peakFrac = 0.4, minGap = 0.6, settleFrac = 0.3, settleHold = 0.3, scale = 1 }.
 */
export function findMoves(curve, { fps = MOTION_FPS, raw = null, scale = 1, peakFrac = 0.4, minGap = 0.6, settleFrac = 0.3, settleHold = 0.3, window = 1 } = {}) {
  const n = curve.length;
  const thr = peakFrac * percentile(curve, 0.95);
  const rawAt = (i) => (raw ? raw[i] : curve[i] * scale);
  const W = Math.max(1, Math.round(window * fps));
  const cands = [];
  for (let i = 1; i < n; i++) {
    if (!(curve[i] > curve[i - 1]) || (i + 1 < n && curve[i] < curve[i + 1])) continue;
    if (curve[i] < thr || rawAt(i) < NOISE_FLOOR) continue;
    // Prominence: the peak rises at least `thr` above the higher of the minima within `window` s on either side.
    let left = Infinity, right = Infinity;
    for (let j = Math.max(0, i - W); j <= i; j++) if (curve[j] < left) left = curve[j];
    for (let j = i; j <= Math.min(n - 1, i + W); j++) if (curve[j] < right) right = curve[j];
    if (curve[i] - Math.max(left, right) < thr) continue;
    cands.push(i);
  }
  cands.sort((p, q) => curve[q] - curve[p] || p - q);
  const gap = minGap * fps;
  const kept = [];
  for (const i of cands) if (kept.every((k) => Math.abs(k - i) >= gap - 1e-9)) kept.push(i);
  kept.sort((p, q) => p - q);
  const hold = Math.max(1, Math.round(settleHold * fps));
  return kept.map((i) => {
    const lim = settleFrac * curve[i];
    let s = i;
    while (s > 0 && curve[s - 1] >= lim) s--;
    let settle = n;
    for (let j = i + 1; j < n; j++) {
      let quiet = true;
      for (let k = j; k < Math.min(n, j + hold) && quiet; k++) if (curve[k] >= lim) quiet = false;
      if (quiet && j + hold <= n) { settle = j; break; }
    }
    return {
      i, t: i / fps, peak: curve[i], start: s / fps, settle: settle / fps,
      strength: Math.min(1, rawAt(i) / STRONG_MOVE),
    };
  });
}

/**
 * Motion analysis of a clip's sampled luma frames (see the header). opts: { w = 64, h = 36, fps = 10 }.
 * Values are rounded to 1e-6 so the cached JSON and the ports agree exactly.
 */
export function analyzeMotion(frames, { w = MOTION_W, h = MOTION_H, fps = MOTION_FPS } = {}) {
  const n = frames.length;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const raw = new Array(n).fill(0);
  const centroid = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const m = frameMotion(frames[i - 1], frames[i], w, h);
    raw[i] = r6(m.energy);
    if (m.weight >= MIN_CENTROID_WEIGHT) centroid[i] = [r6(m.cx), r6(m.cy), r6(m.weight)];
  }
  const scale = Math.max(percentile(raw, 0.95), NOISE_FLOOR);
  const curve = raw.map((v) => r6(v / scale));
  const moves = findMoves(curve, { fps, raw }).map((m) => ({ ...m, peak: r6(m.peak), strength: r6(m.strength) }));
  return { version: MOTION_VERSION, fps, w, h, duration: n / fps, raw, scale, curve, centroid, moves };
}
