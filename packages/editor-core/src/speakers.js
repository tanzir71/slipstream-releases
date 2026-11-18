// Speaker labels (ticket W-03). Pure: no DOM, no media, no model.
// Two halves:
//   1. Words ↔ speakers: tag transcript words from diarization segments, list turns, names, colours, talk time.
//   2. Diarization post-processing used by app/js/diarize-worker.js: pyannote powerset logits → per-speaker
//      activity, stitching of overlapping windows into one consistent set of speakers, and segments.
// Unit-tested in packages/editor-core/test/speakers.test.mjs.

// Speaker colours. Chosen to stay clear of the app's semantic colours (coral = removed, amber = fillers,
// accent = selection/zoom, mint = success, signal = recording): ΔE76 ≥ 30 from each, ≥ 25 from each other.
export const SPEAKER_PALETTE = ['#5cb8ff', '#e58ad6', '#b4d65e', '#ffb3c7', '#d8c3a5', '#3cc8e8'];

const ID_RE = /^S(\d+)$/;
const idNum = (id) => { const m = ID_RE.exec(id || ''); return m ? Number(m[1]) : Infinity; };
const byId = (a, b) => idNum(a) - idNum(b) || String(a).localeCompare(String(b));

/** Speaker id for the n-th (0-based) speaker: S1, S2, … */
export const speakerId = (n) => `S${n + 1}`;

/** Colour for a speaker id (cycles through the palette after six speakers). */
export function speakerColor(id) {
  const n = idNum(id);
  return SPEAKER_PALETTE[(Number.isFinite(n) ? n - 1 : 0) % SPEAKER_PALETTE.length];
}

// ---------------------------------------------------------------------------------------------
// 1. Words ↔ speakers
// ---------------------------------------------------------------------------------------------

/**
 * Tag each word with the speaker whose segments overlap it most. Words that fall in a gap take the
 * nearest segment within `maxGap` seconds, else the previous word's speaker.
 * Smoothing: a run of ≤ `strayWords` words (≤ `strayMaxSec` long) sandwiched between the same speaker
 * on both sides is relabelled to that speaker — unless it is clearly its own turn (pauses ≥ `turnPause`
 * on both sides and ≥ 80% of its time inside its own speaker's segments), so a one-word "Yes." survives.
 * Returns new word objects; input is not mutated. Words get `speaker: null` when there are no segments.
 */
export function assignSpeakers(words, segments, { strayWords = 1, strayMaxSec = 0.8, turnPause = 0.25, maxGap = 1.5 } = {}) {
  const segs = (segments || []).filter((s) => s && s.end > s.start && s.speaker).slice().sort((a, b) => a.start - b.start);
  if (!segs.length) return words.map((w) => ({ ...w, speaker: null }));
  const labels = [];
  const share = [];
  let k = 0; // first segment that may still overlap (words are mostly time-ordered; fall back to a scan if not)
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const s0 = Number(w.start) || 0, e0 = Math.max(Number(w.end) || 0, s0 + 0.01);
    if (i && s0 < (Number(words[i - 1].start) || 0)) k = 0;
    while (k < segs.length && segs[k].end <= s0 - 30) k++;
    const tally = new Map();
    let best = null, bestOv = 0, nearest = null, nearestD = Infinity;
    for (let j = k; j < segs.length && segs[j].start < e0 + maxGap; j++) {
      const s = segs[j];
      const ov = Math.min(e0, s.end) - Math.max(s0, s.start);
      if (ov > 0) {
        const v = (tally.get(s.speaker) || 0) + ov;
        tally.set(s.speaker, v);
        if (v > bestOv) { bestOv = v; best = s.speaker; }
      } else {
        const d = s.start >= e0 ? s.start - e0 : s0 - s.end;
        if (d < nearestD) { nearestD = d; nearest = s.speaker; }
      }
    }
    if (!best) {
      // Look back for a segment that ended shortly before this word.
      for (let j = Math.min(k, segs.length) - 1, n = 0; j >= 0 && n < 50; j--, n++) {
        const d = s0 - segs[j].end;
        if (d >= 0 && d < nearestD) { nearestD = d; nearest = segs[j].speaker; }
      }
    }
    if (best) { labels.push(best); share.push(bestOv / (e0 - s0)); }
    else if (nearest && nearestD <= maxGap) { labels.push(nearest); share.push(0); }
    else { labels.push(i ? labels[i - 1] : null); share.push(0); }
  }
  // Leading words with no speaker take the first known one.
  const first = labels.find((x) => x);
  for (let i = 0; i < labels.length && !labels[i]; i++) labels[i] = first || null;

  // Smooth stray runs.
  let i = 0;
  while (i < labels.length) {
    let j = i;
    while (j + 1 < labels.length && labels[j + 1] === labels[i]) j++;
    const prev = labels[i - 1], next = labels[j + 1];
    if (i > 0 && j < labels.length - 1 && prev === next && prev !== labels[i] && j - i + 1 <= strayWords) {
      const dur = words[j].end - words[i].start;
      const gapBefore = words[i].start - words[i - 1].end, gapAfter = words[j + 1].start - words[j].end;
      let own = 0;
      for (let q = i; q <= j; q++) own += share[q];
      own /= j - i + 1;
      const ownTurn = gapBefore >= turnPause && gapAfter >= turnPause && own >= 0.8;
      if (dur <= strayMaxSec && !ownTurn) for (let q = i; q <= j; q++) labels[q] = prev;
    }
    i = j + 1;
  }
  return words.map((w, n) => ({ ...w, speaker: labels[n] }));
}

/**
 * Consecutive runs of the same speaker. from/to are inclusive word indexes (as in edl.js cut ranges).
 * Words without a speaker are skipped (they neither start nor break a turn).
 */
export function speakerTurns(words) {
  const turns = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.speaker) continue;
    if (cur && cur.speaker === w.speaker) { cur.to = i; cur.end = Math.max(cur.end, w.end); continue; }
    cur = { speaker: w.speaker, from: i, to: i, start: w.start, end: w.end };
    turns.push(cur);
  }
  return turns;
}

/**
 * { S1: { name: 'Speaker 1', color }, … } for every speaker used by the words.
 * Pass the project's current map as `existing` to keep names/colours the user already set.
 */
export function defaultSpeakers(words, existing = {}) {
  const ids = [...new Set(words.map((w) => w.speaker).filter(Boolean))].sort(byId);
  const out = {};
  for (const id of ids) {
    const n = idNum(id);
    out[id] = {
      name: Number.isFinite(n) ? `Speaker ${n}` : String(id),
      color: speakerColor(id),
      ...(existing && existing[id] ? existing[id] : {}),
    };
  }
  return out;
}

/** Rename one speaker. Blank names fall back to "Speaker N". Returns a new map. */
export function renameSpeaker(speakers, id, name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const n = idNum(id);
  const fallback = Number.isFinite(n) ? `Speaker ${n}` : String(id);
  const prev = (speakers && speakers[id]) || { color: speakerColor(id) };
  return { ...speakers, [id]: { ...prev, name: clean || fallback } };
}

/**
 * Talk time per speaker over kept (not deleted) words: [{ speaker, seconds, words, turns, share }]
 * in speaker-id order. `seconds` sums word durations plus short in-turn gaps (< 0.6 s) so it reads like
 * speaking time rather than pure word time.
 */
export function speakerStats(words, { includeDeleted = false } = {}) {
  const live = words.filter((w) => w.speaker && (includeDeleted || !w.deleted));
  const map = new Map();
  let prev = null;
  for (const w of live) {
    let s = map.get(w.speaker);
    if (!s) { s = { speaker: w.speaker, seconds: 0, words: 0, turns: 0, share: 0 }; map.set(w.speaker, s); }
    s.words++;
    s.seconds += Math.max(0, w.end - w.start);
    if (prev && prev.speaker === w.speaker) {
      const gap = w.start - prev.end;
      if (gap > 0 && gap < 0.6) s.seconds += gap;
    } else s.turns++;
    prev = w;
  }
  const total = [...map.values()].reduce((a, s) => a + s.seconds, 0);
  for (const s of map.values()) { s.seconds = Math.round(s.seconds * 100) / 100; s.share = total ? s.seconds / total : 0; }
  return [...map.values()].sort((a, b) => byId(a.speaker, b.speaker));
}

// ---------------------------------------------------------------------------------------------
// 2. Diarization post-processing (pyannote segmentation 3.0)
// ---------------------------------------------------------------------------------------------

/** pyannote/segmentation-3.0 powerset classes → active local speakers. */
export const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

/**
 * Logits [frames × classes] (row-major) → per-local-speaker activity in 0..1 (softmax, then the sum of
 * every class that contains the speaker). Returns { act: Float32Array[3], frames }.
 */
export function powersetActivity(logits, frames, powerset = POWERSET) {
  const C = powerset.length;
  const L = Math.max(...powerset.flat()) + 1;
  const act = Array.from({ length: L }, () => new Float32Array(frames));
  const p = new Float64Array(C);
  for (let f = 0; f < frames; f++) {
    let mx = -Infinity;
    for (let c = 0; c < C; c++) mx = Math.max(mx, logits[f * C + c]);
    let sum = 0;
    for (let c = 0; c < C; c++) { p[c] = Math.exp(logits[f * C + c] - mx); sum += p[c]; }
    for (let c = 0; c < C; c++) for (const s of powerset[c]) act[s][f] += p[c] / sum;
  }
  return { act, frames };
}

/**
 * Split [0, duration] into analysis windows of `windowSec` with `overlapSec` overlap. A short tail is
 * folded into the previous window so no window is shorter than `minLastSec`. Returns [[start, end], …].
 */
export function diarizationWindows(duration, { windowSec = 60, overlapSec = 15, minLastSec = 20 } = {}) {
  if (!(duration > 0)) return [];
  if (duration <= windowSec + minLastSec) return [[0, duration]];
  const hop = windowSec - overlapSec;
  const out = [];
  for (let s = 0; ; s += hop) {
    const e = s + windowSec;
    if (e >= duration - minLastSec) { out.push([s, duration]); break; }
    out.push([s, e]);
  }
  return out;
}

// Small radix-2 FFT (in place) for the spectral voice signature.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const melCache = new Map();
function melBank(sampleRate, size, bands, fmin = 80, fmax = 7600) {
  const key = `${sampleRate}:${size}:${bands}`;
  if (melCache.has(key)) return melCache.get(key);
  const mel = (f) => 2595 * Math.log10(1 + f / 700), inv = (m) => 700 * (10 ** (m / 2595) - 1);
  const top = Math.min(fmax, sampleRate / 2), lo = mel(fmin), hi = mel(top);
  const pts = Array.from({ length: bands + 2 }, (_, i) => inv(lo + ((hi - lo) * i) / (bands + 1)) / (sampleRate / size));
  const bank = [];
  for (let b = 0; b < bands; b++) {
    const [l, c, r] = [pts[b], pts[b + 1], pts[b + 2]];
    const w = new Float32Array(size / 2 + 1);
    for (let k = Math.floor(l); k <= Math.ceil(r) && k <= size / 2; k++) {
      w[k] = k < l || k > r ? 0 : k <= c ? (k - l) / Math.max(1e-6, c - l) : (r - k) / Math.max(1e-6, r - c);
    }
    bank.push(w);
  }
  const hann = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const v = { bank, hann };
  melCache.set(key, v);
  return v;
}

/**
 * A cheap voice signature (mean log-mel spectrum) for each local speaker of one window, from frames where
 * that speaker talks alone. Used only to re-identify a speaker who is absent from a window overlap.
 * win = { start, frameDur, act: Float32Array[] }; pcm covers the whole recording.
 * Returns [{ vec: Float32Array, n } | null] per local speaker.
 */
export function voiceSignatures(pcm, sampleRate, win, { maxFrames = 240, minFrames = 24, size = 512, bands = 24, solo = 0.7, other = 0.3 } = {}) {
  const { bank, hann } = melBank(sampleRate, size, bands);
  const re = new Float64Array(size), im = new Float64Array(size);
  return win.act.map((a, l) => {
    const idx = [];
    for (let f = 0; f < a.length; f++) {
      if (a[f] < solo) continue;
      if (win.act.some((b, m) => m !== l && b[f] > other)) continue;
      idx.push(f);
    }
    if (idx.length < minFrames) return null;
    const stride = Math.max(1, Math.floor(idx.length / maxFrames));
    const vec = new Float32Array(bands);
    let n = 0;
    for (let q = 0; q < idx.length; q += stride) {
      const t = win.start + (idx[q] + 0.5) * win.frameDur;
      const c = Math.round(t * sampleRate) - size / 2;
      if (c < 0 || c + size > pcm.length) continue;
      let energy = 0;
      for (let i = 0; i < size; i++) { const x = pcm[c + i]; re[i] = x * hann[i]; im[i] = 0; energy += x * x; }
      if (energy < 1e-6) continue; // digital silence
      fft(re, im);
      for (let b = 0; b < bands; b++) {
        let e = 0;
        const w = bank[b];
        for (let k = 0; k < w.length; k++) if (w[k]) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
        vec[b] += Math.log(e + 1e-8);
      }
      n++;
    }
    if (n < Math.min(minFrames, 8)) return null;
    for (let b = 0; b < bands; b++) vec[b] /= n;
    return { vec, n };
  });
}

function cosine(a, b, mean) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - mean[i], y = b[i] - mean[i];
    d += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

/**
 * Stitch per-window local speakers into global speakers and return speech segments.
 *
 * windows: [{ start, end, frameDur, act: Float32Array[localSpeakers], sig?: [{vec,n}|null] }] in time order,
 *   consecutive windows overlapping in time.
 * Identity across windows: local speakers are matched to the previous window's speakers by how much their
 * activity agrees inside the overlap (best injective assignment). A speaker who is silent in the overlap
 * is re-identified by voice signature (cosine ≥ `sigMatch`), else becomes a new speaker. Finally, speakers
 * who never talk in the same window and have very similar signatures (≥ `sigMerge`) are merged.
 * `maxSpeakers` (optional) caps the count; extra speakers are forced onto the closest existing one.
 *
 * Returns [{ start, end, speaker: 'S1'|'S2'|… }] sorted, single speaker per segment (in overlapped
 * speech the louder/more confident one wins), ids numbered by first appearance.
 */
export function stitchDiarization(windows, {
  onset = 0.5, minActiveSec = 0.4, minOverlapSec = 0.5, agreeRatio = 0.5,
  sigMatch = 0.5, sigMerge = 0.75, maxSpeakers = 0,
  minSegSec = 0.25, fillGapSec = 0.5, minSpeakerSec = 1,
} = {}) {
  if (!windows || !windows.length) return [];
  const fd = windows[0].frameDur;
  const duration = Math.max(...windows.map((w) => w.end));

  // Mean signature across all windows: signatures are compared after removing it, so what remains is
  // what makes one voice differ from the others in this recording.
  const bands = windows.flatMap((w) => w.sig || []).find(Boolean)?.vec.length || 0;
  const mean = new Float32Array(bands);
  if (bands) {
    let n = 0;
    for (const w of windows) for (const s of w.sig || []) if (s) { for (let b = 0; b < bands; b++) mean[b] += s.vec[b] * s.n; n += s.n; }
    for (let b = 0; b < bands; b++) mean[b] /= n || 1;
  }

  const globals = []; // { sum: Float32Array|null, n, windows: Set }
  const addSig = (g, s, wi) => {
    globals[g].windows.add(wi);
    if (!s) return;
    if (!globals[g].sum) globals[g].sum = new Float32Array(bands);
    for (let b = 0; b < bands; b++) globals[g].sum[b] += s.vec[b] * s.n;
    globals[g].n += s.n;
  };
  const gSig = (g) => (globals[g].sum && globals[g].n ? globals[g].sum.map((v) => v / globals[g].n) : null);
  const newGlobal = () => { globals.push({ sum: null, n: 0, windows: new Set(), last: -1 }); return globals.length - 1; };

  const maps = []; // per window: local → global (-1 = ignored)
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    const L = w.act.length;
    const mass = w.act.map((a) => { let s = 0; for (const v of a) s += v; return s * w.frameDur; });
    const map = new Array(L).fill(-1);
    const used = new Set();
    const prev = wi ? windows[wi - 1] : null;
    if (prev && prev.end > w.start) {
      // Agreement in the overlap between each local speaker here and each local speaker in the previous window.
      const pm = maps[wi - 1];
      const agree = Array.from({ length: L }, () => new Float64Array(prev.act.length));
      const om = new Float64Array(L), pmass = new Float64Array(prev.act.length);
      for (let f = 0; f < w.act[0].length; f++) {
        const t = w.start + (f + 0.5) * w.frameDur;
        if (t >= prev.end) break;
        const j = Math.floor((t - prev.start) / prev.frameDur);
        if (j < 0 || j >= prev.act[0].length) continue;
        for (let m = 0; m < prev.act.length; m++) pmass[m] += prev.act[m][j];
        for (let l = 0; l < L; l++) {
          om[l] += w.act[l][f];
          for (let m = 0; m < prev.act.length; m++) agree[l][m] += Math.min(w.act[l][f], prev.act[m][j]);
        }
      }
      const minF = minOverlapSec / w.frameDur;
      const ok = (l, m) => pm[m] >= 0 && agree[l][m] >= minF && agree[l][m] >= agreeRatio * Math.min(om[l], pmass[m]);
      // Best injective assignment by brute force (≤ 3 × 3).
      let best = { score: 0, pairs: [] };
      const search = (l, takenM, score, pairs) => {
        if (l === L) { if (score > best.score) best = { score, pairs: pairs.slice() }; return; }
        search(l + 1, takenM, score, pairs);
        for (let m = 0; m < prev.act.length; m++) {
          if (takenM & (1 << m) || !ok(l, m)) continue;
          pairs.push([l, m]);
          search(l + 1, takenM | (1 << m), score + agree[l][m], pairs);
          pairs.pop();
        }
      };
      search(0, 0, 0, []);
      for (const [l, m] of best.pairs) if (!used.has(pm[m])) { map[l] = pm[m]; used.add(pm[m]); }
    }
    // Local speakers without overlap evidence: voice signature, else a new speaker.
    const order = [...Array(L).keys()].filter((l) => map[l] < 0 && mass[l] >= minActiveSec).sort((a, b) => mass[b] - mass[a]);
    for (const l of order) {
      const s = w.sig && w.sig[l];
      let bestG = -1, bestSim = -Infinity;
      for (let g = 0; g < globals.length; g++) {
        if (used.has(g)) continue;
        const gs = gSig(g);
        const sim = s && gs ? cosine(s.vec, gs, mean) : -Infinity;
        if (sim > bestSim) { bestSim = sim; bestG = g; }
      }
      if (bestG >= 0 && bestSim >= sigMatch) map[l] = bestG;
      else if (maxSpeakers > 0 && globals.length >= maxSpeakers) {
        // At the cap: closest voice, else the speaker heard least recently.
        let g = bestG;
        if (g < 0 || bestSim === -Infinity) {
          const free = globals.map((_, k) => k).filter((k) => !used.has(k));
          g = free.sort((a, b) => globals[a].last - globals[b].last)[0] ?? -1;
        }
        map[l] = g;
      } else map[l] = newGlobal();
      if (map[l] >= 0) used.add(map[l]);
    }
    for (let l = 0; l < L; l++) if (map[l] >= 0) { addSig(map[l], w.sig && w.sig[l], wi); globals[map[l]].last = wi; }
    maps.push(map);
  }

  // Merge speakers that never share a window and sound alike (a returning speaker given a new id).
  const parent = globals.map((_, g) => g);
  const root = (g) => (parent[g] === g ? g : (parent[g] = root(parent[g])));
  if (bands) {
    for (;;) {
      let pair = null, bestSim = sigMerge;
      const roots = [...new Set(parent.map((_, g) => root(g)))];
      const wins = new Map(roots.map((r) => [r, new Set()]));
      const sums = new Map(roots.map((r) => [r, { sum: new Float32Array(bands), n: 0 }]));
      globals.forEach((G, g) => {
        const r = root(g);
        for (const x of G.windows) wins.get(r).add(x);
        if (G.sum) { const t = sums.get(r); for (let b = 0; b < bands; b++) t.sum[b] += G.sum[b]; t.n += G.n; }
      });
      for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
        const a = roots[i], b = roots[j];
        if ([...wins.get(a)].some((x) => wins.get(b).has(x))) continue;
        const sa = sums.get(a), sb = sums.get(b);
        if (!sa.n || !sb.n) continue;
        const sim = cosine(sa.sum.map((v) => v / sa.n), sb.sum.map((v) => v / sb.n), mean);
        if (sim >= bestSim) { bestSim = sim; pair = [a, b]; }
      }
      if (!pair) break;
      parent[pair[1]] = pair[0];
    }
  }

  // Blend window activities on one frame grid (cross-fade inside overlaps), then pick one speaker per frame.
  const N = Math.ceil(duration / fd);
  const G = globals.length;
  const acc = Array.from({ length: G }, () => new Float32Array(N));
  const wsum = new Float32Array(N);
  windows.forEach((w, wi) => {
    for (let f = 0; f < w.act[0].length; f++) {
      const t = w.start + (f + 0.5) * w.frameDur;
      const gi = Math.floor(t / fd);
      if (gi < 0 || gi >= N) continue;
      const weight = 1e-3 + Math.min(t - w.start, w.end - t);
      wsum[gi] += weight;
      for (let l = 0; l < w.act.length; l++) {
        const g = maps[wi][l];
        if (g >= 0) acc[root(g)][gi] += weight * w.act[l][f];
      }
    }
  });
  const label = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (!wsum[i]) continue;
    let bg = -1, bv = onset;
    for (let g = 0; g < G; g++) { const v = acc[g][i] / wsum[i]; if (v >= bv) { bv = v; bg = g; } }
    label[i] = bg;
  }

  // Frames → segments, then tidy: drop blips, close small same-speaker gaps, fold in near-silent speakers.
  let segs = [];
  for (let i = 0; i < N;) {
    let j = i;
    while (j + 1 < N && label[j + 1] === label[i]) j++;
    if (label[i] >= 0) segs.push({ start: i * fd, end: Math.min(duration, (j + 1) * fd), g: label[i] });
    i = j + 1;
  }
  return finishSegments(segs, { minSegSec, fillGapSec, minSpeakerSec });
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Rename speakers S1, S2, … by first appearance. Accepts segments keyed by `g` or `speaker`. */
function renumber(segs) {
  const ids = new Map();
  return segs.map((s) => {
    const k = s.g !== undefined ? s.g : s.speaker;
    if (!ids.has(k)) ids.set(k, speakerId(ids.size));
    return { start: round3(s.start), end: round3(s.end), speaker: ids.get(k) };
  });
}

/**
 * Quiet stretches of at least `minPause` seconds, from a frame-energy envelope with an adaptive
 * threshold (noise floor + `ratio` of the floor→speech range, in dB). The segmentation model tends to
 * bridge short pauses inside what it thinks is one speaker; turn changes almost always sit in such a
 * pause, so the embedding stage splits there. Returns [{ start, end }].
 */
export function findPauses(pcm, sampleRate, { hop = 0.01, minPause = 0.2, ratio = 0.3 } = {}) {
  const n = Math.max(1, Math.round(hop * sampleRate));
  const frames = Math.floor(pcm.length / n);
  if (frames < 3) return [];
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * n, end = i + n; i < end; i++) e += pcm[i] * pcm[i];
    db[f] = 10 * Math.log10(e / n + 1e-10);
  }
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(frames * 0.1)], peak = sorted[Math.floor(frames * 0.95)];
  if (peak - floor < 6) return []; // no usable contrast (constant noise or tone)
  const thr = floor + ratio * (peak - floor);
  const out = [];
  for (let f = 0; f < frames;) {
    if (db[f] >= thr) { f++; continue; }
    let g = f;
    while (g + 1 < frames && db[g + 1] < thr) g++;
    if ((g - f + 1) * hop >= minPause) out.push({ start: f * hop, end: (g + 1) * hop });
    f = g + 1;
  }
  return out;
}

/**
 * Pieces of speech to compute a voice embedding for: each segment, cut at `pauses` (from findPauses)
 * and with long pieces split to at most `maxSec`. Pieces shorter than `minSec` get `embed: false`
 * (too short to say anything about the voice) and later follow their neighbours.
 * Returns [{ start, end, speaker, embed }].
 */
export function embeddingRegions(segments, { pauses = [], maxSec = 8, minSec = 0.3 } = {}) {
  const out = [];
  const ps = pauses.slice().sort((a, b) => a.start - b.start);
  let k = 0;
  for (const s of segments) {
    const pieces = [];
    let a = s.start;
    while (k < ps.length && ps[k].end <= s.start) k++;
    for (let j = k; j < ps.length && ps[j].start < s.end; j++) {
      const p = ps[j];
      if (p.start > a) pieces.push([a, Math.min(p.start, s.end)]);
      a = Math.max(a, p.end);
    }
    if (s.end > a) pieces.push([a, s.end]);
    for (const [pa, pb] of pieces) {
      const d = pb - pa;
      if (d <= 0.02) continue;
      const n = Math.max(1, Math.ceil(d / maxSec));
      for (let i = 0; i < n; i++) {
        const x = pa + (d * i) / n, y = pa + (d * (i + 1)) / n;
        out.push({ start: x, end: y, speaker: s.speaker, embed: y - x >= minSec });
      }
    }
  }
  return out;
}

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};
const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

/**
 * Re-label speech by clustering voice embeddings — the second stage of a pyannote-style pipeline.
 * regions come from embeddingRegions(); embeddings[i] is the vector for regions[i] (null when not computed).
 *  1. Pieces ≥ `minPieceSec` are clustered bottom-up (centroid linkage on cosine similarity, weighted by
 *     duration) while the closest pair is ≥ `threshold`. Pieces that shared a first-stage (segmentation)
 *     speaker get a small `sameBonus`, so near-ties follow the segmentation model.
 *  2. Clusters with less than `minClusterSec` of speech join the closest large cluster.
 *  3. With `numSpeakers`, merging continues down to that count.
 *  4. Shorter pieces with an embedding join the closest cluster; pieces without one follow a neighbour.
 * Returns tidied segments [{ start, end, speaker }] numbered by first appearance.
 */
export function clusterSpeakers(regions, embeddings, {
  threshold = 0.7, sameBonus = 0.05, minPieceSec = 0.8, minClusterSec = 3, numSpeakers = 0,
  minSegSec = 0.25, fillGapSec = 0.5, minSpeakerSec = 1,
} = {}) {
  const has = (i) => !!(embeddings[i] && embeddings[i].length);
  const dur = (i) => regions[i].end - regions[i].start;
  const idx = regions.map((_, i) => i).filter((i) => has(i) && dur(i) >= minPieceSec);
  if (!idx.length) return finishSegments(regions.map(({ start, end, speaker }) => ({ start, end, g: speaker })), { minSegSec, fillGapSec, minSpeakerSec });
  const unit = embeddings.map((e) => (e && e.length ? normalize(e) : null));

  // A cluster: weighted sum of unit vectors, total seconds, member pieces, seconds per first-stage speaker.
  const make = (i) => ({ sum: unit[i].map((x) => x * dur(i)), w: dur(i), members: [i], labels: new Map([[regions[i].speaker, dur(i)]]) });
  const merge = (a, b) => {
    for (let k = 0; k < a.sum.length; k++) a.sum[k] += b.sum[k];
    a.w += b.w;
    a.members.push(...b.members);
    for (const [k, w] of b.labels) a.labels.set(k, (a.labels.get(k) || 0) + w);
  };
  const centroid = (c) => normalize(c.sum);
  const shared = (a, b) => { // agreement on first-stage speakers, 0..1
    let s = 0;
    for (const [k, w] of a.labels) if (b.labels.has(k)) s += Math.min(w / a.w, b.labels.get(k) / b.w);
    return s;
  };
  const score = (a, ca, b, cb) => dot(ca, cb) + sameBonus * shared(a, b);
  const closest = (list) => {
    const cents = list.map(centroid);
    let bi = -1, bj = -1, best = -Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const s = score(list[i], cents[i], list[j], cents[j]);
      if (s > best) { best = s; bi = i; bj = j; }
    }
    return { bi, bj, best };
  };

  // Seed: consecutive pieces that are clearly the same voice start as one cluster (keeps the O(n³) part small).
  let C = [];
  for (const i of idx) {
    const c = make(i), last = C[C.length - 1];
    if (last && score(last, centroid(last), c, centroid(c)) >= threshold + 0.1) merge(last, c);
    else C.push(c);
  }
  for (;;) { // 1
    const { bi, bj, best } = closest(C);
    if (bi < 0 || best < threshold) break;
    merge(C[bi], C[bj]);
    C.splice(bj, 1);
  }
  const speech = C.reduce((a, c) => a + c.w, 0); // 2
  const isLarge = (c) => c.w >= Math.min(minClusterSec, 0.5 * speech) && c.w >= 0.02 * speech;
  if (C.some(isLarge)) {
    for (const c of C.filter((x) => !isLarge(x))) {
      const cc = centroid(c);
      const target = C.filter(isLarge).map((l) => [l, score(c, cc, l, centroid(l))]).sort((a, b) => b[1] - a[1])[0][0];
      merge(target, c);
      C.splice(C.indexOf(c), 1);
    }
  }
  while (numSpeakers > 0 && C.length > numSpeakers) { // 3
    const { bi, bj } = closest(C);
    merge(C[bi], C[bj]);
    C.splice(bj, 1);
  }

  const label = new Array(regions.length).fill(-1); // 4
  C.forEach((c, k) => { for (const i of c.members) label[i] = k; });
  const cents = C.map(centroid);
  for (let i = 0; i < regions.length; i++) {
    if (label[i] >= 0 || !unit[i]) continue;
    let bk = 0, bs = -Infinity;
    cents.forEach((c, k) => { const s = dot(unit[i], c) + sameBonus * ((C[k].labels.get(regions[i].speaker) || 0) / C[k].w); if (s > bs) { bs = s; bk = k; } });
    label[i] = bk;
  }
  const main = new Map(); // first-stage speaker → cluster holding most of its speech
  C.forEach((c, k) => { for (const [s, w] of c.labels) if (!main.has(s) || main.get(s).w < w) main.set(s, { w, k }); });
  for (let i = 0; i < regions.length; i++) {
    if (label[i] >= 0) continue;
    const r = regions[i];
    const gap = (j) => (j < i ? r.start - regions[j].end : regions[j].start - r.end);
    const near = [i - 1, i + 1].filter((j) => regions[j] && label[j] >= 0 && regions[j].speaker === r.speaker && gap(j) < 2).sort((a, b) => gap(a) - gap(b));
    label[i] = near.length ? label[near[0]] : main.has(r.speaker) ? main.get(r.speaker).k : 0;
  }
  return finishSegments(regions.map((r, i) => ({ start: r.start, end: r.end, g: label[i] })), { minSegSec, fillGapSec, minSpeakerSec });
}

/** Tidy segments keyed by `g`, fold speakers with < minSpeakerSec of speech into a neighbour, number S1…. */
function finishSegments(segs, { minSegSec, fillGapSec, minSpeakerSec }) {
  segs = tidySegments(segs, { minSegSec, fillGapSec });
  const talk = new Map();
  for (const s of segs) talk.set(s.g, (talk.get(s.g) || 0) + s.end - s.start);
  const rare = new Set([...talk].filter(([, v]) => v < minSpeakerSec).map(([g]) => g));
  if (rare.size && rare.size < talk.size) {
    const dist = (a, s) => Math.max(0, a.start > s.end ? a.start - s.end : s.start - a.end);
    segs = segs.map((s, i) => {
      if (!rare.has(s.g)) return s;
      const nb = [segs[i - 1], segs[i + 1]].filter((x) => x && !rare.has(x.g)).sort((a, b) => dist(a, s) - dist(b, s))[0];
      return nb ? { ...s, g: nb.g } : s;
    });
    segs = tidySegments(segs, { minSegSec: 0, fillGapSec });
  }
  return renumber(segs);
}

/** Merge adjacent same-speaker segments across gaps ≤ fillGapSec and absorb segments shorter than minSegSec. */
export function tidySegments(segs, { minSegSec = 0.25, fillGapSec = 0.5 } = {}) {
  const key = (s) => (s.g !== undefined ? s.g : s.speaker);
  const set = (s, v) => (s.g !== undefined ? { ...s, g: v } : { ...s, speaker: v });
  let out = segs.slice().sort((a, b) => a.start - b.start);
  // Short blips between neighbours take the neighbour's speaker (the longer neighbour if they differ).
  if (minSegSec > 0) {
    out = out.map((s, i) => {
      if (s.end - s.start >= minSegSec) return s;
      const a = out[i - 1], b = out[i + 1];
      const near = (x, side) => x && (side < 0 ? s.start - x.end : x.start - s.end) <= fillGapSec;
      const cands = [near(a, -1) && a, near(b, 1) && b].filter(Boolean);
      if (!cands.length) return s;
      const pick = cands.sort((x, y) => (y.end - y.start) - (x.end - x.start))[0];
      return set(s, key(pick));
    });
  }
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && key(last) === key(s) && s.start - last.end <= fillGapSec) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}
