// Edit decision list (EDL) logic for Slipstream Web.
// Pure functions only: no DOM, no media. Everything here is unit-tested in tests/web-edl.test.mjs.
//
// Conventions
// - All times are seconds on the SOURCE timeline unless a name says "out".
// - A range is { start, end } with start < end.
// - "cuts" are ranges removed from the output; "kept" ranges are their complement.

export const MIN_RANGE = 0.04; // ranges shorter than this are dropped (≈1 frame at 25fps)
const WORD_PAD = 0.02;
// Longest pause after a run of deleted words that the cut takes with it. Shorter gaps go completely, so speech
// flows on; a longer silence (a demo on screen, a deliberate pause) keeps all but this much of itself.
export const GAP_ABSORB = 1.0;

// Hard fillers are safe to remove automatically. Soft fillers ("like", "you know") are only flagged.
export const HARD_FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm', 'eh']);
export const SOFT_FILLERS = new Set(['like', 'basically', 'actually', 'literally', 'so', 'right', 'okay']);
export const SOFT_FILLER_PHRASES = [['you', 'know'], ['i', 'mean'], ['kind', 'of'], ['sort', 'of']];

export function normalizeWord(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '').replace(/^'+|'+$/g, '');
}

export function isHardFiller(text) {
  return HARD_FILLERS.has(normalizeWord(text));
}

// What Whisper writes over silence or music: on a take with no talking these are the whole transcript.
const WHISPER_SILENCE_PHRASES = new Set(['you', 'thank you', 'thank you so much', 'thank you very much', 'thanks', 'thanks for watching', 'thank you for watching', 'thanks for watching everyone', 'bye', 'bye bye']);

/**
 * True when a transcript is nothing but phrases Whisper invents over silence ("Thank you.", "Thanks for watching!",
 * "you"), possibly repeated. Such a transcript is dropped, so a take with no talking gets no captions, no title from
 * it and no pause cuts.
 */
export function isWhisperSilence(words) {
  const live = (words || []).filter((w) => !w.deleted);
  if (!live.length) return false;
  const sentences = live.map((w) => w.text).join(' ').split(/[.!?…]+/).map((s) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return sentences.length > 0 && sentences.every((s) => WHISPER_SILENCE_PHRASES.has(s));
}

/** Returns a new words array with `filler: 'hard' | 'soft' | undefined` set on each word. */
export function markFillers(words) {
  const out = words.map((w) => ({ ...w, filler: undefined }));
  for (let i = 0; i < out.length; i++) {
    const n = normalizeWord(out[i].text);
    if (HARD_FILLERS.has(n)) out[i].filler = 'hard';
    else if (SOFT_FILLERS.has(n)) out[i].filler = 'soft';
    for (const phrase of SOFT_FILLER_PHRASES) {
      if (i + phrase.length > out.length) continue;
      if (phrase.every((p, k) => normalizeWord(out[i + k].text) === p)) {
        for (let k = 0; k < phrase.length; k++) out[i + k].filler = out[i + k].filler || 'soft';
      }
    }
  }
  return out;
}

export function sortRanges(ranges) {
  return ranges.filter((r) => r && r.end > r.start).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
}

/** Merge overlapping or nearly-touching ranges. */
export function mergeRanges(ranges, gap = 0.02) {
  const sorted = sortRanges(ranges);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function clampRange(r, duration) {
  return { start: Math.max(0, Math.min(duration, r.start)), end: Math.max(0, Math.min(duration, r.end)) };
}

/** Cut ranges created by deleted transcript words. Each run of deleted words also removes the gap after it, up to GAP_ABSORB. */
export function wordCutRanges(words, duration = Infinity) {
  const cuts = [];
  let i = 0;
  while (i < words.length) {
    if (!words[i].deleted) { i++; continue; }
    let j = i;
    while (j + 1 < words.length && words[j + 1].deleted) j++;
    const prev = words[i - 1];
    const next = words[j + 1];
    const start = Math.max(prev ? prev.end : 0, words[i].start - WORD_PAD);
    const end = next ? Math.max(words[j].end, Math.min(next.start - WORD_PAD, words[j].end + GAP_ABSORB)) : Math.min(duration, words[j].end + 0.05);
    if (end - start > 0) cuts.push({ start, end, kind: 'words', from: i, to: j });
    i = j + 1;
  }
  return cuts;
}

/**
 * All cut ranges for a project edit state, merged and clamped.
 * edit = { words, cuts: [{start,end,kind}], range: {start,end}|null }
 */
export function computeCuts(edit, duration) {
  const raw = [...wordCutRanges(edit.words || [], duration), ...(edit.cuts || [])];
  if (edit.range) {
    if (edit.range.start > 0) raw.push({ start: 0, end: edit.range.start });
    if (edit.range.end < duration) raw.push({ start: edit.range.end, end: duration });
  }
  return mergeRanges(raw.map((r) => clampRange(r, duration))).filter((r) => r.end - r.start >= 0.001);
}

/** Complement of cuts within [0, duration]. */
export function keptRanges(cuts, duration) {
  const out = [];
  let t = 0;
  for (const c of mergeRanges(cuts)) {
    if (c.start - t >= MIN_RANGE) out.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (duration - t >= MIN_RANGE) out.push({ start: t, end: duration });
  return out;
}

export function totalDuration(ranges) {
  return ranges.reduce((s, r) => s + (r.end - r.start), 0);
}

/** Index of the range containing t (binary search) or -1. */
export function findRange(ranges, t) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (t < r.start) hi = mid - 1;
    else if (t >= r.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** If t falls in a cut, returns that cut, else null. */
export function cutAt(cuts, t) {
  const i = findRange(cuts, t);
  return i >= 0 ? cuts[i] : null;
}

/** Source time -> output time. Times inside a cut snap to the start of the next kept range. */
export function srcToOut(kept, t) {
  let acc = 0;
  for (const r of kept) {
    if (t < r.start) return acc;
    if (t < r.end) return acc + (t - r.start);
    acc += r.end - r.start;
  }
  return acc;
}

/** Output time -> source time. */
export function outToSrc(kept, T) {
  let acc = 0;
  for (const r of kept) {
    const len = r.end - r.start;
    if (T < acc + len) return r.start + Math.max(0, T - acc);
    acc += len;
  }
  const last = kept[kept.length - 1];
  return last ? last.end : 0;
}

/** Next playable source time at or after t (skips cuts). Returns null at the end. */
export function nextPlayable(kept, t) {
  for (const r of kept) {
    if (t < r.end - 0.005) return Math.max(t, r.start);
  }
  return null;
}

/**
 * Pauses between words that are longer than `minGap` seconds. Returns cut ranges that shorten each
 * pause so that `keep` seconds remain (split evenly on both sides). Leading/trailing silence is included.
 */
export function detectWordSilences(words, duration, { minGap = 0.75, keep = 0.25 } = {}) {
  // Words that start at or after the end of the media are ignored: on a short take Whisper writes text into the
  // padding of its 30 s window (e.g. "Thank you." at 18 s of a 4 s take), which would cut the whole take as one
  // leading pause.
  const live = words.filter((w) => !w.deleted && !(duration > 0 && w.start >= duration));
  const out = [];
  const half = keep / 2;
  if (!live.length) return out;
  if (live[0].start > minGap) out.push({ start: 0, end: Math.max(0, live[0].start - half), kind: 'silence' });
  for (let i = 1; i < live.length; i++) {
    const gap = live[i].start - live[i - 1].end;
    if (gap >= minGap) out.push({ start: live[i - 1].end + half, end: live[i].start - half, kind: 'silence' });
  }
  const last = live[live.length - 1];
  if (duration - last.end > minGap) out.push({ start: last.end + half, end: duration, kind: 'silence' });
  return out.filter((r) => r.end - r.start >= MIN_RANGE);
}

/**
 * Automatic polish tightens pauses only in a take that is mostly talk. When the pauses would remove more than
 * `maxShare` of it (a demo with a few words of narration, or a few words Whisper invented over silence), it keeps
 * them all; "Remove pauses" still cuts them when asked.
 */
export function autoPauseCuts(silences, duration, { maxShare = 0.5 } = {}) {
  return duration > 0 && totalDuration(silences) > maxShare * duration ? [] : silences;
}

/**
 * Silence detection from an amplitude envelope (peaks: 0..1 per bin) when there is no transcript.
 */
export function detectPeakSilences(peaks, binsPerSec, { thresholdDb = -42, minSec = 0.8, keep = 0.25 } = {}) {
  const thr = Math.pow(10, thresholdDb / 20);
  const out = [];
  let runStart = -1;
  const flush = (endBin) => {
    const s = runStart / binsPerSec, e = endBin / binsPerSec;
    if (e - s >= minSec) out.push({ start: s + keep / 2, end: e - keep / 2, kind: 'silence' });
  };
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] < thr) { if (runStart < 0) runStart = i; }
    else if (runStart >= 0) { flush(i); runStart = -1; }
  }
  if (runStart >= 0) flush(peaks.length);
  return out.filter((r) => r.end - r.start >= MIN_RANGE);
}

/** Map a selection of word indices [a, b] (inclusive) to a source range. */
export function wordSpan(words, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return { start: words[lo].start, end: words[hi].end };
}

/** Index of the word being spoken at time t (or the last word before t). Binary search. */
export function wordIndexAt(words, t) {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Zoom amount at time t for a list of zoom regions. Returns {scale, x, y, k, id}. */
export function zoomAt(zooms, t) {
  let best = { scale: 1, x: 0.5, y: 0.5, k: 0, id: null };
  for (const z of zooms || []) {
    if (t < z.start || t > z.end) continue;
    const len = z.end - z.start;
    const ramp = Math.min(z.ramp ?? 0.65, len / 3);
    const kin = ramp > 0 ? smootherstep((t - z.start) / ramp) : 1;
    const kout = ramp > 0 ? smootherstep((z.end - t) / ramp) : 1;
    const k = Math.min(kin, kout);
    if (k > best.k) best = { scale: 1 + (z.scale - 1) * k, x: 0.5 + (z.x - 0.5) * k, y: 0.5 + (z.y - 0.5) * k, k, id: z.id };
  }
  return best;
}

/** Ken Perlin's smootherstep: zero velocity and acceleration at both ends, like a dolly move. */
export function smootherstep(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function smoothstep(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

let _id = 0;
export function uid(prefix = 'id') {
  _id = (_id + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${_id.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Default editable state for a new project. */
export function defaultEdit() {
  return {
    words: [],
    cuts: [],
    zooms: [],
    range: null,
    chapters: [],
    aspect: '16:9',
    layout: { mode: 'pip', corner: 'bl', size: 0.22, shape: 'circle', mirror: true, split: 0.4, fit: 'contain' },
    // Export-ready defaults: soft wallpaper, generous padding, macOS-like corners and shadow.
    style: { bg: 'tide', solid: '#2b2d33', padding: 0.07, radius: 0.016, shadow: 0.7 },
    // uppercase: null means "follow the preset" (only Bold sets caps).
    captions: { enabled: true, preset: 'studio', position: 'bottom', size: 1, color: '#ffd34d', uppercase: null },
  };
}

export const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] };

/** Output pixel size for an aspect at a target "p" resolution (short side). */
export function outputSize(aspect, short = 1080) {
  const [a, b] = ASPECTS[aspect] || ASPECTS['16:9'];
  const even = (n) => Math.round(n / 2) * 2;
  return a >= b ? { width: even((short * a) / b), height: short } : { width: short, height: even((short * b) / a) };
}

// ---- Segments and retakes (ticket W-04) -----------------------------------------------------------

const SEG_SENTENCE_END = /[.!?…]["')\]]?$/;
// The speaker broke off: trailing dash or ellipsis, or a dash on its own.
const SEG_BREAK = /(?:[—–]|--|\.\.\.|…)["')\]]?$|^-$/;

/** Stable id for word i: its own id, else `w<i>`. Ops, prompts and proposals all address words this way. */
export function wordIdOf(words, i) {
  const w = words[i];
  return w && w.id != null && w.id !== '' ? String(w.id) : `w${i}`;
}

/**
 * Split words into sentence-like segments at sentence punctuation and pauses longer than `pause`.
 * With `breaks`, also split where the speaker broke off (dash or ellipsis). Deleted words are skipped
 * unless `includeDeleted`. Returns [{ from, to, start, end, indices }] with indices into `words`.
 */
export function segmentWords(words, { pause = 0.9, breaks = false, includeDeleted = false } = {}) {
  const idx = [];
  for (let i = 0; i < words.length; i++) if (includeDeleted || !words[i].deleted) idx.push(i);
  const out = [];
  let cur = [];
  for (let k = 0; k < idx.length; k++) {
    const w = words[idx[k]];
    const next = k + 1 < idx.length ? words[idx[k + 1]] : null;
    const text = String(w.text || '').trim();
    cur.push(idx[k]);
    const end = !next || SEG_SENTENCE_END.test(text) || next.start - w.end > pause || (breaks && SEG_BREAK.test(text));
    if (end) {
      out.push({ from: cur[0], to: cur[cur.length - 1], start: words[cur[0]].start, end: words[cur[cur.length - 1]].end, indices: cur });
      cur = [];
    }
  }
  return out;
}

function retakeTokens(words, indices) {
  const out = [];
  for (const i of indices) {
    const n = normalizeWord(words[i].text);
    if (!n || HARD_FILLERS.has(n) || SOFT_FILLERS.has(n)) continue;
    out.push({ n, i });
  }
  return out;
}

function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return prev[b.length];
}

/**
 * Retake detection. Finds places where the speaker restarted or repeated a sentence and proposes
 * cutting the EARLIER take:
 * - a later segment (within `window` seconds) repeats ≥ `threshold` of an earlier segment's
 *   normalized tokens, in order, near its start (fillers ignored);
 * - an immediate restart inside one segment ("so the first thing so the first thing you do…").
 * An unfinished earlier take (no sentence punctuation) only pairs with the next substantial segment,
 * so a phrase reused later in the talk is not mistaken for a retake.
 * Returns non-overlapping proposals sorted by time:
 * [{ id, from, to, keepFrom, keepTo, similarity, start, end }] — from/to are inclusive word indices of
 * the take to cut, keepFrom/keepTo the take that stays. Words already deleted are skipped.
 */
export function detectRetakes(words, { window = 20, threshold = 0.6, minTokens = 3 } = {}) {
  const segs = segmentWords(words, { pause: 0.6, breaks: true }).map((s) => ({ ...s, toks: retakeTokens(words, s.indices) }));
  const cands = [];

  // 1. Immediate restarts inside one segment: tokens[a..a+k) === tokens[a+k..a+2k).
  for (const s of segs) {
    const t = s.toks;
    let found = null;
    for (let a = 0; !found && a + 2 * minTokens <= t.length; a++) {
      for (let k = Math.floor((t.length - a) / 2); k >= minTokens; k--) {
        let same = true;
        for (let q = 0; q < k && same; q++) same = t[a + q].n === t[a + k + q].n;
        if (same) { found = { a, k }; break; }
      }
    }
    if (!found) continue;
    const { a, k } = found;
    // The first take ends at its last token plus hard fillers or dashes; a soft "so" before the second take stays with it.
    let to = t[a + k - 1].i;
    while (to + 1 < t[a + k].i && (HARD_FILLERS.has(normalizeWord(words[to + 1].text)) || !normalizeWord(words[to + 1].text))) to++;
    cands.push({ from: a === 0 ? s.from : t[a - 1].i + 1, to, keepFrom: to + 1, keepTo: s.to, similarity: 1 });
  }

  // 2. A later segment repeats an earlier one.
  for (let ai = 0; ai < segs.length; ai++) {
    const A = segs[ai];
    if (A.toks.length < minTokens) continue;
    const complete = SEG_SENTENCE_END.test(String(words[A.to].text || '').trim()) && !SEG_BREAK.test(String(words[A.to].text || '').trim());
    const aTok = A.toks.map((x) => x.n);
    let best = null;
    let substantial = 0;
    for (let bj = ai + 1; bj < segs.length && segs[bj].start - A.end <= window; bj++) {
      const B = segs[bj];
      if (B.toks.length < minTokens) { if (bj - ai > 3) break; continue; }
      substantial++;
      if (substantial > (complete ? 4 : 1)) break;
      const slack = Math.max(2, Math.ceil(aTok.length / 2));
      const sim = lcsLength(aTok, B.toks.slice(0, aTok.length + slack).map((x) => x.n)) / aTok.length;
      if (sim >= threshold && (!best || sim > best.sim)) best = { bj, sim };
    }
    if (!best) continue;
    const B = segs[best.bj];
    // Short interjections between the takes ("sorry", "um") go with the flubbed take.
    const between = segs.slice(ai + 1, best.bj);
    const to = between.every((s) => s.toks.length < minTokens) ? B.from - 1 : A.to;
    cands.push({ from: A.from, to, keepFrom: B.from, keepTo: B.to, similarity: best.sim });
  }

  cands.sort((x, y) => x.from - y.from || y.to - x.to);
  const out = [];
  let lastTo = -1;
  for (const c of cands) {
    if (c.to < c.from || c.from <= lastTo) continue;
    const live = [];
    for (let i = c.from; i <= c.to; i++) if (!words[i].deleted) live.push(i);
    if (!live.length) continue;
    lastTo = c.to;
    out.push({
      id: `rt_${wordIdOf(words, c.from)}`,
      from: c.from, to: c.to, keepFrom: c.keepFrom, keepTo: c.keepTo,
      similarity: Math.round(c.similarity * 100) / 100,
      start: words[live[0]].start, end: words[live[live.length - 1]].end,
    });
  }
  return out;
}

/** New words array with each proposal's live words marked deleted:true and retake:<proposal id>. */
export function applyRetakes(words, proposals) {
  const out = words.slice();
  for (const p of proposals || []) {
    for (let i = Math.max(0, p.from); i <= Math.min(out.length - 1, p.to); i++) {
      if (!out[i].deleted) out[i] = { ...out[i], deleted: true, retake: p.id };
    }
  }
  return out;
}

/** Undo one retake: words cut by proposal `id` come back. */
export function restoreRetake(words, id) {
  return words.map((w) => {
    if (w.retake !== id) return w;
    const { retake, deleted, ...rest } = w;
    return rest;
  });
}

// ---- Multi-clip sequences (ticket AE-01) -------------------------------------------------------------
// A multi-clip project plays sources.clips through segments with an `asset`: { id, asset, sourceIn, start, end,
// speed? }. start/end are OUTPUT seconds and the segments are laid end to end; sourceIn is the clip time at start
// and a source second lasts 1/speed output seconds. There is no single source timeline, so zooms, scenes,
// frameSections, masks, annotations, B-roll and chapters use output seconds, and edits never add cuts: deleting
// words or a timeline range removes that stretch from the segments (a ripple) and moves later items with it.
// Words belong to clips ({ clip, start, end } in clip seconds); sequenceWords() lays them out on the output.

/** Items on the output timeline of a multi-clip edit that move with the segments under them. */
export const TIMELINE_LISTS = ['zooms', 'scenes', 'frameSections', 'masks', 'annotations', 'broll'];
const SPEED_MIN = 0.88, SPEED_MAX = 1.12;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** Playback rate of a segment: speed clamped to 0.88..1.12, default 1. */
export function segmentSpeed(s) {
  const v = Number(s?.speed);
  return Number.isFinite(v) && v > 0 ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, v)) : 1;
}

/** Segments that play a clip, sorted by start. */
export function sequenceSegments(segments) {
  return (Array.isArray(segments) ? segments : []).filter((s) => s && typeof s.asset === 'string' && s.asset && s.end > s.start).slice().sort((a, b) => a.start - b.start);
}

/** Output length of a sequence: the last segment's end. */
export function sequenceDuration(segments) {
  return sequenceSegments(segments).reduce((m, s) => Math.max(m, s.end), 0);
}

/** Clip seconds a segment plays: [sourceIn, sourceOut). */
export function segmentSourceRange(s) {
  return { start: s.sourceIn, end: s.sourceIn + (s.end - s.start) * segmentSpeed(s) };
}

/** Index of the segment playing at output time t (start inclusive, end exclusive) in sorted segments, or -1. */
export function segmentIndexAt(sorted, t) {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sorted[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * What plays at output time t: { index, segment, asset, local, speed } with local = the clip time, or null in a gap
 * or past the end. The last segment also answers for t === its end (the final frame).
 */
export function sequenceTime(segments, t) {
  const sorted = sequenceSegments(segments);
  let i = segmentIndexAt(sorted, t);
  if (i < 0 && sorted.length && Math.abs(t - sorted[sorted.length - 1].end) < 1e-9) i = sorted.length - 1;
  if (i < 0) return null;
  const s = sorted[i], speed = segmentSpeed(s);
  return { index: i, segment: s, asset: s.asset, local: s.sourceIn + (t - s.start) * speed, speed };
}

/**
 * The sound of a sequence as pieces: each kept stretch (timeline seconds) of each segment, at the output time where
 * it plays (the kept ranges laid end to end). A gap between segments keeps its length and stays silent. xin / xout:
 * the crossfade overlap at a cut between pieces that touch on the output (each side plays `crossfade` seconds past
 * the cut into its own footage); 0 at the very start and end and next to a gap.
 * → [{ s, a, b, o0, o1, xin, xout }] in output order.
 */
export function sequenceAudioPieces(kept, segments, { crossfade = 0.04 } = {}) {
  const segs = sequenceSegments(segments);
  const pieces = [];
  let base = 0;
  for (const r of Array.isArray(kept) ? kept : []) {
    for (const s of segs) {
      const a = Math.max(r.start, s.start), b = Math.min(r.end, s.end);
      if (b - a > 1e-6) pieces.push({ s, a, b, o0: base + (a - r.start), o1: base + (b - r.start) });
    }
    base += r.end - r.start;
  }
  pieces.forEach((p, k) => {
    const prev = pieces[k - 1], next = pieces[k + 1];
    p.xin = prev && Math.abs(p.o0 - prev.o1) < 1e-6 ? crossfade : 0;
    p.xout = next && Math.abs(next.o0 - p.o1) < 1e-6 ? crossfade : 0;
  });
  return pieces;
}

/** Every output time at which clip time `local` of `asset` plays (a clip can appear more than once). */
export function clipToSequence(segments, asset, local) {
  const out = [];
  for (const s of sequenceSegments(segments)) {
    if (s.asset !== asset) continue;
    const r = segmentSourceRange(s);
    if (local >= r.start && local < r.end) out.push(s.start + (local - r.start) / segmentSpeed(s));
  }
  return out;
}

/** Lay segments end to end from 0 in the given order, keeping each one's length. Returns new objects. */
export function packSegments(segments) {
  let t = 0;
  return segments.map((s) => {
    const len = s.end - s.start;
    const out = { ...s, start: r6(t), end: r6(t + len) };
    t += len;
    return out;
  });
}

const cloneJSON = (x) => JSON.parse(JSON.stringify(x));

/** Move timeline items (and keyframes) of `edit` with a time map f(t); drop items shorter than minLen. */
function remapTimeline(edit, f, { minLen = 0.05, span = null } = {}) {
  for (const k of TIMELINE_LISTS) {
    if (!Array.isArray(edit[k])) continue;
    edit[k] = edit[k].filter((it) => it && Number.isFinite(it.start) && Number.isFinite(it.end)).map((it) => {
      const o = { ...it };
      const [a, b] = span ? span(it) : [f(it.start), f(it.end)];
      o.start = r6(a); o.end = r6(b);
      if (Array.isArray(it.keyframes)) o.keyframes = it.keyframes.map((kf) => ({ ...kf, t: r6(span ? kf.t + (o.start - it.start) : f(kf.t)) }));
      return o;
    }).filter((it) => it.end - it.start >= minLen);
  }
  if (Array.isArray(edit.chapters)) edit.chapters = edit.chapters.map((c) => ({ ...c, start: r6(f(c.start)) }));
  if (edit.brand?.lowerThird && Number.isFinite(edit.brand.lowerThird.start)) edit.brand = { ...edit.brand, lowerThird: { ...edit.brand.lowerThird, start: r6(f(edit.brand.lowerThird.start)) } };
  const tr = edit.captions?.translations;
  if (tr && typeof tr === 'object') {
    const next = {};
    for (const [lang, list] of Object.entries(tr)) next[lang] = (Array.isArray(list) ? list : []).map((c) => ({ ...c, start: r6(f(c.start)), end: r6(f(c.end)) })).filter((c) => c.end - c.start >= minLen);
    edit.captions = { ...edit.captions, translations: next };
  }
  return edit;
}

/**
 * Move timeline items that start at or after output time `at` by `delta` seconds (and keyframes with them), for
 * edits that grow or insert into a multi-clip sequence. Items that start before `at` keep their place. Returns a new
 * edit.
 */
export function shiftTimeline(edit, at, delta) {
  const out = cloneJSON(edit);
  if (!delta) return out;
  return remapTimeline(out, (t) => (t >= at - 1e-9 ? t + delta : t), { span: (it) => (it.start >= at - 1e-9 ? [it.start + delta, it.end + delta] : [it.start, it.end]) });
}

/**
 * Move segment `from` to position `to` (indices into the sorted segments) and lay the sequence out again. Timeline
 * items that start inside a segment travel with it (clamped to it); words need nothing (they're in clip time).
 * Returns a new edit.
 */
export function reorderSegments(edit, from, to) {
  const out = cloneJSON(edit);
  const old = sequenceSegments(out.segments);
  if (from < 0 || from >= old.length || to < 0 || to >= old.length || from === to) return out;
  const order = old.slice();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const packed = packSegments(order);
  const byId = new Map(packed.map((s) => [s.id, s]));
  const seat = (t) => { const i = segmentIndexAt(old, t); return i < 0 ? null : old[i]; };
  remapTimeline(out, (t) => { const s = seat(t); return s ? t + byId.get(s.id).start - s.start : t; }, {
    span: (it) => {
      const s = seat(it.start);
      if (!s) return [it.start, it.end];
      const d = byId.get(s.id).start - s.start;
      return [it.start + d, Math.min(it.end, s.end) + d];
    },
  });
  out.segments = [...packed, ...(Array.isArray(out.segments) ? out.segments.filter((s) => !(s && s.asset)) : [])];
  return out;
}

/**
 * Remove output ranges from a multi-clip edit (a ripple): segments are trimmed or split (sourceIn follows the speed),
 * later segments and timeline items move earlier, items inside a removed range shrink or go. Words stay as they are
 * (clip time). Returns a new edit.
 */
export function rippleDelete(edit, ranges) {
  const out = cloneJSON(edit);
  const total = sequenceDuration(out.segments);
  const cuts = mergeRanges((ranges || []).map((r) => clampRange(r, total)), 1e-6).filter((r) => r.end - r.start >= 1e-4);
  if (!cuts.length) return out;
  const f = (t) => {
    let removed = 0;
    for (const c of cuts) {
      if (t >= c.end) removed += c.end - c.start;
      else if (t > c.start) return c.start - removed;
      else break;
    }
    return t - removed;
  };
  const ids = new Set(sequenceSegments(out.segments).map((s) => s.id));
  const pieces = [];
  for (const s of sequenceSegments(out.segments)) {
    const sp = segmentSpeed(s);
    const local = cuts.filter((c) => c.end > s.start && c.start < s.end).map((c) => ({ start: c.start - s.start, end: c.end - s.start }));
    let n = 0;
    for (const k of keptRanges(local, s.end - s.start)) {
      let id = s.id;
      if (n > 0) { let j = n; while (ids.has(`${s.id}.${j}`)) j++; id = `${s.id}.${j}`; ids.add(id); }
      n++;
      pieces.push({ ...s, id, sourceIn: r6(s.sourceIn + k.start * sp), start: r6(f(s.start + k.start)), end: r6(f(s.start + k.end)) });
    }
  }
  remapTimeline(out, f);
  out.segments = [...packSegments(pieces), ...(Array.isArray(out.segments) ? out.segments.filter((s) => !(s && s.asset)) : [])];
  return out;
}

/**
 * Clip words laid out on the output timeline, in sequence order: each word of a segment's clip whose middle falls in
 * the part the segment plays, with output times. ids become `<word id>@<segment id>` (a clip can play twice);
 * src / seg / clip point back to where it came from.
 */
export function sequenceWords(words, segments) {
  const byClip = new Map();
  for (const w of Array.isArray(words) ? words : []) {
    if (!w || typeof w.clip !== 'string') continue;
    if (!byClip.has(w.clip)) byClip.set(w.clip, []);
    byClip.get(w.clip).push(w);
  }
  for (const list of byClip.values()) list.sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sequenceSegments(segments)) {
    const sp = segmentSpeed(s), r = segmentSourceRange(s);
    for (const w of byClip.get(s.asset) || []) {
      const mid = (w.start + w.end) / 2;
      if (mid < r.start || mid >= r.end) continue;
      const { deleted, retake, ...rest } = w;
      out.push({ ...rest, id: `${w.id}@${s.id}`, src: String(w.id), seg: s.id, start: r6(s.start + (Math.max(w.start, r.start) - r.start) / sp), end: r6(s.start + (Math.min(w.end, r.end) - r.start) / sp) });
    }
  }
  return out;
}

/** Output-time words (e.g. a transcript of the whole sequence) back to clip words, by the segment under each middle. */
export function toClipWords(words, segments) {
  const sorted = sequenceSegments(segments);
  const out = [];
  const seen = new Set();
  for (const w of Array.isArray(words) ? words : []) {
    if (!w) continue;
    const i = segmentIndexAt(sorted, (w.start + w.end) / 2);
    if (i < 0) continue;
    const s = sorted[i], sp = segmentSpeed(s);
    const { deleted, retake, seg, src, ...rest } = w;
    const start = r6(s.sourceIn + (w.start - s.start) * sp), end = r6(s.sourceIn + (w.end - s.start) * sp);
    const key = `${s.asset}\u0000${Math.round(start * 100)}\u0000${w.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...rest, id: src != null ? String(src) : String(w.id ?? `w${out.length}`), clip: s.asset, start, end });
  }
  return out;
}

/** The editable view of a multi-clip edit: words on the output timeline, no cuts, no range. */
export function sequenceView(edit) {
  const v = cloneJSON(edit);
  v.words = sequenceWords(edit.words, edit.segments);
  v.cuts = [];
  v.range = null;
  return v;
}

const WORD_PROPS = ['text', 'speaker', 'filler', 'confidence'];
/**
 * Fold an edited view (see sequenceView) back into the multi-clip edit: deleted words, new cuts and a range become a
 * ripple delete of those output ranges; text, speaker, filler and confidence changes go back to the clip words.
 * When the view's words were replaced (a fresh transcript of the sequence) they become clip words, and clip words
 * outside every segment are kept. Other fields are taken from the view. Returns a new edit.
 */
export function foldSequenceView(edit, view) {
  const total = sequenceDuration(view.segments);
  const vw = Array.isArray(view.words) ? view.words : [];
  const ranges = computeCuts({ words: vw, cuts: view.cuts || [], range: view.range || null }, total);
  let words;
  if (vw.every((w) => w && w.src != null && typeof w.clip === 'string' && w.seg != null)) {
    const keyOf = (w) => `${w.clip}\u0000${w.id}`;
    const orig = new Map((edit.words || []).map((w) => [keyOf(w), w]));
    const next = new Map((edit.words || []).map((w) => [keyOf(w), { ...w }]));
    for (const w of vw) {
      const key = `${w.clip}\u0000${w.src}`, o = orig.get(key), n = next.get(key);
      if (!o) continue;
      for (const k of WORD_PROPS) if (w[k] !== o[k]) { if (w[k] === undefined) delete n[k]; else n[k] = w[k]; }
    }
    words = (edit.words || []).map((w) => next.get(keyOf(w)) || w);
  } else {
    const segs = sequenceSegments(view.segments);
    const inSeq = (w) => segs.some((s) => { const r = segmentSourceRange(s); const m = (w.start + w.end) / 2; return s.asset === w.clip && m >= r.start && m < r.end; });
    words = [...(edit.words || []).filter((w) => w && typeof w.clip === 'string' && !inSeq(w)), ...toClipWords(vw, segs)]
      .sort((a, b) => (a.clip < b.clip ? -1 : a.clip > b.clip ? 1 : a.start - b.start));
  }
  const out = { ...cloneJSON(view), words, cuts: [], range: null };
  return ranges.length ? rippleDelete(out, ranges) : out;
}

/**
 * Long pauses between words inside each segment (output time), shortened to `keep` like detectWordSilences. Unlike
 * it, the stretches before a segment's first word and after its last are never cut: a clip edge is a deliberate cut,
 * and a clip without speech (B-roll, a photo) is not a pause.
 */
export function sequenceSilences(words, segments, { minGap = 0.75, keep = 0.25 } = {}) {
  const out = [];
  const half = keep / 2;
  const live = (Array.isArray(words) ? words : []).filter((w) => w && !w.deleted);
  for (const s of sequenceSegments(segments)) {
    const inSeg = live.filter((w) => (w.seg != null ? w.seg === s.id : w.start >= s.start && w.end <= s.end)).sort((a, b) => a.start - b.start);
    for (let i = 1; i < inSeg.length; i++) {
      const gap = inSeg[i].start - inSeg[i - 1].end;
      if (gap >= minGap) out.push({ start: inSeg[i - 1].end + half, end: inSeg[i].start - half, kind: 'silence' });
    }
  }
  return out.filter((r) => r.end - r.start >= MIN_RANGE);
}

/**
 * A per-clip signal sampled at `rate` per second (peaks, 16 kHz PCM …) laid out on the output timeline: for each
 * output sample, the clip sample under it (nearest; speed respected). signals: { [clipId]: Float32Array }.
 */
export function sequenceSignal(segments, signals, rate) {
  const sorted = sequenceSegments(segments);
  const out = new Float32Array(Math.ceil(sequenceDuration(sorted) * rate));
  for (const s of sorted) {
    const sig = signals?.[s.asset];
    if (!sig) continue;
    const sp = segmentSpeed(s);
    const i0 = Math.round(s.start * rate), i1 = Math.min(out.length, Math.round(s.end * rate));
    for (let i = i0; i < i1; i++) {
      const j = Math.round((s.sourceIn + (i / rate - s.start) * sp) * rate);
      if (j >= 0 && j < sig.length) out[i] = sig[j];
    }
  }
  return out;
}

/** Per-clip timed events ([{ t, … }] in clip seconds) on the output timeline. eventsByClip: { [clipId]: events }. */
export function sequenceEvents(segments, eventsByClip) {
  const out = [];
  for (const s of sequenceSegments(segments)) {
    const sp = segmentSpeed(s), r = segmentSourceRange(s);
    for (const e of eventsByClip?.[s.asset] || []) if (e.t >= r.start && e.t < r.end) out.push({ ...e, t: r6(s.start + (e.t - r.start) / sp) });
  }
  return out.sort((a, b) => a.t - b.t);
}
