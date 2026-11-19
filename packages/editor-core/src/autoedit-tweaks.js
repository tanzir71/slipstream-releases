// Auto edit tweaks (ticket AE-08) and the output-time beat grid. Pure edits of a multi-clip edit's segments, so the
// web timeline tools (and later the desktop apps) change an Auto edit the same way: extend a clip into footage the edit
// left out, move a cut, bring back a left-out moment, replace a clip, land a move on the beat, lock. Every manual
// change locks the segments it touches, so Try another take, Pace, Rough length and Order re-solve around them
// (autoedit.solveAutoEdit with `previous`). No DOM, no media. Tested in test/autoedit-tweaks.test.mjs.
//
// Times: segment start/end and grid times are OUTPUT seconds; sourceIn and moments are clip seconds.
//   outputBeats(edit) -> { beats, downbeats, beat, bpm, sections } | null      song analysis through the music bed
//   barBeatAt(grid, t) -> { bar, beat }       snapTo(list, t)       stepBeats(grid, t, n)
//   trimSegment(edit, id, edge, grow, { mode: 'push'|'keep', durations, minLen })
//   moveCut(edit, index, delta, { durations, minLen })
//   insertMoment(edit, { asset, start, end }, at, { grid, durations })
//   replaceClip(edit, id, { asset, start }, { durations })
//   landOnBeat(edit, id, moveSource, grid)          toggleLock(edit, id)
//   fillCrops(edit, aspects, { tracks, sourceAspects })   AE-06: crops for segments missing one (cuts never move)
//   motionTrack(motion, duration)                    a focus track from motion.js centroids (the web has no faces)

import { sequenceSegments, segmentSpeed, packSegments, shiftTimeline, sequenceDuration, segmentIndexAt } from './edl.js';
import { reframeSegments, focusTrack } from './focus.js';

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const clone = (x) => JSON.parse(JSON.stringify(x));
const MIN_LEN = 0.2;

/**
 * Beats, downbeats and sections of the Auto edit's song on the output timeline: edit.autoEdit.music is in song
 * seconds, the music bed plays from music.trimIn at output music.start. null without an analysed song.
 */
export function outputBeats(edit) {
  const am = edit?.autoEdit?.music;
  if (!am || !Array.isArray(am.beats) || am.beats.length < 2) return null;
  const trimIn = Number(edit.music?.trimIn) || 0, start = Number(edit.music?.start) || 0;
  const end = sequenceDuration(edit.segments) || Infinity;
  const map = (b) => r6(b - trimIn + start);
  const inside = (t) => t >= -1e-6 && t <= end + 1e-6;
  const beats = am.beats.map(map).filter(inside);
  const downbeats = (am.downbeats || []).map(map).filter(inside);
  const gaps = am.beats.slice(1).map((b, i) => b - am.beats[i]).sort((a, b) => a - b);
  const beat = am.bpm > 0 ? 60 / am.bpm : gaps[gaps.length >> 1] || 0.5;
  const sections = (am.sections || []).map((s) => ({ ...s, start: map(s.start), end: map(s.end) })).filter((s) => s.end > 0 && s.start < end);
  return { beats, downbeats, beat: r6(beat), bpm: am.bpm || r6(60 / beat), sections };
}

/** The value in `list` nearest to t (list sorted), or t itself for an empty list. */
export function snapTo(list, t) {
  if (!list?.length) return t;
  let lo = 0, hi = list.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid] <= t) lo = mid; else hi = mid; }
  return Math.abs(list[lo] - t) <= Math.abs(list[hi] - t) ? list[lo] : list[hi];
}

/** 1-based bar and beat of output time t on the grid ("bar 5, beat 1"). */
export function barBeatAt(grid, t) {
  if (!grid) return null;
  const bar = Math.max(1, grid.downbeats.filter((d) => d <= t + 1e-6).length);
  const lastDown = [...grid.downbeats].reverse().find((d) => d <= t + 1e-6) ?? grid.beats[0] ?? 0;
  const beat = grid.beats.filter((b) => b >= lastDown - 1e-6 && b <= t + 1e-6).length || 1;
  return { bar, beat };
}

/** The grid time n beats from t (t snapped to the nearest beat first); past the grid, n·beat seconds. */
export function stepBeats(grid, t, n) {
  if (!grid) return t + n;
  const s = snapTo(grid.beats, t);
  const i = grid.beats.indexOf(s);
  const j = i + n;
  if (j >= 0 && j < grid.beats.length) return grid.beats[j];
  return r6(s + n * grid.beat);
}

const sorted = (edit) => sequenceSegments(edit.segments);
const durOf = (durations, asset) => (Number.isFinite(durations?.[asset]) ? durations[asset] : Infinity);
function withSegments(edit, segs) {
  const out = clone(edit);
  out.segments = [...segs, ...(Array.isArray(edit.segments) ? edit.segments.filter((s) => !(s && s.asset)) : [])];
  return out;
}

/**
 * Grow (grow > 0) or shrink one edge of a segment by `grow` output seconds; the segment is locked.
 * edge 'end' moves its out-point, 'start' its in-point (earlier footage when growing).
 * mode 'push': later segments and timeline items move with it (every later cut keeps its place relative to the beat
 * when grow is a whole number of beats). 'keep': the neighbour (next for 'end', previous for 'start') gives or takes
 * the same amount, so the length of the edit stays. Clamped to the clip's footage (durations[asset]) and minLen.
 */
export function trimSegment(edit, id, edge, grow, { mode = 'push', durations = {}, minLen = MIN_LEN } = {}) {
  const segs = sorted(edit).map((s) => ({ ...s }));
  const i = segs.findIndex((s) => s.id === id);
  if (i < 0 || !grow) return clone(edit);
  const s = segs[i], sp = segmentSpeed(s), len = s.end - s.start;
  let g = grow;
  if (edge === 'end') g = Math.min(g, (durOf(durations, s.asset) - s.sourceIn) / sp - len);
  else g = Math.min(g, s.sourceIn / sp);
  g = Math.max(g, minLen - len);
  const nb = mode === 'keep' ? segs[edge === 'end' ? i + 1 : i - 1] : null;
  if (nb) {
    const spN = segmentSpeed(nb), lenN = nb.end - nb.start;
    g = Math.min(g, lenN - minLen);
    if (edge === 'end') g = Math.max(g, -nb.sourceIn / spN); // the next clip can only grow back into its own footage
    else g = Math.max(g, -((durOf(durations, nb.asset) - nb.sourceIn) / spN - lenN));
  }
  if (Math.abs(g) < 1e-9) return clone(edit);
  if (edge === 'start') s.sourceIn = r6(s.sourceIn - g * sp);
  s.locked = true;
  if (nb) {
    nb.locked = true;
    if (edge === 'end') { s.end = r6(s.end + g); nb.start = r6(nb.start + g); nb.sourceIn = r6(nb.sourceIn + g * segmentSpeed(nb)); }
    else { s.start = r6(s.start - g); nb.end = r6(nb.end - g); }
    return withSegments(edit, segs);
  }
  const at = edge === 'end' ? s.end : s.start;
  s.end = r6(s.end + g);
  const packed = packSegments(segs.map((x, k) => (k === i ? { ...s, end: s.start + len + g } : x)));
  return withSegments(shiftTimeline(edit, edge === 'end' ? at : at + 1e-9, g), packed);
}

/** Move the cut between sorted segments index and index+1 by delta output seconds (both locked; the length stays). */
export function moveCut(edit, index, delta, { durations = {}, minLen = MIN_LEN } = {}) {
  const segs = sorted(edit).map((s) => ({ ...s }));
  const a = segs[index], b = segs[index + 1];
  if (!a || !b || !delta) return clone(edit);
  const spA = segmentSpeed(a), spB = segmentSpeed(b);
  let d = delta;
  d = Math.min(d, (durOf(durations, a.asset) - a.sourceIn) / spA - (a.end - a.start), b.end - b.start - minLen);
  d = Math.max(d, minLen - (a.end - a.start), -b.sourceIn / spB);
  if (Math.abs(d) < 1e-9) return clone(edit);
  a.end = r6(a.end + d); b.start = r6(b.start + d); b.sourceIn = r6(b.sourceIn + d * spB);
  a.locked = true; b.locked = true;
  return withSegments(edit, segs);
}

/**
 * Bring a left-out moment back: it lands at the nearest beat to `at` (or the nearest cut without music), whole beats
 * long with music, and later segments and items move right. Inserting inside a segment splits it. The new segment is
 * locked. moment = { asset, start, end } in clip seconds.
 */
export function insertMoment(edit, moment, at, { grid = null, durations = {} } = {}) {
  const segs = sorted(edit).map((s) => ({ ...s }));
  const cuts = [0, ...segs.map((s) => s.end)];
  let t = grid ? snapTo(grid.beats.filter((b) => b <= (cuts[cuts.length - 1] ?? 0) + 1e-6), at) : snapTo(cuts, at);
  t = Math.max(0, Math.min(cuts[cuts.length - 1] ?? 0, t));
  let len = Math.max(MIN_LEN, Math.min(moment.end, durOf(durations, moment.asset)) - moment.start);
  if (grid) len = Math.max(grid.beat, Math.round(len / grid.beat) * grid.beat);
  len = Math.min(len, durOf(durations, moment.asset) - moment.start);
  const ids = new Set(segs.map((s) => s.id));
  let n = segs.length + 1;
  while (ids.has(`s${n}`)) n++;
  const add = { id: `s${n}`, asset: moment.asset, sourceIn: r6(moment.start), start: r6(t), end: r6(t + len), locked: true };
  const out = [];
  for (const s of segs) {
    if (t > s.start + 1e-6 && t < s.end - 1e-6) {
      const sp = segmentSpeed(s);
      let m = 1;
      while (ids.has(`${s.id}.${m}`)) m++;
      out.push({ ...s, end: r6(t) }, add, { ...s, id: `${s.id}.${m}`, start: r6(t), sourceIn: r6(s.sourceIn + (t - s.start) * sp) });
    } else if (Math.abs(s.start - t) <= 1e-6 && !out.includes(add)) out.push(add, s);
    else out.push(s);
  }
  if (!out.includes(add)) out.push(add);
  return withSegments(shiftTimeline(edit, t, len), packSegments(out));
}

/** Swap the clip a segment plays, keeping its place and length (clamped to the new footage). Locked. */
export function replaceClip(edit, id, moment, { durations = {} } = {}) {
  const segs = sorted(edit).map((s) => ({ ...s }));
  const s = segs.find((x) => x.id === id);
  if (!s) return clone(edit);
  const need = (s.end - s.start) * segmentSpeed(s);
  const dur = durOf(durations, moment.asset);
  s.asset = moment.asset;
  s.sourceIn = r6(Math.max(0, Math.min(moment.start, dur - need)));
  delete s.crops;
  s.locked = true;
  return withSegments(edit, segs);
}

/** Slide a segment's footage so the move at clip time moveSource lands on the nearest beat inside it. Locked. */
export function landOnBeat(edit, id, moveSource, grid, { durations = {} } = {}) {
  if (!grid) return clone(edit);
  const segs = sorted(edit).map((s) => ({ ...s }));
  const s = segs.find((x) => x.id === id);
  if (!s) return clone(edit);
  const sp = segmentSpeed(s);
  const at = s.start + (moveSource - s.sourceIn) / sp;
  const target = snapTo(grid.beats.filter((b) => b >= s.start && b <= s.end), at);
  const need = (s.end - s.start) * sp;
  s.sourceIn = r6(Math.max(0, Math.min(durOf(durations, s.asset) - need, moveSource - (target - s.start) * sp)));
  s.locked = true;
  return withSegments(edit, segs);
}

/** Lock or unlock a segment. */
export function toggleLock(edit, id, on = null) {
  const out = clone(edit);
  for (const s of out.segments || []) if (s && s.id === id) { const v = on ?? !s.locked; if (v) s.locked = true; else delete s.locked; }
  return out;
}

/** Index of the cut nearest to output time t (the cut after sorted segment i), or -1. */
export function cutIndexNear(edit, t) {
  const segs = sorted(edit);
  let best = -1, d = Infinity;
  for (let i = 0; i + 1 < segs.length; i++) { const e = Math.abs(segs[i].end - t); if (e < d) { d = e; best = i; } }
  return best;
}

/**
 * Reframing on the surface (AE-06): every segment without a crop for one of `aspects` (an id or a list) gets one from
 * focus.reframeSegments, using tracks[asset] (see motionTrack; a missing track centres the crop) and
 * sourceAspects[asset] (width / height). Crops a segment already has, its cut, speed and source range never change.
 */
export function fillCrops(edit, aspects, { tracks = {}, sourceAspects = {} } = {}) {
  const list = Array.isArray(aspects) ? aspects : [aspects];
  const out = clone(edit);
  for (const aspect of list) {
    const need = (out.segments || []).filter((s) => s && s.asset && !(s.crops && Array.isArray(s.crops[aspect])));
    if (!need.length) continue;
    const made = new Map(reframeSegments(need, { tracks, sourceAspects, aspects: [aspect] }).map((s) => [s.id, s.crops[aspect]]));
    for (const s of out.segments) if (s && made.has(s.id)) s.crops = { ...(s.crops || {}), [aspect]: made.get(s.id) };
  }
  return out;
}

/** A focus track for a clip from its motion analysis (motion.js: { fps, centroid }), or null without one. */
export function motionTrack(motion, duration) {
  if (!motion || !Array.isArray(motion.centroid)) return null;
  return focusTrack({ duration: duration || motion.duration || motion.centroid.length / (motion.fps || 10), fps: motion.fps || 10, centroids: motion.centroid });
}

export { segmentIndexAt };
