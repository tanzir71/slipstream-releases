// Recorder logic shared by Slipstream Web's recorder (W-11) and the desktop app's recording overlays (T-11):
// mute nudges, the pill's level bars and clock, area drawing with aspect locks and snapping, the source crop an
// Area take hands the editor, where the pill docks, window size presets and take-time mapping. No DOM, no media:
// unit-tested in tests/rec-logic.test.mjs. The thresholds match the macOS recorder (docs/handover/minimal-states.md).

// ---- mute nudges (frame 10) ----------------------------------------------------------------------------------------

export const NUDGE = Object.freeze({
  /** Talking while muted: mic level above this (dBFS) … */
  mutedTalkDb: -40,
  /** … for this long (seconds, continuous). */
  mutedTalkSec: 1,
  /** Silent mic: below this (dBFS) … */
  silentDb: -60,
  /** … for the first this-many seconds of the take. */
  silentSec: 5,
  /** A nudge stays this long (seconds). */
  showSec: 4,
  /** And never repeats within this long (seconds). */
  repeatSec: 30,
});

/** Peak sample (0..1) → dBFS; silence is -Infinity. */
export const dbfs = (peak) => (peak > 0 ? 20 * Math.log10(Math.min(1, peak)) : -Infinity);

/**
 * Mute nudges, fed with the live mic level. update({ t, db, muted, paused }) → the nudge to show now
 * ({ kind: 'muted' | 'silent', since }) or null. t: seconds on any steady clock (performance.now() / 1000);
 * the first update is the start of the take. Paused time doesn't count towards either rule.
 * - 'muted': muted and the level stays above −40 dBFS for 1 s ("You're talking while muted · Unmute").
 * - 'silent': not muted and the level stays below −60 dBFS for the take's first 5 s ("No sound from <mic>").
 * A nudge shows for 4 s and the same kind never shows again within 30 s.
 */
export function createNudger(opts = {}) {
  const o = { ...NUDGE, ...opts };
  let start = null, loudSince = null, quietFor = 0, heard = false, lastT = null;
  let shown = null; // { kind, since }
  const lastShown = { muted: -Infinity, silent: -Infinity };
  const show = (kind, t) => {
    if (t - lastShown[kind] < o.repeatSec) return;
    lastShown[kind] = t;
    shown = { kind, since: t };
  };
  return {
    update({ t, db, muted = false, paused = false }) {
      if (start === null) start = t;
      const dt = lastT === null ? 0 : Math.max(0, t - lastT);
      lastT = t;
      if (shown && t - shown.since >= o.showSec) shown = null;
      if (paused) { loudSince = null; return shown; }
      const level = Number.isFinite(db) ? db : -Infinity;
      // Talking while muted.
      if (muted && level > o.mutedTalkDb) {
        if (loudSince === null) loudSince = t;
        else if (t - loudSince >= o.mutedTalkSec && shown?.kind !== 'muted') show('muted', t);
      } else loudSince = null;
      // A silent mic at the start of the take.
      if (!heard) {
        if (level >= o.silentDb) heard = true;
        else if (!muted) {
          quietFor += dt;
          if (quietFor >= o.silentSec) { heard = true; show('silent', t); }
        }
      }
      if (shown?.kind === 'muted' && !muted) shown = null; // unmuted: the nudge has done its job
      return shown;
    },
    dismiss() { shown = null; },
    get current() { return shown; },
  };
}

// ---- the pill ------------------------------------------------------------------------------------------------------

/** Four live bars from a 0..1 level (the pill's mic meter), each 0.2..1. */
export function levelBars(level, n = 4) {
  const l = Math.max(0, Math.min(1, Number(level) || 0));
  const shape = [0.55, 1, 0.75, 0.4, 0.85, 0.6];
  return Array.from({ length: n }, (_, i) => Math.round((0.2 + 0.8 * l * shape[i % shape.length]) * 100) / 100);
}

/** dBFS → the 0..1 level the meters draw (−60 dBFS and below is empty, 0 dBFS full). */
export const dbToLevel = (db) => (Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0);

/** 0:42, 12:05, 1:02:03 (tabular, no leading zero on the first field). */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** The countdown's numbers: 3 → [3, 2, 1]; 0 (or less) skips it. */
export const countdownSteps = (seconds) => Array.from({ length: Math.max(0, Math.floor(seconds || 0)) }, (_, i) => Math.floor(seconds) - i);

/** The countdown chip cycles through these (seconds). */
export const COUNTDOWN_CHOICES = [3, 5, 10, 0];
export const nextCountdown = (s) => COUNTDOWN_CHOICES[(COUNTDOWN_CHOICES.indexOf(s) + 1) % COUNTDOWN_CHOICES.length];

// ---- take time -----------------------------------------------------------------------------------------------------

/**
 * A moment (performance.now() ms) on the recording's own clock (seconds): from the screen file's t = 0, with the
 * paused stretches before it taken out. null when it falls inside a pause. start / pauses: Session.timeline().
 */
export function takeTime(at, { start, pauses = [] }) {
  if (!(at >= start)) return 0;
  let skipped = 0;
  for (const [from, to] of pauses) {
    if (at >= to) skipped += to - from;
    else if (at >= from) return null;
  }
  return (at - start - skipped) / 1000;
}

/**
 * Stretches with the camera turned off (performance.now() ms pairs) → [{ start, end }] on the take's clock,
 * merged and clipped to [0, duration], for "camera off" scenes in the editor.
 */
export function cameraOffRanges(offs, timeline, duration = Infinity) {
  const out = [];
  for (const [from, to] of offs || []) {
    const a = takeTime(from, timeline) ?? pauseEnd(from, timeline);
    const b = takeTime(Number.isFinite(to) ? to : Infinity, timeline) ?? pauseEnd(to, timeline);
    const s = Math.max(0, a), e = Math.min(duration, Number.isFinite(b) ? b : duration);
    if (e - s > 0.05) out.push({ start: round3(s), end: round3(e) });
  }
  out.sort((p, q) => p.start - q.start);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
function pauseEnd(at, timeline) {
  // Inside a pause: the take resumes where the pause ends.
  const p = (timeline.pauses || []).find(([from, to]) => at >= from && at < to);
  return p ? takeTime(p[1], timeline) ?? 0 : 0;
}
const round3 = (v) => Math.round(v * 1000) / 1000;

// ---- areas: drawing, aspect locks, snapping, the source crop --------------------------------------------------------

export const AREA_ASPECTS = Object.freeze([['free', 'Free', null], ['16:9', '16:9', 16 / 9], ['9:16', '9:16', 9 / 16], ['1:1', '1:1', 1], ['4:5', '4:5', 4 / 5]]);
export const aspectRatio = (id) => AREA_ASPECTS.find((a) => a[0] === id)?.[2] ?? null;
/** Smallest area (px) worth recording. */
export const MIN_AREA = 64;
/** Edges within this many pixels snap to a window edge (frame 5). */
export const SNAP_PX = 8;

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** {x, y, w, h} kept inside bounds (moved first, then shrunk). */
export function clampRect(r, b) {
  const w = Math.min(r.w, b.w), h = Math.min(r.h, b.h);
  return { x: clampN(r.x, b.x, b.x + b.w - w), y: clampN(r.y, b.y, b.y + b.h - h), w, h };
}

/**
 * The rectangle dragged from `a` to `b` (points), locked to `aspect` (w / h, or null for free) and kept inside
 * `bounds`. With an aspect the drag's longer side wins and the other follows.
 */
export function dragRect(a, b, aspect, bounds) {
  let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (aspect) {
    if (w / aspect >= h) h = w / aspect; else w = h * aspect;
  }
  const sx = b.x >= a.x ? 1 : -1, sy = b.y >= a.y ? 1 : -1;
  // Room in the drag's direction, so a locked rectangle never leaves the bounds.
  const roomX = sx > 0 ? bounds.x + bounds.w - a.x : a.x - bounds.x;
  const roomY = sy > 0 ? bounds.y + bounds.h - a.y : a.y - bounds.y;
  const k = Math.min(1, w > 0 ? roomX / w : 1, h > 0 ? roomY / h : 1);
  w *= k; h *= k;
  return { x: sx > 0 ? a.x : a.x - w, y: sy > 0 ? a.y : a.y - h, w, h };
}

/**
 * Move one handle of `r` to point `p`. handle: 'n','s','e','w','ne','nw','se','sw' or 'move' (p is then the
 * pointer delta {dx, dy}). The opposite edge or corner stays put; an aspect lock is kept; at least `min` px.
 */
export function resizeRect(r, handle, p, aspect, bounds, min = MIN_AREA) {
  if (handle === 'move') return clampRect({ ...r, x: r.x + p.dx, y: r.y + p.dy }, bounds);
  let l = r.x, t = r.y, rt = r.x + r.w, bt = r.y + r.h;
  if (handle.includes('w')) l = Math.min(p.x, rt - min);
  if (handle.includes('e')) rt = Math.max(p.x, l + min);
  if (handle.includes('n')) t = Math.min(p.y, bt - min);
  if (handle.includes('s')) bt = Math.max(p.y, t + min);
  l = Math.max(bounds.x, l); t = Math.max(bounds.y, t);
  rt = Math.min(bounds.x + bounds.w, rt); bt = Math.min(bounds.y + bounds.h, bt);
  let out = { x: l, y: t, w: rt - l, h: bt - t };
  if (aspect) {
    const horizontal = handle === 'e' || handle === 'w';
    const vertical = handle === 'n' || handle === 's';
    let w = out.w, h = out.h;
    if (horizontal) h = w / aspect; else if (vertical) w = h * aspect; else if (w / aspect >= h) h = w / aspect; else w = h * aspect;
    // Anchor on the edges that didn't move.
    const x = handle.includes('w') ? rt - w : horizontal || handle.includes('e') ? l : r.x + (r.w - w) / 2;
    const y = handle.includes('n') ? bt - h : vertical || handle.includes('s') ? t : r.y + (r.h - h) / 2;
    out = fitInside({ x, y, w, h }, bounds, aspect);
  }
  return out;
}

/** Shrink (keeping the aspect) and move a rectangle until it fits in bounds. */
function fitInside(r, b, aspect) {
  let { w, h } = r;
  if (w > b.w) { w = b.w; h = aspect ? w / aspect : h; }
  if (h > b.h) { h = b.h; w = aspect ? h * aspect : w; }
  return clampRect({ x: r.x, y: r.y, w, h }, b);
}

/** The x and y edges of window rectangles ({x, y, w, h}), for snapping. */
export function windowEdges(windows) {
  const xs = new Set(), ys = new Set();
  for (const w of windows || []) {
    if (!(w.w > 0 && w.h > 0)) continue;
    xs.add(w.x); xs.add(w.x + w.w); ys.add(w.y); ys.add(w.y + w.h);
  }
  return { xs: [...xs], ys: [...ys] };
}

const nearest = (v, list, within) => {
  let best = null, d = within + 1e-9;
  for (const e of list) { const k = Math.abs(e - v); if (k <= d) { d = k; best = e; } }
  return best;
};

/**
 * Pull each edge of `r` to the nearest window edge within `px`. 'move' keeps the size (the closer of the two
 * snaps wins); a handle snaps only the edges it moves; 'draw' snaps every edge.
 */
export function snapRect(r, edges, handle = 'draw', px = SNAP_PX) {
  if (!edges) return r;
  let l = r.x, t = r.y, rt = r.x + r.w, bt = r.y + r.h;
  if (handle === 'move') {
    const dx = pick2(nearest(l, edges.xs, px), l, nearest(rt, edges.xs, px), rt);
    const dy = pick2(nearest(t, edges.ys, px), t, nearest(bt, edges.ys, px), bt);
    return { x: l + dx, y: t + dy, w: r.w, h: r.h };
  }
  const all = handle === 'draw';
  if (all || handle.includes('w')) l = nearest(l, edges.xs, px) ?? l;
  if (all || handle.includes('e')) rt = nearest(rt, edges.xs, px) ?? rt;
  if (all || handle.includes('n')) t = nearest(t, edges.ys, px) ?? t;
  if (all || handle.includes('s')) bt = nearest(bt, edges.ys, px) ?? bt;
  return rt - l >= MIN_AREA / 2 && bt - t >= MIN_AREA / 2 ? { x: l, y: t, w: rt - l, h: bt - t } : r;
}
function pick2(a, av, b, bv) {
  const da = a === null ? Infinity : a - av, db = b === null ? Infinity : b - bv;
  if (!Number.isFinite(da) && !Number.isFinite(db)) return 0;
  return Math.abs(da) <= Math.abs(db) ? da : db;
}

/**
 * The source crop an Area take hands the editor: `area` inside the recorded `frame` (same pixel space) as
 * [x, y, w, h] fractions of the frame, clipped to it, rounded to 1e-4. null when it covers the whole frame (or
 * nothing). This is edit plan v2 `frame.crop` (see applySourceCrop in rec-ui.js).
 */
export function cropFraction(area, frame) {
  if (!area || !frame || !(frame.w > 0 && frame.h > 0)) return null;
  const l = clampN((area.x - frame.x) / frame.w, 0, 1), t = clampN((area.y - frame.y) / frame.h, 0, 1);
  const r = clampN((area.x + area.w - frame.x) / frame.w, 0, 1), b = clampN((area.y + area.h - frame.y) / frame.h, 0, 1);
  const q = (v) => Math.round(v * 1e4) / 1e4;
  const crop = [q(l), q(t), q(r - l), q(b - t)];
  if (crop[2] <= 0.01 || crop[3] <= 0.01) return null;
  if (crop[0] <= 0.0005 && crop[1] <= 0.0005 && crop[2] >= 0.999 && crop[3] >= 0.999) return null;
  return crop;
}

/** Pixel size label for an area, e.g. "1408 × 792" (frame 5). `scale` maps drawn px to capture px. */
export const areaLabel = (r, scale = 1) => `${Math.round(r.w * scale)} × ${Math.round(r.h * scale)}`;

// ---- where the pill goes (frame 8) ---------------------------------------------------------------------------------

/**
 * Top-left for the pill: 22 px under the recorded window or area, centred on it; for a whole display (or when
 * there's no room below) bottom-centre of the work area. Always inside `work`. Units: one pixel space.
 */
export function dockPill(target, work, pill, { gap = 22, margin = 12, display = false } = {}) {
  const centreX = (r) => r.x + (r.w - pill.w) / 2;
  let x, y;
  if (!display && target) {
    x = centreX(target);
    y = target.y + target.h + gap;
    if (y + pill.h > work.y + work.h - margin) {
      // No room under it: inside the bottom edge of the window, still clear of the content's centre.
      y = Math.min(target.y + target.h - pill.h - gap, work.y + work.h - pill.h - margin);
    }
  } else {
    x = centreX(work);
    y = work.y + work.h - pill.h - 48;
  }
  return {
    x: Math.round(clampN(x, work.x + margin, work.x + work.w - pill.w - margin)),
    y: Math.round(clampN(y, work.y + margin, work.y + work.h - pill.h - margin)),
  };
}

// ---- window size presets (frame 2) ----------------------------------------------------------------------------------

export const SIZE_PRESETS = Object.freeze([
  { id: 'native', label: 'Its size' },
  { id: '1920x1080', label: '1920×1080', w: 1920, h: 1080 },
  { id: '1280x720', label: '1280×720', w: 1280, h: 720 },
  { id: '9:16', label: '9:16', aspect: 9 / 16 },
]);

/**
 * The window size (physical px) a preset asks for on a monitor whose work area is `work`, or null for "Its size".
 * Fixed sizes shrink to the work area keeping their aspect; 9:16 takes 90% of the work area's height.
 */
export function presetSize(id, work) {
  const p = SIZE_PRESETS.find((s) => s.id === id);
  if (!p || p.id === 'native' || !work) return null;
  let w, h;
  if (p.aspect) { h = Math.floor(work.h * 0.9); w = Math.round(h * p.aspect); } else { w = p.w; h = p.h; }
  const k = Math.min(1, work.w / w, work.h / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** Centre a size on the window it replaces, inside the work area. */
export function placeResized(rect, size, work) {
  return clampRect({ x: Math.round(rect.x + (rect.w - size.w) / 2), y: Math.round(rect.y + (rect.h - size.h) / 2), w: size.w, h: size.h }, work);
}

// ---- matching what the browser shared ----------------------------------------------------------------------------

/**
 * Does a shared track's size match what was picked (a window or display, physical px)? Encoders round odd sizes
 * and window frames differ by a few pixels, so within `slack` px (or 2%) counts.
 */
export function sizeMatches(track, target, slack = 16) {
  if (!track?.width || !track?.height || !target?.w || !target?.h) return true; // unknown: don't nag
  const near = (a, b) => Math.abs(a - b) <= Math.max(slack, b * 0.02);
  return near(track.width, target.w) && near(track.height, target.h);
}

/** The window under a point: the first (top-most) of z-ordered windows that contains it. */
export function windowAt(windows, p) {
  return (windows || []).find((w) => p.x >= w.x && p.x < w.x + w.w && p.y >= w.y && p.y < w.y + w.h) || null;
}
