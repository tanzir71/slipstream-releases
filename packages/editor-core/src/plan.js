// Edit plan v2 (ticket C-01): migrations between the shapes Slipstream has used and the shared v2 format.
// Pure: no DOM, no I/O. Never mutates its inputs (everything is cloned first).
//
//   toV2(edit, media?, meta?)  (alias fromWebV1)   web project.edit (+ project.media) -> v2
//   fromV2(plan)                                   v2 -> { edit, media, meta } in the web shape
//   fromEngineV1(enginePlan, opts?)                Rust slipstream_engine EditPlan v1 -> v2
//   toEngine(plan, opts?)                          v2 -> engine EditPlan v1 for `slipstream_engine render-plan`
//   fromSwiftV1(json, opts?)                       macOS 1.x project JSON (best effort) -> v2
//   detectPlanShape(json) / migratePlan(json)      sniff any of the above and return v2
//   validatePlan(plan)                             JSON Schema check against PLAN_SCHEMA
//
// Units
// - Times are seconds on the source timeline everywhere.
// - v2 padding / radius / camera size / margin are fractions of the output frame's short side, like the web
//   compositor. The engine and macOS shapes may store pixels or points: values > 1 are read as pixels and
//   divided by `reference` (default 1080, the short side of a 1080p export); values <= 1 are fractions.
//   toEngine writes fractions unless called with { units: 'px' }.
// - Zoom scale is a multiplier (1 = no zoom). Values > 4 are read as percentages (150 -> 1.5).
// - Zoom focus x/y are 0..1 of the source frame. Larger values are read as pixels when the source size is
//   known, else clamped.
// - Shadow is 0..1. A boolean becomes 0.7 (the web default) or 0; values > 1 are read as percentages.
//
// Engine v1 (docs/ARCHITECTURE.md §1.2, reverse-engineered from the binary; field names assumed camelCase via
// serde rename_all): source{screenPath, cameraPath, fps, screenAudioTracks, cameraAudioTracks},
// frame{aspect, reframe, focusPath, staging{backgroundKind, backgroundHex, gradientId, imagePath, padding,
// cornerRadius, scale, offsetX, offsetY, shadow}}, words[{id, text, start, end, isCut}], segments[], manualCuts[],
// zooms[{startTime, endTime, focus{x,y}, scale}], camera{enabled, layout, splitRatio, rounded, margin},
// cursor{…}, captions{preset, fontScale, fillChoice, boxed, cues}, audio{fadeIn, fadeOut}, broll[], focusKeyframes[].
// Assumptions: serde ignores unknown fields (toEngine adds id/kind to cuts and zooms, source.duration, so a
// round trip is lossless); `frame.reframe` may be a bool, an anchor string or {enabled, anchor, smoothing};
// `camera.layout` names are matched loosely (split/stack/side -> split, bubble/pip/overlay -> pip,
// camera/full/face -> camera, screen/none/hidden -> screen) and written back as the v2 mode names.
//
// Cut ranges for the engine: toEngine bakes every cut the web would make into `manualCuts`: explicit cuts keep
// their kind, ranges derived from deleted words are tagged kind 'words' and the clip in/out kind 'range'. The
// union equals edl.computeCuts() exactly, whatever padding the engine applies to `isCut` words. fromEngineV1
// drops the 'words' entries (they come back from isCut) and turns the 'range' entries back into `range`.

import { PLAN_SCHEMA } from './plan-schema.js';
import { validate } from './jsonschema.js';
import { defaultEdit, wordCutRanges, ASPECTS } from './edl.js';

export { PLAN_SCHEMA };
export const PLAN_VERSION = 2;

const CUT_KINDS = new Set(['manual', 'silence', 'retake', 'ai']);
const PRESETS = new Set(PLAN_SCHEMA.properties.captions.properties.preset.enum);
const MODES = new Set(['pip', 'split', 'screen', 'camera']);
const SHAPES = new Set(['circle', 'rounded', 'square', 'wide']);
const ANCHORS = new Set(['center', 'left', 'right', 'auto']);
const DEFAULT_REFERENCE = 1080;
const UNKNOWN_DURATION_END = 1e6; // tail cut end when the source duration is unknown

// Keys of the web edit that toV2 maps explicitly; every other key passes through to the plan unchanged.
const WEB_EDIT_KEYS = new Set(['words', 'cuts', 'zooms', 'range', 'chapters', 'aspect', 'frame', 'layout', 'scenes', 'style', 'captions', 'speakers', 'brand', 'version', 'app', 'meta', 'sources']);
// Keys of a v2 plan that fromV2 maps explicitly; every other key passes through to the web edit unchanged.
const V2_KEYS = new Set(['version', 'app', 'meta', 'sources', 'words', 'cuts', 'zooms', 'range', 'chapters', 'frame', 'layout', 'scenes', 'style', 'captions', 'speakers', 'brand']);

// ---------------------------------------------------------------------------------------------------------
// Small helpers

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const isAspect = (a) => typeof a === 'string' && Object.prototype.hasOwnProperty.call(ASPECTS, a);

/** Drop keys whose value is undefined (shallow). */
function compact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** First value among `keys` of `o` that is neither undefined nor null. */
function pick(o, ...keys) {
  if (!isObj(o)) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** A finite number from a number, a numeric string, a CMTime-like {value, timescale} or {seconds}. */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (isObj(v)) {
    if (v.value !== undefined && v.timescale) return toNum(Number(v.value) / Number(v.timescale));
    if (v.seconds !== undefined) return toNum(v.seconds);
  }
  return undefined;
}
const str = (v) => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const int = (v) => { const n = toNum(v); return n === undefined ? undefined : Math.round(n); };
const ints = (v) => (Array.isArray(v) ? v.map(int).filter((n) => n !== undefined) : undefined);

function sameJSON(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJSON(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameJSON(a[k], b[k]));
  }
  return false;
}

/** Pixels (> 1) to a fraction of `reference`; fractions pass through. */
function toFraction(v, reference) {
  const n = toNum(v);
  if (n === undefined) return undefined;
  return Math.abs(n) > 1 ? round6(n / reference) : n;
}

function hex6(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split('').map((c) => c + c).join('')}`.toLowerCase();
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return `#${s.slice(0, 6)}`;
  return undefined;
}

function normShadow(v) {
  if (typeof v === 'boolean') return v ? 0.7 : 0;
  const n = toNum(v);
  if (n === undefined) return undefined;
  return clamp(n > 1 ? n / 100 : n, 0, 1);
}

function normZoomScale(v) {
  const n = toNum(v);
  if (n === undefined) return 1.5;
  return clamp(n > 4 ? n / 100 : n, 1, 4);
}

const ASPECT_WORDS = {
  landscape: '16:9', widescreen: '16:9', horizontal: '16:9', wide: '16:9', youtube: '16:9',
  portrait: '9:16', vertical: '9:16', story: '9:16', stories: '9:16', reel: '9:16', reels: '9:16', shorts: '9:16', tiktok: '9:16', ninebysixteen: '9:16', sixteenbynine: '16:9',
  square: '1:1', onebyone: '1:1', fourbyfive: '4:5', feed: '4:5', instagram: '4:5',
};
function normAspect(a) {
  if (typeof a === 'number' && a > 0) {
    let best = '16:9', bestErr = Infinity;
    for (const [k, [w, h]] of Object.entries(ASPECTS)) { const err = Math.abs(Math.log(a / (w / h))); if (err < bestErr) { best = k; bestErr = err; } }
    return best;
  }
  if (isObj(a)) return normAspect(pick(a, 'aspect', 'ratio', 'rawValue', 'id') ?? Object.keys(a)[0]);
  if (typeof a !== 'string') return '16:9';
  const s = a.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const m = /^(\d+)[:x/×](\d+)$/.exec(s);
  if (m && isAspect(`${m[1]}:${m[2]}`)) return `${m[1]}:${m[2]}`;
  return Object.prototype.hasOwnProperty.call(ASPECT_WORDS, s) ? ASPECT_WORDS[s] : '16:9';
}

function normCorner(c) {
  if (typeof c !== 'string') return undefined;
  const s = c.toLowerCase().replace(/[\s_-]+/g, '');
  if (['tl', 'tr', 'bl', 'br'].includes(s)) return s;
  const v = s.includes('top') ? 't' : s.includes('bottom') ? 'b' : undefined;
  const h = s.includes('left') || s.includes('leading') ? 'l' : s.includes('right') || s.includes('trailing') ? 'r' : undefined;
  return v && h ? v + h : undefined;
}

function normLayoutMode(m) {
  if (isObj(m)) m = Object.keys(m)[0]; // Swift enums with associated values encode as {"case": {...}}
  if (typeof m !== 'string') return undefined;
  const s = m.toLowerCase();
  if (MODES.has(s)) return s;
  if (/split|stack|side/.test(s)) return 'split';
  if (/bubble|pip|overlay|corner|float/.test(s)) return 'pip';
  if (/camera|full|face/.test(s)) return 'camera';
  if (/screen|none|hidden|off/.test(s)) return 'screen';
  return undefined;
}

function normPreset(p) {
  if (isObj(p)) p = pick(p, 'id', 'rawValue', 'name') ?? Object.keys(p)[0];
  if (typeof p !== 'string') return undefined;
  const s = p.toLowerCase();
  return PRESETS.has(s) ? s : 'studio';
}

function normPosition(p) {
  if (typeof p !== 'string') return undefined;
  const s = p.toLowerCase();
  if (s.includes('top')) return 'top';
  if (s.includes('mid') || s.includes('center') || s.includes('centre')) return 'middle';
  if (s.includes('bottom')) return 'bottom';
  return undefined;
}

/** {x, y} from {x, y} or [x, y] (CGPoint encodes as an array). */
function point(p) {
  if (Array.isArray(p) && p.length >= 2) return { x: toNum(p[0]), y: toNum(p[1]) };
  if (isObj(p)) return { x: toNum(p.x), y: toNum(p.y) };
  return undefined;
}

function unit(v, size) {
  if (v === undefined) return 0.5;
  if (v > 1 && size) v /= size;
  return round6(clamp(v, 0, 1));
}

/** {start, end} from {start,end} / {startTime,endTime} / {from,to} / {lowerBound,upperBound} / [a, b] / {start, duration}. */
function normRange(r) {
  if (Array.isArray(r) && r.length >= 2) return { start: toNum(r[0]), end: toNum(r[1]) };
  if (!isObj(r)) return undefined;
  if (isObj(r.range) || Array.isArray(r.range)) return normRange(r.range);
  const start = toNum(pick(r, 'start', 'startTime', 'from', 'lowerBound', 'in', 'inPoint'));
  let end = toNum(pick(r, 'end', 'endTime', 'to', 'upperBound', 'out', 'outPoint'));
  const dur = toNum(r.duration);
  if (end === undefined && start !== undefined && dur !== undefined) end = start + dur;
  return start === undefined || end === undefined ? undefined : { start, end };
}

function normKeyframe(k) {
  if (Array.isArray(k)) return k.length >= 3 ? compact({ t: toNum(k[0]) ?? 0, x: toNum(k[1]) ?? 0.5, y: toNum(k[2]) ?? 0.5 }) : undefined;
  if (!isObj(k)) return undefined;
  const p = point(pick(k, 'focus', 'point', 'center')) || { x: toNum(k.x), y: toNum(k.y) };
  return compact({ t: toNum(pick(k, 't', 'time', 'timestamp', 'at', 'start')) ?? 0, x: p.x ?? 0.5, y: p.y ?? 0.5, scale: toNum(k.scale) });
}
const keyframes = (list) => arr(list).map(normKeyframe).filter(Boolean);

function normCue(c) {
  if (!isObj(c)) return undefined;
  const r = normRange(c);
  const text = str(pick(c, 'text', 'string', 'caption'));
  return r && text !== undefined ? { start: r.start, end: r.end, text } : undefined;
}
const cues = (list) => arr(list).map(normCue).filter(Boolean);

function normWord(w, i) {
  const r = normRange(w) || { start: 0, end: 0 };
  const deleted = pick(w, 'deleted', 'isCut', 'isDeleted', 'isRemoved', 'removed', 'isExcluded');
  const filler = w.filler === 'hard' || w.filler === 'soft' ? w.filler : w.isFiller === true ? 'hard' : undefined;
  const conf = toNum(pick(w, 'confidence', 'probability', 'p'));
  return compact({
    id: str(w.id) ?? `w${i}`,
    text: str(pick(w, 'text', 'word', 'string')) ?? '',
    start: r.start,
    end: r.end,
    deleted: !!deleted,
    filler,
    speaker: str(pick(w, 'speaker', 'speakerId', 'speakerID')),
    retake: str(w.retake),
    confidence: conf === undefined ? undefined : clamp(conf, 0, 1),
  });
}

function normZoom(z, i, size = {}) {
  const r = normRange(z) || { start: 0, end: 0 };
  const f = point(pick(z, 'focus', 'center', 'point', 'target')) || { x: toNum(z.x), y: toNum(z.y) };
  const followRaw = pick(z, 'follow', 'mode');
  const follow = followRaw === 'cursor' || followRaw === 'fixed' ? followRaw
    : z.followCursor === true || z.followsCursor === true ? 'cursor'
      : z.followCursor === false || z.followsCursor === false ? 'fixed' : undefined;
  const auto = bool(pick(z, 'auto', 'isAuto'));
  return compact({
    id: str(z.id) ?? `z${i + 1}`,
    start: r.start,
    end: r.end,
    scale: normZoomScale(pick(z, 'scale', 'zoom', 'magnification', 'level')),
    x: unit(f.x, size.width),
    y: unit(f.y, size.height),
    ramp: toNum(pick(z, 'ramp', 'easeDuration', 'transition')),
    auto,
    follow,
  });
}

function normBroll(b, i) {
  const r = normRange(b) || { start: 0, end: 0 };
  const fit = b.fit === 'cover' || b.fit === 'contain' ? b.fit : undefined;
  return compact({
    assetId: str(pick(b, 'assetId', 'assetID', 'sourceId', 'sourceID', 'id')) ?? str(b.source?.id) ?? `asset${i + 1}`,
    path: urlPath(pick(b, 'path', 'url', 'fileURL')),
    start: r.start,
    end: r.end,
    opacity: toNum(b.opacity),
    fit,
  });
}

function normSegments(list) {
  const segs = arr(list).filter(isObj).map((s, i) => {
    const sourceIn = toNum(pick(s, 'sourceIn', 'sourceStart', 'inPoint')) ?? 0;
    const start = toNum(pick(s, 'start', 'timelineStart', 'offset')) ?? 0;
    let end = toNum(pick(s, 'end', 'timelineEnd'));
    const dur = toNum(s.duration);
    const sourceOut = toNum(pick(s, 'sourceOut', 'sourceEnd', 'outPoint'));
    if (end === undefined && dur !== undefined) end = start + dur;
    if (end === undefined && sourceOut !== undefined) end = start + (sourceOut - sourceIn);
    return compact({ id: str(s.id) ?? `seg${i + 1}`, sourceIn, start, end, isGap: bool(s.isGap), track: int(s.track) });
  });
  // Segments without a length run to the next segment on the same track.
  for (const s of segs) {
    if (s.end !== undefined) continue;
    const next = segs.filter((o) => o !== s && (o.track ?? 0) === (s.track ?? 0) && o.start > s.start).sort((a, b) => a.start - b.start)[0];
    s.end = next ? next.start : s.start;
  }
  return segs;
}

/** A file path from a path string, a file URL string or Swift's URL encoding {relative, base?}. */
function urlPath(u) {
  if (isObj(u)) u = pick(u, 'relative', 'path', 'url');
  if (typeof u !== 'string' || !u) return undefined;
  if (u.startsWith('file://')) {
    let p = u.slice('file://'.length);
    if (p.startsWith('localhost/')) p = p.slice('localhost'.length);
    try { p = decodeURIComponent(p); } catch { /* keep as is */ }
    return p;
  }
  return u;
}

/**
 * Timestamps to Unix ms. Numbers below 1.2e9 are Swift's default Date encoding (seconds since 2001-01-01),
 * up to 1e11 Unix seconds, above that Unix ms. ISO strings are kept as strings.
 */
function toTimestamp(v) {
  if (typeof v === 'string') return v;
  const n = toNum(v);
  if (n === undefined) return undefined;
  if (n < 1.2e9) return Math.round((n + 978307200) * 1000);
  if (n < 1e11) return Math.round(n * 1000);
  return n;
}

const EXT_BY_MIME = { 'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v', 'audio/webm': 'webm', 'audio/mp4': 'm4a' };
function extFrom({ ext, mime, name }) {
  if (typeof ext === 'string' && /^\.?[a-z0-9]{2,5}$/i.test(ext)) return `.${ext.replace(/^\./, '').toLowerCase()}`;
  if (typeof mime === 'string' && mime.includes('/')) {
    const base = mime.split(';')[0].trim().toLowerCase();
    const e = EXT_BY_MIME[base] || (/^[a-z0-9]{2,5}$/.test(base.split('/')[1]) ? base.split('/')[1] : '');
    if (e) return `.${e}`;
  }
  if (typeof name === 'string') { const m = /\.([a-z0-9]{2,5})$/i.exec(name); if (m) return `.${m[1].toLowerCase()}`; }
  return '';
}

function metaOf(m) {
  if (!isObj(m)) return undefined;
  const out = compact({ id: str(m.id), name: typeof m.name === 'string' ? m.name : undefined, created: toTimestamp(m.created), updated: toTimestamp(m.updated) });
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Web <-> v2

/** v2 sources from the web media record. `media.sources` (set by fromV2) carries paths and hashes through. */
function webSources(m) {
  const base = isObj(m.sources) ? m.sources : {};
  const screen = { ...(isObj(base.screen) ? base.screen : {}) };
  screen.path = screen.path || `media/screen${extFrom({ ext: m.screenExt ?? m.ext, mime: m.screenType ?? m.mime ?? m.type, name: m.screenName ?? m.fileName ?? m.name })}`;
  for (const k of ['duration', 'width', 'height', 'hasAudio', 'hasVideo']) if (m[k] !== undefined && m[k] !== null) screen[k] = m[k];
  const hasCam = m.camera !== undefined ? !!m.camera : isObj(base.camera);
  let camera = null;
  if (hasCam) {
    camera = { ...(isObj(base.camera) ? base.camera : {}) };
    camera.path = camera.path || `media/camera${extFrom({ ext: m.cameraExt, mime: m.cameraType ?? m.cameraMime, name: m.cameraName })}`;
  }
  const out = { screen, camera };
  const off = m.cameraOffset ?? base.cameraOffset;
  if (off !== undefined && off !== null) out.cameraOffset = off;
  // Extra camera angles (S-03): the web keeps them in media.angles; the first camera stays sources.camera.
  const angles = (Array.isArray(m.angles) ? m.angles : []).filter((a) => isObj(a) && a.id && a.id !== 'camera')
    .map((a) => compact({ id: String(a.id), name: str(a.name), path: str(a.path) || `media/angle-${a.id}${extFrom({ mime: a.type, name: a.name })}`, offset: toNum(a.offset), speaker: str(a.speaker) }));
  if (angles.length) out.angles = angles;
  else if (Array.isArray(base.angles)) out.angles = base.angles;
  return out;
}

/**
 * Web edit (project.edit) + media (project.media) -> edit plan v2.
 * meta: { id, name, created, updated } (a whole project object works too).
 * Unknown edit keys pass through, so desktop-only fields survive a trip through the web app.
 * Cursor samples recorded by the desktop app (media.cursor = { samples, source }) go into `cursor.samples`.
 */
export function toV2(edit, media = null, meta = null) {
  if (!isObj(edit)) throw new TypeError('toV2: edit must be an object');
  const e = clone(edit), m = clone(media) || {}, d = defaultEdit();
  const plan = { version: PLAN_VERSION, app: { name: 'Slipstream Web', surface: 'web' } };
  const mt = metaOf(meta);
  if (mt) plan.meta = mt;
  plan.sources = webSources(m);
  plan.words = arr(e.words).map((w, i) => ({ ...w, id: str(w.id) ?? `w${i}` }));
  if (e.speakers !== undefined) plan.speakers = e.speakers;
  plan.cuts = arr(e.cuts).map((c) => ({ ...c, ...(c.id !== undefined ? { id: String(c.id) } : {}), kind: CUT_KINDS.has(c.kind) ? c.kind : 'manual' }));
  plan.range = e.range ?? null;
  plan.zooms = arr(e.zooms).map((z, i) => ({ ...z, id: str(z.id) ?? `z${i + 1}` }));
  plan.frame = { ...(isObj(e.frame) ? e.frame : {}), aspect: isAspect(e.aspect) ? e.aspect : d.aspect };
  plan.layout = isObj(e.layout) ? e.layout : d.layout;
  if (e.scenes !== undefined) plan.scenes = e.scenes;
  plan.style = isObj(e.style) ? e.style : d.style;
  plan.captions = isObj(e.captions) ? e.captions : d.captions;
  if (e.brand !== undefined) plan.brand = e.brand;
  if (e.chapters !== undefined) plan.chapters = e.chapters;
  for (const [k, v] of Object.entries(e)) if (!WEB_EDIT_KEYS.has(k)) plan[k] = v;
  // The web keeps recorded cursor samples on the media record, out of the undoable edit (T-04).
  const mc = isObj(m.cursor) && Array.isArray(m.cursor.samples) && m.cursor.samples.length ? m.cursor : null;
  if (mc && !Array.isArray(plan.cursor?.samples)) plan.cursor = { ...(isObj(plan.cursor) ? plan.cursor : {}), samples: mc.samples, ...(str(mc.source) ? { source: mc.source } : {}) };
  return plan;
}
export const fromWebV1 = toV2;

/**
 * Edit plan v2 -> { edit, media, meta } in the web shape. Missing web settings get defaultEdit() values;
 * v2 fields the web doesn't render (cursor, broll, audio, …) ride along on `edit` so toV2 can write them back.
 */
export function fromV2(plan) {
  if (!isObj(plan) || Number(plan.version) !== PLAN_VERSION) throw new TypeError('fromV2: expected an edit plan with version 2');
  const p = clone(plan), d = defaultEdit();
  const edit = {
    words: arr(p.words),
    cuts: arr(p.cuts),
    zooms: arr(p.zooms),
    range: p.range ?? null,
    chapters: arr(p.chapters),
    aspect: isObj(p.frame) && isAspect(p.frame.aspect) ? p.frame.aspect : d.aspect,
    layout: { ...d.layout, ...(isObj(p.layout) ? p.layout : {}) },
    style: { ...d.style, ...(isObj(p.style) ? p.style : {}) },
    captions: { ...d.captions, ...(isObj(p.captions) ? p.captions : {}) },
  };
  for (const k of ['scenes', 'speakers', 'brand']) if (p[k] !== undefined) edit[k] = p[k];
  if (isObj(p.frame)) {
    const { aspect, ...rest } = p.frame;
    if (Object.keys(rest).length) edit.frame = rest;
  }
  for (const [k, v] of Object.entries(p)) if (!V2_KEYS.has(k)) edit[k] = v;

  const sources = isObj(p.sources) ? p.sources : { screen: { path: 'media/screen' }, camera: null };
  const screen = isObj(sources.screen) ? sources.screen : {};
  const media = {};
  for (const k of ['duration', 'width', 'height', 'hasAudio', 'hasVideo']) if (screen[k] !== undefined) media[k] = screen[k];
  media.camera = isObj(sources.camera);
  if (sources.cameraOffset !== undefined) media.cameraOffset = sources.cameraOffset;
  if (Array.isArray(sources.angles) && sources.angles.length) {
    media.angles = [
      ...(media.camera ? [{ id: 'camera', name: 'Camera', offset: sources.cameraOffset ?? 0 }] : []),
      ...sources.angles.map((a) => compact({ id: a.id, name: a.name, offset: a.offset ?? 0, speaker: a.speaker, path: a.path })),
    ];
  }
  // Keep paths, hashes and desktop source details only when the web record can't regenerate them.
  if (!sameJSON(webSources(media), sources)) media.sources = sources;
  return { edit, media, meta: isObj(p.meta) ? p.meta : {} };
}

// ---------------------------------------------------------------------------------------------------------
// Engine v1 <-> v2

function normReframe(r, focusPath) {
  const path = keyframes(focusPath);
  let out;
  if (r === true) out = { enabled: true };
  else if (r === false) out = { enabled: false };
  else if (typeof r === 'string') out = compact({ enabled: true, anchor: ANCHORS.has(r.toLowerCase()) ? r.toLowerCase() : undefined });
  else if (isObj(r)) {
    const anchor = typeof r.anchor === 'string' && ANCHORS.has(r.anchor.toLowerCase()) ? r.anchor.toLowerCase() : undefined;
    out = compact({ enabled: bool(r.enabled) ?? true, anchor, smoothing: toNum(r.smoothing) });
    path.push(...keyframes(r.focusPath));
  }
  if (path.length) out = { ...(out || { enabled: true }), focusPath: path };
  return out;
}

function stagingToStyle(st, reference, d) {
  const kind = String(st.backgroundKind ?? st.kind ?? '').toLowerCase();
  let bg;
  if (/solid|colou?r/.test(kind)) bg = 'solid';
  else if (/image|photo|picture/.test(kind)) bg = 'image';
  else if (/blur/.test(kind)) bg = 'blur';
  else if (str(st.gradientId)) bg = str(st.gradientId);
  else if (str(st.imagePath)) bg = 'image';
  else bg = d.bg;
  return compact({
    bg,
    solid: hex6(st.backgroundHex) ?? d.solid,
    imagePath: urlPath(st.imagePath),
    padding: clamp(toFraction(st.padding, reference) ?? d.padding, 0, 0.2),
    radius: clamp(toFraction(st.cornerRadius, reference) ?? d.radius, 0, 0.08),
    shadow: normShadow(st.shadow) ?? d.shadow,
    scale: toNum(st.scale) > 0 ? toNum(st.scale) : undefined,
    offsetX: toFraction(st.offsetX, reference),
    offsetY: toFraction(st.offsetY, reference),
  });
}

function cameraToLayout(cam, hasCamera, reference, d) {
  const mode = !hasCamera || cam.enabled === false || cam.isHidden === true || cam.hidden === true ? 'screen' : normLayoutMode(pick(cam, 'layout', 'mode', 'style', 'kind')) ?? d.mode;
  const shapeRaw = typeof cam.shape === 'string' ? cam.shape.toLowerCase() : undefined;
  const shape = SHAPES.has(shapeRaw) ? shapeRaw : cam.rounded === true ? 'rounded' : cam.rounded === false ? 'square' : d.shape;
  let split = toNum(pick(cam, 'splitRatio', 'split'));
  if (split !== undefined && split > 1) split /= 100;
  const size = toFraction(pick(cam, 'size', 'diameter'), reference);
  return compact({
    ...d,
    mode,
    corner: normCorner(pick(cam, 'corner', 'position', 'anchor')) ?? d.corner,
    size: size === undefined ? d.size : clamp(size, 0.08, 0.5),
    shape,
    mirror: bool(pick(cam, 'mirror', 'mirrored', 'isMirrored')) ?? d.mirror,
    split: split === undefined ? d.split : clamp(split, 0.25, 0.7),
    fit: cam.fit === 'cover' || cam.fit === 'contain' ? cam.fit : d.fit,
    margin: toFraction(cam.margin, reference),
  });
}

function captionsFrom(cap, style, d, explicitCues) {
  const fill = str(pick(style, 'fillChoice'));
  const color = hex6(pick(style, 'color', 'textColor', 'fillColor')) ?? (hex6(fill) || d.color);
  const enabled = bool(pick(cap, 'enabled', 'isEnabled', 'isVisible', 'show', 'burnIn'));
  return compact({
    enabled: enabled ?? d.enabled,
    preset: normPreset(pick(style, 'preset', 'presetID', 'presetId', 'look')) ?? d.preset,
    position: normPosition(pick(style, 'position', 'placement')) ?? d.position,
    size: toNum(pick(style, 'fontScale', 'size', 'scale')) > 0 ? toNum(pick(style, 'fontScale', 'size', 'scale')) : d.size,
    color,
    uppercase: bool(pick(style, 'uppercase', 'isUppercase', 'allCaps')) ?? null,
    language: typeof cap.language === 'string' && isObj(cap.translations) ? cap.language : undefined,
    translations: isObj(cap.translations) ? Object.fromEntries(Object.entries(cap.translations).map(([k, v]) => [k, cues(v)])) : undefined,
    cues: explicitCues.length ? explicitCues : undefined,
    fillChoice: fill,
    boxed: bool(pick(style, 'boxed', 'isBoxed')),
  });
}

function cursorFrom(c, samplesPath) {
  if (!isObj(c) && !samplesPath) return undefined;
  c = isObj(c) ? c : {};
  const style = isObj(c.style) ? Object.keys(c.style)[0] : str(c.style);
  return compact({
    style,
    smoothing: toNum(c.smoothing),
    showClicks: bool(pick(c, 'showClicks', 'clickHighlights', 'highlightClicks')),
    motionBlur: bool(c.motionBlur),
    hideHardwareCursor: bool(pick(c, 'hideHardwareCursor', 'hideSystemCursor')),
    samplesPath: urlPath(c.samplesPath) ?? samplesPath,
  });
}

function audioFrom(a) {
  if (!isObj(a)) return undefined;
  const out = compact({
    fadeIn: toNum(a.fadeIn) >= 0 ? toNum(a.fadeIn) : undefined,
    fadeOut: toNum(a.fadeOut) >= 0 ? toNum(a.fadeOut) : undefined,
    enhance: bool(pick(a, 'enhance', 'voiceIsolation', 'studioSound')),
    loudnessLufs: toNum(pick(a, 'loudnessLufs', 'targetLUFS', 'targetLufs')),
  });
  return Object.keys(out).length ? out : undefined;
}

function maxEnd(p) {
  let t = 0;
  for (const list of [p.words, p.cuts, p.zooms, p.scenes, p.broll]) for (const x of arr(list)) if (Number.isFinite(x?.end)) t = Math.max(t, x.end);
  if (p.range && Number.isFinite(p.range.end)) t = Math.max(t, p.range.end);
  return t;
}

/**
 * Rust slipstream_engine EditPlan v1 -> v2. opts.reference: pixels per unit of the frame's short side
 * (default 1080) for engine values stored in pixels.
 */
export function fromEngineV1(enginePlan, { reference = DEFAULT_REFERENCE } = {}) {
  if (!isObj(enginePlan)) throw new TypeError('fromEngineV1: expected an engine EditPlan object');
  const e = clone(enginePlan), d = defaultEdit();
  const src = isObj(e.source) ? e.source : {};
  const frame = isObj(e.frame) ? e.frame : {};
  const cap = isObj(e.captions) ? e.captions : {};
  const size = { width: toNum(src.width), height: toNum(src.height) };

  const screen = compact({ path: urlPath(pick(src, 'screenPath', 'path')) ?? 'media/screen', duration: toNum(src.duration), width: int(src.width), height: int(src.height), fps: toNum(src.fps), audioTracks: ints(src.screenAudioTracks) });
  const camPath = urlPath(src.cameraPath);
  const sources = { screen, camera: camPath ? compact({ path: camPath, audioTracks: ints(src.cameraAudioTracks) }) : null };
  const offset = toNum(pick(src, 'cameraOffset', 'cameraOffsetSec'));
  if (offset !== undefined) sources.cameraOffset = offset;

  const plan = { version: PLAN_VERSION, app: { name: 'slipstream_engine', surface: 'engine' } };
  const meta = metaOf(e);
  if (meta) plan.meta = meta;
  plan.sources = sources;
  plan.words = arr(e.words).filter(isObj).map(normWord);

  // manualCuts: 'words' entries are derived from isCut words; 'range' entries encode the clip in/out.
  const cuts = [], rangeCuts = [];
  arr(e.manualCuts).forEach((c, i) => {
    const r = normRange(c);
    if (!r) return;
    const kind = isObj(c) ? c.kind : undefined;
    if (kind === 'words') return;
    if (kind === 'range') { rangeCuts.push(r); return; }
    cuts.push({ id: str(isObj(c) ? c.id : undefined) ?? `c${i + 1}`, start: r.start, end: r.end, kind: CUT_KINDS.has(kind) ? kind : 'manual' });
  });
  plan.cuts = cuts;
  plan.range = normRange(e.range) ?? null;
  if (rangeCuts.length) {
    const dur = screen.duration ?? maxEnd({ words: plan.words, cuts });
    const head = rangeCuts.find((r) => r.start <= 1e-6);
    const tail = rangeCuts.find((r) => r !== head);
    plan.range = { start: head ? head.end : 0, end: tail ? tail.start : dur };
  }
  plan.zooms = arr(e.zooms).filter(isObj).map((z, i) => normZoom(z, i, size));
  const fk = keyframes(e.focusKeyframes);
  if (fk.length) plan.focusKeyframes = fk;

  plan.frame = { aspect: normAspect(frame.aspect) };
  const reframe = normReframe(frame.reframe, frame.focusPath);
  if (reframe) plan.frame.reframe = reframe;
  plan.layout = cameraToLayout(isObj(e.camera) ? e.camera : {}, !!sources.camera, reference, d.layout);
  plan.style = stagingToStyle(isObj(frame.staging) ? frame.staging : {}, reference, d.style);
  plan.captions = captionsFrom(cap, cap, d.captions, cues(cap.cues));
  const cursor = cursorFrom(e.cursor);
  if (cursor) plan.cursor = cursor;
  const audio = audioFrom(e.audio);
  if (audio) plan.audio = audio;
  const broll = arr(e.broll).filter(isObj).map(normBroll);
  if (broll.length) plan.broll = broll;
  const segments = normSegments(e.segments);
  if (segments.length) plan.segments = segments;
  for (const k of ['masks', 'annotations', 'chapters', 'scenes', 'speakers', 'brand']) if (e[k] !== undefined && e[k] !== null) plan[k] = e[k];
  return plan;
}

/** Word ids that are decimal integers go back as numbers: the engine's ids are probably integer indices. */
const engineId = (id) => (typeof id === 'string' && /^(0|[1-9]\d{0,14})$/.test(id) ? Number(id) : id);

/**
 * v2 -> engine EditPlan v1 (for `slipstream_engine render-plan`).
 * opts.units: 'fraction' (default) or 'px' for padding / cornerRadius / margin; opts.reference: px per short side.
 */
export function toEngine(plan, { units = 'fraction', reference = DEFAULT_REFERENCE } = {}) {
  const p = isObj(plan) && Number(plan.version) === PLAN_VERSION ? clone(plan) : migratePlan(plan);
  const px = (v) => (v === undefined || v === null ? undefined : units === 'px' ? Math.round(v * reference * 100) / 100 : v);
  const sources = isObj(p.sources) ? p.sources : {};
  const screen = isObj(sources.screen) ? sources.screen : {};
  const cam = isObj(sources.camera) ? sources.camera : null;
  const layout = isObj(p.layout) ? p.layout : defaultEdit().layout;
  const style = isObj(p.style) ? p.style : {};
  const cap = isObj(p.captions) ? p.captions : {};
  const reframe = isObj(p.frame?.reframe) ? p.frame.reframe : null;
  const duration = toNum(screen.duration);

  // Every cut the web would make (see the header comment).
  const span = duration ?? Infinity;
  const manualCuts = arr(p.cuts).map((c) => compact({ id: c.id, start: c.start, end: c.end, kind: c.kind }));
  for (const r of wordCutRanges(arr(p.words), span)) manualCuts.push({ start: r.start, end: Math.min(r.end, span), kind: 'words' });
  if (p.range) {
    if (p.range.start > 0) manualCuts.push({ start: 0, end: p.range.start, kind: 'range' });
    if (duration === undefined || p.range.end < duration) manualCuts.push({ start: p.range.end, end: duration ?? UNKNOWN_DURATION_END, kind: 'range' });
  }

  const bg = typeof style.bg === 'string' ? style.bg : 'tide';
  const backgroundKind = bg === 'solid' || bg === 'image' || bg === 'blur' ? bg : 'gradient';
  const explicitCues = Array.isArray(cap.cues) ? cap.cues : cap.language && isObj(cap.translations) ? arr(cap.translations[cap.language]) : [];

  const out = {
    source: compact({
      screenPath: screen.path ?? 'media/screen',
      cameraPath: cam ? cam.path : null,
      fps: screen.fps ?? cam?.fps,
      screenAudioTracks: screen.audioTracks,
      cameraAudioTracks: cam?.audioTracks,
      duration,
      width: screen.width,
      height: screen.height,
      cameraOffset: sources.cameraOffset,
    }),
    frame: {
      aspect: isAspect(p.frame?.aspect) ? p.frame.aspect : '16:9',
      reframe: reframe ? compact({ enabled: reframe.enabled ?? true, anchor: reframe.anchor, smoothing: reframe.smoothing }) : null,
      focusPath: reframe ? arr(reframe.focusPath) : [],
      staging: compact({
        backgroundKind,
        backgroundHex: style.solid,
        gradientId: backgroundKind === 'gradient' ? bg : undefined,
        imagePath: style.imagePath,
        padding: px(style.padding),
        cornerRadius: px(style.radius),
        scale: style.scale ?? 1,
        offsetX: style.offsetX ?? 0,
        offsetY: style.offsetY ?? 0,
        shadow: style.shadow,
      }),
    },
    words: arr(p.words).map((w) => ({ id: engineId(w.id), text: w.text, start: w.start, end: w.end, isCut: !!w.deleted })),
    segments: arr(p.segments).map((s) => compact({ id: s.id, sourceIn: s.sourceIn, start: s.start, end: s.end, isGap: s.isGap, track: s.track })),
    manualCuts,
    zooms: arr(p.zooms).map((z) => compact({ id: z.id, startTime: z.start, endTime: z.end, focus: { x: z.x, y: z.y }, scale: z.scale, ramp: z.ramp, auto: z.auto, follow: z.follow })),
    camera: compact({
      enabled: !!cam && layout.mode !== 'screen',
      layout: layout.mode,
      splitRatio: layout.split,
      rounded: layout.shape !== 'square',
      shape: layout.shape,
      corner: layout.corner,
      size: layout.size,
      mirror: layout.mirror,
      margin: px(layout.margin),
    }),
    captions: compact({
      enabled: cap.enabled ?? true,
      preset: cap.preset,
      fontScale: cap.size,
      fillChoice: cap.fillChoice,
      boxed: cap.boxed,
      position: cap.position,
      color: cap.color,
      uppercase: cap.uppercase,
      cues: explicitCues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
    }),
    audio: compact({ fadeIn: p.audio?.fadeIn ?? 0, fadeOut: p.audio?.fadeOut ?? 0, enhance: p.audio?.enhance, loudnessLufs: p.audio?.loudnessLufs }),
    broll: arr(p.broll).map((b) => compact({ assetId: b.assetId, path: b.path, start: b.start, end: b.end, opacity: b.opacity, fit: b.fit })),
    focusKeyframes: arr(p.focusKeyframes),
  };
  if (p.cursor) out.cursor = p.cursor;
  for (const k of ['masks', 'annotations']) if (Array.isArray(p[k]) && p[k].length) out[k] = p[k];
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// macOS 1.x -> v2 (best effort)
//
// The Swift source isn't available; names below are guesses from type names in the binary
// (docs/ARCHITECTURE.md §1.1) and Swift's synthesized Codable conventions:
// - Dates: default JSONEncoder strategy (seconds since 2001-01-01), Unix seconds/ms, or ISO strings.
// - URLs: plain strings, file URL strings, or {"relative": "file:///…"}.
// - CGPoint/CGSize encode as [x, y] / [w, h]; ClosedRange as [lower, upper]; CMTime as {value, timescale}.
// - Enums with associated values encode as {"case": {"_0": …}}; plain enums as their raw string.
// - Media: screenURL|screenPath|screenFile|recordingURL|videoURL (or recording.screenURL), cameraURL|cameraPath,
//   cameraOffset|cameraStartOffset, duration, videoSize|naturalSize|size, frameRate|fps.
// - Transcript: words | transcript.words | transcript.segments[].words with text|word, start|startTime,
//   end|endTime|duration, isDeleted|isRemoved|deleted|isCut, isFiller, confidence, speaker.
// - Cuts: cuts (with kind), razorCuts|manualCuts (manual), silenceCuts|silences (silence), retakeCuts (retake).
// - Zooms: zooms|zoomRegions|zoomEvents with scale|zoom|magnification, focus|center|point ([x,y] or {x,y}),
//   followsCursor, isAuto.
// - Camera (CameraLayout/CameraPosition): cameraLayout|camera|cameraOverlay as a string or
//   {style|mode|layout, position|corner, size, shape, isMirrored, isHidden, splitRatio}.
// - Background (BackgroundKind/StylePreset): background|style|backgroundStyle {kind|type, presetID|gradientId,
//   color|hex, imagePath|imageURL, padding, cornerRadius, shadow}; padding/cornerRadius/shadow also top level.
// - Captions (CaptionTrack/CaptionStyle/CaptionCue): captions|captionTrack {isEnabled, style{preset, position,
//   fontScale, color, uppercase}, cues[{text, start, end}]}, or captionStyle at top level.
// - Chapters [{title|name, start|time}], B-roll broll|bRoll|brollClips|brollOverlays, timeline clips
//   clips|timelineClips|segments, cursor|cursorSettings, cursorSamplesURL, audio, range|trim|trimRange.

function swiftSize(v) {
  if (Array.isArray(v) && v.length >= 2) return { width: toNum(v[0]), height: toNum(v[1]) };
  if (isObj(v)) return { width: toNum(v.width ?? v.w), height: toNum(v.height ?? v.h) };
  return {};
}

function swiftBackground(j) {
  const b = pick(j, 'background', 'backgroundStyle') ?? (isObj(j.style) ? j.style : {});
  const st = isObj(b) ? { ...b } : { kind: b };
  let kind = pick(st, 'kind', 'type');
  let preset = pick(st, 'presetID', 'presetId', 'preset', 'gradientId', 'gradientID', 'gradient', 'wallpaper');
  if (isObj(kind)) { const k = Object.keys(kind)[0]; const v = kind[k]; preset = preset ?? (isObj(v) ? pick(v, '_0', 'id', 'preset') : v); kind = k; }
  return {
    backgroundKind: typeof kind === 'string' ? kind : undefined,
    gradientId: typeof preset === 'string' ? preset : undefined,
    backgroundHex: pick(st, 'color', 'hex', 'solidColor', 'backgroundHex'),
    imagePath: urlPath(pick(st, 'imagePath', 'imageURL', 'image')),
    padding: pick(st, 'padding') ?? j.padding,
    cornerRadius: pick(st, 'cornerRadius', 'radius') ?? j.cornerRadius,
    shadow: pick(st, 'shadow', 'shadowOpacity', 'hasShadow') ?? j.shadow,
    scale: st.scale,
  };
}

/** macOS 1.x project JSON -> v2 (see the assumptions above). */
export function fromSwiftV1(json, { reference = DEFAULT_REFERENCE } = {}) {
  if (!isObj(json)) throw new TypeError('fromSwiftV1: expected a project object');
  const j = clone(json), d = defaultEdit();
  const size = swiftSize(pick(j, 'videoSize', 'naturalSize', 'size', 'dimensions'));

  const screenPath = urlPath(pick(j, 'screenURL', 'screenPath', 'screenFile', 'recordingURL', 'videoURL') ?? pick(j.recording, 'screenURL', 'screenPath') ?? pick(j.media, 'screen'));
  const cameraPath = urlPath(pick(j, 'cameraURL', 'cameraPath', 'cameraFile') ?? pick(j.recording, 'cameraURL', 'cameraPath') ?? pick(j.media, 'camera'));
  const screen = compact({ path: screenPath ?? 'media/screen', duration: toNum(j.duration), width: int(size.width), height: int(size.height), fps: toNum(pick(j, 'frameRate', 'fps')) });
  const sources = { screen, camera: cameraPath ? { path: cameraPath } : null };
  const offset = toNum(pick(j, 'cameraOffset', 'cameraStartOffset', 'cameraDelay'));
  if (offset !== undefined) sources.cameraOffset = offset;

  const plan = { version: PLAN_VERSION, app: { name: 'Slipstream for macOS', surface: 'macos' } };
  const meta = compact({
    id: str(j.id),
    name: str(pick(j, 'name', 'title')),
    created: toTimestamp(pick(j, 'createdAt', 'created', 'creationDate', 'dateCreated')),
    updated: toTimestamp(pick(j, 'modifiedAt', 'updatedAt', 'updated', 'modified', 'lastModified')),
  });
  if (Object.keys(meta).length) plan.meta = meta;
  plan.sources = sources;

  const t = isObj(j.transcript) ? j.transcript : {};
  const rawWords = Array.isArray(j.words) ? j.words : Array.isArray(t.words) ? t.words : arr(t.segments).flatMap((s) => arr(s?.words));
  plan.words = rawWords.filter(isObj).map(normWord);

  const speakers = j.speakers ?? t.speakers;
  if (isObj(speakers)) plan.speakers = Object.fromEntries(Object.entries(speakers).map(([k, v]) => [k, compact({ name: str(isObj(v) ? v.name : v) ?? k, color: hex6(v?.color) })]));
  else if (Array.isArray(speakers)) plan.speakers = Object.fromEntries(speakers.filter(isObj).map((s, i) => [str(s.id) ?? `S${i + 1}`, compact({ name: str(s.name) ?? `Speaker ${i + 1}`, color: hex6(s.color) })]));

  const cuts = [];
  const addCuts = (list, kindDefault) => arr(list).forEach((c) => {
    const r = normRange(c);
    if (!r) return;
    const kind = isObj(c) && CUT_KINDS.has(c.kind) ? c.kind : kindDefault;
    cuts.push(compact({ id: isObj(c) ? str(c.id) : undefined, start: r.start, end: r.end, kind }));
  });
  addCuts(j.cuts, 'manual');
  addCuts(j.razorCuts, 'manual');
  addCuts(j.manualCuts, 'manual');
  addCuts(j.silenceCuts ?? j.silences, 'silence');
  addCuts(j.retakeCuts, 'retake');
  cuts.forEach((c, i) => { if (!c.id) c.id = `c${i + 1}`; });
  plan.cuts = cuts;
  let rng = normRange(pick(j, 'range', 'trim', 'trimRange'));
  if (!rng && (j.trimStart !== undefined || j.trimEnd !== undefined)) {
    rng = normRange({ start: j.trimStart ?? 0, end: j.trimEnd ?? screen.duration ?? maxEnd({ words: plan.words, cuts }) });
  }
  plan.range = rng && rng.end > rng.start ? rng : null;

  plan.zooms = arr(j.zooms ?? j.zoomRegions ?? j.zoomEvents).filter(isObj).map((z, i) => normZoom(z, i, size));
  plan.frame = { aspect: normAspect(pick(j, 'aspect', 'aspectRatio', 'exportAspect') ?? pick(j.canvas, 'aspect') ?? pick(j.frame, 'aspect')) };

  let cam = pick(j, 'cameraLayout', 'camera', 'cameraOverlay');
  cam = isObj(cam) ? { ...cam } : { mode: cam };
  if (cam.position === undefined && j.cameraPosition !== undefined) cam.position = j.cameraPosition;
  if (cam.size === undefined && j.cameraSize !== undefined) cam.size = j.cameraSize;
  if (cam.shape === undefined && j.cameraShape !== undefined) cam.shape = j.cameraShape;
  plan.layout = cameraToLayout(cam, !!sources.camera, reference, d.layout);
  plan.style = stagingToStyle(swiftBackground(j), reference, d.style);

  const capObj = pick(j, 'captions', 'captionTrack');
  const cap = isObj(capObj) ? capObj : {};
  const capStyle = { ...(isObj(j.captionStyle) ? j.captionStyle : {}), ...cap, ...(isObj(cap.style) ? cap.style : {}) };
  plan.captions = captionsFrom(cap, capStyle, d.captions, cues(cap.cues ?? j.cues));

  const chapters = arr(j.chapters).filter(isObj).map((c) => ({ start: toNum(pick(c, 'start', 'time', 'startTime')) ?? 0, title: str(pick(c, 'title', 'name')) ?? '' }));
  if (chapters.length) plan.chapters = chapters;
  const cursor = cursorFrom(pick(j, 'cursor', 'cursorSettings'), urlPath(pick(j, 'cursorSamplesURL', 'cursorSamplesPath')));
  if (cursor) plan.cursor = cursor;
  const audio = audioFrom(j.audio);
  if (audio) plan.audio = audio;
  const broll = arr(j.broll ?? j.bRoll ?? j.brollClips ?? j.brollOverlays).filter(isObj).map(normBroll);
  if (broll.length) plan.broll = broll;
  const segments = normSegments(j.clips ?? j.timelineClips ?? j.segments);
  if (segments.length) plan.segments = segments;
  return plan;
}

// ---------------------------------------------------------------------------------------------------------
// Detection, migration, validation

/** 'v2' | 'web-project' | 'web-edit' | 'engine-v1' | 'swift-v1' | 'unknown' */
export function detectPlanShape(json) {
  if (!isObj(json)) return 'unknown';
  if (Number(json.version) === PLAN_VERSION && isObj(json.sources)) return 'v2';
  if (isObj(json.edit) && Array.isArray(json.edit.words)) return 'web-project';
  if (isObj(json.plan) && Number(json.plan.version) === PLAN_VERSION) return 'web-project';
  if (Array.isArray(json.words) && typeof json.aspect === 'string' && isObj(json.layout) && isObj(json.style)) return 'web-edit';
  if ((isObj(json.source) && 'screenPath' in json.source) || isObj(json.frame?.staging) || Array.isArray(json.manualCuts) || Array.isArray(json.focusKeyframes)) return 'engine-v1';
  const swiftKeys = ['screenURL', 'cameraURL', 'screenPath', 'captionTrack', 'cameraLayout', 'transcript', 'createdAt', 'modifiedAt', 'razorCuts', 'silenceCuts', 'background', 'clips', 'zoomRegions', 'aspectRatio'];
  if (swiftKeys.some((k) => k in json)) return 'swift-v1';
  if (arr(json.words).some((w) => isObj(w) && 'isCut' in w) || arr(json.zooms).some((z) => isObj(z) && 'startTime' in z)) return 'engine-v1';
  if (Array.isArray(json.words) || Array.isArray(json.zooms)) return 'swift-v1';
  return 'unknown';
}

/** Any known project/plan shape -> v2. Throws on input it can't recognise. */
export function migratePlan(json) {
  switch (detectPlanShape(json)) {
    case 'v2': return clone(json);
    case 'web-project': return isObj(json.edit) ? toV2(json.edit, json.media, json) : clone(json.plan);
    case 'web-edit': return toV2(json);
    case 'engine-v1': return fromEngineV1(json);
    case 'swift-v1': return fromSwiftV1(json);
    default: throw new TypeError('migratePlan: unrecognised project shape');
  }
}

/** Validate against the v2 JSON Schema. Returns { valid, errors: [{ path, message, keyword }] }. */
export function validatePlan(plan) {
  return validate(PLAN_SCHEMA, plan);
}
