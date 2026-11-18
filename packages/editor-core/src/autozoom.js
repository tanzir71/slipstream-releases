// Automatic zooms. zoomsFromActivity turns on-screen activity (frame diffs) into zoom regions: the web's approach,
// since a browser can't see the pointer. zoomsFromCursor plans them from clicks recorded by the desktop apps
// (T-04 / T-10 on Windows/Linux, M-09 on macOS). Pure functions; unit-tested in packages/editor-core/test/.
import { uid } from './edl.js';

/**
 * events: [{ t, x, y, w, h, area }] normalized (see media.activityEvents)
 * Returns zoom regions [{ id, start, end, scale, x, y, auto: true }].
 */
export function zoomsFromActivity(events, duration, { sensitivity = 0.5, minLen = 1.8, maxLen = 7, maxBox = 0.8 } = {}) {
  const minArea = 0.0002 + (1 - sensitivity) * 0.0016;
  const useful = events.filter((e) => e.area >= minArea && (e.global ?? e.area) <= 0.35 && e.w <= 0.85 && e.h <= 0.85);
  const groups = [];
  for (const e of useful) {
    const g = groups[groups.length - 1];
    if (g && e.t - g.last <= 1.1 && Math.abs(e.x - g.cx) < 0.22 && Math.abs(e.y - g.cy) < 0.22) {
      g.items.push(e);
      g.last = e.t;
      g.cx = g.items.reduce((s, i) => s + i.x, 0) / g.items.length;
      g.cy = g.items.reduce((s, i) => s + i.y, 0) / g.items.length;
    } else {
      groups.push({ items: [e], first: e.t, last: e.t, cx: e.x, cy: e.y });
    }
  }
  const zooms = [];
  for (const g of groups) {
    if (g.items.length < 2 && Math.max(...g.items.map((i) => i.area)) < 0.0025) continue;
    const x0 = Math.min(...g.items.map((i) => i.x - i.w / 2)), x1 = Math.max(...g.items.map((i) => i.x + i.w / 2));
    const y0 = Math.min(...g.items.map((i) => i.y - i.h / 2)), y1 = Math.max(...g.items.map((i) => i.y + i.h / 2));
    const bw = x1 - x0, bh = y1 - y0;
    // A panel or menu opening (up to most of the screen) still earns a gentle push-in; whole-screen changes don't.
    if (Math.max(bw, bh) > maxBox) continue;
    // Restrained by default: 1.35-2x reads as a camera move, not a jump cut.
    const scale = Math.max(1.35, Math.min(2.0, 0.6 / Math.max(bw, bh, 0.12)));
    let start = Math.max(0, g.first - 0.5);
    let end = Math.min(duration, g.last + 1.3);
    if (end - start < minLen) end = Math.min(duration, start + minLen);
    if (end - start > maxLen) end = start + maxLen;
    const prev = zooms[zooms.length - 1];
    if (prev && start < prev.end + 0.6) {
      if (Math.abs(prev.x - g.cx) < 0.12 && Math.abs(prev.y - g.cy) < 0.12) { prev.end = Math.min(duration, Math.max(prev.end, end)); continue; }
      start = prev.end + 0.6;
      end = Math.max(end, Math.min(duration, start + minLen));
      if (end - start < minLen * 0.8) continue;
    }
    zooms.push({ id: uid('z'), start, end, scale: Math.round(scale * 10) / 10, x: (x0 + x1) / 2, y: (y0 + y1) / 2, auto: true });
  }
  return zooms;
}

/**
 * Find the dominant changed region between two luminance frames. Changes are binned into a coarse grid;
 * the busiest cell and its busy neighbours form the region, so a ticking clock elsewhere on screen does
 * not drag the zoom target away from where the user is working.
 */
export function dominantChange(lum, prev, w, h, { threshold = 24, gx = 16, gy = 10 } = {}) {
  const cells = new Uint32Array(gx * gy);
  let total = 0;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(gy - 1, ((y * gy) / h) | 0);
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const d = lum[k] - prev[k];
      if (d > threshold || d < -threshold) { cells[cy * gx + Math.min(gx - 1, ((x * gx) / w) | 0)]++; total++; }
    }
  }
  if (!total) return null;
  const globalArea = total / (w * h);
  let best = 0;
  for (let i = 1; i < cells.length; i++) if (cells[i] > cells[best]) best = i;
  const cut = Math.max(2, cells[best] * 0.22);
  const seen = new Uint8Array(cells.length);
  const stack = [best];
  seen[best] = 1;
  let minX = gx, minY = gy, maxX = -1, maxY = -1, n = 0;
  while (stack.length) {
    const c = stack.pop();
    const cx = c % gx, cy = (c / gx) | 0;
    n += cells[c];
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
      const j = ny * gx + nx;
      if (!seen[j] && cells[j] >= cut) { seen[j] = 1; stack.push(j); }
    }
  }
  return {
    x: (minX + maxX + 1) / 2 / gx, y: (minY + maxY + 1) / 2 / gy,
    w: (maxX - minX + 1) / gx, h: (maxY - minY + 1) / gy,
    area: n / (w * h), global: globalArea,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Cursor samples: [{ t, x, y, click }], t in seconds on the source timeline, x/y 0..1 of the recorded screen
// (top-left origin), click true on primary-button presses.

/** zoomsFromCursor defaults: the macOS app's behaviour (CursorZoomOptions in desktop/macos/.../Zoom.swift). */
export const CURSOR_ZOOM = Object.freeze({
  ramp: 0.65, // smootherstep ease in and out, seconds; written to each zoom's `ramp`
  lead: 0.15, // fully zoomed in this long before the first click of a cluster
  hold: 1.2, // hold after the last click before easing out
  minScale: 1.35,
  maxScale: 2,
  clusterGap: 1.6, // a click joins the cluster when it comes within this many seconds of the previous click…
  clusterRadius: 0.2, // …and lands within this distance (each axis) of the cluster's centroid
  minStart: 1, // never zoom during the first second
  minLength: 1.8,
  maxLength: 8,
  mergeGap: 0.6, // zooms closer than this merge (same spot) or are pushed apart, like zoomsFromActivity
  sameSpot: 0.12,
  moveWindow: 0.3, // pointer positions this long around a cluster widen its framing box
});

// A sample stands for the pointer until the next one while the pointer stays put (a compacted stretch at rest),
// else for at most this long (gaps: pointer on another screen, paused take).
const MAX_HOLD = 0.1;
// Swift widens the box only with at least 3 pointer samples (~0.1 s at its 20 Hz); here, 0.1 s of positions.
const MIN_COVER = 0.1;

const isSample = (s) => !!s && Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Time-weighted pointer positions over [a, b] from samples sorted by t. */
function positionsBetween(pts, a, b) {
  let lo = 0, hi = pts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < a) lo = mid + 1; else hi = mid; }
  const items = [];
  let total = 0;
  for (let i = Math.max(0, lo - 1); i < pts.length && pts[i].t <= b; i++) {
    const s = pts[i], n = pts[i + 1];
    const until = n ? (n.x === s.x && n.y === s.y ? n.t : Math.min(n.t, s.t + MAX_HOLD)) : s.t + MAX_HOLD;
    const w = Math.min(until, b) - Math.max(s.t, a);
    if (w > 0) { items.push({ x: s.x, y: s.y, w }); total += w; }
  }
  return { items, total };
}

function weightedPercentile(items, total, key, p) {
  const sorted = items.map((i) => [i[key], i.w]).sort((m, n) => m[0] - n[0]);
  let acc = 0;
  for (const [v, w] of sorted) { acc += w; if (acc >= p * total - 1e-12) return v; }
  return sorted[sorted.length - 1][0];
}

/**
 * One zoom per click cluster, from cursor samples. Port of AutoZoom.zoomsFromCursor (macOS, M-09):
 * 1. Clicks (sorted, outside 0..duration ignored) form clusters: a click joins the current one when it comes within
 *    clusterGap s of the cluster's previous click, lands within clusterRadius of its centroid on both axes, and the
 *    cluster still fits in maxLength.
 * 2. The framing box is the clicks' bounding box, widened by where the pointer was from moveWindow s before the first
 *    click to moveWindow s after the last (10th–90th percentile, so a quick flick doesn't count).
 * 3. Scale = clamp(0.6 / max(box w, box h, 0.12), 1.35, 2), rounded to 0.1 (zoomsFromActivity's formula): a single
 *    click gets 2x, work spread over a panel a gentle push-in. Focus = the box centre.
 * 4. Timing: fully in `lead` s before the first click (after a `ramp` s ease), held `hold` s after the last click,
 *    then eased out. Never before minStart; minLength..maxLength long; clamped to the duration (dropped under 80 %
 *    of minLength).
 * 5. Merged like zoomsFromActivity: a zoom starting within mergeGap of the previous one extends it on the same spot
 *    (within sameSpot), otherwise starts mergeGap after it (dropped if that leaves under 80 % of minLength).
 * Pointer positions are time-weighted, so compacted samples (compactCursorSamples) plan the same zooms as the raw
 * 60 Hz stream. Returns [{ id, start, end, scale, x, y, ramp, auto: true }].
 */
export function zoomsFromCursor(samples, duration, opts = {}) {
  const o = { ...CURSOR_ZOOM, ...opts };
  if (!(duration > 0) || !Array.isArray(samples)) return [];
  const pts = samples.filter(isSample).sort((a, b) => a.t - b.t);
  const clicks = pts.filter((s) => s.click && s.t >= 0 && s.t <= duration);
  const span = Math.max(0, o.maxLength - o.ramp * 2 - o.lead - o.hold);
  const clusters = [];
  for (const c of clicks) {
    const g = clusters[clusters.length - 1];
    if (g) {
      const cx = g.reduce((s, i) => s + i.x, 0) / g.length, cy = g.reduce((s, i) => s + i.y, 0) / g.length;
      if (c.t - g[g.length - 1].t <= o.clusterGap && Math.abs(c.x - cx) < o.clusterRadius && Math.abs(c.y - cy) < o.clusterRadius && c.t - g[0].t <= span) {
        g.push(c);
        continue;
      }
    }
    clusters.push([c]);
  }
  const zooms = [];
  for (const g of clusters) {
    const first = g[0].t, last = g[g.length - 1].t;
    let x0 = Math.min(...g.map((c) => c.x)), x1 = Math.max(...g.map((c) => c.x));
    let y0 = Math.min(...g.map((c) => c.y)), y1 = Math.max(...g.map((c) => c.y));
    const around = positionsBetween(pts, first - o.moveWindow, last + o.moveWindow);
    if (around.total >= MIN_COVER) {
      x0 = Math.min(x0, weightedPercentile(around.items, around.total, 'x', 0.1));
      x1 = Math.max(x1, weightedPercentile(around.items, around.total, 'x', 0.9));
      y0 = Math.min(y0, weightedPercentile(around.items, around.total, 'y', 0.1));
      y1 = Math.max(y1, weightedPercentile(around.items, around.total, 'y', 0.9));
    }
    x0 = clamp(x0, 0, 1); x1 = clamp(x1, 0, 1); y0 = clamp(y0, 0, 1); y1 = clamp(y1, 0, 1);
    const scale = Math.round(clamp(0.6 / Math.max(x1 - x0, y1 - y0, 0.12), o.minScale, o.maxScale) * 10) / 10;
    const fx = (x0 + x1) / 2, fy = (y0 + y1) / 2;
    let start = Math.max(o.minStart, first - o.ramp - o.lead);
    let end = Math.min(duration, last + o.hold + o.ramp);
    if (end - start < o.minLength) end = Math.min(duration, start + o.minLength);
    if (end - start > o.maxLength) end = start + o.maxLength;
    if (end - start < o.minLength * 0.8) continue;
    const prev = zooms[zooms.length - 1];
    if (prev && start < prev.end + o.mergeGap) {
      if (Math.abs(prev.x - fx) < o.sameSpot && Math.abs(prev.y - fy) < o.sameSpot) { prev.end = Math.min(duration, Math.max(prev.end, end)); continue; }
      start = prev.end + o.mergeGap;
      end = Math.max(end, Math.min(duration, start + o.minLength));
      if (end - start < o.minLength * 0.8) continue;
    }
    zooms.push({ id: uid('z'), start, end, scale, x: fx, y: fy, ramp: o.ramp, auto: true });
  }
  return zooms;
}

/** True when cursor samples include at least one click (zoomsFromCursor has something to plan from). */
export function hasCursorClicks(samples) {
  return Array.isArray(samples) && samples.some((s) => s?.click === true && isSample(s));
}

/**
 * Cursor samples as stored with a project: sorted by time, t/x/y rounded to 3 decimals (x/y clamped to 0..1),
 * `click: true` only on presses (left out otherwise), and a pointer at rest kept as the first and last sample of the
 * stretch, so the path is unchanged while a still pointer costs nothing.
 */
export function compactCursorSamples(samples) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const src = (Array.isArray(samples) ? samples : []).filter(isSample)
    .map((s) => ({ t: r3(s.t), x: r3(clamp(s.x, 0, 1)), y: r3(clamp(s.y, 0, 1)), click: s.click === true }))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const s of src) {
    const n = out.length;
    const item = s.click ? { t: s.t, x: s.x, y: s.y, click: true } : { t: s.t, x: s.x, y: s.y };
    if (!s.click && n >= 2) {
      const a = out[n - 2], b = out[n - 1];
      if (!b.click && a.x === b.x && a.y === b.y && b.x === s.x && b.y === s.y) { out[n - 1] = item; continue; }
    }
    out.push(item);
  }
  return out;
}
