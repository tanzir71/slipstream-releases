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
  const live = words.filter((w) => !w.deleted);
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
