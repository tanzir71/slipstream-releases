// Scenes (ticket S-01): per-segment layout overrides with eased transitions, plus an automatic plan that
// shows the camera full-frame while the screen is static and someone is talking, and brings the screen
// back (bubble or split) when something happens on it. Pure: no DOM, no media. Tested in test/scenes.test.mjs.

import { smootherstep, uid } from './edl.js';

export const SCENE_RAMP = 0.4; // seconds for a layout transition
export const SCENE_MODES = ['pip', 'split', 'screen', 'camera'];

export function sortScenes(scenes) {
  return (scenes || []).filter((s) => s && s.end > s.start).slice().sort((a, b) => a.start - b.start);
}

/** The scene covering source time t, or null. Later scenes win on overlap. */
export function sceneAt(scenes, t) {
  let hit = null;
  for (const s of scenes || []) if (t >= s.start && t < s.end) hit = s;
  return hit;
}

/** Global layout merged with the scene override at t. */
export function layoutAt(edit, t) {
  const s = sceneAt(edit.scenes, t);
  return s ? { ...edit.layout, ...s.layout } : edit.layout;
}

const sameLayout = (a, b) => a.mode === b.mode && a.corner === b.corner && a.shape === b.shape && Math.abs((a.size ?? 0) - (b.size ?? 0)) < 1e-6 && Math.abs((a.split ?? 0) - (b.split ?? 0)) < 1e-6;

/**
 * Layout blend at t: { from, to, k } where k in [0,1] eases from `from` to `to` over `ramp` seconds after
 * each scene boundary. Outside transitions from === to and k === 1.
 */
export function layoutBlendAt(edit, t, ramp = SCENE_RAMP) {
  const to = layoutAt(edit, t);
  if (!edit.scenes?.length || ramp <= 0) return { from: to, to, k: 1 };
  let boundary = -Infinity;
  for (const s of edit.scenes) {
    if (s.start <= t && s.start > boundary) boundary = s.start;
    if (s.end <= t && s.end > boundary) boundary = s.end;
  }
  if (!(t - boundary < ramp) || boundary <= 0) return { from: to, to, k: 1 };
  const from = layoutAt(edit, boundary - 1e-6);
  if (sameLayout(from, to)) return { from: to, to, k: 1 };
  return { from, to, k: smootherstep((t - boundary) / ramp) };
}

/** Replace or insert a scene for [start, end), trimming overlapping scenes. Returns a new array. */
export function setScene(scenes, start, end, layout) {
  const out = [];
  for (const s of sortScenes(scenes)) {
    if (s.end <= start || s.start >= end) { out.push(s); continue; }
    if (s.start < start) out.push({ ...s, end: start });
    if (s.end > end) out.push({ ...s, id: uid('sc'), start: end });
  }
  if (layout) out.push({ id: uid('sc'), start, end, layout: { ...layout } });
  return sortScenes(out);
}

/**
 * Automatic scenes from screen activity and speech.
 * activity: [{ t }] change events (autozoom.dominantChange output over time); words: transcript words.
 * Returns scenes that differ from the global layout only. The camera is required.
 */
export function autoScenes(activity, words, duration, { base = { mode: 'pip' }, active = null, minLen = 3, hold = 1.5, speechGap = 1.2, minArea = 0.0015 } = {}) {
  if (!(duration > 0)) return [];
  const n = Math.ceil(duration);
  const busy = new Uint8Array(n), talk = new Uint8Array(n);
  for (const e of activity || []) {
    // A moving pointer alone (a few pixels of change) doesn't make the screen "busy".
    if (e.area != null && e.area < minArea) continue;
    const a = Math.max(0, Math.floor(e.t - hold)), b = Math.min(n - 1, Math.floor(e.t + hold));
    for (let i = a; i <= b; i++) busy[i] = 1;
  }
  const live = (words || []).filter((w) => !w.deleted);
  for (let i = 0; i < live.length; i++) {
    const w = live[i], next = live[i + 1];
    const end = next && next.start - w.end < speechGap ? next.start : w.end;
    for (let s = Math.floor(w.start); s <= Math.min(n - 1, Math.floor(end)); s++) talk[s] = 1;
  }
  const activeLayout = active || (base.mode === 'camera' || base.mode === 'screen' ? { mode: 'pip' } : { mode: base.mode });
  // 'cam' when only talking, 'scr' when the screen is busy, otherwise keep the previous state
  const label = new Array(n);
  let prev = 'scr';
  for (let i = 0; i < n; i++) {
    const l = busy[i] ? 'scr' : talk[i] ? 'cam' : prev;
    label[i] = l; prev = l;
  }
  // runs, then absorb runs shorter than minLen into their neighbours
  let runs = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && last.l === label[i]) last.end = i + 1; else runs.push({ l: label[i], start: i, end: i + 1 });
  }
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.end - r.start >= minLen) continue;
      const left = runs[i - 1], right = runs[i + 1];
      const into = !left ? right : !right ? left : (left.end - left.start >= right.end - right.start ? left : right);
      into.start = Math.min(into.start, r.start); into.end = Math.max(into.end, r.end);
      runs.splice(i, 1);
      changed = true;
      break;
    }
    const merged = [];
    for (const r of runs) { const last = merged[merged.length - 1]; if (last && last.l === r.l) last.end = r.end; else merged.push(r); }
    runs = merged;
  }
  const want = { cam: { mode: 'camera' }, scr: activeLayout };
  return runs
    .map((r) => ({ id: uid('sc'), start: r.start, end: Math.min(duration, r.end), layout: { ...want[r.l] }, auto: true }))
    .filter((s) => s.layout.mode !== base.mode && s.end - s.start > 0.5);
}

const lerp = (a, b, k) => a + (b - a) * k;
/** Linear blend of two rectangles {x,y,w,h}; a missing side grows from/shrinks to the other's centre. */
export function lerpRect(a, b, k) {
  if (!a && !b) return null;
  if (!a) a = { x: b.x + b.w / 2, y: b.y + b.h / 2, w: 0, h: 0 };
  if (!b) b = { x: a.x + a.w / 2, y: a.y + a.h / 2, w: 0, h: 0 };
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
}

/**
 * Multi-camera angle switching by speaker (S-03): one full-frame camera scene per speaker turn, showing the
 * angle assigned to that speaker. angleBySpeaker = { S1: 'camera', S2: 'cam-guest' }. Turns shorter than
 * minLen merge into the previous scene so the edit doesn't flicker. Returns scenes like setScene() makes.
 */
export function speakerScenes(words, angleBySpeaker, duration, { minLen = 2, mode = 'camera', lead = 0.15 } = {}) {
  const live = (words || []).filter((w) => !w.deleted && w.speaker && angleBySpeaker[w.speaker]);
  const runs = [];
  for (const w of live) {
    const angle = angleBySpeaker[w.speaker];
    const last = runs[runs.length - 1];
    if (last && last.angle === angle) last.end = w.end;
    else runs.push({ angle, start: w.start, end: w.end });
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r.end - r.start < minLen || last.angle === r.angle)) { last.end = r.end; continue; }
    merged.push({ ...r });
  }
  // Cut slightly before each new speaker starts, and hold each angle until the next one begins.
  return merged.map((r, i) => ({
    id: uid('sc'),
    start: i === 0 ? 0 : Math.max(0, r.start - lead),
    end: i === merged.length - 1 ? duration : Math.max(0, merged[i + 1].start - lead),
    layout: { mode, angle: r.angle },
    auto: true,
  })).filter((s) => s.end - s.start > 0.2);
}
