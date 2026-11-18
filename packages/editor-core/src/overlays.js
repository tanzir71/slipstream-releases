// Privacy masks and annotations (tickets T-03/M-03 masks, T-05/M-05 annotations). Pure: no DOM, no media.
//
// Both live in the edit plan with SOURCE times and a `rect` of [x, y, w, h] as fractions of the screen recording,
// so they follow zooms, padding and aspect changes. An arrow goes from (x, y) to (x + w, y + h), so its w and h may
// be negative; every other kind keeps a positive size. The macOS compositor and slipstream_engine read the same
// fields (keyframe interpolation matches KitBridge.maskRect).

export const MASK_MODES = ['blur', 'pixelate', 'solid'];
export const ANNOTATION_KINDS = ['arrow', 'box', 'highlight', 'text'];
export const ANNOTATION_COLOR = '#8b93ff'; // the accent, same default as the macOS app
export const OVERLAY_FADE = 0.2; // seconds, annotations fade in and out
export const DEFAULT_OVERLAY_LENGTH = 3;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

let seq = 0;
const newId = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Items whose [start, end] contains source time t. */
export function activeAt(list, t) {
  return (list || []).filter((it) => it && t >= num(it.start) && t <= num(it.end));
}

/** Mask rect at time t: linear between keyframes (sorted by t), clamped to the first and last. */
export function maskRectAt(mask, t) {
  const kfs = (mask?.keyframes || []).filter((k) => k && Array.isArray(k.rect) && k.rect.length === 4).slice().sort((a, b) => a.t - b.t);
  if (!kfs.length) return mask?.rect || null;
  if (t <= kfs[0].t) return kfs[0].rect;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.rect;
  for (let i = 1; i < kfs.length; i++) {
    if (t < kfs[i].t) {
      const a = kfs[i - 1], b = kfs[i];
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return a.rect.map((v, j) => v + (b.rect[j] - v) * k);
    }
  }
  return mask.rect;
}

/** 0..1 opacity: fades in over the first OVERLAY_FADE seconds and out over the last (no fade-in at 0 s). */
export function fadeAlpha(item, t, fade = OVERLAY_FADE) {
  const s = num(item.start), e = num(item.end);
  if (t < s || t > e) return 0;
  return clamp01(Math.min(1, s <= 0 ? 1 : (t - s) / fade, (e - t) / fade));
}

/** Rect from two drag points (fractions). Arrows keep their direction; other kinds get a positive, clamped box. */
export function rectFromDrag(a, b, kind = 'box') {
  if (kind === 'arrow') return [clamp01(a.x), clamp01(a.y), clamp01(b.x) - clamp01(a.x), clamp01(b.y) - clamp01(a.y)].map(round4);
  const x0 = clamp01(Math.min(a.x, b.x)), y0 = clamp01(Math.min(a.y, b.y));
  const x1 = clamp01(Math.max(a.x, b.x)), y1 = clamp01(Math.max(a.y, b.y));
  return [x0, y0, x1 - x0, y1 - y0].map(round4);
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/** Move a rect by (dx, dy) fractions, keeping a positive box inside the frame (arrows may point anywhere). */
export function moveRect(rect, dx, dy, kind = 'box') {
  const [x, y, w, h] = rect;
  if (kind === 'arrow') {
    const ex = x + w, ey = y + h;
    const mx = Math.max(-Math.min(x, ex), Math.min(dx, 1 - Math.max(x, ex)));
    const my = Math.max(-Math.min(y, ey), Math.min(dy, 1 - Math.max(y, ey)));
    return [x + mx, y + my, w, h].map(round4);
  }
  return [clamp01(Math.min(1 - w, x + dx)), clamp01(Math.min(1 - h, y + dy)), w, h].map(round4);
}

/**
 * Drag one handle of a rect to point p (fractions). Handles: 'nw','ne','sw','se' for boxes; 'start','end' for arrows.
 */
export function resizeRect(rect, handle, p, kind = 'box') {
  const [x, y, w, h] = rect;
  if (kind === 'arrow') {
    const s = { x, y }, e = { x: x + w, y: y + h };
    const q = { x: clamp01(p.x), y: clamp01(p.y) };
    return handle === 'start' ? [q.x, q.y, e.x - q.x, e.y - q.y].map(round4) : [s.x, s.y, q.x - s.x, q.y - s.y].map(round4);
  }
  const fixed = { x: handle.includes('w') ? x + w : x, y: handle.includes('n') ? y + h : y };
  return rectFromDrag(fixed, p, kind);
}

/** Hit test at point p (fractions of the source frame). Returns { id, handle } for the topmost hit, or null. */
export function hitTest(items, t, p, tol = 0.012, rectOf = (it) => maskRectAt(it, t)) {
  const live = activeAt(items, t);
  for (let i = live.length - 1; i >= 0; i--) {
    const it = live[i];
    const r = rectOf(it);
    if (!r || r.length !== 4) continue;
    const [x, y, w, h] = r;
    if (it.kind === 'arrow') {
      if (Math.hypot(p.x - x, p.y - y) <= tol * 1.5) return { id: it.id, handle: 'start' };
      if (Math.hypot(p.x - (x + w), p.y - (y + h)) <= tol * 1.5) return { id: it.id, handle: 'end' };
      if (distToSegment(p, { x, y }, { x: x + w, y: y + h }) <= tol) return { id: it.id, handle: 'move' };
      continue;
    }
    const corners = { nw: [x, y], ne: [x + w, y], sw: [x, y + h], se: [x + w, y + h] };
    for (const [k, [cx, cy]] of Object.entries(corners)) if (Math.hypot(p.x - cx, p.y - cy) <= tol * 1.5) return { id: it.id, handle: k };
    if (p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol) return { id: it.id, handle: 'move' };
  }
  return null;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const k = L ? clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / L) : 0;
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

/** A new mask. mode: 'blur' | 'pixelate' | 'solid'. */
export function newMask({ start, end, rect, mode = 'blur' }) {
  return { id: newId('mask'), start: num(start), end: Math.max(num(start) + 0.1, num(end)), rect: rect.map(round4), mode: MASK_MODES.includes(mode) ? mode : 'blur' };
}

/** A new annotation. kind: 'arrow' | 'box' | 'highlight' | 'text'. */
export function newAnnotation({ start, end, rect, kind = 'box', text, color }) {
  const a = { id: newId('ann'), start: num(start), end: Math.max(num(start) + 0.1, num(end)), kind: ANNOTATION_KINDS.includes(kind) ? kind : 'box', rect: rect.map(round4) };
  if (a.kind === 'text') a.text = String(text ?? 'Note');
  if (color && color !== ANNOTATION_COLOR) a.color = color;
  return a;
}

/**
 * Time range for a new overlay: the selection when there is one, else DEFAULT_OVERLAY_LENGTH seconds from the
 * playhead. It starts one fade earlier so it's fully visible at the playhead, where it was just drawn.
 */
export function overlayRange(t, duration, selection = null) {
  if (selection && selection.end - selection.start >= 0.1) return { start: selection.start, end: selection.end };
  const at = Math.max(0, Math.min(t, Math.max(0, duration - 0.1)));
  const start = Math.round(Math.max(0, at - OVERLAY_FADE) * 1000) / 1000;
  return { start, end: Math.min(duration, at + DEFAULT_OVERLAY_LENGTH) };
}
