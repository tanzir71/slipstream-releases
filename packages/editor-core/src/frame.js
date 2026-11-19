// Editor framing (ticket E-01): show the recording on a background or full screen, the Layout track that switches
// between the two per section, Fill/Fit, a fill crop that keeps the cursor in view, and the Area crop (W-11).
// Pure geometry: no DOM, no media. compositor.renderFrame() uses it for the preview and both web exporters; the
// desktop apps port it against packages/editor-core/test/parity/frame.json.
//
// Units: padding / radius are fractions of the output frame's short side (like the rest of plan v2); crops and
// focus points are fractions of the SOURCE frame (top-left origin); rects are { x, y, w, h } in whatever unit the
// caller passes (pixels in the compositor).

import { smootherstep, uid } from './edl.js';

/** Background amount presets (Figma "Minimal states" components sheet). */
export const FRAME_PRESETS = [
  { id: 'full', label: 'Full screen', padding: 0 },
  { id: 'tight', label: 'Tight', padding: 0.04 },
  { id: 'balanced', label: 'Balanced', padding: 0.07 },
  { id: 'roomy', label: 'Roomy', padding: 0.12 },
  { id: 'spacious', label: 'Spacious', padding: 0.18 },
];
export const MAX_PADDING = 0.2;
export const FRAMES = ['background', 'full'];
/** Default section transition: Smooth 0.6 s. */
export const FRAME_TRANSITION = Object.freeze({ kind: 'smooth', dur: 0.6 });
/** Seconds either side of t that the cursor-follow crop averages over (the auto-zoom ramp). */
export const FOLLOW_WINDOW = 0.65;
const FOLLOW_STEPS = 8;
/** The cursor stays at least this far inside the crop's edge, as a fraction of the crop size. */
export const FOLLOW_MARGIN = 0.04;
const MIN_CROP = 0.02;
const STYLE_DEFAULTS = { padding: 0.07, radius: 0.016, shadow: 0.7 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 'full' or 'background' (the default, also for old projects without style.frame). */
export function frameOf(style) {
  return style?.frame === 'full' ? 'full' : 'background';
}

/** Valid sections sorted by start. */
export function sortFrameSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && FRAMES.includes(s.frame))
    .slice().sort((a, b) => a.start - b.start);
}

/** The section covering t (start inclusive, end exclusive), or null. Later sections win on overlap. */
export function frameSectionAt(sections, t) {
  let hit = null;
  for (const s of sortFrameSections(sections)) if (t >= s.start && t < s.end) hit = s;
  return hit;
}

/** { kind: 'smooth' | 'cut', dur } with defaults (Smooth 0.6 s), dur clamped to 0..3 s. */
export function transitionOf(section) {
  const tr = section?.transition || {};
  return { kind: tr.kind === 'cut' ? 'cut' : 'smooth', dur: clamp(num(tr.dur, FRAME_TRANSITION.dur), 0, 3) };
}

/** The frame (without transitions) at t: the section's, else style.frame. */
export function rawFrameAt(style, sections, t) {
  return frameSectionAt(sections, t)?.frame ?? frameOf(style);
}

/**
 * How "full screen" the frame is at t, 0 (on background) … 1 (full screen). At each section edge the value eases with
 * smootherstep over the transition's dur, starting at the edge: the entered section's transition, or at a section's
 * end the transition of the section being left. A cut switches on the edge. The value just before an edge is the
 * eased one, so a section shorter than its transition never jumps.
 */
export function fullAmountAt(style, sections, t) {
  const list = sortFrameSections(sections);
  return fullAmount(style, list, t, list.length + 1);
}

function fullAmount(style, list, t, depth) {
  const raw = (x) => (rawFrameAt(style, list, x) === 'full' ? 1 : 0);
  const to = raw(t);
  let boundary = -Infinity, tr = null;
  for (const s of list) {
    if (s.start <= t && s.start >= boundary) { boundary = s.start; tr = transitionOf(s); }
    if (s.end <= t && s.end > boundary) { boundary = s.end; tr = transitionOf(s); }
  }
  if (!tr || boundary <= 0 || tr.kind === 'cut' || tr.dur <= 0 || t - boundary >= tr.dur || depth <= 0) return to;
  const from = fullAmount(style, list, boundary - 1e-9, depth - 1);
  if (from === to) return to;
  return lerp(from, to, smootherstep((t - boundary) / tr.dur));
}

/**
 * Frame state at t from style + frameSections. opts.bgCover: 1 when the background frame fills its area (layout fit
 * 'cover'), else 0. Returns { frame, full, padding, radius, shadow, cover } where full = fullAmountAt, padding /
 * radius / shadow ease to 0 in full screen, and cover (0 = contain, 1 = cover) eases from bgCover to the full-screen
 * fit (style.fit: 'fill' (default) = 1, 'fit' = 0).
 */
export function frameAt(style, sections, t, { bgCover = 0 } = {}) {
  const S = style || {};
  const full = fullAmountAt(S, sections, t);
  const keep = 1 - full;
  const fullCover = S.fit === 'fit' ? 0 : 1;
  return {
    frame: full >= 0.5 ? 'full' : 'background',
    full,
    padding: clamp(num(S.padding, STYLE_DEFAULTS.padding), 0, MAX_PADDING) * keep,
    radius: Math.max(0, num(S.radius, STYLE_DEFAULTS.radius)) * keep,
    shadow: clamp(num(S.shadow, STYLE_DEFAULTS.shadow), 0, 1) * keep,
    cover: lerp(bgCover ? 1 : 0, fullCover, full),
  };
}

/** Replace or insert the section [start, end) with `frame`, trimming overlapping sections. Returns a new array. */
export function setFrameSection(sections, start, end, frame, transition = FRAME_TRANSITION) {
  const out = [];
  for (const s of sortFrameSections(sections)) {
    if (s.end <= start || s.start >= end) { out.push(s); continue; }
    if (s.start < start) out.push({ ...s, end: start });
    if (s.end > end) out.push({ ...s, id: uid('fs'), start: end });
  }
  if (frame && end > start) out.push({ id: uid('fs'), start, end, frame, transition: { kind: transition.kind === 'cut' ? 'cut' : 'smooth', dur: num(transition.dur, FRAME_TRANSITION.dur) } });
  return sortFrameSections(out);
}

/**
 * Sections for the Layout track: every stretch of [0, duration] labelled with its frame, the gaps between sections
 * showing style.frame ("whole video" parts). [{ start, end, frame, section: id | null }].
 */
export function frameRuns(style, sections, duration) {
  const out = [];
  let t = 0;
  const base = frameOf(style);
  for (const s of sortFrameSections(sections)) {
    const a = Math.max(t, s.start), b = Math.min(duration, s.end);
    if (b <= a) continue;
    if (a > t + 1e-6) out.push({ start: t, end: a, frame: base, section: null });
    out.push({ start: a, end: b, frame: s.frame, section: s.id ?? null });
    t = b;
  }
  if (duration > t + 1e-6) out.push({ start: t, end: duration, frame: base, section: null });
  return out;
}

// ---- rects -----------------------------------------------------------------------------------------------

/** The screen area for a padding (fraction of the short side): the frame minus the padding on every side. */
export function screenArea(W, H, padding) {
  const p = Math.max(0, padding) * Math.min(W, H);
  return { x: p, y: p, w: Math.max(0, W - p * 2), h: Math.max(0, H - p * 2) };
}

/** Largest rect with the source's aspect inside `area`, centred (contain). */
export function containRect(sw, sh, area) {
  const s = Math.min(area.w / sw, area.h / sh);
  const w = sw * s, h = sh * s;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

/** Crop of a sw×sh source (same units) with the aspect of dw×dh, centred near (fx, fy) (fractions) and kept inside. */
export function coverCrop(sw, sh, dw, dh, fx = 0.5, fy = 0.5) {
  const dstA = dw / dh, srcA = sw / sh;
  let w = sw, h = sh;
  if (srcA > dstA) w = sh * dstA; else h = sw / dstA;
  const x = clamp(fx * sw - w / 2, 0, sw - w);
  const y = clamp(fy * sh - h / 2, 0, sh - h);
  return { x, y, w, h };
}

export function lerpRect(a, b, k) {
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
}

// ---- Area crop (W-11) ------------------------------------------------------------------------------------

/** A source crop [x, y, w, h] in fractions, clamped inside the frame (at least 2% each way), or null for none/full. */
export function normCrop(crop) {
  if (!Array.isArray(crop) || crop.length < 4 || !crop.slice(0, 4).every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  let [x, y, w, h] = crop;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  x = clamp(x, 0, 1 - MIN_CROP); y = clamp(y, 0, 1 - MIN_CROP);
  w = clamp(w, MIN_CROP, 1 - x); h = clamp(h, MIN_CROP, 1 - y);
  if (x <= 1e-6 && y <= 1e-6 && w >= 1 - 1e-6 && h >= 1 - 1e-6) return null;
  return [x, y, w, h];
}

/** Centre of a crop in pixels ({ x, y, w, h }) as fractions of the whole source. */
export function cropCentre(c, sw, sh) {
  return { x: (c.x + c.w / 2) / sw, y: (c.y + c.h / 2) / sh };
}

/** The crop in source pixels ({ x, y, w, h }); the whole frame when there is no crop. */
export function cropPixels(crop, sw, sh) {
  const c = normCrop(crop);
  return c ? { x: c[0] * sw, y: c[1] * sh, w: c[2] * sw, h: c[3] * sh } : { x: 0, y: 0, w: sw, h: sh };
}

// ---- cursor follow ---------------------------------------------------------------------------------------

/** Pointer position at t from samples sorted by t ([{ t, x, y }]), linearly interpolated; null without samples. */
export function cursorAt(samples, t) {
  if (!Array.isArray(samples) || !samples.length) return null;
  let lo = 0, hi = samples.length - 1;
  if (t <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  if (t >= samples[hi].t) return { x: samples[hi].x, y: samples[hi].y };
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].t <= t) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi];
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
}

/**
 * Smoothed pointer position at t: a smootherstep-weighted average of the pointer over t ± window (the auto-zoom
 * ramp), so the crop eases after the pointer like a zoom does instead of jittering with it. Stateless, so the
 * preview after a seek and the export agree. null without samples.
 */
export function followPoint(samples, t, window = FOLLOW_WINDOW) {
  if (!Array.isArray(samples) || !samples.length) return null;
  let sx = 0, sy = 0, sw = 0;
  for (let i = -FOLLOW_STEPS; i <= FOLLOW_STEPS; i++) {
    const w = smootherstep(1 - Math.abs(i) / (FOLLOW_STEPS + 1));
    const p = cursorAt(samples, t + (window * i) / FOLLOW_STEPS);
    sx += p.x * w; sy += p.y * w; sw += w;
  }
  return { x: sx / sw, y: sy / sw };
}

/**
 * Centre (fractions) of a crop of size w×h (fractions) that follows the pointer: the smoothed position, moved just
 * enough to keep the pointer at t inside (FOLLOW_MARGIN of the crop from its edge), then kept inside the frame.
 */
export function followCenter(samples, t, w, h, { window = FOLLOW_WINDOW, margin = FOLLOW_MARGIN } = {}) {
  const f = followPoint(samples, t, window);
  if (!f) return null;
  const p = cursorAt(samples, t);
  const keep = (c, size, pos) => {
    const m = Math.min(size * margin, size / 2);
    if (pos < c - size / 2 + m) c = pos + size / 2 - m;
    if (pos > c + size / 2 - m) c = pos - size / 2 + m;
    return clamp(c, size / 2, 1 - size / 2);
  };
  return { x: keep(f.x, w, p.x), y: keep(f.y, h, p.y) };
}

/**
 * The part of the source that fills a dw×dh frame (cover), as fractions { x, y, w, h } of the WHOLE source frame.
 * With follow and pointer samples it follows the pointer (followCenter); otherwise it centres on the zoom focus
 * while a zoom is on (zoom = zoomAt() result), else on the middle. crop: the Area crop, which bounds it.
 */
export function fillCrop({ srcW, srcH, dstW, dstH, t = 0, samples = null, follow = true, zoom = null, crop = null }) {
  const c = cropPixels(crop, srcW, srcH);
  const size = coverCrop(c.w, c.h, dstW, dstH);
  const wf = size.w / c.w, hf = size.h / c.h; // crop size as fractions of the Area crop
  let fx = 0.5, fy = 0.5;
  const toLocal = (p) => ({ x: (p.x * srcW - c.x) / c.w, y: (p.y * srcH - c.y) / c.h });
  const local = follow && Array.isArray(samples) && samples.length ? samples.map((s) => ({ t: s.t, ...toLocal(s) })) : null;
  const fc = local ? followCenter(local, t, wf, hf) : null;
  if (fc) { fx = fc.x; fy = fc.y; } else if (zoom && zoom.k > 0) { const z = toLocal(zoom); fx = z.x; fy = z.y; }
  const r = coverCrop(c.w, c.h, dstW, dstH, fx, fy);
  return { x: (c.x + r.x) / srcW, y: (c.y + r.y) / srcH, w: r.w / srcW, h: r.h / srcH };
}

/**
 * Where the screen recording lands: `dest` is its rect in the output and `view` the part of the source drawn into it,
 * in source pixels of the WHOLE source (so masks, annotations and zoom focus, all in whole-source fractions, map
 * through it). area: the screen area; cover: 0 = contain … 1 = cover (eased in between); zoom: zoomAt() result;
 * focus: centre for the cover crop (fractions of the whole source), default the zoom focus while zooming else the
 * centre of the Area crop (the middle of the frame without one); crop: the Area crop.
 */
export function screenGeometry({ srcW, srcH, area, cover = 0, zoom = { scale: 1, x: 0.5, y: 0.5, k: 0 }, focus = null, crop = null }) {
  const c = cropPixels(crop, srcW, srcH);
  const z = zoom || { scale: 1, x: 0.5, y: 0.5, k: 0 };
  const zoomed = (base) => {
    const vw = base.w / z.scale, vh = base.h / z.scale;
    const cx = clamp(z.x * srcW, base.x + vw / 2, base.x + base.w - vw / 2);
    const cy = clamp(z.y * srcH, base.y + vh / 2, base.y + base.h - vh / 2);
    return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
  };
  const contain = () => ({ dest: containRect(c.w, c.h, area), view: zoomed(c) });
  const covered = () => {
    const f = focus || (z.k > 0 ? { x: z.x, y: z.y } : cropCentre(c, srcW, srcH));
    const r = coverCrop(c.w, c.h, area.w, area.h, (f.x * srcW - c.x) / c.w, (f.y * srcH - c.y) / c.h);
    return { dest: { ...area }, view: zoomed({ x: c.x + r.x, y: c.y + r.y, w: r.w, h: r.h }) };
  };
  if (cover <= 0) return contain();
  if (cover >= 1) return covered();
  const a = contain(), b = covered();
  return { dest: lerpRect(a.dest, b.dest, cover), view: lerpRect(a.view, b.view, cover) };
}

// ---- crop note ---------------------------------------------------------------------------------------------

/** How much a sw×sh source loses to fill dw×dh: { axis: 'vertical' (top and bottom) | 'horizontal' | null, each }. */
export function trimOf(sw, sh, dw, dh) {
  const srcA = sw / sh, dstA = dw / dh;
  if (!(srcA > 0) || !(dstA > 0) || Math.abs(srcA - dstA) / dstA < 1e-3) return { axis: null, each: 0 };
  if (srcA < dstA) return { axis: 'vertical', each: (1 - srcA / dstA) / 2 };
  return { axis: 'horizontal', each: (1 - dstA / srcA) / 2 };
}

const pct = (f) => { const p = f * 100; return p >= 1 ? `${Math.round(p)}%` : `${Math.max(0.1, Math.round(p * 10) / 10)}%`; };

/**
 * The sentence under Fill/Fit, e.g. "The recording fills 16:9 by trimming 5% from the top and bottom."
 * sw×sh: the source (after the Area crop); aspect: '16:9' | '9:16' | '1:1' | '4:5'; fit: 'fill' | 'fit'.
 */
export function cropNote(sw, sh, aspect, fit = 'fill') {
  const [a, b] = String(aspect || '16:9').split(':').map(Number);
  const tr = trimOf(sw, sh, a || 16, b || 9);
  const name = `${a || 16}:${b || 9}`;
  if (!tr.axis) return `The recording fills ${name} exactly.`;
  if (fit === 'fit') return `The recording fits inside ${name}, with the wallpaper ${tr.axis === 'vertical' ? 'on the left and right' : 'above and below'}.`;
  return `The recording fills ${name} by trimming ${pct(tr.each)} from the ${tr.axis === 'vertical' ? 'top and bottom' : 'left and right'}.`;
}
