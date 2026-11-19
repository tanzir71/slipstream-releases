// Auto edit: cut a set of clips to the motion in them, and to the beat when there is music (tickets AE-04 solver,
// AE-05 rough length). Pure: no DOM, no media. Inputs are the cached analyses (motion.js per clip, beats.js for the
// song, the transcript per clip); the output is plan-shaped segments (docs/handover/auto-edit.md → Edit plan) plus the
// "why" of every cut, the Left out tray and the keep map. The Swift and Rust ports re-implement this against
// test/parity/autoedit.json. Same inputs + settings + seed → the same edit, always.
//
// Public API
//   solveAutoEdit({ clips, music?, settings?, previous? }) -> AutoEditResult          the one-press entry point
//   roughCut(clips, opts) -> RoughCut                                                 AE-05 cut-first pipeline only
//   resolveLength({ total, preset?, target?, music? }) -> { preset, target, keepMost, window }
//   autoTarget(total) -> seconds          lengthPresets(total, { music }) -> preset ids
//   presetSeconds(id) -> seconds | Infinity ('song') | null ('auto', 'most'; 'keep' is read as 'most')
//   paceValue(p) / paceShot(p) / paceBeats(p, meter) / photoHold(p)
//   hash01(seed, a, b) -> [0, 1)          the deterministic jitter behind "Try another take"
//   DEFAULT_SETTINGS, PACE, SPEED_MIN, SPEED_MAX, LONG_FOOTAGE, REASONS
//
// Types
//   Clip = {
//     id: string, kind: 'video' | 'photo', duration?: number (s, video),
//     motion?: MotionAnalysis (motion.js; { fps, curve, raw?, scale?, moves?, centroid? }),
//     words?: Word[] (this clip's transcript, source seconds; deleted words are ignored),
//     quality?: number (0..1, clips.frameQuality score; default 0.6),
//     peaks?: number[], peaksPerSec?: number (audio envelope for clips.energyRatio), activity?: ActivityEvent[],
//     faces?: [{ t, boxes: [[x, y, w, h]] }], aspect?: number (source width / height, default 16/9),
//     repeats?: [{ start, end }] (points made twice from the user's model; replaces clarity.js for this clip)
//   }
//   Settings (plan `autoEdit`): { match: 'beat'|'motion'|'both', length: { preset, target? }, pace: 0..1 | 'relaxed'|
//     'balanced'|'energetic', order: 'mine'|'energy', cutFirst: { pauses, retakes, idle, repeats }, sentences: boolean,
//     keepClipSound: boolean, transitions: { punch, flash, sectionFade }, seed: integer, aspects?: string[] }
//   previous = { segments: Segment[], trimIn?: number } (or just the segments): segments with locked: true stay.
//   Segment = { id, asset, sourceIn, start, end, speed, crops: { [aspect]: [x, y, w, h] }, photoMotion, locked }
//     start/end are output seconds; the source range is [sourceIn, sourceIn + (end − start)·speed].
//   AutoEditResult = {
//     segments: Segment[], why: [{ id, text, kind, bar?, beat?, onDownbeat?, moveAt? }] (one per segment, same order),
//     leftOut: [{ asset, start, end, score, highMotion, minor, kind, reason }] (best first),
//     keepMap: { total, kept, removed: { pauses, retakes, idle, repeats, lowScore, unused },
//                ranges: [{ asset, start, end, kept, reason }], chapters: [{ start, title }] },
//     duration, target, music: { trimIn, bpm, clearBeat, beats, downbeats } | null (beats/downbeats in OUTPUT time),
//     autoEdit: plan `autoEdit` object (settings + music analysis: bpm, beats, downbeats, sections in song time)
//   }
//
// How it cuts (see docs/handover/auto-edit.md for the product rules)
//   Units. Each video clip is tiled into units, in source order: sentences of its transcript (highlights.sentences,
//   whole, so cuts land between sentences), retakes (edl.detectRetakes, the earlier take), points made twice
//   (clarity.js 'repeat', only when cutFirst.repeats), and the footage between them. A gap of ≥ 0.75 s between words
//   keeps 0.125 s on either side with the speech; the rest is classified by motion: moves (motion.js) become
//   'move' units that start 0.4 s before the move starts and end after it settles (rough mode: about one paced shot),
//   still stretches become 'pause' (clips with speech) or 'idle' (clips without), the rest 'plain' footage in
//   paced chunks. Photos are one unit of photoHold(pace) seconds. Unit boundaries are always between words, so no
//   cut lands mid-word.
//   Without music (rough mode): units are removed in the cut-first order — pauses (longest first), retakes, idle,
//   repeats, then the lowest-scoring content (sentences, moves, plain footage, photos; a clip's last content unit is
//   protected) — until the total reaches the target, never removing a unit that would land further below the target
//   than stopping leaves above it. "Keep most" runs only the first three steps. Units of a step that is turned off
//   stay. Kept units then become segments at 1.0× in the user's order ('mine'), or by rising energy ('energy').
//   With music: the window (bestWindow) is split into slots of paceBeats() beats (or twice that); a dynamic program
//   over (beat, unit) fills every slot with one unit so that the total of
//     quality + alignment − retime cost − repetition + energy fit (+ seeded jitter, − a small pace penalty)
//   is highest. Alignment: the unit's biggest move lands on a beat inside the slot (extra for a downbeat at a section
//   start with match 'both', and for the move's start or settle also landing on a beat) at a speed in 0.88–1.12
//   (units with speech stay at 1.0). Every cut is on a beat. 'mine' keeps the source order (a monotone DP); 'energy'
//   gives calm units to calm sections and the biggest to the chorus (units and sections are matched by energy rank,
//   then a monotone DP per section) and never puts the same clip twice in a row.
//   Locks: locked segments come back exactly as they were (output start and end, source range, speed, crops) on every
//   re-solve — seed, pace, rough length, order, match, with or without music; the solver fills around them. With
//   music the free slots are beats as usual. Without music the output time between locks is split into spans that
//   are filled exactly (solveRoughLocked: cut first per span, then trim, extend, bring back moments, hold on the
//   previous locked shot for a span under 0.6 s, borrow unused footage). If the rough length is shorter than the locks
//   need, the locks win: the edit runs to the end of the last lock and that lock's `why` says so (lengthGrew: true).
//   Determinism: DP rows go in increasing beat index, columns in order, slot lengths short to long; a state is only
//   replaced on value > best + 1e-9. Jitter = 0.3·(hash01(seed, unit, slot) − 0.5).

import { detectRetakes, normalizeWord, HARD_FILLERS, wordIdOf, MIN_RANGE } from './edl.js';
import { sentences, suggestChapters, titleFrom } from './highlights.js';
import { clarityCuts, STOP_WORDS } from './clarity.js';
import { energyRatio, activityRate } from './clips.js';
import { findMoves, NOISE_FLOOR, STRONG_MOVE } from './motion.js';
import { bestWindow, barLength } from './beats.js';
import { focusTrack, segmentCrops, AUTO_ASPECTS } from './focus.js';

export const LONG_FOOTAGE = 600;
export const PACE = Object.freeze({ relaxed: 0, balanced: 0.5, energetic: 1 });
export const SPEED_MIN = 0.88;
export const SPEED_MAX = 1.12;
export const REASONS = Object.freeze(['pauses', 'retakes', 'idle', 'repeats', 'lowScore']);
export const DEFAULT_SETTINGS = Object.freeze({
  match: 'motion',
  length: { preset: 'auto' },
  pace: 0.5,
  order: 'mine',
  cutFirst: { pauses: true, retakes: true, idle: true, repeats: false },
  sentences: true,
  keepClipSound: true,
  transitions: { punch: false, flash: false, sectionFade: true },
  seed: 1,
});

const EPS = 1e-9;
const MIN_GAP = 0.75;      // a pause between words at least this long can be cut…
const KEEP_PAUSE = 0.25;   // …keeping this much of it (half on each side)
const LEAD = 0.4;          // cut this long before a move starts (0.3–0.5 s)
const IDLE_CURVE = 0.15;   // normalised motion under this…
const IDLE_RAW = NOISE_FLOOR; // …or raw energy under this (luma levels) is "nothing happens"
const MIN_SEG = 0.3;       // kept fragments shorter than this between removed units go too
const BUSY = 1.5;          // silence with speech around it is content only above 1.5 × the clip's median motion
const DIVERSITY = 0.12;    // music: the r-th best unit of a clip (from 0) costs r × this, so every clip gets used
const JITTER = 0.3;
const RETIME = 0.5;        // cost of a full 12 % retime
const TWO_POINT = 0.4;     // bonus when the move's start or settle also lands on a beat
const PACE_PENALTY = 0.25; // per extra multiple of the paced slot length
const SHORT_PENALTY = 2;   // slots shorter than the pace (only to fill odd gaps between locks), per missing fraction
const REPEAT_CLIP = 0.6;   // same clip twice in a row ('mine' order)
const REUSE = 0.8;         // using a unit a second time (not enough footage for the music)
const PROTECT = 10;        // a clip's last content unit
const CONTENT = new Set(['speech', 'move', 'plain', 'photo']);
const REASON_OF = { pause: 'pauses', retake: 'retakes', idle: 'idle', repeat: 'repeats' };

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- seeds, pace, length --------------------------------------------------------------------------

function mix32(x) {
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Deterministic [0, 1) from three integers (fmix32 of the seed, then of each index × a golden-ratio constant). */
export function hash01(seed, a, b) {
  let h = mix32((seed | 0) ^ 0x9e3779b9);
  h = mix32(h ^ Math.imul((a | 0) + 1, 0x9e3779b1));
  h = mix32(h ^ Math.imul((b | 0) + 1, 0x85ebca77));
  return h / 4294967296;
}

/** Pace as 0..1 (relaxed 0, balanced 0.5, energetic 1). */
export function paceValue(p) {
  if (typeof p === 'string') return PACE[p] ?? 0.5;
  return Number.isFinite(p) ? clamp(p, 0, 1) : 0.5;
}

/** Seconds per shot without music: 8 s (relaxed) → 5 s (balanced) → 2.5 s (energetic), linear in between. */
export function paceShot(p) {
  const v = paceValue(p);
  return v <= 0.5 ? 8 - 6 * v : 5 - 5 * (v - 0.5);
}

/** Beats per slot with music: a bar (relaxed, pace < 1/3), 2 beats (balanced), 1 beat (energetic, pace ≥ 2/3). */
export function paceBeats(p, meter = 4) {
  const v = paceValue(p);
  return v < 1 / 3 ? meter : v < 2 / 3 ? 2 : 1;
}

/** How long a photo holds without music: 3 s (relaxed) to 2 s (energetic). With music: 2–4 beats. */
export function photoHold(p) {
  return 3 - paceValue(p);
}

/** About 26 % of the footage clamped to 15–90 s under 10 min; about 20 % clamped to 3–20 min from 10 min. */
export function autoTarget(total) {
  if (!(total > 0)) return 0;
  const t = total < LONG_FOOTAGE ? clamp(0.26 * total, 15, 90) : clamp(0.2 * total, 180, 1200);
  return Math.min(total, t);
}

/** Rough length presets for the panel. */
export function lengthPresets(total, { music = false } = {}) {
  if (music) return ['15s', '30s', '60s', 'song'];
  return total < LONG_FOOTAGE ? ['auto', '30s', '1m', 'most'] : ['auto', '5m', '10m', '20m', 'most'];
}

/** '30s' → 30, '10m' → 600, 'song' → Infinity, anything else (auto, most) → null. */
export function presetSeconds(preset) {
  if (preset === 'song') return Infinity;
  const m = /^(\d+(?:\.\d+)?)(s|m)$/.exec(String(preset || ''));
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : null;
}

/**
 * The target length. 'most' (or the older 'keep') → keepMost (no target); null → 'auto'. With music the music wins: the preset's length ('auto' = the
 * whole song), snapped to bars by beats.bestWindow, which also picks where in the song. 'custom' uses `target`.
 * Without music, 'auto' = autoTarget(total). Never longer than the footage without music.
 */
export function resolveLength({ total = 0, preset = 'auto', target = null, music = null } = {}) {
  if (preset == null) preset = 'auto'; // a plan without a preset (null) reads as Auto
  if (preset === 'most' || preset === 'keep') return { preset: 'most', target: null, keepMost: true, window: null };
  const custom = preset === 'custom' && target > 0 ? target : null;
  if (music) {
    let L = custom ?? presetSeconds(preset);
    if (L == null) L = Infinity;
    const window = bestWindow(music, L);
    return { preset, target: r6(window.end - window.start), keepMost: false, window };
  }
  let t = custom ?? presetSeconds(preset);
  if (t == null) t = autoTarget(total);
  return { preset, target: r6(Math.max(0, Math.min(total, t))), keepMost: false, window: null };
}

function normalizeSettings(settings = {}, hasMusic) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  s.cutFirst = { ...DEFAULT_SETTINGS.cutFirst, ...(settings.cutFirst || {}) };
  s.transitions = { ...DEFAULT_SETTINGS.transitions, ...(settings.transitions || {}) };
  s.length = { ...DEFAULT_SETTINGS.length, ...(settings.length || {}) };
  // 'keep' is an older name for Keep most; a missing preset (null) means Auto.
  if (s.length.preset === 'keep') s.length.preset = 'most';
  else if (s.length.preset == null) s.length.preset = DEFAULT_SETTINGS.length.preset;
  if (!hasMusic) s.match = 'motion';
  else if (!['beat', 'motion', 'both'].includes(s.match)) s.match = 'both';
  if (!('order' in settings)) s.order = hasMusic ? 'energy' : 'mine';
  if (s.order !== 'energy') s.order = 'mine';
  if (!('keepClipSound' in settings)) s.keepClipSound = !hasMusic;
  s.seed = Number.isFinite(s.seed) ? Math.trunc(s.seed) : 1;
  s.aspects = Array.isArray(settings.aspects) && settings.aspects.length ? settings.aspects : AUTO_ASPECTS;
  return s;
}

// ---- per-clip signals -----------------------------------------------------------------------------

function prefix(arr) {
  const p = new Float64Array(arr.length + 1);
  for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
  return p;
}

function clipMotion(clip) {
  const m = clip.motion;
  if (!m || !Array.isArray(m.curve) || !m.curve.length) return null;
  const fps = m.fps > 0 ? m.fps : 10;
  const scale = m.scale > 0 ? m.scale : NOISE_FLOOR;
  const raw = Array.isArray(m.raw) && m.raw.length === m.curve.length ? m.raw : m.curve.map((v) => v * scale);
  const moves = (Array.isArray(m.moves) ? m.moves : findMoves(m.curve, { fps, raw })).filter((mv) => mv && Number.isFinite(mv.t));
  const sorted = Array.from(m.curve).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return { fps, n: m.curve.length, curve: m.curve, raw, moves, preC: prefix(m.curve), preR: prefix(raw), centroid: m.centroid || null, median };
}

/** Mean of a per-sample signal over samples with t in [a, b) (the nearest sample when none). */
function meanOver(mo, pre, a, b) {
  const i0 = clamp(Math.ceil(a * mo.fps - EPS), 0, mo.n), i1 = clamp(Math.ceil(b * mo.fps - EPS), 0, mo.n);
  if (i1 > i0) return (pre[i1] - pre[i0]) / (i1 - i0);
  const i = clamp(Math.round(((a + b) / 2) * mo.fps), 0, mo.n - 1);
  return pre[i + 1] - pre[i];
}

function clipDuration(clip) {
  if (clip.kind === 'photo') return 0;
  if (clip.duration > 0) return clip.duration;
  const m = clip.motion;
  if (m && Array.isArray(m.curve) && m.curve.length) return m.curve.length / (m.fps || 10);
  const ws = clip.words || [];
  return ws.length ? Math.max(...ws.map((w) => w.end || 0)) : 0;
}

/** 0..1 transcript score of a sentence (density, clean ending, hooks, fillers) blended with clips.js audio/screen signals. */
function sentenceScore(ws, clip, mo, a, b) {
  const norm = ws.map((w) => normalizeWord(w.text)).filter(Boolean);
  const dur = Math.max(0.3, b - a);
  const content = norm.filter((n) => !STOP_WORDS.has(n) && !HARD_FILLERS.has(n)).length;
  const fillers = norm.filter((n) => HARD_FILLERS.has(n)).length;
  const lastText = String(ws[ws.length - 1]?.text || '');
  const clean = /[.!?]["')\]]?$/.test(lastText) ? 1 : 0;
  const hook = ws.some((w) => /\?$/.test(String(w.text)) || /\d/.test(String(w.text))) ? 1 : 0;
  const text = clamp(0.1 + 0.55 * Math.min(1, content / dur / 1.6) + 0.2 * clean + 0.15 * hook - 0.6 * (fillers / Math.max(1, norm.length)), 0, 1);
  let audio = null, screen = null;
  if (Array.isArray(clip.peaks) && clip.peaks.length) audio = clamp((energyRatio(clip.peaks, clip.peaksPerSec || 100, a, b) - 0.7) / 0.6, 0, 1);
  if (Array.isArray(clip.activity) && clip.activity.length) screen = clamp(activityRate(clip.activity, a, b) / 0.5, 0, 1);
  else if (mo) screen = clamp(meanOver(mo, mo.preR, a, b) / 4, 0, 1);
  let w = 0.6, s = 0.6 * text;
  if (audio !== null) { s += 0.2 * audio; w += 0.2; }
  if (screen !== null) { s += 0.2 * screen; w += 0.2; }
  return s / w;
}

// ---- units ----------------------------------------------------------------------------------------

/** Speech runs of a clip: sentences, retakes and repeats, in order, as word-time ranges. */
function speechRuns(clip, D, { repeats, sentencesOn }) {
  const live = (clip.words || []).filter((w) => w && !w.deleted && Number.isFinite(w.start) && w.end > w.start && w.start < D)
    .map((w) => ({ ...w, end: Math.min(w.end, D) })).sort((x, y) => x.start - y.start);
  if (!live.length) return { runs: [], live };
  const tag = new Array(live.length).fill(null);
  for (const p of detectRetakes(live)) for (let i = p.from; i <= p.to; i++) tag[i] = `r${p.from}`;
  if (repeats && Array.isArray(clip.repeats)) {
    // Points made twice from the user's model (the copilot path): source ranges; whole words inside them.
    clip.repeats.forEach((r, k) => {
      for (let i = 0; i < live.length; i++) if (tag[i] === null && live[i].start >= r.start - 1e-6 && live[i].end <= r.end + 1e-6) tag[i] = `p${k}`;
    });
  } else if (repeats) {
    const ids = new Map(live.map((_, i) => [wordIdOf(live, i), i]));
    for (const c of clarityCuts(live, { duration: D })) {
      if (c.reason !== 'repeat') continue;
      const a = ids.get(c.from_word_id), b = ids.get(c.to_word_id);
      if (a == null || b == null) continue;
      for (let i = a; i <= b; i++) if (tag[i] === null) tag[i] = `p${a}`;
    }
  }
  const runs = [];
  let i = 0;
  while (i < live.length) {
    let j = i;
    while (j + 1 < live.length && tag[j + 1] === tag[i]) j++;
    const ws = live.slice(i, j + 1);
    if (tag[i] !== null) runs.push({ kind: tag[i][0] === 'r' ? 'retake' : 'repeat', words: ws, start: ws[0].start, end: ws[ws.length - 1].end });
    else {
      const parts = sentencesOn ? sentences(ws) : phrases(ws);
      for (const s of parts) runs.push({ kind: 'speech', words: s.words, start: s.start, end: s.end });
    }
    i = j + 1;
  }
  return { runs, live };
}

/** With "Don't cut mid-sentence" off: phrases split at commas and gaps over 0.35 s. */
function phrases(ws) {
  const out = [];
  let cur = [];
  for (let k = 0; k < ws.length; k++) {
    cur.push(ws[k]);
    const next = ws[k + 1];
    if (!next || /[,;:.!?…]["')\]]?$/.test(String(ws[k].text)) || next.start - ws[k].end > 0.35) {
      out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
    }
  }
  return out;
}

function chunk(a, b, len) {
  const n = Math.max(1, Math.round((b - a) / Math.max(0.5, len)));
  const out = [];
  for (let k = 0; k < n; k++) out.push([a + ((b - a) * k) / n, k === n - 1 ? b : a + ((b - a) * (k + 1)) / n]);
  return out;
}

/** Units for footage without speech in [f0, f1]. */
function stretchUnits(f0, f1, mo, hasSpeech, ctx) {
  if (f1 - f0 < EPS) return [];
  const still = hasSpeech ? 'pause' : 'idle';
  if (!mo) {
    if (hasSpeech) return [{ kind: 'pause', a: f0, b: f1 }];
    return chunk(f0, f1, ctx.chunkLen).map(([a, b]) => ({ kind: 'plain', a, b }));
  }
  const ms = mo.moves.filter((m) => m.t >= f0 && m.t < f1);
  const wins = [];
  for (const m of ms) {
    let a, b;
    if (ctx.music) { a = Math.max(f0, m.start - 1); b = Math.min(f1, Math.max(m.settle, m.t + 0.2) + 1); }
    else {
      a = Math.max(f0, m.start - LEAD);
      b = Math.min(f1, Math.min(Math.max(m.settle + 0.3, a + 0.6 * ctx.shot), a + 1.4 * ctx.shot));
      b = Math.min(f1, Math.max(b, m.t + 0.2));
    }
    const prev = wins[wins.length - 1];
    if (prev && a < prev.b) {
      if (!ctx.music && b - prev.a <= 1.6 * ctx.shot) {
        prev.b = Math.max(prev.b, b);
        if ((m.strength ?? m.peak) > (prev.move.strength ?? prev.move.peak)) prev.move = m;
        continue;
      }
      const cut = clamp((prev.move.settle + m.start) / 2, prev.move.t + 0.1, m.t - 0.1);
      if (cut <= prev.a + EPS || cut >= b - EPS) { if ((m.strength ?? m.peak) > (prev.move.strength ?? prev.move.peak)) prev.move = m; prev.b = Math.max(prev.b, b); continue; }
      prev.b = cut;
      a = cut;
    }
    wins.push({ kind: 'move', a, b, move: m });
  }
  const out = [];
  const leftover = (x0, x1) => {
    if (x1 - x0 < EPS) return;
    const prev = out[out.length - 1];
    if (x1 - x0 < 0.5 && prev) { prev.b = x1; return; }
    const mc = meanOver(mo, mo.preC, x0, x1), mr = meanOver(mo, mo.preR, x0, x1);
    // Silence in a clip with speech is a pause unless it's clearly busier than the clip usually is (a demo).
    const still2 = mc < IDLE_CURVE || mr < IDLE_RAW || (hasSpeech && (x1 - x0 < 2 || mc < BUSY * mo.median));
    if (still2) {
      if (ctx.music) for (const [a, b] of chunk(x0, x1, ctx.chunkLen)) out.push({ kind: still, a, b });
      else out.push({ kind: still, a: x0, b: x1 });
    } else for (const [a, b] of chunk(x0, x1, ctx.chunkLen)) out.push({ kind: 'plain', a, b });
  };
  let cur = f0;
  for (const w of wins) {
    leftover(cur, w.a);
    if (out.length && out[out.length - 1].b < w.a) out[out.length - 1].b = w.a;
    out.push(w);
    cur = w.b;
  }
  leftover(cur, f1);
  // Tile exactly: close any hole left by merging.
  for (let k = 1; k < out.length; k++) out[k].a = out[k - 1].b;
  if (out.length) { out[0].a = f0; out[out.length - 1].b = f1; }
  return out.filter((u) => u.b - u.a > EPS);
}

/** Tile a clip into units (see the header). ctx: { music, shot, chunkLen, repeats, sentencesOn, quality }. */
function clipUnits(clip, ci, ctx) {
  const clipQ = Number.isFinite(clip.quality) ? clamp(clip.quality, 0, 1) : 0.6;
  if (clip.kind === 'photo') {
    return [{ ci, asset: clip.id, kind: 'photo', a: 0, b: ctx.photoHold, q: 0.3 + 0.4 * clipQ, energy: 0.3, speech: false }];
  }
  const D = clipDuration(clip);
  if (!(D > 0)) return [];
  const mo = clipMotion(clip);
  const { runs } = speechRuns(clip, D, ctx);
  const hasSpeech = runs.length > 0;
  const units = [];
  const pushStretch = (f0, f1) => { for (const u of stretchUnits(f0, f1, mo, hasSpeech, ctx)) units.push(u); };
  if (!runs.length) pushStretch(0, D);
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k], prev = runs[k - 1], next = runs[k + 1];
    let a, b;
    if (!prev) a = r.start >= MIN_GAP ? r.start - KEEP_PAUSE / 2 : 0;
    else { const g = r.start - prev.end; a = g < MIN_GAP ? prev.end + g / 2 : r.start - KEEP_PAUSE / 2; }
    if (!next) b = D - r.end >= MIN_GAP ? r.end + KEEP_PAUSE / 2 : D;
    else { const g = next.start - r.end; b = g < MIN_GAP ? r.end + g / 2 : r.end + KEEP_PAUSE / 2; }
    if (!prev && a > 0) pushStretch(0, a);
    units.push({ kind: r.kind, a, b, words: r.words });
    const nextA = next ? (next.start - r.end < MIN_GAP ? b : next.start - KEEP_PAUSE / 2) : D;
    if (nextA > b + EPS) pushStretch(b, nextA);
  }
  // Scores and energy.
  for (const u of units) {
    u.ci = ci; u.asset = clip.id; u.clipQ = clipQ;
    u.speech = u.kind === 'speech' || u.kind === 'retake' || u.kind === 'repeat';
    const mr = mo ? meanOver(mo, mo.preR, u.a, u.b) : null;
    u.energy = mr !== null ? clamp(mr / 4, 0, 1) : u.speech ? 0.5 : 0.3;
    if (u.kind === 'move') {
      const st = Number.isFinite(u.move.strength) ? u.move.strength : clamp((u.move.peak || 0) * NOISE_FLOOR / STRONG_MOVE, 0, 1);
      u.q = 0.4 + 0.4 * st + 0.2 * clipQ;
      u.energy = Math.max(u.energy, st);
    } else if (u.kind === 'speech') {
      u.score = sentenceScore(u.words, clip, mo, u.a, u.b);
      u.q = 0.35 + 0.55 * u.score + 0.1 * clipQ;
      u.title = titleFrom(u.words, 7);
    } else if (u.kind === 'plain') u.q = 0.2 + 0.4 * u.energy + 0.2 * clipQ;
    else if (u.kind === 'idle') u.q = 0.1 * clipQ;
    else u.q = 0.05;
    delete u.words;
  }
  return units;
}

/** Split units at locked source ranges; the locked parts become one 'locked' unit per lock. */
function applyLocks(units, locks) {
  if (!locks.length) return units;
  let out = units;
  for (const L of locks) {
    const next = [];
    let placed = false;
    for (const u of out) {
      if (u.b <= L.a + EPS || u.a >= L.b - EPS || u.kind === 'locked') { next.push(u); continue; }
      if (L.a - u.a > MIN_RANGE) next.push({ ...u, b: L.a });
      if (!placed) { next.push({ ci: u.ci, asset: u.asset, kind: 'locked', a: L.a, b: L.b, lock: L, q: 1, energy: u.energy, speech: u.speech }); placed = true; }
      if (u.b - L.b > MIN_RANGE) next.push({ ...u, a: L.b });
    }
    if (!placed) next.push({ ci: L.ci, asset: L.asset, kind: 'locked', a: L.a, b: L.b, lock: L, q: 1, energy: 0.5, speech: false });
    out = next.sort((x, y) => x.a - y.a || (x.kind === 'locked' ? -1 : 1));
  }
  return out;
}

function buildUnits(clips, ctx, locksByClip) {
  const all = [];
  clips.forEach((clip, ci) => {
    const locks = locksByClip.get(clip.id) || [];
    const us = clip.kind === 'photo' && locks.length ? [] : clipUnits(clip, ci, ctx);
    for (const u of applyLocks(us, locks.map((l) => ({ ...l, ci })))) all.push(u);
  });
  all.forEach((u, i) => { u.idx = i; });
  return all;
}

function lockedFrom(previous, clips) {
  const segs = Array.isArray(previous) ? previous : previous?.segments || [];
  const ids = new Map(clips.map((c, i) => [c.id, i]));
  return segs.filter((s) => s && s.locked === true && ids.has(s.asset) && s.end > s.start).map((s) => {
    const speed = s.speed > 0 ? s.speed : 1;
    const isPhoto = clips[ids.get(s.asset)].kind === 'photo';
    return { seg: s, asset: s.asset, ci: ids.get(s.asset), a: s.sourceIn || 0, b: isPhoto ? (s.sourceIn || 0) + (s.end - s.start) : (s.sourceIn || 0) + (s.end - s.start) * speed };
  });
}

// ---- AE-05: rough cut (no music) ------------------------------------------------------------------

/**
 * The cut-first pipeline. opts: { target (s) | null, keepMost, cutFirst, seed }. Units are marked
 * `kept` / `reason` in place. Returns the total kept seconds.
 */
function cutFirst(units, { target, keepMost, cutFirst: cf, seed }) {
  for (const u of units) { u.kept = true; u.reason = null; }
  let total = units.reduce((s, u) => s + (u.b - u.a), 0);
  const done = () => target !== null && total <= target + EPS;
  const tryRemove = (u, reason) => {
    const len = u.b - u.a;
    if (target !== null) {
      if (done()) return 'stop';
      const after = total - len;
      if (after < target - EPS && total - target <= target - after + EPS) return 'skip';
    }
    u.kept = false; u.reason = reason; total -= len;
    return 'ok';
  };
  const steps = [
    { reason: 'pauses', kind: 'pause', on: cf.pauses },
    { reason: 'retakes', kind: 'retake', on: cf.retakes },
    { reason: 'idle', kind: 'idle', on: cf.idle },
    { reason: 'repeats', kind: 'repeat', on: cf.repeats && !keepMost },
  ];
  for (const st of steps) {
    if (!st.on) continue;
    const list = units.filter((u) => u.kind === st.kind).sort((x, y) => (y.b - y.a) - (x.b - x.a) || x.idx - y.idx);
    for (const u of list) { if (tryRemove(u, st.reason) === 'stop') return total; }
  }
  if (keepMost || target === null) return total;
  // Lowest-scoring content, a clip's last content unit protected.
  const content = units.filter((u) => CONTENT.has(u.kind));
  const left = new Map();
  for (const u of content) left.set(u.ci, (left.get(u.ci) || 0) + 1);
  const adj = (u) => u.q + JITTER * 0.5 * (hash01(seed, u.idx, 7) - 0.5) + (left.get(u.ci) <= 1 ? PROTECT : 0);
  const skipped = new Set();
  while (!done()) {
    let best = null, bv = Infinity;
    for (const u of content) {
      if (!u.kept || skipped.has(u)) continue;
      const v = adj(u);
      if (v < bv - EPS) { bv = v; best = u; }
    }
    if (!best) break;
    const r = tryRemove(best, 'lowScore');
    if (r === 'skip') skipped.add(best);
    else if (r === 'ok') left.set(best.ci, left.get(best.ci) - 1);
    else break;
  }
  return total;
}

/** Kept non-content units (and short fragments) whose neighbours in the clip are both gone go with them. */
function dropOrphans(units) {
  const byClip = new Map();
  for (const u of units) { if (!byClip.has(u.ci)) byClip.set(u.ci, []); byClip.get(u.ci).push(u); }
  for (const list of byClip.values()) {
    list.sort((x, y) => x.a - y.a);
    for (let k = 0; k < list.length; k++) {
      const u = list[k];
      if (!u.kept || u.kind === 'locked' || u.kind === 'photo') continue;
      const p = list[k - 1], n = list[k + 1];
      const pGone = !p || !p.kept, nGone = !n || !n.kept;
      if (!pGone || !nGone) continue;
      if (!CONTENT.has(u.kind) || u.b - u.a < MIN_SEG) {
        if (!p && !n) continue;
        u.kept = false;
        u.reason = (p && !p.kept && p.reason) || (n && !n.kept && n.reason) || 'lowScore';
      }
    }
  }
}

/**
 * AE-05 on its own: the cut-first pipeline over clips, without music. opts: { target?, preset?, cutFirst?, pace?,
 * sentences?, seed?, previous? }. Returns { target, keepMost, total, kept, units, keepMap } (units: the tiling with
 * kept/reason; keepMap as in AutoEditResult).
 */
export function roughCut(clips, opts = {}) {
  const s = normalizeSettings({ ...opts, length: opts.length || { preset: opts.preset || 'auto', target: opts.target } }, false);
  const total = clips.reduce((t, c) => t + (c.kind === 'photo' ? photoHold(s.pace) : clipDuration(c)), 0);
  const len = Number.isFinite(opts.target) && opts.preset == null ? { preset: 'custom', target: r6(opts.target), keepMost: false } : resolveLength({ total, preset: s.length.preset, target: s.length.target });
  const locks = lockedFrom(opts.previous, clips);
  const byClip = new Map();
  for (const l of locks) { if (!byClip.has(l.asset)) byClip.set(l.asset, []); byClip.get(l.asset).push(l); }
  const ctx = { music: false, shot: paceShot(s.pace), chunkLen: paceShot(s.pace), repeats: s.cutFirst.repeats && !len.keepMost, sentencesOn: s.sentences !== false, photoHold: photoHold(s.pace) };
  const units = buildUnits(clips, ctx, byClip);
  cutFirst(units, { target: len.target, keepMost: len.keepMost, cutFirst: s.cutFirst, seed: s.seed });
  dropOrphans(units);
  // Counted after dropOrphans, like keepMap.kept (which leaves photos out; this includes their holds, as total does).
  const kept = units.reduce((t, u) => t + (u.kept ? u.b - u.a : 0), 0);
  return { target: len.target, keepMost: len.keepMost, preset: len.preset, total: r6(total), kept: r6(kept), units, keepMap: keepMapOf(clips, units, null) };
}

// ---- keep map, left out, chapters -----------------------------------------------------------------

function keepMapOf(clips, units, used) {
  const removed = { pauses: 0, retakes: 0, idle: 0, repeats: 0, lowScore: 0, unused: 0 };
  const ranges = [];
  let total = 0, kept = 0;
  const push = (asset, start, end, isKept, reason) => {
    if (end - start < EPS) return;
    const last = ranges[ranges.length - 1];
    if (last && last.asset === asset && last.kept === isKept && last.reason === reason && Math.abs(last.end - start) < EPS) last.end = end;
    else ranges.push({ asset, start, end, kept: isKept, reason });
  };
  for (const u of [...units].sort((x, y) => x.ci - y.ci || x.a - y.a)) {
    if (u.kind === 'photo') continue;
    const len = u.b - u.a;
    total += len;
    if (!used) {
      if (u.kept) { kept += len; push(u.asset, u.a, u.b, true, null); }
      else { removed[u.reason] += len; push(u.asset, u.a, u.b, false, u.reason); }
      continue;
    }
    // Music: the parts of the unit that segments used are kept; the rest is cut-first or unused.
    const iv = (used.get(u.asset) || []).filter((r) => r[1] > u.a + EPS && r[0] < u.b - EPS);
    let cur = u.a;
    const reason = u.cutReason || 'unused';
    for (const [s0, s1] of iv) {
      const a = Math.max(u.a, s0), b = Math.min(u.b, s1);
      if (a > cur) { removed[reason] += a - cur; push(u.asset, cur, a, false, reason); }
      if (b > Math.max(a, cur)) { kept += b - Math.max(a, cur); push(u.asset, Math.max(a, cur), b, true, null); }
      cur = Math.max(cur, b);
    }
    if (u.b > cur) { removed[reason] += u.b - cur; push(u.asset, cur, u.b, false, reason); }
  }
  for (const k of Object.keys(removed)) removed[k] = r6(removed[k]);
  return { total: r6(total), kept: r6(kept), removed, ranges: ranges.map((r) => ({ ...r, start: r6(r.start), end: r6(r.end) })), chapters: [] };
}

function chaptersOf(clips, segments) {
  const out = [];
  clips.forEach((clip) => {
    if (clip.kind === 'photo' || !(clip.words || []).length) return;
    const D = clipDuration(clip);
    const segs = segments.filter((s) => s.asset === clip.id).sort((a, b) => a.sourceIn - b.sourceIn);
    if (!segs.length) return;
    for (const ch of suggestChapters(clip.words.filter((w) => !w.deleted), D)) {
      let at = null;
      for (const s of segs) {
        const span = (s.end - s.start) * (s.speed || 1);
        if (ch.start >= s.sourceIn - EPS && ch.start < s.sourceIn + span) { at = s.start + (ch.start - s.sourceIn) / (s.speed || 1); break; }
        if (s.sourceIn >= ch.start) { at = s.start; break; }
      }
      if (at === null) continue;
      if (out.some((c) => Math.abs(c.start - at) < 1)) continue;
      out.push({ start: r6(at), title: ch.title });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

function leftOutOf(units, used) {
  const out = [];
  for (const u of units) {
    if (!CONTENT.has(u.kind)) continue;
    const len = u.b - u.a;
    let cover = 0;
    if (used) for (const [s0, s1] of used.get(u.asset) || []) cover += Math.max(0, Math.min(u.b, s1) - Math.max(u.a, s0));
    else if (u.kept) cover = len;
    if (u.kind === 'photo' ? (used ? used.has(`photo:${u.asset}`) : u.kept) : cover >= 0.5 * len) continue;
    out.push({
      asset: u.asset, start: r6(u.a), end: r6(u.b), score: r6(u.q), kind: u.kind,
      highMotion: u.kind === 'move' ? (u.move.strength ?? 0) >= 0.5 || u.energy >= 0.6 : u.energy >= 0.6,
      minor: u.kind === 'photo' || len < 1,
      reason: u.reason || 'unused',
      _ci: u.ci,
    });
  }
  out.sort((x, y) => y.score - x.score || x._ci - y._ci || x.start - y.start);
  return out.map(({ _ci, ...rest }) => rest);
}

// ---- segments, crops, why -------------------------------------------------------------------------

function cropper(clips, aspects) {
  const tracks = new Map();
  return (clip, start, end) => {
    if (!tracks.has(clip.id)) {
      const mo = clip.motion;
      tracks.set(clip.id, focusTrack({
        duration: clip.kind === 'photo' ? 1 : clipDuration(clip),
        fps: mo && mo.fps > 0 ? mo.fps : 10,
        faces: clip.faces || null,
        centroids: mo && Array.isArray(mo.centroid) ? mo.centroid : null,
      }));
    }
    return segmentCrops(tracks.get(clip.id), { start, end, sourceAspect: clip.aspect > 0 ? clip.aspect : 16 / 9, aspects });
  };
}

function idMaker(locks) {
  const taken = new Set(locks.map((l) => String(l.seg.id)));
  let n = 0;
  return () => { let id; do { n++; id = `s${n}`; } while (taken.has(id)); return id; };
}

function lockedSegment(L, start) {
  const s = L.seg;
  const dur = s.end - s.start;
  return { ...s, start: r6(start), end: r6(start + dur), locked: true };
}

// ---- rough mode (no music) ------------------------------------------------------------------------

function solveRough(clips, s, locks) {
  const total = clips.reduce((t, c) => t + (c.kind === 'photo' ? photoHold(s.pace) : clipDuration(c)), 0);
  const len = resolveLength({ total, preset: s.length.preset, target: s.length.target });
  const byClip = new Map();
  for (const l of locks) { if (!byClip.has(l.asset)) byClip.set(l.asset, []); byClip.get(l.asset).push(l); }
  const ctx = { music: false, shot: paceShot(s.pace), chunkLen: paceShot(s.pace), repeats: s.cutFirst.repeats && !len.keepMost, sentencesOn: s.sentences !== false, photoHold: photoHold(s.pace) };
  const units = buildUnits(clips, ctx, byClip);
  if (locks.length) return solveRoughLocked(clips, s, locks, len, units);
  cutFirst(units, { target: len.target, keepMost: len.keepMost, cutFirst: s.cutFirst, seed: s.seed });
  dropOrphans(units);
  // Kept ranges per clip: contiguous kept units merge, locked units stay on their own.
  const groups = [];
  for (const u of [...units].sort((x, y) => x.ci - y.ci || x.a - y.a)) {
    if (!u.kept) continue;
    const g = groups[groups.length - 1];
    if (g && g.ci === u.ci && u.kind !== 'locked' && g.units[g.units.length - 1].kind !== 'locked' && u.kind !== 'photo' && Math.abs(g.b - u.a) < 1e-6) { g.b = u.b; g.units.push(u); }
    else groups.push({ ci: u.ci, a: u.a, b: u.b, units: [u] });
  }
  for (const g of groups) {
    let e = 0, w = 0;
    for (const u of g.units) { e += u.energy * (u.b - u.a); w += u.b - u.a; }
    g.energy = w > 0 ? e / w : 0;
  }
  let order = groups;
  if (s.order === 'energy') {
    order = [...groups].sort((x, y) => x.energy - y.energy || x.ci - y.ci || x.a - y.a);
    varietyRepair(order, (g) => g.ci, (g) => g.units[0].kind === 'locked');
  }
  const crop = cropper(clips, s.aspects);
  const nextId = idMaker(locks);
  const segments = [], why = [];
  let t = 0;
  for (const g of order) {
    const clip = clips[g.ci];
    const first = g.units[0];
    if (first.kind === 'locked') {
      const seg = lockedSegment(first.lock, t);
      segments.push(seg);
      why.push({ id: seg.id, text: 'Locked: stays as you set it', kind: 'lock' });
      t = seg.end;
      continue;
    }
    const id = nextId();
    const photo = clip.kind === 'photo';
    const dur = g.b - g.a;
    const seg = {
      id, asset: clip.id, sourceIn: r6(g.a), start: r6(t), end: r6(t + dur), speed: 1,
      crops: crop(clip, g.a, g.b), photoMotion: photo ? { from: 1, to: 1.08 } : null, locked: false,
    };
    segments.push(seg);
    why.push({ id, ...roughWhy(g, clip, clipNo(clips, g.ci)) });
    t += dur;
  }
  const keepMap = keepMapOf(clips, units, null);
  keepMap.chapters = chaptersOf(clips, segments);
  return {
    segments, why, leftOut: leftOutOf(units, null), keepMap,
    duration: r6(t), target: len.target, music: null,
    autoEdit: planSettings(s, { preset: len.preset, target: len.target }, null),
  };
}

// ---- rough mode around locks (no music) -----------------------------------------------------------

const MIN_SHOT = 0.6;      // no free shot shorter than this without music; a shorter span holds the previous shot
const PHOTO_MIN = 1.5;     // a photo's hold may shrink or grow to fit a span between locks…
const PHOTO_MAX = 4;       // …within these bounds
const NONSPEECH = new Set(['pause', 'idle', 'plain', 'move']);
const SPEECHY = new Set(['speech', 'retake', 'repeat']);

/** m:ss for notes. */
function clock(t) {
  const s = Math.round(Math.max(0, t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Contiguous kept units of one clip become one group (photos and locked units stand alone). */
function groupUnits(list) {
  const groups = [];
  for (const u of [...list].sort((x, y) => x.ci - y.ci || x.a - y.a)) {
    const g = groups[groups.length - 1];
    if (g && g.ci === u.ci && !g.photo && u.kind !== 'photo' && Math.abs(g.b - u.a) < 1e-6) { g.b = u.b; g.units.push(u); }
    else groups.push({ ci: u.ci, a: u.a, b: u.b, units: [u], photo: u.kind === 'photo', fill: null });
  }
  return groups;
}

function groupEnergy(g) {
  let e = 0, w = 0;
  for (const u of g.units) { e += u.energy * (u.b - u.a); w += u.b - u.a; }
  return w > 0 ? e / w : 0.3;
}

function groupScore(g) {
  let q = 0, w = 0;
  for (const u of g.units) { q += u.q * (u.b - u.a); w += u.b - u.a; }
  return w > 0 ? q / w : 0;
}

/** The earliest a group's end can be trimmed to: back over trailing footage without speech, never before a move shows. */
function minEnd(g) {
  if (g.photo) return Math.min(g.b, g.a + PHOTO_MIN);
  let m = g.b;
  if (!g.fill) {
    for (let k = g.units.length - 1; k >= 0; k--) {
      const u = g.units[k];
      if (u.kind === 'move') { m = Math.min(m, Math.max(u.a, u.move.t + 0.3)); break; }
      if (NONSPEECH.has(u.kind)) { m = Math.min(m, Math.max(u.a, g.a)); continue; }
      m = Math.min(m, u.b);
      break;
    }
  }
  return Math.min(g.b, Math.max(m, g.a + MIN_SHOT));
}

/**
 * Without music, locked segments keep their exact output start and end (and footage, speed, crops). The output time
 * between them is split into spans: before the first lock, between locks, and after the last (up to the rough
 * length; if the locks need more, they win and the edit grows). Free units go to the span their source position falls
 * in relative to the locks (clip order, then clip time). Each span runs the cut-first pipeline with its own length as
 * the target, then fits exactly, in this order: trim footage without speech at the ends of shots (never before a
 * move shows, never under 0.6 s), drop the lowest-scoring shot, extend shot ends then starts into unused footage
 * without speech, grow or shrink photo holds within 1.5–4 s, bring back the best removed moment that fits, hold on
 * the previous locked shot (continue its footage) or start the next one early, borrow the largest stretch of unused
 * footage without speech. A span shorter than 0.6 s skips straight to the hold. What still can't be filled stays a
 * silent gap; a lock never moves.
 */
function solveRoughLocked(clips, s, locks, len, units) {
  const L = [...locks].sort((x, y) => x.seg.start - y.seg.start || x.seg.end - y.seg.end);
  const lockUnit = new Map();
  for (const u of units) {
    u.kept = u.kind === 'locked';
    u.reason = null;
    if (u.kind === 'locked') lockUnit.set(u.lock.seg, u);
  }
  const durOf = clips.map((c) => (c.kind === 'photo' ? 0 : clipDuration(c)));
  // Spans of free output time.
  const spans = [];
  let t = 0;
  for (let j = 0; j <= L.length; j++) {
    const next = L[j] || null;
    const b = next ? next.seg.start : len.target === null ? null : Math.max(t, len.target);
    spans.push({ a: t, b, prev: L[j - 1] || null, next, units: [], groups: [] });
    if (next) t = Math.max(t, next.seg.end);
  }
  const lockEnd = t;
  // Free units go to the span their (clip, time) falls in, relative to the locks (thresholds rise monotonically).
  const before = (ci1, a1, ci2, a2) => ci1 < ci2 || (ci1 === ci2 && a1 < a2 - EPS);
  const thr = [];
  let mx = null;
  for (const l of L) { if (!mx || before(mx.ci, mx.a, l.ci, l.a)) mx = { ci: l.ci, a: l.a }; thr.push(mx); }
  for (const u of units) {
    if (u.kind === 'locked') continue;
    let j = 0;
    while (j < thr.length && !before(u.ci, u.a, thr[j].ci, thr[j].a)) j++;
    spans[j].units.push(u);
  }
  // Room in a clip's footage: up to the nearest locked footage, shot (other than `self`) or sentence.
  const all = [];
  const blockers = (ci, self) => {
    const out = [];
    for (const u of units) if (u.ci === ci && (u.kind === 'locked' || SPEECHY.has(u.kind))) out.push([u.a, u.b]);
    for (const g of all) if (g !== self && g.ci === ci) out.push([g.a, g.b]);
    return out;
  };
  const roomAfter = (ci, x, self = null) => {
    if (clips[ci].kind === 'photo') return 0;
    let lim = durOf[ci];
    for (const [p, q] of blockers(ci, self)) { if (q <= x + EPS) continue; if (p <= x + EPS) return 0; lim = Math.min(lim, p); }
    return Math.max(0, lim - x);
  };
  const roomBefore = (ci, x, self = null) => {
    if (clips[ci].kind === 'photo') return 0;
    let lim = 0;
    for (const [p, q] of blockers(ci, self)) { if (p >= x - EPS) continue; if (q >= x - EPS) return 0; lim = Math.max(lim, q); }
    return Math.max(0, x - lim);
  };
  // No shot or locked footage overlaps [a, b] of the clip (sentences don't count: this is for whole moments).
  const freeRange = (ci, a, b) => {
    for (const u of units) if (u.ci === ci && u.kind === 'locked' && u.a < b - EPS && u.b > a + EPS) return false;
    for (const g of all) if (g.ci === ci && g.a < b - EPS && g.b > a + EPS) return false;
    return true;
  };
  const drop = (groups, g) => {
    groups.splice(groups.indexOf(g), 1);
    all.splice(all.indexOf(g), 1);
    for (const u of g.units) { u.kept = false; u.reason = 'lowScore'; }
  };
  const add = (groups, g, front = false) => { g.len0 = g.b - g.a; if (front) groups.unshift(g); else groups.push(g); all.push(g); };
  // A shot grows by at most 1 s, or up to 1.5 paced shots, so a span isn't filled by one long stretch.
  const shot = paceShot(s.pace);
  const grow = (g) => Math.max(0, Math.max(g.len0 + 1, 1.5 * shot) - (g.b - g.a));
  const bestMoment = (list, delta) => {
    let best = null;
    for (const u of list) {
      if (u.kept || !CONTENT.has(u.kind) || u.b - u.a > delta + 1e-9 || u.b - u.a < MIN_SHOT - EPS) continue;
      if (u.kind === 'photo' ? all.some((g) => g.photo && g.ci === u.ci) : !freeRange(u.ci, u.a, u.b)) continue;
      if (!best || u.q > best.q + EPS) best = u;
    }
    return best;
  };
  const addMoment = (groups, u) => {
    u.kept = true; u.reason = null;
    add(groups, { ci: u.ci, a: u.a, b: u.b, units: [u], photo: u.kind === 'photo', fill: null });
  };
  const fit = (sp, groups, D) => {
    const sum = () => groups.reduce((x, g) => x + (g.b - g.a), 0);
    for (let iter = 0; iter < 100; iter++) {
      let delta = D - sum();
      if (Math.abs(delta) <= 1e-6) return;
      if (delta < 0) {
        for (let k = groups.length - 1; k >= 0 && delta < -1e-9; k--) {
          const g = groups[k];
          const cut = Math.min(-delta, g.b - minEnd(g));
          if (cut > 1e-9) { g.b -= cut; delta += cut; }
        }
        if (delta < -1e-6) {
          let worst = null;
          for (const g of groups) if (!worst || groupScore(g) < groupScore(worst) - EPS) worst = g;
          if (!worst) return;
          drop(groups, worst);
        }
        continue;
      }
      for (let k = groups.length - 1; k >= 0 && delta > 1e-9; k--) {
        const g = groups[k];
        if (g.photo) continue;
        const ext = Math.min(delta, grow(g), roomAfter(g.ci, g.b, g));
        if (ext > 1e-9) { g.b += ext; delta -= ext; }
      }
      for (let k = 0; k < groups.length && delta > 1e-9; k++) {
        const g = groups[k];
        if (g.photo) continue;
        const ext = Math.min(delta, grow(g), roomBefore(g.ci, g.a, g));
        if (ext > 1e-9) { g.a -= ext; delta -= ext; }
      }
      for (const g of groups) {
        if (!g.photo || delta <= 1e-9) continue;
        const ext = Math.min(delta, PHOTO_MAX - (g.b - g.a));
        if (ext > 1e-9) { g.b += ext; delta -= ext; }
      }
      if (delta <= 1e-6) continue;
      // The best removed moment of this span that fits, then of any span (nothing else kept it).
      const back = bestMoment(sp.units, delta) || bestMoment(units, delta);
      if (back) { addMoment(groups, back); continue; }
      // Hold on the previous locked shot, or start the next one early (up to 1.5 paced shots).
      const pu = sp.prev && lockUnit.get(sp.prev.seg), nu = sp.next && lockUnit.get(sp.next.seg);
      const cap = Math.max(MIN_SHOT, 1.5 * shot);
      const hold = pu && !groups.some((g) => g.fill === 'hold') ? Math.min(delta, cap, roomAfter(pu.ci, pu.b)) : 0;
      if (hold > 1e-9) { add(groups, { ci: pu.ci, a: pu.b, b: pu.b + hold, units: [], photo: false, fill: 'hold' }, true); continue; }
      const lead = nu && !groups.some((g) => g.fill === 'lead') ? Math.min(delta, cap, roomBefore(nu.ci, nu.a)) : 0;
      if (lead > 1e-9) { add(groups, { ci: nu.ci, a: nu.a - lead, b: nu.a, units: [], photo: false, fill: 'lead' }); continue; }
      // Borrow the largest stretch of unused footage without speech (ties: earlier clip, earlier time), a paced shot at a time.
      let best = null;
      clips.forEach((c, ci) => {
        if (c.kind === 'photo') return;
        const bl = blockers(ci, null).sort((x, y) => x[0] - y[0]);
        let cur = 0;
        for (const [p, q] of [...bl, [durOf[ci], durOf[ci]]]) {
          if (p - cur > (best ? best.len + EPS : 1e-9)) best = { ci, a: cur, len: p - cur };
          cur = Math.max(cur, q);
        }
      });
      if (!best) return;
      add(groups, { ci: best.ci, a: best.a, b: best.a + Math.min(delta, best.len, shot), units: [], photo: false, fill: 'fill' });
    }
  };
  // First every span picks its shots (cut first, with its own length as the target), then each fits exactly, in order.
  for (const sp of spans) {
    const open = sp.b === null;
    const D = open ? null : Math.max(0, sp.b - sp.a);
    sp.groups = [];
    if (open || D >= MIN_SHOT - EPS) {
      cutFirst(sp.units, { target: D, keepMost: open && len.keepMost, cutFirst: s.cutFirst, seed: s.seed });
      dropOrphans(sp.units);
      sp.groups = groupUnits(sp.units.filter((u) => u.kept));
    } else for (const u of sp.units) { u.kept = false; u.reason = 'lowScore'; }
    for (const g of sp.groups) { g.len0 = g.b - g.a; all.push(g); }
  }
  for (const sp of spans) if (sp.b !== null && sp.b - sp.a > 1e-6) fit(sp, sp.groups, sp.b - sp.a);
  // Lay out: holds first, then shots in order (by rising energy for 'energy'), then leads and borrowed footage.
  const crop = cropper(clips, s.aspects);
  const nextId = idMaker(locks);
  const segments = [], why = [];
  const used = new Map();
  const markUsed = (asset, a, b) => { if (!used.has(asset)) used.set(asset, []); used.get(asset).push([a, b]); };
  let end = 0;
  spans.forEach((sp, j) => {
    for (const g of sp.groups) g.energy = groupEnergy(g);
    let shots = sp.groups.filter((g) => !g.fill);
    shots.sort((x, y) => x.ci - y.ci || x.a - y.a);
    if (s.order === 'energy') {
      shots.sort((x, y) => x.energy - y.energy || x.ci - y.ci || x.a - y.a);
      varietyRepair(shots, (g) => g.ci, () => false);
    }
    const ordered = [...sp.groups.filter((g) => g.fill === 'hold'), ...shots, ...sp.groups.filter((g) => g.fill === 'lead' || g.fill === 'fill')];
    // Contiguous footage of one clip plays as one shot.
    const merged = [];
    for (const g of ordered) {
      const m = merged[merged.length - 1];
      if (m && m.ci === g.ci && !m.photo && !g.photo && Math.abs(m.b - g.a) < 1e-6 && (m.fill || null) === (g.fill || null)) { m.b = g.b; m.units = m.units.concat(g.units); }
      else merged.push({ ...g, units: g.units.slice() });
    }
    let x = sp.a;
    merged.forEach((g, k) => {
      const clip = clips[g.ci];
      const photo = clip.kind === 'photo';
      const len = g.b - g.a;
      const segEnd = k === merged.length - 1 && sp.b !== null && Math.abs(x + len - sp.b) <= 1e-6 ? sp.b : x + len;
      const id = nextId();
      segments.push({
        id, asset: clip.id, sourceIn: r6(photo ? 0 : g.a), start: r6(x), end: r6(segEnd), speed: 1,
        crops: crop(clip, photo ? 0 : g.a, photo ? 1 : g.b), photoMotion: photo ? { from: 1, to: 1.08 } : null, locked: false,
      });
      if (photo) used.set(`photo:${clip.id}`, true); else markUsed(clip.id, g.a, g.b);
      const name = photo ? `Photo ${clipNo(clips, g.ci)}` : `clip ${clipNo(clips, g.ci)}`;
      if (g.fill === 'hold') why.push({ id, text: `Holds on ${name} a little longer so the locked clip after it stays put`, kind: 'hold' });
      else if (g.fill === 'lead') why.push({ id, text: `Starts ${name} early so the locked clip stays put`, kind: 'hold' });
      else if (g.fill === 'fill') why.push({ id, text: `Fills the time around the locked clips with unused footage from ${name}`, kind: 'plain' });
      else if (photo) why.push({ id, text: `${name} holds for ${fmt(len)} s with a slow push-in`, kind: 'photo' });
      else why.push({ id, ...roughWhy(g, clip, clipNo(clips, g.ci)) });
      x = segEnd;
    });
    end = Math.max(end, x);
    const gap = sp.b !== null ? sp.b - x : 0;
    const l = L[j];
    if (l) {
      const seg = { ...l.seg };
      segments.push(seg);
      markUsed(seg.asset, l.a, l.b);
      if (clips[l.ci].kind === 'photo') used.set(`photo:${seg.asset}`, true);
      let text = 'Locked: stays as you set it';
      if (gap > 1e-6) text += `. The ${fmt(gap)} s before it stays silent: there's no unused footage left to fill it`;
      const entry = { id: seg.id, text, kind: 'lock' };
      if (j === L.length - 1 && len.target !== null && lockEnd > len.target + 1e-6) {
        entry.text += `. The locked clips run to ${clock(lockEnd)}, past the ${clock(len.target)} you picked, so the edit is longer`;
        entry.lengthGrew = true;
      }
      why.push(entry);
      end = Math.max(end, seg.end);
    }
  });
  for (const [k, v] of used) if (Array.isArray(v)) used.set(k, v.sort((a, b) => a[0] - b[0]));
  for (const u of units) u.cutReason = u.reason || 'lowScore';
  const keepMap = keepMapOf(clips, units, used);
  keepMap.chapters = chaptersOf(clips, segments);
  return {
    segments, why, leftOut: leftOutOf(units, used), keepMap,
    duration: r6(end), target: len.target, music: null,
    autoEdit: planSettings(s, { preset: len.preset, target: len.target }, null),
  };
}

/** Clips (and photos) are numbered by their position in the user's order, from 1. */
function clipNo(clips, ci) {
  return ci + 1;
}

function roughWhy(g, clip, n) {
  const first = g.units[0];
  const name = clip.kind === 'photo' ? `Photo ${n}` : `clip ${n}`;
  if (first.kind === 'photo') return { text: `Photo ${n} holds for ${fmt(g.b - g.a)} s with a slow push-in`, kind: 'photo' };
  if (first.kind === 'move' && !(first.move.t >= g.a - EPS && first.move.t < g.b)) {
    // A piece of a move window left over beside a locked clip: the move itself isn't in this shot.
    return { text: `More of ${name}, beside the locked clip`, kind: 'plain' };
  }
  if (first.kind === 'move') {
    const lead = first.move.start - g.a;
    if (lead >= 0.25) return { text: `Cuts in ${fmt(lead)} s before the move in ${name} starts`, kind: 'move' };
    return { text: `Starts with the move in ${name}`, kind: 'move' };
  }
  const speech = g.units.filter((u) => u.kind === 'speech');
  if (speech.length === 1) return { text: `Keeps the sentence “${speech[0].title}” whole`, kind: 'speech' };
  if (speech.length > 1) return { text: `Keeps ${speech.length} sentences from ${name} whole`, kind: 'speech' };
  if (g.units.some((u) => u.kind === 'move')) {
    const m = g.units.find((u) => u.kind === 'move');
    return { text: `Starts where the last move settles, then the move in ${name}`, kind: 'move', moveAt: r6(m.move.t) };
  }
  if (first.kind === 'plain') return { text: `The liveliest stretch of ${name}`, kind: 'plain' };
  return { text: `Kept from ${name}`, kind: first.kind };
}

const fmt = (x) => (Math.round(x * 10) / 10).toString();

/** Never the same clip twice in a row where a later item can swap in (fixed items never move). */
function varietyRepair(seq, clipOf, fixed) {
  for (let i = 1; i < seq.length; i++) {
    if (clipOf(seq[i]) !== clipOf(seq[i - 1]) || fixed(seq[i])) continue;
    for (let j = i + 1; j < seq.length; j++) {
      if (fixed(seq[j]) || clipOf(seq[j]) === clipOf(seq[i - 1])) continue;
      if (i + 1 < seq.length && j !== i + 1 && clipOf(seq[j]) === clipOf(seq[i + 1])) continue;
      const t = seq[i]; seq[i] = seq[j]; seq[j] = t;
      break;
    }
  }
}

function planSettings(s, length, music) {
  return {
    match: s.match, length, pace: paceValue(s.pace), order: s.order,
    cutFirst: { ...s.cutFirst }, sentences: s.sentences !== false, keepClipSound: !!s.keepClipSound,
    transitions: { ...s.transitions }, seed: s.seed,
    music: music ? { bpm: music.bpm, beats: music.beats.slice(), downbeats: music.downbeats.slice(), sections: music.sections.map((x) => ({ start: x.start, end: x.end, label: x.label })) } : null,
  };
}

// ---- music mode -----------------------------------------------------------------------------------

/** The output-time grid of cut points: beats in the window (or paced onsets without a clear beat), plus lock edges. */
function musicGrid(music, win, s, locks) {
  const ws = win.start, we = win.end;
  const L = we - ws;
  const pts = [];
  if (music.clearBeat && music.beats.length) {
    for (const b of music.beats) if (b >= ws - 1e-6 && b <= we + 1e-6) pts.push(b - ws);
  } else {
    const shot = paceBeats(s.pace, 4) * 0.5;
    const on = (music.onsets || []).map((t) => t - ws).filter((t) => t > 0 && t < L);
    let t = 0;
    pts.push(0);
    while (t < L - EPS) {
      let next = t + shot, bestD = Infinity;
      for (const o of on) if (o >= t + 0.7 * shot && o <= t + 1.3 * shot && Math.abs(o - (t + shot)) < bestD - EPS) { bestD = Math.abs(o - (t + shot)); next = o; }
      if (L - next < 0.5 * shot) next = L;
      pts.push(Math.min(next, L));
      t = next;
    }
  }
  if (!pts.length || pts[0] > 1e-6) pts.unshift(0);
  if (L - pts[pts.length - 1] > 1e-6) pts.push(L);
  for (const l of locks) for (const t of [l.seg.start, l.seg.end]) if (t > 1e-6 && t < L - 1e-6 && !pts.some((p) => Math.abs(p - t) < 1e-6)) pts.push(t);
  pts.sort((a, b) => a - b);
  const G = pts.map((p) => r6(p));
  const down = new Set((music.downbeats || []).map((d) => r6(d - ws)));
  const isDown = G.map((g) => [...down].some((d) => Math.abs(d - g) < 1e-6));
  // Bar and beat numbers from the window start (bar 1, beat 1 = the first grid point).
  const bar = [], beat = [];
  let b = 0, k = 0;
  for (let i = 0; i < G.length; i++) {
    if (isDown[i] || i === 0) { b++; k = 1; } else k++;
    bar.push(b); beat.push(k);
  }
  const secStart = G.map(() => false);
  secStart[0] = true;
  for (const sec of music.sections || []) {
    const t = sec.start - ws;
    if (t <= 1e-6 || t >= L - 1e-6) continue;
    let best = 0;
    for (let i = 1; i < G.length; i++) if (Math.abs(G[i] - t) < Math.abs(G[best] - t) - EPS) best = i;
    secStart[best] = true;
  }
  const energyAt = (a, c) => {
    const e = music.energy;
    if (e && e.values && e.values.length) {
      const i0 = Math.max(0, Math.floor((a + ws) * e.fps)), i1 = Math.min(e.values.length, Math.max(i0 + 1, Math.ceil((c + ws) * e.fps)));
      let sum = 0;
      for (let i = i0; i < i1; i++) sum += e.values[i];
      return i1 > i0 ? sum / (i1 - i0) : 0.5;
    }
    const mid = (a + c) / 2 + ws;
    const sec = (music.sections || []).find((x) => mid >= x.start && mid < x.end);
    return sec ? sec.energy : 0.5;
  };
  return { G, isDown, bar, beat, secStart, energyAt, ws, we };
}

/**
 * Fill grid rows [K0, K1] by DP. cols: units in DP order. Returns items [{ u, ka, kb, pl } | { lock }] or null.
 */
function dpFill({ K0, K1, cols, lens, place, locks, startClip, rep }) {
  const R = K1 - K0, M = cols.length;
  const W = M + 1;
  const dp = new Float64Array((R + 1) * W).fill(-Infinity);
  const fromC = new Int32Array((R + 1) * W).fill(-1);
  const fromR = new Int32Array((R + 1) * W).fill(-1);
  const fromPl = new Array((R + 1) * W).fill(null);
  dp[0] = 0;
  const clipOf = (c) => (c === 0 ? startClip : cols[c - 1].ci);
  const lockEnd = new Map(), inLock = new Uint8Array(R + 1);
  const rel = locks.map((l) => ({ ...l, rs: l.ka - K0, re: l.kb - K0 }));
  for (const l of rel) { lockEnd.set(l.re, l); for (let r = l.rs + 1; r < l.re; r++) inLock[r] = 1; }
  // Prefix structures per row: top1/top2 by distinct clip (normal rows) or a plain prefix max (rows that end a lock).
  const t1v = new Float64Array((R + 1) * (W + 1)), t1c = new Array((R + 1) * (W + 1)), t1i = new Int32Array((R + 1) * (W + 1));
  const t2v = new Float64Array((R + 1) * (W + 1)), t2i = new Int32Array((R + 1) * (W + 1));
  const buildPrefix = (r) => {
    const o = r * (W + 1);
    let a = { v: -Infinity, c: undefined, i: -1 }, b = { v: -Infinity, i: -1 };
    for (let c = 0; c <= W; c++) {
      t1v[o + c] = a.v; t1c[o + c] = a.c; t1i[o + c] = a.i; t2v[o + c] = b.v; t2i[o + c] = b.i;
      if (c === W) break;
      const v = dp[r * W + c];
      if (v === -Infinity) continue;
      const cl = lockEnd.has(r) ? '__lock__' : clipOf(c);
      if (v > a.v + EPS) { if (a.c !== cl) b = { v: a.v, i: a.i }; a = { v, c: cl, i: c }; }
      else if (cl !== a.c && v > b.v + EPS) b = { v, i: c };
    }
  };
  const prevBest = (r0, c, clip) => {
    const o = r0 * (W + 1) + c;
    const L = lockEnd.get(r0);
    if (L) {
      const v = t1v[o];
      if (v === -Infinity) return null;
      return { v: clip === L.ci ? v - rep : v, i: t1i[o] };
    }
    if (t1v[o] === -Infinity) return null;
    if (t1c[o] !== clip) return { v: t1v[o], i: t1i[o] };
    const v1 = t1v[o] - rep, v2 = t2v[o];
    if (v2 > v1 + EPS) return { v: v2, i: t2i[o] };
    return v1 === -Infinity ? null : { v: v1, i: t1i[o] };
  };
  buildPrefix(0);
  for (let r = 1; r <= R; r++) {
    if (inLock[r]) { buildPrefix(r); continue; }
    const L = lockEnd.get(r);
    if (L) {
      for (let c = 0; c < W; c++) {
        let v = dp[L.rs * W + c];
        if (v === -Infinity) continue;
        if (clipOf(c) === L.ci) v -= rep;
        dp[r * W + c] = v; fromC[r * W + c] = c; fromR[r * W + c] = L.rs; fromPl[r * W + c] = { lock: L };
      }
      buildPrefix(r);
      continue;
    }
    for (let c = 1; c < W; c++) {
      const u = cols[c - 1];
      for (const len of lens(u)) {
        const r0 = r - len;
        if (r0 < 0 || inLock[r0]) continue;
        if (rel.some((l) => l.rs < r && l.re > r0)) continue;
        const pl = place(u, K0 + r0, K0 + r);
        if (!pl) continue;
        const pb = prevBest(r0, c, u.ci);
        if (!pb) continue;
        const v = pb.v + pl.score - (u.copy ? REUSE : 0);
        if (v > dp[r * W + c] + EPS) { dp[r * W + c] = v; fromC[r * W + c] = pb.i; fromR[r * W + c] = r0; fromPl[r * W + c] = pl; }
      }
    }
    buildPrefix(r);
  }
  let bc = -1, bv = -Infinity;
  for (let c = 0; c < W; c++) if (dp[R * W + c] > bv + EPS) { bv = dp[R * W + c]; bc = c; }
  if (bc < 0) return null;
  const items = [];
  let r = R, c = bc;
  while (r > 0) {
    const k = r * W + c;
    const pl = fromPl[k];
    if (!pl) return null;
    if (pl.lock) items.push({ lock: pl.lock });
    else items.push({ u: cols[c - 1], ka: K0 + fromR[k], kb: K0 + r, pl });
    const nr = fromR[k], nc = fromC[k];
    r = nr; c = nc;
  }
  return { items: items.reverse(), score: bv };
}

function solveMusic(clips, music, s, locks, previous) {
  const total = clips.reduce((t, c) => t + (c.kind === 'photo' ? 0 : clipDuration(c)), 0);
  const len = resolveLength({ total, preset: s.length.preset, target: s.length.target, music });
  let win = len.window || { start: 0, end: music.duration };
  const trimIn = previous && !Array.isArray(previous) && Number.isFinite(previous.trimIn) ? previous.trimIn : null;
  if (locks.length && trimIn !== null) {
    const L = win.end - win.start;
    win = { start: trimIn, end: Math.min(music.duration, trimIn + L) };
  }
  // Locks past the new length keep the edit at least that long (whole bars when possible).
  const lockEndT = Math.max(0, ...locks.map((l) => l.seg.end));
  const asked = win.end - win.start;
  const grew = lockEndT > asked + 1e-6;
  if (grew) {
    const later = (music.downbeats || []).find((d) => d - win.start >= lockEndT - 1e-6);
    win = { start: win.start, end: Math.min(music.duration, later ?? win.start + lockEndT) };
  }
  const grid = musicGrid(music, win, s, locks);
  const { G } = grid;
  const K = G.length - 1;
  const meter = music.meter || 4;
  const g = music.clearBeat ? paceBeats(s.pace, meter) : 1;
  const slotSec = K > 0 ? (G[K] / K) * g : 1;
  const byClip = new Map();
  for (const l of locks) { if (!byClip.has(l.asset)) byClip.set(l.asset, []); byClip.get(l.asset).push(l); }
  const ctx = { music: true, shot: slotSec, chunkLen: Math.max(2, 2 * slotSec), repeats: s.cutFirst.repeats, sentencesOn: s.sentences !== false, photoHold: 0 };
  const all = buildUnits(clips, ctx, byClip);
  // Cut first under music: pauses, retakes and repeats (when on) are never used; idle footage is, at low quality.
  for (const u of all) {
    u.excluded = !!(REASON_OF[u.kind] && s.cutFirst[REASON_OF[u.kind]] && u.kind !== 'idle');
    u.cutReason = u.excluded || (u.kind === 'idle' && s.cutFirst.idle) ? REASON_OF[u.kind] : 'unused';
  }
  let usable = all.filter((u) => u.kind !== 'locked' && !u.excluded);
  // Under the music with clip sound off, a sentence is only worth what it shows.
  if (!s.keepClipSound) for (const u of usable) if (u.speech) u.q = 0.2 + 0.4 * u.energy + 0.2 * (u.clipQ ?? 0.6);
  // Diversity: rank units within their clip by quality (ties: earlier); the r-th costs r × DIVERSITY.
  const perClip = new Map();
  for (const u of usable) { if (!perClip.has(u.ci)) perClip.set(u.ci, []); perClip.get(u.ci).push(u); }
  for (const list of perClip.values()) list.sort((x, y) => y.q - x.q || x.a - y.a).forEach((u, r) => { u.rank = r; });
  const useMoves = s.match !== 'beat';
  const wA = s.match === 'motion' ? 1.5 : s.match === 'both' ? 1 : 0;
  const dbBonus = s.match === 'both' ? 0.25 : 0, secBonus = s.match === 'both' ? 0.5 : 0;
  const wE = s.order === 'energy' ? 1 : 0.3;
  const photoLen = Math.min(4, Math.max(2, g));
  // Slots of g or 2g beats; shorter ones (1..g−1, at a cost) only matter where locks leave an odd gap.
  const videoLens = [];
  for (let l = 1; l < g; l++) videoLens.push(l);
  videoLens.push(g);
  if (2 * g <= 8) videoLens.push(2 * g);
  const lens = (u) => (u.kind === 'photo' ? [photoLen] : videoLens);
  const memo = new Map();
  const place = (u, ka, kb) => {
    const key = `${u.idx}:${ka}:${kb}`;
    if (memo.has(key)) return memo.get(key);
    const pl = placeUnit(u, ka, kb);
    memo.set(key, pl);
    return pl;
  };
  const placeUnit = (u, ka, kb) => {
    const S = G[ka], E = G[kb], D = E - S;
    if (!(D > EPS)) return null;
    const lenBeats = kb - ka;
    const jit = JITTER * (hash01(s.seed, u.idx, ka) - 0.5);
    const fit = wE * (1 - Math.abs(grid.energyAt(S, E) - u.energy));
    const pacePen = PACE_PENALTY * Math.max(0, lenBeats / g - 1) + SHORT_PENALTY * Math.max(0, 1 - lenBeats / g) + DIVERSITY * (u.rank || 0);
    if (u.kind === 'photo') return { sourceIn: 0, speed: 1, align: 0, k: null, score: u.q + fit + jit - pacePen };
    const span = u.b - u.a;
    if (u.speech ? span < D - EPS : span < D * SPEED_MIN - EPS) return null;
    let best = null;
    if (useMoves && u.kind === 'move' && !u.speech) {
      const m = u.move, p = m.t;
      for (let k = ka; k < kb; k++) {
        const o = G[k] - S, rest = E - G[k];
        const cands = [1];
        let vmax = Infinity;
        if (o > EPS) vmax = Math.min(vmax, (p - u.a) / o);
        if (rest > EPS) vmax = Math.min(vmax, (u.b - p) / rest);
        if (vmax < 1 - EPS && vmax >= SPEED_MIN - EPS) cands.push(vmax);
        if (k > ka) { const v = (p - m.start) / (G[k] - G[k - 1]); if (v >= SPEED_MIN - EPS && v <= SPEED_MAX + EPS) cands.push(v); }
        if (k + 1 <= kb) { const v = (m.settle - p) / (G[k + 1] - G[k]); if (v >= SPEED_MIN - EPS && v <= SPEED_MAX + EPS) cands.push(v); }
        for (const v0 of cands) {
          const v = clamp(v0, SPEED_MIN, SPEED_MAX);
          const sourceIn = p - o * v;
          if (sourceIn < u.a - 1e-6 || sourceIn + D * v > u.b + 1e-6) continue;
          const two = (k > ka && Math.abs((p - m.start) - v * (G[k] - G[k - 1])) < 0.04) || (k + 1 <= kb && Math.abs((m.settle - p) - v * (G[k + 1] - G[k])) < 0.04);
          const sc = 1 + (grid.isDown[k] ? dbBonus : 0) + (k === ka && grid.secStart[k] ? secBonus : 0) + (two ? TWO_POINT : 0) - (RETIME * Math.abs(v - 1)) / 0.12;
          if (!best || sc > best.align + EPS || (Math.abs(sc - best.align) <= EPS && Math.abs(v - 1) < Math.abs(best.speed - 1) - EPS)) best = { sourceIn: clamp(sourceIn, u.a, u.b - D * v), speed: v, align: sc, k };
        }
      }
    }
    let retime = 0;
    if (!best) {
      const v = span < D ? Math.max(SPEED_MIN, span / D) : 1;
      const anchor = u.kind === 'speech' || u.kind === 'retake' || u.kind === 'repeat' ? u.a + (D * v) / 2 : u.kind === 'move' ? u.move.t : (u.a + u.b) / 2;
      best = { sourceIn: clamp(anchor - (D * v) / 2, u.a, Math.max(u.a, u.b - D * v)), speed: v, align: 0, k: null };
      retime = (RETIME * Math.abs(v - 1)) / 0.12;
    }
    return { sourceIn: best.sourceIn, speed: best.speed, align: best.align, k: best.k, score: u.q + wA * best.align + fit + jit - pacePen - retime };
  };
  // Enough footage? Add copies (reused at a cost) until there are about 1.5 units per slot.
  const slots = Math.max(1, Math.ceil(K / g));
  const withCopies = (list) => {
    if (!list.length) return list;
    const out = list.slice();
    let copy = 1;
    while (out.length < 1.5 * slots && copy <= 4) {
      for (const u of list) out.push({ ...u, copy });
      copy++;
    }
    return out;
  };
  const lockItems = locks.map((l) => ({ ...l, ka: G.findIndex((x) => Math.abs(x - r6(l.seg.start)) < 1e-6), kb: G.findIndex((x) => Math.abs(x - r6(l.seg.end)) < 1e-6) })).filter((l) => l.ka >= 0 && l.kb > l.ka);
  const rep = s.order === 'energy' && new Set(usable.map((u) => u.ci)).size > 1 ? Infinity : REPEAT_CLIP;
  let items = null;
  if (s.order === 'mine') {
    const cols = withCopies([...usable].sort((x, y) => x.ci - y.ci || x.a - y.a)).map((u, i) => ({ ...u, ord: i }));
    const sorted = cols.slice().sort((x, y) => (x.copy || 0) - (y.copy || 0) || x.ci - y.ci || x.a - y.a);
    items = dpFill({ K0: 0, K1: K, cols: sorted, lens, place, locks: lockItems, startClip: undefined, rep })?.items;
  } else {
    items = energyFill({ grid, K, g, usable, lens, place, locks: lockItems, rep, withCopies, music, win });
  }
  if (!items) {
    // Fallback: every clip usable end to end, soft variety.
    const wide = clips.map((c, ci) => (c.kind === 'photo' ? all.find((u) => u.ci === ci && u.kind === 'photo') : { ci, asset: c.id, kind: 'plain', a: 0, b: clipDuration(c), q: 0.2, energy: 0.3, speech: false, idx: all.length + ci })).filter((u) => u && u.b > u.a);
    items = dpFill({ K0: 0, K1: K, cols: withCopies(wide), lens: (u) => (u.kind === 'photo' ? [photoLen] : [1, 2, 3, 4].map((x) => x * g).filter((x) => x <= 8)), place, locks: lockItems, startClip: undefined, rep: REPEAT_CLIP })?.items || [];
    usable = wide;
  }
  // Assemble.
  const crop = cropper(clips, s.aspects);
  const nextId = idMaker(locks);
  const segments = [], why = [];
  const used = new Map();
  const markUsed = (asset, a, b) => { if (!used.has(asset)) used.set(asset, []); used.get(asset).push([a, b]); };
  for (const it of items) {
    if (it.lock) {
      const seg = lockedSegment(it.lock, it.lock.seg.start);
      segments.push(seg);
      const entry = { id: seg.id, text: 'Locked: stays as you set it', kind: 'lock' };
      if (grew && Math.abs(it.lock.seg.end - lockEndT) < 1e-9) {
        entry.text += `. The locked clips run to ${clock(lockEndT)}, past the ${clock(asked)} you picked, so the edit is longer`;
        entry.lengthGrew = true;
      }
      why.push(entry);
      continue;
    }
    const { u, ka, kb, pl } = it;
    const clip = clips[u.ci];
    const id = nextId();
    const S = G[ka], E = G[kb];
    const srcEnd = pl.sourceIn + (E - S) * pl.speed;
    const photo = u.kind === 'photo';
    const seg = {
      id, asset: clip.id, sourceIn: r6(photo ? 0 : pl.sourceIn), start: G[ka], end: G[kb], speed: r6(photo ? 1 : pl.speed),
      crops: crop(clip, photo ? 0 : pl.sourceIn, photo ? 1 : srcEnd), photoMotion: photo ? { from: 1, to: 1.08 } : null, locked: false,
    };
    segments.push(seg);
    if (photo) used.set(`photo:${clip.id}`, true); else markUsed(clip.id, pl.sourceIn, srcEnd);
    why.push({ id, ...musicWhy(u, pl, ka, kb, grid, clipNo(clips, u.ci), clip.kind === 'photo', music.clearBeat) });
  }
  for (const [k, v] of used) if (Array.isArray(v)) used.set(k, v.sort((a, b) => a[0] - b[0]));
  const keepMap = keepMapOf(clips, all.filter((u) => u.kind !== 'locked'), used);
  keepMap.chapters = chaptersOf(clips, segments);
  const outBeats = music.clearBeat ? music.beats.filter((b) => b >= win.start - 1e-6 && b <= win.end + 1e-6).map((b) => r6(b - win.start)) : G.slice();
  const outDown = (music.downbeats || []).filter((b) => b >= win.start - 1e-6 && b <= win.end + 1e-6).map((b) => r6(b - win.start));
  return {
    segments, why, leftOut: leftOutOf(usable.filter((u) => !u.copy), used), keepMap,
    duration: G[K], target: r6(G[K]),
    music: { trimIn: r6(win.start), bpm: music.bpm, clearBeat: !!music.clearBeat, beats: outBeats, downbeats: outDown },
    autoEdit: planSettings(s, { preset: s.length.preset, target: r6(G[K]) }, music),
  };
}

/** 'energy' order: units and sections matched by energy rank, then a monotone DP per section. */
function energyFill({ grid, K, g, usable, lens, place, locks, rep, withCopies, music, win }) {
  const { G } = grid;
  // Section boundaries on the grid (never inside a lock).
  const bounds = [0];
  for (const sec of music.sections || []) {
    const t = sec.start - win.start;
    if (t <= 1e-6 || t >= G[K] - 1e-6) continue;
    let k = 0;
    for (let i = 1; i <= K; i++) if (Math.abs(G[i] - t) < Math.abs(G[k] - t) - EPS) k = i;
    for (const l of locks) if (k > l.ka && k < l.kb) k = l.kb;
    if (k > bounds[bounds.length - 1] && k < K) bounds.push(k);
  }
  bounds.push(K);
  const secs = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const ka = bounds[i], kb = bounds[i + 1];
    let free = kb - ka;
    for (const l of locks) if (l.ka >= ka && l.kb <= kb) free -= l.kb - l.ka;
    secs.push({ ka, kb, need: Math.max(0, free / g), energy: grid.energyAt(G[ka], G[kb]), i });
  }
  const units = withCopies([...usable].sort((x, y) => x.energy - y.energy || x.ci - y.ci || x.a - y.a || (x.copy || 0) - (y.copy || 0)));
  units.sort((x, y) => x.energy - y.energy || x.ci - y.ci || x.a - y.a || (x.copy || 0) - (y.copy || 0));
  const need = secs.reduce((t, x) => t + x.need, 0) || 1;
  const byEnergy = [...secs].sort((x, y) => x.energy - y.energy || x.ka - y.ka);
  const chunks = new Map();
  let at = 0;
  byEnergy.forEach((sec, n) => {
    const size = n === byEnergy.length - 1 ? units.length - at : Math.round((units.length * sec.need) / need);
    chunks.set(sec.i, units.slice(at, at + size));
    at += size;
  });
  const items = [];
  let lastClip;
  for (const sec of secs) {
    const inSec = locks.filter((l) => l.ka >= sec.ka && l.kb <= sec.kb);
    let cols = chunks.get(sec.i) || [];
    let res = dpFill({ K0: sec.ka, K1: sec.kb, cols, lens, place, locks: inSec, startClip: lastClip, rep });
    if (!res) res = dpFill({ K0: sec.ka, K1: sec.kb, cols, lens, place, locks: inSec, startClip: lastClip, rep: REPEAT_CLIP });
    if (!res) { cols = units; res = dpFill({ K0: sec.ka, K1: sec.kb, cols, lens, place, locks: inSec, startClip: lastClip, rep: REPEAT_CLIP }); }
    if (!res) return null;
    for (const it of res.items) items.push(it);
    const last = res.items[res.items.length - 1];
    lastClip = last ? (last.lock ? last.lock.ci : last.u.ci) : lastClip;
  }
  return items;
}

function musicWhy(u, pl, ka, kb, grid, n, isPhoto, clearBeat) {
  const name = isPhoto ? `Photo ${n}` : `clip ${n}`;
  const where = (k) => (grid.isDown[k] ? (k === ka ? 'this downbeat' : `the downbeat of bar ${grid.bar[k]}`) : `beat ${grid.beat[k]} of bar ${grid.bar[k]}`);
  const base = { bar: grid.bar[ka], beat: grid.beat[ka], onDownbeat: !!grid.isDown[ka] };
  if (!clearBeat) {
    if (isPhoto) return { text: `${name} holds until the next strong onset with a slow push-in`, kind: 'photo' };
    return { text: `Cuts on a strong onset in the music (no clear beat)`, kind: u.kind };
  }
  if (isPhoto) return { text: `${name} holds for ${kb - ka} beats with a slow push-in`, kind: 'photo', ...base };
  if (pl.k !== null && pl.k !== undefined) {
    const sp = Math.abs(pl.speed - 1) > 0.005 ? ` at ${pl.speed.toFixed(2)}× speed` : '';
    return { text: `The move in ${name} lands on ${where(pl.k)}${sp}`, kind: 'move', ...base, moveAt: grid.G[pl.k] };
  }
  const Name = `${name[0].toUpperCase()}${name.slice(1)}`;
  if (u.speech) return { text: `${Name} starts at a sentence, on ${where(ka)}`, kind: 'speech', ...base };
  const sp = Math.abs(pl.speed - 1) > 0.005 ? ` at ${pl.speed.toFixed(2)}× speed` : '';
  return { text: `${Name} fills ${kb - ka === 1 ? '1 beat' : `${kb - ka} beats`} from ${where(ka)}${sp}`, kind: u.kind, ...base };
}

// ---- entry point ----------------------------------------------------------------------------------

/**
 * Make an Auto edit. clips in the user's order; music = beats.analyzeMusic() output or null; settings = plan
 * `autoEdit` (missing fields take DEFAULT_SETTINGS; without music, match is 'motion'; order defaults to 'energy'
 * with music and 'mine' without; keepClipSound defaults to true without music); previous = the current segments
 * (locked ones are kept) and the music trimIn. See the header for the result.
 */
export function solveAutoEdit({ clips = [], music = null, settings = {}, previous = null } = {}) {
  const list = (clips || []).filter((c) => c && c.id != null && (c.kind === 'photo' || clipDuration(c) > 0));
  const hasMusic = !!(music && music.duration > 0);
  const s = normalizeSettings(settings, hasMusic);
  const locks = lockedFrom(previous, list);
  if (!list.length) {
    return { segments: [], why: [], leftOut: [], keepMap: { total: 0, kept: 0, removed: { pauses: 0, retakes: 0, idle: 0, repeats: 0, lowScore: 0, unused: 0 }, ranges: [], chapters: [] }, duration: 0, target: 0, music: null, autoEdit: planSettings(s, { preset: s.length.preset, target: 0 }, null) };
  }
  return hasMusic ? solveMusic(list, music, s, locks, previous) : solveRough(list, s, locks);
}

export { barLength };
