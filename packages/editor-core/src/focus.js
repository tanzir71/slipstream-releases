// Reframing per aspect for Auto edit (ticket AE-06, the pure part). Pure: no DOM, no media. A focus track follows
// faces where the surface has them (Vision on macOS, or any detector) and otherwise the motion centroid from
// motion.js, smoothed; each segment then gets one crop per aspect. Switching aspect recomputes crops only: cuts,
// speeds and source ranges never move. The Swift and Rust ports check against test/parity/autoedit.json ("focus").
//
// Public API
//   AUTO_ASPECTS = ['16:9', '9:16', '1:1', '4:5']
//   focusTrack({ duration, fps?, faces?, centroids?, sigma? }) -> FocusTrack
//   cropFor(track, { start, end, sourceAspect, aspect }) -> [x, y, w, h]       fractions of the source frame
//   segmentCrops(track, { start, end, sourceAspect, aspects? }) -> { [aspect]: [x, y, w, h] }
//   reframeSegments(segments, { tracks, sourceAspects, aspects? }) -> segments  same segments, crops recomputed
//   aspectRatio('9:16') -> 0.5625
//
// Types
//   Face observations: faces = [{ t, boxes: [[x, y, w, h], …] }], boxes in 0..1 of the frame, top-left origin.
//   Motion centroids: centroids = motion.centroid (one per sample at `fps`): [x, y, weight] | null.
//   FocusTrack = { fps, source: 'faces' | 'motion' | 'center', x: number[], y: number[], faces: faces | null }
//
// Algorithm
//   Samples i = 0..ceil(duration·fps), t = i/fps.
//   Observations: with faces, each observation's point is the area-weighted centre of its boxes, placed on sample
//   round(t·fps) (a later observation on the same sample replaces an earlier one) with weight 1; samples between
//   observations are filled by linear interpolation and held flat before the first and after the last. Without faces,
//   each non-null centroid is an observation with its weight. Smoothing: x[i] = Σ g(j)·w·x / Σ g(j)·w over observations
//   j within ±3σ samples, g = exp(−½(d/σ)²), σ = sigma·fps (sigma = 0.5 s); with no observation in reach, x[i] holds
//   x[i−1] (the first such samples take the first smoothed value, or 0.5 when there is none at all).
//   Crop for source range [start, end]: the largest crop of the aspect inside the frame (full height if the aspect is
//   narrower than the source, else full width), centred on the mean of the track over samples with t in [start, end]
//   (the nearest sample if none), clamped to the frame. With faces, the crop then shifts as little as possible to
//   contain the union of the face boxes seen in [start, end] when that union fits; if it doesn't, the largest face.
//   Values are rounded to 1e-6.

import { ASPECTS } from './edl.js';

export const AUTO_ASPECTS = Object.freeze(['16:9', '9:16', '1:1', '4:5']);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Width / height of an aspect id ('9:16' -> 0.5625); unknown ids are 16:9. */
export function aspectRatio(aspect) {
  const [a, b] = ASPECTS[aspect] || String(aspect).split(':').map(Number);
  return a > 0 && b > 0 ? a / b : 16 / 9;
}

function faceCentre(boxes) {
  let sx = 0, sy = 0, sw = 0;
  for (const [x, y, w, h] of boxes) { const a = Math.max(1e-6, w * h); sx += (x + w / 2) * a; sy += (y + h / 2) * a; sw += a; }
  return sw > 0 ? [sx / sw, sy / sw] : null;
}

/** A smoothed focus track; see the header. */
export function focusTrack({ duration, fps = 10, faces = null, centroids = null, sigma = 0.5 } = {}) {
  const n = Math.max(1, Math.ceil(Math.max(0, duration) * fps) + 1);
  const obs = new Array(n).fill(null); // [x, y, w]
  let source = 'center';
  const faceObs = Array.isArray(faces) ? faces.filter((f) => f && Number.isFinite(f.t) && Array.isArray(f.boxes) && f.boxes.length) : [];
  if (faceObs.length) {
    source = 'faces';
    const pts = [];
    for (const f of [...faceObs].sort((a, b) => a.t - b.t)) {
      const c = faceCentre(f.boxes);
      if (!c) continue;
      const i = clamp(Math.round(f.t * fps), 0, n - 1);
      if (pts.length && pts[pts.length - 1].i === i) pts[pts.length - 1] = { i, c };
      else pts.push({ i, c });
    }
    for (let k = 0; k < pts.length; k++) {
      const { i, c } = pts[k];
      obs[i] = [c[0], c[1], 1];
      const next = pts[k + 1];
      if (next) for (let j = i + 1; j < next.i; j++) { const u = (j - i) / (next.i - i); obs[j] = [c[0] + (next.c[0] - c[0]) * u, c[1] + (next.c[1] - c[1]) * u, 1]; }
    }
    if (pts.length) {
      for (let j = 0; j < pts[0].i; j++) obs[j] = [pts[0].c[0], pts[0].c[1], 1];
      const last = pts[pts.length - 1];
      for (let j = last.i + 1; j < n; j++) obs[j] = [last.c[0], last.c[1], 1];
    }
  } else if (Array.isArray(centroids)) {
    for (let i = 0; i < Math.min(n, centroids.length); i++) {
      const c = centroids[i];
      if (c && c[2] > 0) { obs[i] = [c[0], c[1], c[2]]; source = 'motion'; }
    }
  }
  const s = Math.max(1e-6, sigma * fps);
  const R = Math.ceil(3 * s);
  const x = new Array(n).fill(null), y = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sw = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) {
      const o = obs[j];
      if (!o) continue;
      const g = Math.exp(-0.5 * ((j - i) / s) ** 2) * o[2];
      sx += g * o[0]; sy += g * o[1]; sw += g;
    }
    if (sw > 0) { x[i] = sx / sw; y[i] = sy / sw; }
  }
  const firstX = x.find((v) => v !== null), firstY = y.find((v) => v !== null);
  let px = firstX ?? 0.5, py = firstY ?? 0.5;
  for (let i = 0; i < n; i++) {
    if (x[i] === null) { x[i] = px; y[i] = py; } else { px = x[i]; py = y[i]; }
    x[i] = r6(x[i]); y[i] = r6(y[i]);
  }
  return { fps, source, x, y, faces: faceObs.length ? faceObs : null };
}

/** The crop of `aspect` for source range [start, end]; see the header. */
export function cropFor(track, { start, end, sourceAspect = 16 / 9, aspect }) {
  const At = aspectRatio(aspect), As = sourceAspect > 0 ? sourceAspect : 16 / 9;
  if (Math.abs(At - As) < 1e-6) return [0, 0, 1, 1];
  const cw = At < As ? At / As : 1;
  const ch = At < As ? 1 : As / At;
  let fx = 0.5, fy = 0.5;
  if (track && track.x && track.x.length) {
    const n = track.x.length;
    const i0 = Math.max(0, Math.ceil(start * track.fps - 1e-9)), i1 = Math.min(n - 1, Math.floor(end * track.fps + 1e-9));
    if (i1 >= i0) {
      let sx = 0, sy = 0;
      for (let i = i0; i <= i1; i++) { sx += track.x[i]; sy += track.y[i]; }
      fx = sx / (i1 - i0 + 1); fy = sy / (i1 - i0 + 1);
    } else {
      const i = clamp(Math.round(((start + end) / 2) * track.fps), 0, n - 1);
      fx = track.x[i]; fy = track.y[i];
    }
  }
  let x = clamp(fx - cw / 2, 0, 1 - cw), y = clamp(fy - ch / 2, 0, 1 - ch);
  if (track && track.faces) {
    const seen = track.faces.filter((f) => f.t >= start - 1e-9 && f.t <= end + 1e-9).flatMap((f) => f.boxes);
    if (seen.length) {
      const contain = (bx0, by0, bx1, by1) => {
        if (bx1 - bx0 <= cw + 1e-9) x = clamp(clamp(x, bx1 - cw, bx0), 0, 1 - cw);
        if (by1 - by0 <= ch + 1e-9) y = clamp(clamp(y, by1 - ch, by0), 0, 1 - ch);
      };
      const ux0 = Math.min(...seen.map((b) => b[0])), uy0 = Math.min(...seen.map((b) => b[1]));
      const ux1 = Math.max(...seen.map((b) => b[0] + b[2])), uy1 = Math.max(...seen.map((b) => b[1] + b[3]));
      if (ux1 - ux0 <= cw + 1e-9 && uy1 - uy0 <= ch + 1e-9) contain(ux0, uy0, ux1, uy1);
      else {
        let big = seen[0];
        for (const b of seen) if (b[2] * b[3] > big[2] * big[3] + 1e-12) big = b;
        contain(big[0], big[1], big[0] + big[2], big[1] + big[3]);
      }
    }
  }
  return [r6(x), r6(y), r6(cw), r6(ch)];
}

/** Crops for every aspect in `aspects` (default all four). */
export function segmentCrops(track, { start, end, sourceAspect = 16 / 9, aspects = AUTO_ASPECTS } = {}) {
  const out = {};
  for (const a of aspects) out[a] = cropFor(track, { start, end, sourceAspect, aspect: a });
  return out;
}

/**
 * Recompute only the crops of `segments` (plan shape: asset, sourceIn, start, end, speed). tracks and sourceAspects
 * are keyed by asset id; a missing track centres the crop. Every other field is returned unchanged.
 */
export function reframeSegments(segments, { tracks = {}, sourceAspects = {}, aspects = AUTO_ASPECTS } = {}) {
  return (segments || []).map((s) => {
    if (!s || s.asset == null) return s;
    const speed = s.speed > 0 ? s.speed : 1;
    const start = s.sourceIn || 0, end = start + Math.max(0, s.end - s.start) * speed;
    return { ...s, crops: segmentCrops(tracks[s.asset] || null, { start, end, sourceAspect: sourceAspects[s.asset] || 16 / 9, aspects }) };
  });
}
