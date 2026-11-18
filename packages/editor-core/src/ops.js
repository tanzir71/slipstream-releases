// Edit ops: validate and apply the shared op vocabulary (ops-schema.js) to a web edit (defaultEdit()).
// Pure: no DOM, no media, never mutates its input. Every applied op yields a diff so a UI can preview
// it, accept or reject it, and undo it; ops that produce files (render, export_nle) are returned as
// `effects` for the host to run against the final edit.

import { OPS } from './ops-schema.js';
import {
  computeCuts, keptRanges, totalDuration, markFillers, detectWordSilences, detectRetakes, applyRetakes,
  MIN_RANGE, uid, wordIdOf, segmentWords, outputSize, defaultEdit,
} from './edl.js';
import { findHighlights } from './highlights.js';

// ---- validation -----------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOk(v, t) {
  switch (t) {
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'object': return isObj(v);
    case 'array': return Array.isArray(v);
    default: return false;
  }
}

/** Checks `v` against the subset of JSON Schema used in ops-schema.js. */
function checkValue(v, s, path, errors) {
  if (s.anyOf) {
    if (!s.anyOf.some((sub) => { const e = []; checkValue(v, sub, path, e); return !e.length; })) errors.push(`${path} has the wrong shape`);
    return;
  }
  if ('const' in s && v !== s.const) { errors.push(`${path} must be ${JSON.stringify(s.const)}`); return; }
  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some((t) => typeOk(v, t))) { errors.push(`${path} must be ${types.join(' or ')}`); return; }
  }
  if (s.enum && !s.enum.includes(v)) { errors.push(`${path} must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`); return; }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${path} must be at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${path} must be at most ${s.maximum}`);
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path} must not be empty`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${path} must match ${s.pattern}`);
  }
  if (isObj(v) && s.properties) {
    for (const k of s.required || []) if (v[k] === undefined) errors.push(`${path}.${k} is required`);
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      const ps = s.properties[k];
      if (!ps) { if (s.additionalProperties === false) errors.push(`${path}.${k} is not an argument of this op`); continue; }
      checkValue(x, ps, `${path}.${k}`, errors);
    }
  }
}

function checkSemantics(name, a, errors) {
  const num = (x) => typeof x === 'number';
  if (['cut_range', 'restore_range', 'add_zoom'].includes(name) && !(a.end > a.start)) errors.push('args.end must be greater than args.start');
  if (name === 'update_zoom') {
    if (!['start', 'end', 'scale', 'x', 'y'].some((k) => a[k] !== undefined)) errors.push('update_zoom needs at least one of start, end, scale, x, y');
    if (num(a.start) && num(a.end) && !(a.end > a.start)) errors.push('args.end must be greater than args.start');
  }
  if (name === 'remove_zoom') {
    const hasSpan = num(a.start) && num(a.end);
    if (!a.id && !hasSpan) errors.push('remove_zoom needs an id, or start and end');
    if (hasSpan && a.end < a.start) errors.push('args.end must not be before args.start');
  }
  if (name === 'set_clip_range') {
    const s = a.start ?? null, e = a.end ?? null;
    if ((s === null) !== (e === null)) errors.push('set_clip_range needs both start and end, or neither to clear the range');
    else if (s !== null && !(e > s)) errors.push('args.end must be greater than args.start');
  }
  if (name === 'shorten_pauses' && !((a.keep ?? 0.25) < (a.min_gap ?? 0.75))) errors.push('args.keep must be smaller than args.min_gap');
  if (name === 'find_clips' && (a.min_dur ?? 12) > (a.max_dur ?? 60)) errors.push('args.min_dur must not exceed args.max_dur');
}

/** Hand-written check of { op, args } against OPS. Returns { valid, errors: [string] }. */
export function validateOp(op) {
  if (!isObj(op)) return { valid: false, errors: ['Each op must be an object like { "op": "cut_words", "args": { … } }'] };
  const name = op.op;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, name)) {
    return { valid: false, errors: [`Unknown op ${JSON.stringify(name)}. Known ops: ${Object.keys(OPS).join(', ')}`] };
  }
  const errors = [];
  for (const k of Object.keys(op)) if (k !== 'op' && k !== 'args') errors.push(`Unexpected field "${k}"; an op has only op and args`);
  const schema = OPS[name].inputSchema;
  let args = op.args;
  if (args === undefined && !schema.required) args = {};
  if (args === null && name === 'set_clip_range') args = {};
  if (!isObj(args)) errors.push(args === undefined ? 'args is required' : 'args must be an object');
  else {
    checkValue(args, schema, 'args', errors);
    if (!errors.length) checkSemantics(name, args, errors);
  }
  return { valid: errors.length === 0, errors };
}

// ---- helpers --------------------------------------------------------------------------------------

const clone = typeof structuredClone === 'function' ? (x) => structuredClone(x) : (x) => JSON.parse(JSON.stringify(x));
const round3 = (x) => Math.round(x * 1000) / 1000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const secs = (s) => `${Math.abs(s).toFixed(1)} s`;

/** m:ss.s (or h:mm:ss.s) for summaries. */
export function fmtTime(t) {
  const s = Math.max(0, t || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s - h * 3600 - m * 60;
  const ss = r.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** mm:ss.s (or h:mm:ss.s) for prompt transcripts. */
function clock(t) {
  const s = Math.max(0, t || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s - h * 3600 - m * 60;
  const ss = (Math.floor(r * 10) / 10).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Best guess at the source duration when the host did not pass ctx.duration. */
export function inferDuration(edit) {
  let d = 0;
  for (const w of edit?.words || []) d = Math.max(d, w.end || 0);
  for (const c of edit?.cuts || []) d = Math.max(d, c.end || 0);
  for (const z of edit?.zooms || []) d = Math.max(d, z.end || 0);
  if (edit?.range) d = Math.max(d, edit.range.end || 0);
  return d;
}

const durationOf = (edit, ctx) => (ctx && Number.isFinite(ctx.duration) && ctx.duration > 0 ? ctx.duration : inferDuration(edit));

/** Output (edited) duration in seconds. */
export function outputDuration(edit, duration) {
  return totalDuration(keptRanges(computeCuts(edit, duration), duration));
}

function wordIndexMap(words) {
  const m = new Map();
  for (let i = 0; i < words.length; i++) {
    const id = wordIdOf(words, i);
    if (!m.has(id)) m.set(id, i);
  }
  return m;
}

function resolveWordRange(words, a) {
  const map = wordIndexMap(words);
  const i = map.get(String(a.from_word_id)), j = map.get(String(a.to_word_id));
  const missing = [i === undefined && a.from_word_id, j === undefined && a.to_word_id].filter((x) => x !== false);
  if (missing.length) return { error: `Unknown word id${missing.length > 1 ? 's' : ''} ${missing.map((x) => JSON.stringify(x)).join(' and ')}` };
  return { lo: Math.min(i, j), hi: Math.max(i, j) };
}

function liveText(words, lo, hi, max = 90) {
  const t = [];
  for (let i = lo; i <= hi; i++) if (!words[i].deleted) t.push(words[i].text);
  const s = t.join(' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function restoreWord(w) {
  const { deleted, retake, ...rest } = w;
  return rest;
}

const MODE_LABEL = { pip: 'camera bubble', split: 'split screen', screen: 'screen only', camera: 'camera only' };
const CORNER_LABEL = { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' };
const ASPECT_LABEL = { '16:9': 'landscape', '9:16': 'vertical', '1:1': 'square', '4:5': 'portrait' };
const PRESET_LABEL = { studio: 'Studio', cinema: 'Cinema', editorial: 'Editorial', bold: 'Bold' };
const NLE_LABEL = { fcpxml: 'Final Cut Pro XML (FCPXML)', edl: 'CMX3600 EDL', xmeml: 'Premiere Pro XML' };

function setFields(e, key, a, fields, defaults) {
  e[key] = { ...defaults, ...(e[key] || {}) };
  const settings = [];
  for (const k of fields) {
    if (a[k] === undefined || e[key][k] === a[k]) continue;
    settings.push({ path: `${key}.${k}`, before: e[key][k], after: a[k] });
    e[key][k] = a[k];
  }
  return settings;
}

// ---- op handlers ----------------------------------------------------------------------------------
// Each handler mutates the cloned edit `e` and returns { diff, summary(seconds) } or { error }.

const H = {
  cut_words(e, a) {
    const r = resolveWordRange(e.words, a);
    if (r.error) return r;
    const deleted = [];
    const text = liveText(e.words, r.lo, r.hi);
    for (let i = r.lo; i <= r.hi; i++) {
      if (e.words[i].deleted) continue;
      e.words[i] = { ...e.words[i], deleted: true };
      deleted.push(wordIdOf(e.words, i));
    }
    return {
      diff: { words: { deleted, restored: [] }, text },
      summary: (s) => (deleted.length ? `Cut ${plural(deleted.length, 'word')} (${secs(s)})` : 'Those words are already cut'),
    };
  },

  restore_words(e, a) {
    const r = resolveWordRange(e.words, a);
    if (r.error) return r;
    const restored = [];
    for (let i = r.lo; i <= r.hi; i++) {
      if (!e.words[i].deleted) continue;
      e.words[i] = restoreWord(e.words[i]);
      restored.push(wordIdOf(e.words, i));
    }
    return {
      diff: { words: { deleted: [], restored } },
      summary: (s) => (restored.length ? `Restored ${plural(restored.length, 'word')} (+${secs(s)})` : 'Those words are not cut'),
    };
  },

  cut_range(e, a, { duration, cutKind = 'ai' }) {
    const start = Math.max(0, a.start), end = Math.min(duration, a.end);
    if (end - start < MIN_RANGE) return { error: `Nothing to cut between ${fmtTime(a.start)} and ${fmtTime(a.end)} (video is ${fmtTime(duration)})` };
    const cut = { id: uid('c'), start, end, kind: cutKind };
    e.cuts.push(cut);
    return { diff: { cuts: { added: [cut], removed: [] } }, summary: (s) => `Cut ${fmtTime(start)}–${fmtTime(end)} (${secs(s)})` };
  },

  restore_range(e, a, { duration }) {
    const s = Math.max(0, a.start), t = Math.min(duration, a.end);
    const removed = [], added = [], keep = [];
    for (const c of e.cuts) {
      if (c.end <= s || c.start >= t) { keep.push(c); continue; }
      removed.push(c);
      if (s - c.start >= MIN_RANGE) { const p = { ...c, id: uid('c'), end: s }; keep.push(p); added.push(p); }
      if (c.end - t >= MIN_RANGE) { const p = { ...c, id: uid('c'), start: t }; keep.push(p); added.push(p); }
    }
    e.cuts = keep;
    const restored = [];
    e.words = e.words.map((w, i) => {
      if (!w.deleted || !(w.start < t && w.end > s)) return w;
      restored.push(wordIdOf(e.words, i));
      return restoreWord(w);
    });
    const settings = [];
    if (e.range && (e.range.start > s || e.range.end < t)) {
      const before = { ...e.range };
      let after = { start: Math.min(e.range.start, s), end: Math.max(e.range.end, t) };
      if (after.start <= 0.001 && after.end >= duration - 0.001) after = null;
      e.range = after;
      settings.push({ path: 'range', before, after });
    }
    const diff = { words: { deleted: [], restored }, cuts: { added, removed } };
    if (settings.length) diff.settings = settings;
    const nothing = !removed.length && !restored.length && !settings.length;
    return { diff, summary: (x) => (nothing ? `Nothing is cut between ${fmtTime(s)} and ${fmtTime(t)}` : `Restored ${fmtTime(s)}–${fmtTime(t)} (+${secs(x)})`) };
  },

  remove_fillers(e, a) {
    const marked = markFillers(e.words);
    const deleted = [];
    e.words = e.words.map((w, i) => {
      const f = marked[i].filler;
      if (w.deleted || !(f === 'hard' || (a.include_soft && f === 'soft'))) return w;
      deleted.push(wordIdOf(e.words, i));
      return { ...w, deleted: true };
    });
    return {
      diff: { words: { deleted, restored: [] } },
      summary: (s) => (deleted.length ? `Removed ${plural(deleted.length, 'filler')} (${secs(s)})` : 'No fillers to remove'),
    };
  },

  shorten_pauses(e, a, { duration }) {
    const minGap = a.min_gap ?? 0.75, keepSec = a.keep ?? 0.25;
    const sil = detectWordSilences(e.words, duration, { minGap, keep: keepSec });
    const same = (x, y) => Math.abs(x.start - y.start) < 1e-6 && Math.abs(x.end - y.end) < 1e-6;
    const old = e.cuts.filter((c) => c.kind === 'silence');
    const removed = old.filter((c) => !sil.some((r) => same(c, r)));
    const added = sil.filter((r) => !old.some((c) => same(c, r))).map((r) => ({ id: uid('c'), start: r.start, end: r.end, kind: 'silence' }));
    e.cuts = [...e.cuts.filter((c) => !removed.includes(c)), ...added];
    const none = !e.words.length ? 'No pauses found (needs a transcript)' : 'No long pauses to shorten';
    return {
      diff: { cuts: { added, removed } },
      summary: (s) => (sil.length ? `Shortened ${plural(sil.length, 'pause')} to ${keepSec} s (${s <= 0 ? '' : '+'}${secs(s)})` : none),
    };
  },

  remove_retakes(e) {
    const props = detectRetakes(e.words);
    const before = e.words;
    e.words = applyRetakes(before, props);
    const deleted = [];
    for (let i = 0; i < e.words.length; i++) if (e.words[i] !== before[i]) deleted.push(wordIdOf(e.words, i));
    const retakes = props.map((p) => ({
      id: p.id,
      from_word_id: wordIdOf(before, p.from), to_word_id: wordIdOf(before, p.to),
      keep_from_word_id: wordIdOf(before, p.keepFrom), keep_to_word_id: wordIdOf(before, p.keepTo),
      similarity: p.similarity, start: p.start, end: p.end, text: liveText(before, p.from, p.to),
    }));
    return {
      diff: { words: { deleted, restored: [] }, retakes },
      summary: (s) => (props.length ? `Removed ${plural(props.length, 'retake')} (${secs(s)})` : 'No retakes found'),
    };
  },

  add_zoom(e, a, { duration }) {
    const id = a.id || uid('z');
    if (e.zooms.some((z) => z.id === id)) return { error: `A zoom with id ${JSON.stringify(id)} already exists; use update_zoom` };
    const start = Math.max(0, a.start), end = Math.min(duration, a.end);
    if (end - start < 0.1) return { error: `Zoom ${fmtTime(a.start)}–${fmtTime(a.end)} is outside the video (${fmtTime(duration)})` };
    const z = { id, start, end, scale: a.scale ?? 1.8, x: a.x ?? 0.5, y: a.y ?? 0.5 };
    e.zooms.push(z);
    return { diff: { zooms: { added: [z], removed: [], updated: [] } }, summary: () => `Added a ${z.scale.toFixed(1)}× zoom at ${fmtTime(start)} (${(end - start).toFixed(1)} s)` };
  },

  update_zoom(e, a) {
    const i = e.zooms.findIndex((z) => z.id === a.id);
    if (i < 0) return { error: `Unknown zoom id ${JSON.stringify(a.id)}` };
    const before = { ...e.zooms[i] };
    const after = { ...before };
    for (const k of ['start', 'end', 'scale', 'x', 'y']) if (a[k] !== undefined) after[k] = a[k];
    if (!(after.end > after.start)) return { error: 'Zoom end must be after its start' };
    if (after.auto) after.auto = false;
    e.zooms[i] = after;
    return { diff: { zooms: { added: [], removed: [], updated: [{ id: a.id, before, after }] } }, summary: () => `Updated the zoom at ${fmtTime(after.start)}` };
  },

  remove_zoom(e, a) {
    let removed;
    if (a.id) {
      removed = e.zooms.filter((z) => z.id === a.id);
      if (!removed.length) return { error: `Unknown zoom id ${JSON.stringify(a.id)}` };
    } else {
      const hit = a.end > a.start ? (z) => z.start < a.end && z.end > a.start : (z) => z.start <= a.start && z.end >= a.start;
      removed = e.zooms.filter(hit);
    }
    e.zooms = e.zooms.filter((z) => !removed.includes(z));
    return { diff: { zooms: { added: [], removed, updated: [] } }, summary: () => (removed.length ? `Removed ${plural(removed.length, 'zoom')}` : 'No zooms there') };
  },

  set_layout(e, a) {
    const settings = setFields(e, 'layout', a, ['mode', 'corner', 'size', 'shape', 'split'], defaultEdit().layout);
    const L = e.layout;
    const parts = [MODE_LABEL[L.mode] || L.mode];
    for (const s of settings) {
      if (s.path === 'layout.corner') parts.push(CORNER_LABEL[s.after]);
      if (s.path === 'layout.shape') parts.push(s.after);
      if (s.path === 'layout.size') parts.push(`size ${Math.round(s.after * 100)}%`);
      if (s.path === 'layout.split') parts.push(`camera ${Math.round(s.after * 100)}%`);
    }
    return { diff: { settings }, summary: () => (settings.length ? `Layout: ${parts.join(', ')}` : 'Layout unchanged') };
  },

  set_aspect(e, a) {
    const before = e.aspect;
    const settings = before === a.aspect ? [] : [{ path: 'aspect', before, after: a.aspect }];
    e.aspect = a.aspect;
    return { diff: { settings }, summary: () => `Aspect ${a.aspect} (${ASPECT_LABEL[a.aspect]})${settings.length ? '' : ', unchanged'}` };
  },

  set_captions(e, a) {
    const settings = setFields(e, 'captions', a, ['enabled', 'preset', 'position', 'size', 'color'], defaultEdit().captions);
    const parts = [];
    for (const s of settings) {
      const k = s.path.split('.')[1];
      if (k === 'enabled') parts.push(s.after ? 'on' : 'off');
      if (k === 'preset') parts.push(PRESET_LABEL[s.after]);
      if (k === 'position') parts.push(s.after);
      if (k === 'size') parts.push(`size ${Math.round(s.after * 100)}%`);
      if (k === 'color') parts.push(s.after);
    }
    return { diff: { settings }, summary: () => (settings.length ? `Captions: ${parts.join(', ')}` : 'Captions unchanged') };
  },

  set_clip_range(e, a, { duration }) {
    const before = e.range ? { ...e.range } : null;
    let after = null;
    if (a && typeof a.start === 'number') {
      after = { start: Math.max(0, a.start), end: Math.min(duration, a.end) };
      if (after.end - after.start < MIN_RANGE) return { error: `Clip range ${fmtTime(a.start)}–${fmtTime(a.end)} is outside the video (${fmtTime(duration)})` };
    }
    e.range = after;
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    return {
      diff: { settings: changed ? [{ path: 'range', before, after }] : [] },
      summary: () => (after ? `Clip range ${fmtTime(after.start)}–${fmtTime(after.end)} (${(after.end - after.start).toFixed(1)} s)` : 'Clip range cleared: exporting the whole recording'),
    };
  },

  find_clips(e, a, { duration }) {
    const candidates = findHighlights(e.words, { minDur: a.min_dur ?? 12, maxDur: a.max_dur ?? 60, count: a.count ?? 5 })
      .map((c) => ({ ...c, start: round3(c.start), end: round3(Math.min(duration, c.end)) }));
    return {
      readOnly: true,
      diff: { candidates },
      summary: () => (candidates.length ? `Found ${plural(candidates.length, 'clip idea')}` : e.words.length ? 'No clips of that length found' : 'No clips found (needs a transcript)'),
    };
  },

  render(e, a) {
    const size = outputSize(e.aspect || '16:9', 1080);
    const args = {
      width: a.width ?? size.width,
      height: a.height ?? size.height,
      fps: a.fps ?? 30,
      format: a.format ?? 'mp4',
      captions: a.captions ?? (!!(e.captions && e.captions.enabled) && e.words.length > 0),
    };
    return {
      readOnly: true,
      diff: {},
      effect: { op: 'render', args },
      summary: () => `Render ${args.width}×${args.height} ${args.format.toUpperCase()} at ${args.fps} fps${args.captions ? ' with captions' : ''}`,
    };
  },

  export_nle(e, a) {
    return { readOnly: true, diff: {}, effect: { op: 'export_nle', args: { format: a.format } }, summary: () => `Export ${NLE_LABEL[a.format]}` };
  },
};

const TIMELINE_OPS = new Set(['cut_words', 'restore_words', 'cut_range', 'restore_range', 'remove_fillers', 'shorten_pauses', 'remove_retakes', 'set_clip_range']);

// ---- apply ----------------------------------------------------------------------------------------

/**
 * Apply one op. ctx = { duration (source seconds), cutKind? ('ai' default for cut_range) }.
 * Returns { edit, diff, errors: [string], effect } — on error `edit` is the input and diff is null.
 */
export function applyOp(edit, op, ctx = {}) {
  const v = validateOp(op);
  if (!v.valid) return { edit, diff: null, errors: v.errors, effect: null };
  const name = op.op;
  const args = op.args == null ? {} : op.args;
  const duration = durationOf(edit, ctx);
  const e = clone(edit || defaultEdit());
  e.words = Array.isArray(e.words) ? e.words : [];
  e.cuts = Array.isArray(e.cuts) ? e.cuts : [];
  e.zooms = Array.isArray(e.zooms) ? e.zooms : [];
  if (!(duration > 0) && TIMELINE_OPS.has(name)) return { edit, diff: null, errors: [`${name} needs the video duration (ctx.duration)`], effect: null };
  const before = TIMELINE_OPS.has(name) ? outputDuration(e, duration) : 0;
  let r;
  try {
    r = H[name](e, args, { ...ctx, duration });
  } catch (err) {
    return { edit, diff: null, errors: [`${name} failed: ${err && err.message ? err.message : err}`], effect: null };
  }
  if (r.error) return { edit, diff: null, errors: [r.error], effect: null };
  const diff = { op: name, summary: '', ...r.diff };
  let seconds = 0;
  if (TIMELINE_OPS.has(name)) {
    seconds = round3(outputDuration(e, duration) - before);
    diff.seconds = seconds;
  }
  diff.summary = r.summary(seconds);
  return { edit: r.readOnly ? edit : e, diff, errors: [], effect: r.effect || null };
}

/**
 * Apply ops in order. `ops` is an array of { op, args } (or { ops: [...] } as a model returns it).
 * Invalid ops are skipped and reported; the rest still apply.
 * Returns { edit, diffs: [{ index, op, summary, … }], errors: [{ index, op, message }], effects: [{ index, op, args }] }.
 */
export function applyOps(edit, ops, ctx = {}) {
  const list = Array.isArray(ops) ? ops : ops && Array.isArray(ops.ops) ? ops.ops : null;
  if (!list) return { edit, diffs: [], errors: [{ index: -1, op: null, message: 'ops must be an array of { op, args }' }], effects: [] };
  const c = { ...ctx, duration: durationOf(edit, ctx) };
  let cur = edit;
  const diffs = [], errors = [], effects = [];
  list.forEach((op, index) => {
    const r = applyOp(cur, op, c);
    if (r.errors.length) {
      for (const message of r.errors) errors.push({ index, op: isObj(op) && typeof op.op === 'string' ? op.op : null, message });
      return;
    }
    cur = r.edit;
    diffs.push({ index, ...r.diff });
    if (r.effect) effects.push({ index, ...r.effect });
  });
  return { edit: cur, diffs, errors, effects };
}

// ---- prompt helpers -------------------------------------------------------------------------------

/**
 * Compact plan summary for prompts and get_plan. Returns the numbers plus `text`, a few lines a model
 * can read. ctx = { duration }.
 */
export function summarizeEdit(edit, ctx = {}) {
  const e = edit || defaultEdit();
  const words = e.words || [];
  const duration = durationOf(e, ctx);
  const out = duration > 0 ? outputDuration({ ...e, words }, duration) : 0;
  const marked = markFillers(words);
  const fillersLeft = marked.filter((w, i) => w.filler === 'hard' && !words[i].deleted).length;
  const deleted = words.filter((w) => w.deleted).length;
  const retakes = new Set(words.filter((w) => w.deleted && w.retake).map((w) => w.retake)).size;
  const cutKinds = {};
  for (const c of e.cuts || []) cutKinds[c.kind || 'manual'] = (cutKinds[c.kind || 'manual'] || 0) + 1;
  const L = e.layout || {}, C = e.captions || {};
  const s = {
    duration: round3(duration),
    outputDuration: round3(out),
    removed: round3(duration - out),
    words: { total: words.length, deleted, fillersLeft, retakesCut: retakes },
    cuts: { total: (e.cuts || []).length, ...cutKinds },
    zooms: (e.zooms || []).length,
    chapters: (e.chapters || []).length,
    aspect: e.aspect || '16:9',
    layout: { mode: L.mode, corner: L.corner, shape: L.shape, size: L.size, split: L.split },
    captions: { enabled: !!C.enabled, preset: C.preset, position: C.position, size: C.size },
    range: e.range ? { start: e.range.start, end: e.range.end } : null,
  };
  const kinds = Object.entries(cutKinds).map(([k, n]) => `${n} ${k}`).join(', ');
  const layout = L.mode === 'pip' ? `pip (${CORNER_LABEL[L.corner] || L.corner}, ${L.shape}, ${Math.round((L.size || 0) * 100)}%)` : L.mode === 'split' ? `split (camera ${Math.round((L.split || 0) * 100)}%)` : L.mode || 'pip';
  s.text = [
    `Source ${fmtTime(duration)} · output ${fmtTime(out)} (${s.removed > 0 ? '−' : ''}${s.removed.toFixed(1)} s cut)`,
    words.length ? `Transcript ${plural(words.length, 'word')} · ${deleted} cut · ${plural(fillersLeft, 'filler')} left${retakes ? ` · ${plural(retakes, 'retake')} cut` : ''}` : 'No transcript yet',
    `Cuts ${s.cuts.total}${kinds ? ` (${kinds})` : ''} · ${plural(s.zooms, 'zoom')} · ${plural(s.chapters, 'chapter')}`,
    `Aspect ${s.aspect} · layout ${layout}`,
    `Captions ${C.enabled ? `on (${C.preset}, ${C.position}, size ${C.size ?? 1})` : 'off'}`,
    `Clip range ${e.range ? `${fmtTime(e.range.start)}–${fmtTime(e.range.end)}` : 'whole recording'}`,
  ].join('\n');
  return s;
}

/**
 * Transcript for a model prompt, one sentence per line:
 *   [w_12..w_25] 00:42.1 So the first thing ~~um~~ you do is…
 * The bracket gives the first and last word id of the line (use them for cut_words); ~~…~~ marks words
 * already cut. With { ids: 'word' } every word carries its id (`w_12:So`) for phrase-level edits.
 * Lines past maxChars are dropped with a note.
 */
export function transcriptForPrompt(words, { maxChars = 12000, ids = 'sentence' } = {}) {
  const ws = words || [];
  const segs = segmentWords(ws, { includeDeleted: true, breaks: true });
  const lines = [];
  for (const s of segs) {
    const parts = [];
    let run = [];
    const flush = () => { if (run.length) { parts.push(`~~${run.join(' ')}~~`); run = []; } };
    for (const i of s.indices) {
      const t = ids === 'word' ? `${wordIdOf(ws, i)}:${ws[i].text}` : String(ws[i].text);
      if (ws[i].deleted) run.push(t);
      else { flush(); parts.push(t); }
    }
    flush();
    const head = ids === 'word' ? '' : `[${wordIdOf(ws, s.from)}..${wordIdOf(ws, s.to)}] `;
    lines.push(`${head}${clock(s.start)} ${parts.join(' ')}`);
  }
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    const note = `… ${plural(lines.length - k, 'more line')} not shown`;
    if (out.length + lines[k].length + 1 > maxChars - (k < lines.length - 1 ? note.length + 1 : 0)) {
      return `${out}${note}`;
    }
    out += `${lines[k]}\n`;
  }
  return out.replace(/\n$/, '');
}
