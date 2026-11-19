// Beats, bars and sections of a music track (Auto edit, ticket AE-02). Pure: no DOM, no media decoding. The
// decode worker (app/js/beats-worker.js) turns a music file into 22.05 kHz mono and calls analyzeMusic().
// The macOS (Swift) and engine (Rust) ports re-implement this file against test/parity/beats.json, so every step
// below is deterministic and spelled out; floats agree within 1e-6.
//
// Public API
//   BEAT_RATE = 22050, HOP = 512, FRAME = 1024                    analysis constants (fps = 22050 / 512 ≈ 43.07)
//   analyzeMusic(samples, opts?) -> MusicAnalysis                 the whole pipeline (steps 1–7)
//   musicFeatures(samples, opts?) -> MusicFeatures                step 1: onset envelopes, loudness, brightness
//   analyzeFeatures(features, opts?) -> MusicAnalysis             steps 2–7 from features (what the parity fixture checks)
//   estimateTempo(env, fps, opts?) -> TempoEstimate               step 2: autocorrelation, 60–180 BPM, soft prior at 120
//   trackBeats(env, fps, period, opts?) -> number[]               step 3: Ellis (2007) dynamic-programming beat tracker
//   beatAccents(features, beats) -> number[]                      step 4a: low-band (kick) accent per beat
//   findDownbeats(beats, accent) -> { meter, phase, downbeats, score4, score3 }   step 4b: 4/4, or 3/4 if clearly better
//   findSections(features, downbeats, opts?) -> Section[]         step 5: bars -> smoothed loudness + novelty -> labels
//   bestWindow(analysis, length) -> { start, end, bars }           step 6: the loudest window of `length` s, on a bar
//   snapToBars(analysis, seconds) -> number                        a length rounded to whole bars
//   barLength(analysis) -> number                                  seconds per bar (median)
//   resample(mono, rate, outRate?) / createResampler(rate, outRate?) / mixToMono(channels)   decode helpers
//
// Types
//   MusicFeatures = { rate, fps, frames, duration, flux: number[], env: number[], low: number[], rms: number[], centroid: number[] }
//     flux: spectral flux per frame; env: flux minus its local mean, rectified, divided by its standard deviation;
//     low: the same flux restricted to bins below 250 Hz (kick drums), divided by its max; rms: frame RMS;
//     centroid: spectral centroid / Nyquist (0..1).
//   TempoEstimate = { bpm, period (frames, fractional), lag (integer frames), ratio (peak/median), clarity, confidence (0..1) }
//   Section = { start, end, label: 'intro'|'verse'|'chorus'|'outro', energy (0..1) }
//   MusicAnalysis = {
//     duration, bpm, confidence (0..1, pulse clarity), ratio (the spec's peak/median, informational),
//     clearBeat (confidence ≥ NO_BEAT; false = "No clear beat": beats is empty, cut on onsets, offer Set BPM…),
//     meter (4 | 3), beats: number[] (s), downbeats: number[] (s), onsets: number[] (s), sections: Section[],
//     energy: { fps: 2, values: number[] }   smoothed loudness 0..1 at 2 Hz, for bestWindow and the solver's energy fit
//   }
//
// Determinism rules the ports must follow: argmax scans go in increasing index order and only replace the best on
// `value > best + EPS` (EPS = 1e-9), so ties go to the earliest index; Math.round is only applied to non-negative
// numbers (round half up); medians/percentiles use the sorted copy and the index rule given at each call.

export const BEAT_RATE = 22050;
export const HOP = 512;
export const FRAME = 1024;
export const EPS = 1e-9;

const LOG_GAMMA = 10;          // log compression: log(1 + 10·|X|)
const LOW_HZ = 250;            // the "low" envelope: bins up to 250 Hz
const LOCAL_MEAN = 8;          // frames either side for the onset envelope's local mean (~0.19 s)
export const TEMPO_MIN = 60;
export const TEMPO_MAX = 180;
export const TEMPO_PRIOR = 120;
export const TEMPO_PRIOR_OCTAVES = 1;
export const TIGHTNESS = 100;  // Ellis's transition weight (librosa's default)
export const NO_BEAT = 0.4;    // tempo confidence below this: "No clear beat"
const ENERGY_FPS = 2;

// ---- small numeric helpers ------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sortedCopy(arr) {
  return Array.from(arr).sort((a, b) => a - b);
}

/** Median: mean of the two middle values for even lengths. */
export function median(arr) {
  if (!arr.length) return 0;
  const s = sortedCopy(arr);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr, a = 0, b = arr.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += arr[i];
  return b > a ? s / (b - a) : 0;
}

function std(arr) {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
  return arr.length ? Math.sqrt(s / arr.length) : 0;
}

/** Parabolic peak offset in (-0.5, 0.5) for three samples around a maximum at the middle one. */
function parabolic(a, b, c) {
  const d = a - 2 * b + c;
  if (!(Math.abs(d) > EPS)) return 0;
  return clamp(0.5 * (a - c) / d, -0.5, 0.5);
}

// ---- decode helpers -------------------------------------------------------------------------------

/** Average of the channels (Float32Array[]) into one Float32Array. */
export function mixToMono(channels) {
  if (!channels || !channels.length) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < channels.length; c++) v += channels[c][i];
    out[i] = v / channels.length;
  }
  return out;
}

/**
 * Streaming resampler with a triangular (linear) filter: output sample i sits at input position c = i·rate/outRate
 * and is Σ w·x[j] / Σ w over input j with w = max(0, 1 − |j − c| / h), h = max(1, rate/outRate). For upsampling this
 * is linear interpolation; for downsampling it low-passes enough for beat tracking.
 * Returns { push(Float32Array) -> Float32Array, flush() -> Float32Array }.
 */
export function createResampler(rate, outRate = BEAT_RATE) {
  const r = rate / outRate;
  const h = Math.max(1, r);
  let buf = new Float32Array(0); // input samples from absolute index `base`
  let base = 0;
  let total = 0;                  // input samples seen
  let i = 0;                      // next output index
  const emit = (final) => {
    const out = [];
    for (;;) {
      const c = i * r;
      const hi = Math.ceil(c + h) - 1;     // last input index with w > 0 (j < c + h)
      if (!final && hi >= total) break;
      if (final && c >= total) break;
      const lo = Math.max(0, Math.floor(c - h) + 1);
      let s = 0, ws = 0;
      for (let j = lo; j <= Math.min(hi, total - 1); j++) {
        const w = 1 - Math.abs(j - c) / h;
        if (w <= 0) continue;
        s += w * buf[j - base];
        ws += w;
      }
      out.push(ws > 0 ? s / ws : 0);
      i++;
    }
    // Drop input no future output needs.
    const keepFrom = Math.max(0, Math.floor(i * r - h) + 1);
    if (keepFrom > base) {
      buf = buf.slice(Math.min(buf.length, keepFrom - base));
      base = keepFrom;
    }
    return Float32Array.from(out);
  };
  return {
    push(chunk) {
      const next = new Float32Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
      total += chunk.length;
      return emit(false);
    },
    flush() { return emit(true); },
  };
}

/** Resample a mono signal (see createResampler). Output length = ceil(n · outRate / rate). */
export function resample(mono, rate, outRate = BEAT_RATE) {
  if (rate === outRate) return Float32Array.from(mono);
  const rs = createResampler(rate, outRate);
  const a = rs.push(mono instanceof Float32Array ? mono : Float32Array.from(mono));
  const b = rs.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---- FFT ------------------------------------------------------------------------------------------

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, y = 0;
    for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; }
    rev[i] = y;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / n); sin[k] = -Math.sin((2 * Math.PI * k) / n); }
  const hann = new Float64Array(n);
  for (let k = 0; k < n; k++) hann[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / n); // periodic Hann
  t = { rev, cos, sin, hann };
  fftCache.set(n, t);
  return t;
}

/** In-place radix-2 complex FFT (forward, no scaling). */
function fft(re, im, tables) {
  const n = re.length;
  const { rev, cos, sin } = tables;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// ---- step 1: features -----------------------------------------------------------------------------

/**
 * Onset envelopes and loudness of 22.05 kHz mono samples (Float32Array or number[]).
 * Frame n is centred on sample n·HOP (zero padding outside the signal), frames = floor(len / HOP) + 1, and covers
 * FRAME samples under a periodic Hann window. Per frame: X = |FFT|, L[k] = log(1 + 10·X[k]) for k = 1..FRAME/2;
 * flux[n] = Σ_k max(0, L_n[k] − L_{n−1}[k]) (flux[0] = 0); low[n] the same over k ≤ floor(250·FRAME/rate);
 * rms[n] = sqrt(mean(x²)) over the frame's FRAME samples (unwindowed); centroid[n] = Σ k·X / Σ X / (FRAME/2).
 * env[n] = max(0, flux[n] − mean(flux[n−8..n+8] within range)), then divided by its standard deviation;
 * low is divided by its maximum.
 */
export function musicFeatures(samples, { rate = BEAT_RATE } = {}) {
  const n = samples.length;
  const frames = Math.floor(n / HOP) + 1;
  const tables = fftTables(FRAME);
  const half = FRAME / 2;
  const lowBins = Math.floor((LOW_HZ * FRAME) / rate);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let prev = new Float64Array(half + 1), cur = new Float64Array(half + 1);
  const flux = new Array(frames).fill(0), lowRaw = new Array(frames).fill(0);
  const rms = new Array(frames).fill(0), centroid = new Array(frames).fill(0);
  for (let f = 0; f < frames; f++) {
    const s0 = f * HOP - half;
    let e2 = 0;
    for (let k = 0; k < FRAME; k++) {
      const j = s0 + k;
      const x = j >= 0 && j < n ? samples[j] : 0;
      e2 += x * x;
      re[k] = x * tables.hann[k];
      im[k] = 0;
    }
    rms[f] = Math.sqrt(e2 / FRAME);
    fft(re, im, tables);
    let fl = 0, lo = 0, wsum = 0, msum = 0;
    for (let k = 1; k <= half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const L = Math.log(1 + LOG_GAMMA * mag);
      cur[k] = L;
      wsum += k * mag; msum += mag;
      if (f > 0) {
        const d = L - prev[k];
        if (d > 0) { fl += d; if (k <= lowBins) lo += d; }
      }
    }
    flux[f] = fl;
    lowRaw[f] = lo;
    centroid[f] = msum > EPS ? wsum / msum / half : 0;
    const t = prev; prev = cur; cur = t;
  }
  // Onset envelope: flux above its local mean, normalised by the standard deviation.
  const env = new Array(frames).fill(0);
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) pre[i + 1] = pre[i] + flux[i];
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - LOCAL_MEAN), b = Math.min(frames, i + LOCAL_MEAN + 1);
    env[i] = Math.max(0, flux[i] - (pre[b] - pre[a]) / (b - a));
  }
  const sd = std(env);
  if (sd > EPS) for (let i = 0; i < frames; i++) env[i] /= sd;
  return { rate, fps: rate / HOP, frames, duration: n / rate, flux, env, low: normMax(lowRaw), rms, centroid };
}

/** Values divided by their maximum (all zeros stay zero). */
function normMax(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return Array.from(arr, (v) => (m > EPS ? v / m : 0));
}

// ---- step 2: tempo --------------------------------------------------------------------------------

/** env smoothed with a Gaussian of σ = 1 frame (weights exp(−½j²), j = −3..3, divided by their sum; zero outside). */
export function smoothEnvelope(env) {
  const k = [];
  let ks = 0;
  for (let j = -3; j <= 3; j++) { const w = Math.exp(-0.5 * j * j); k.push(w); ks += w; }
  const out = new Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) { const q = i + j; if (q >= 0 && q < env.length) s += env[q] * k[j + 3]; }
    out[i] = s / ks;
  }
  return out;
}

/**
 * Tempo by autocorrelation of the onset envelope. e = smoothEnvelope(env); c = e − mean(e).
 * rc(L) = Σ c[i]·c[i+L] / (N − L) for integer lags L = floor(60·fps/max) .. ceil(60·fps/min), weighted by a log-normal
 * prior w(L) = exp(−½·(log2(bpm(L)/prior)/octaves)²). The best weighted lag is refined with a parabola through its
 * neighbours' weighted scores to a fractional period.
 * clarity = rc(best) / rc(0) (pulse clarity: 1 for a perfectly steady pulse, near 0 for free time);
 * confidence = clamp((clarity − 0.25) / 0.5, 0, 1); "No clear beat" when confidence < NO_BEAT (0.4).
 * ratio = the spec's peak-to-median ratio, r(best)/median(r) with r on e (not mean-removed); reported only, because on
 * a sparse onset envelope the median is near zero and the ratio doesn't separate steady from free time.
 */
export function estimateTempo(env, fps, { min = TEMPO_MIN, max = TEMPO_MAX, prior = TEMPO_PRIOR, octaves = TEMPO_PRIOR_OCTAVES } = {}) {
  const N = env.length;
  const lagMin = Math.max(1, Math.floor((60 * fps) / max));
  const lagMax = Math.min(N - 2, Math.ceil((60 * fps) / min));
  const none = { bpm: prior, period: (60 * fps) / prior, lag: Math.round((60 * fps) / prior), ratio: 1, clarity: 0, confidence: 0 };
  if (lagMax <= lagMin + 1) return none;
  const e = smoothEnvelope(env);
  const m = mean(e);
  const c = e.map((v) => v - m);
  const ac = (x, L) => { let s = 0; for (let i = 0; i + L < N; i++) s += x[i] * x[i + L]; return s / (N - L); };
  const c0 = ac(c, 0);
  if (!(c0 > EPS)) return none;
  const r = [], rc = [], w = [];
  for (let L = lagMin; L <= lagMax; L++) {
    rc.push(ac(c, L));
    r.push(ac(e, L));
    const o = Math.log2((60 * fps) / L / prior) / octaves;
    w.push(Math.exp(-0.5 * o * o));
  }
  const sc = (k) => rc[k] * w[k];
  let best = 0;
  for (let k = 1; k < rc.length; k++) if (sc(k) > sc(best) + EPS) best = k;
  const off = best > 0 && best < rc.length - 1 ? parabolic(sc(best - 1), sc(best), sc(best + 1)) : 0;
  const period = lagMin + best + off;
  const med = median(r);
  const ratio = med > EPS ? r[best] / med : 1;
  const clarity = Math.max(0, rc[best] / c0);
  return { bpm: (60 * fps) / period, period, lag: lagMin + best, ratio, clarity, confidence: clamp((clarity - 0.25) / 0.5, 0, 1) };
}

// ---- step 3: beats --------------------------------------------------------------------------------

/**
 * Ellis (2007) beat tracking by dynamic programming, as librosa implements it.
 * localscore = env convolved with exp(−½·(j·32/period)²), j = −round(period)..round(period) ("same" alignment).
 * cumscore[i] = localscore[i] + max over prev in [i − round(2·period), i − round(period/2)] of
 *   cumscore[prev] − tightness·(log(i − prev) − log(period))²  (scanned from the latest prev backwards, strict >).
 * Frames before the first frame whose localscore reaches 1 % of the maximum don't link back. The last beat is the
 * last local maximum of cumscore that reaches half the median of all its local maxima; then backtrack. Weak beats
 * at either end (localscore under half the RMS of the 5-frame-Hann-smoothed localscore) are trimmed.
 * Each beat is then refined to the onset peak within ±1 frame (parabolic). Returns beat times in seconds.
 */
export function trackBeats(env, fps, period, { tightness = TIGHTNESS } = {}) {
  const N = env.length;
  if (!(period > 1) || N < 3) return [];
  const R = Math.round(period);
  const kernel = [];
  for (let j = -R; j <= R; j++) kernel.push(Math.exp(-0.5 * Math.pow((j * 32) / period, 2)));
  const local = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = -R; j <= R; j++) { const k = i + j; if (k >= 0 && k < N) s += env[k] * kernel[j + R]; }
    local[i] = s;
  }
  let lmax = 0;
  for (let i = 0; i < N; i++) if (local[i] > lmax) lmax = local[i];
  const thresh = 0.01 * lmax;
  const cum = new Float64Array(N);
  const back = new Int32Array(N).fill(-1);
  const near = Math.round(period / 2), far = Math.round(2 * period);
  const logP = Math.log(period);
  let first = true;
  for (let i = 0; i < N; i++) {
    let bestScore = -Infinity, bestLoc = -1;
    for (let loc = i - near; loc >= i - far && loc >= 0; loc--) {
      const d = Math.log(i - loc) - logP;
      const s = cum[loc] - tightness * d * d;
      if (s > bestScore) { bestScore = s; bestLoc = loc; }
    }
    cum[i] = bestLoc >= 0 ? local[i] + bestScore : local[i];
    if (first && local[i] < thresh) back[i] = -1;
    else { back[i] = bestLoc; first = false; }
  }
  // Last beat: the last local maximum of cumscore that is at least half the median local maximum.
  const peaks = [];
  for (let i = 1; i < N - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) peaks.push(i);
  if (!peaks.length) return [];
  const medPeak = median(peaks.map((i) => cum[i]));
  let last = peaks[0];
  for (const i of peaks) if (cum[i] >= 0.5 * medPeak) last = i;
  const idx = [];
  for (let i = last; i >= 0; i = back[i]) { idx.push(i); if (back[i] >= i) break; }
  idx.reverse();
  // Trim weak beats at both ends.
  const hann5 = [0.25, 0.75, 1, 0.75, 0.25]; // np.hanning(7)[1:-1] normalised shape, symmetric
  const sm = idx.map((b) => {
    let s = 0;
    for (let j = -2; j <= 2; j++) { const k = b + j; if (k >= 0 && k < N) s += local[k] * hann5[j + 2]; }
    return s;
  });
  const rmsSm = Math.sqrt(mean(sm.map((v) => v * v)));
  const cut = 0.5 * rmsSm;
  let a = 0, b = idx.length;
  while (a < b && sm[a] <= cut) a++;
  while (b > a && sm[b - 1] <= cut) b--;
  const kept = idx.slice(a, b);
  // Refine to the onset peak within ±1 frame.
  return kept.map((f) => {
    let m = f;
    if (f > 0 && env[f - 1] > env[m] + EPS) m = f - 1;
    if (f + 1 < N && env[f + 1] > env[m] + EPS) m = f + 1;
    const off = m > 0 && m < N - 1 && env[m] >= env[m - 1] && env[m] >= env[m + 1] ? parabolic(env[m - 1], env[m], env[m + 1]) : 0;
    return (m + off) / fps;
  });
}

// ---- step 4: downbeats ----------------------------------------------------------------------------

/**
 * Downbeats from accent periodicity. accent[k] is the accent of beat k (see analyzeFeatures: low envelope + half the
 * full envelope, max within ±1 frame of the beat). For meter m ∈ {4, 3} and phase p < m:
 *   score(m, p) = mean(accent[k] : k ≡ p mod m) − mean(accent[k] : k ≢ p mod m).
 * 4/4 unless 3/4's best score is clearly better: score3 > 1.25·score4 + 0.05. Ties go to the lower phase.
 */
export function findDownbeats(beats, accent) {
  const n = beats.length;
  const bestFor = (m) => {
    let best = { phase: 0, score: -Infinity };
    for (let p = 0; p < m; p++) {
      let on = 0, cOn = 0, off = 0, cOff = 0;
      for (let k = 0; k < n; k++) { if (k % m === p) { on += accent[k]; cOn++; } else { off += accent[k]; cOff++; } }
      const s = (cOn ? on / cOn : 0) - (cOff ? off / cOff : 0);
      if (s > best.score + EPS) best = { phase: p, score: s };
    }
    return best;
  };
  if (n < 2) return { meter: 4, phase: 0, downbeats: beats.slice(0, 1), score4: 0, score3: 0 };
  const b4 = bestFor(4), b3 = bestFor(3);
  const three = b3.score > 1.25 * b4.score + 0.05;
  const meter = three ? 3 : 4;
  const phase = three ? b3.phase : b4.phase;
  const downbeats = beats.filter((_, k) => k % meter === phase);
  return { meter, phase, downbeats, score4: b4.score, score3: b3.score };
}

/**
 * Accent of each beat for findDownbeats: the low-band (kick) onset strength max low[f−1..f+1] with f = round(t·fps),
 * divided by its maximum over the beats. (Full-band onsets and spectral change were tried and follow the snare.)
 */
export function beatAccents(features, beats) {
  const { low, fps } = features;
  const N = low.length;
  return normMax(beats.map((t) => {
    const f = Math.round(t * fps);
    let m = 0;
    for (let j = Math.max(0, f - 1); j <= Math.min(N - 1, f + 1); j++) if (low[j] > m) m = low[j];
    return m;
  }));
}

// ---- step 5: sections -----------------------------------------------------------------------------

/** Loudness per frame in dB, smoothed over ±1 s, normalised to 0..1 over the track. */
function loudnessCurve(features) {
  const { rms, fps } = features;
  const db = rms.map((v) => 20 * Math.log10(v + 1e-5));
  const W = Math.max(1, Math.round(fps));
  const pre = new Float64Array(db.length + 1);
  for (let i = 0; i < db.length; i++) pre[i + 1] = pre[i] + db[i];
  const sm = db.map((_, i) => { const a = Math.max(0, i - W), b = Math.min(db.length, i + W + 1); return (pre[b] - pre[a]) / (b - a); });
  let lo = Infinity, hi = -Infinity;
  for (const v of sm) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return sm.map((v) => (hi - lo > EPS ? (v - lo) / (hi - lo) : 0));
}

/**
 * Sections from bar features. Bars run from each downbeat to the next (the first from 0, the last to the end); with no
 * downbeats, 4-second blocks. Per bar: loudness (mean of the smoothed 0..1 loudness), onset density (mean env,
 * divided by the max over bars), brightness (mean centroid, divided by the max over bars).
 * Novelty at the start of bar j (j ≥ 1) = Euclidean distance between the mean feature vectors of bars [j−4, j) and
 * [j, j+4) (clipped to the track). Boundaries: bars whose novelty is a local maximum (≥ both neighbours) and at least
 * mean + 0.5·std of all novelties, taken greedily by height (ties: earlier) when ≥ 4 bars from every boundary taken.
 * Section energy = 0.7·loudness + 0.3·density (means over its bars). Labels: the first section is 'intro' and the last
 * 'outro' when there are ≥ 3 sections and their energy is below the median section energy; the others are 'chorus'
 * when their energy exceeds the mean of the middle sections by 0.05, else 'verse'.
 */
export function findSections(features, downbeats, { blockSec = 4, minBars = 4 } = {}) {
  const { fps, duration } = features;
  const frames = features.env.length;
  const loud = loudnessCurve(features);
  let edges = downbeats.filter((t) => t > 0.05 && t < duration - 0.05);
  if (!edges.length) { edges = []; for (let t = blockSec; t < duration - 0.05; t += blockSec) edges.push(t); }
  const bounds = [0, ...edges, duration];
  const bars = [];
  for (let j = 0; j + 1 < bounds.length; j++) {
    const a = Math.min(frames - 1, Math.round(bounds[j] * fps)), b = Math.max(a + 1, Math.min(frames, Math.round(bounds[j + 1] * fps)));
    bars.push({ start: bounds[j], end: bounds[j + 1], loud: mean(loud, a, b), dens: mean(features.env, a, b), bright: mean(features.centroid, a, b) });
  }
  if (!bars.length) return [{ start: 0, end: duration, label: 'verse', energy: 0 }];
  const dmax = Math.max(EPS, ...bars.map((b) => b.dens)), bmax = Math.max(EPS, ...bars.map((b) => b.bright));
  const feat = bars.map((b) => [b.loud, b.dens / dmax, b.bright / bmax]);
  const meanVec = (a, b) => { const v = [0, 0, 0]; for (let j = a; j < b; j++) for (let d = 0; d < 3; d++) v[d] += feat[j][d] / (b - a); return v; };
  const nov = bars.map((_, j) => {
    if (j === 0) return 0;
    const L = meanVec(Math.max(0, j - minBars), j), R = meanVec(j, Math.min(bars.length, j + minBars));
    return Math.sqrt((L[0] - R[0]) ** 2 + (L[1] - R[1]) ** 2 + (L[2] - R[2]) ** 2);
  });
  const nm = mean(nov.slice(1)), ns = std(nov.slice(1));
  const cands = [];
  for (let j = 1; j < bars.length; j++) {
    if (nov[j] >= nov[j - 1] && (j + 1 >= bars.length || nov[j] >= nov[j + 1]) && nov[j] >= nm + 0.5 * ns && nov[j] > EPS) cands.push(j);
  }
  cands.sort((x, y) => nov[y] - nov[x] || x - y);
  const cuts = [];
  for (const j of cands) {
    if (j < minBars || bars.length - j < minBars) continue;
    if (cuts.every((c) => Math.abs(c - j) >= minBars)) cuts.push(j);
  }
  cuts.sort((x, y) => x - y);
  const parts = [0, ...cuts, bars.length];
  const secs = [];
  for (let s = 0; s + 1 < parts.length; s++) {
    const a = parts[s], b = parts[s + 1];
    const loudM = mean(feat.map((f) => f[0]), a, b), densM = mean(feat.map((f) => f[1]), a, b);
    secs.push({ start: bars[a].start, end: bars[b - 1].end, label: 'verse', energy: clamp(0.7 * loudM + 0.3 * densM, 0, 1) });
  }
  if (secs.length >= 3) {
    const med = median(secs.map((s) => s.energy));
    if (secs[0].energy < med) secs[0].label = 'intro';
    if (secs[secs.length - 1].energy < med) secs[secs.length - 1].label = 'outro';
  }
  const middle = secs.filter((s) => s.label === 'verse');
  const mm = mean(middle.map((s) => s.energy));
  for (const s of middle) if (s.energy > mm + 0.05) s.label = 'chorus';
  return secs;
}

// ---- steps 6–7: windows, analysis -----------------------------------------------------------------

/** Seconds per bar: the median downbeat spacing, else meter × the median beat spacing, else 2 s. */
export function barLength(analysis) {
  const d = analysis.downbeats || [];
  if (d.length >= 2) return median(d.slice(1).map((t, i) => t - d[i]));
  const b = analysis.beats || [];
  if (b.length >= 2) return (analysis.meter || 4) * median(b.slice(1).map((t, i) => t - b[i]));
  return 2;
}

/** A length rounded to whole bars (at least one). Without a clear beat, unchanged. */
export function snapToBars(analysis, seconds) {
  if (!analysis || !analysis.clearBeat) return seconds;
  const bar = barLength(analysis);
  return Math.max(1, Math.round(seconds / bar)) * bar;
}

/**
 * The best window of `length` seconds: it starts on a downbeat d_j and ends nBars = max(1, round(length / bar)) bars
 * later (on downbeat d_{j+nBars}, or d_j + nBars·bar past the last downbeat), within the track; score = mean of
 * analysis.energy over the window (2 Hz samples whose time falls in [start, end)); the highest score wins, ties to the
 * earliest. `length` ≥ duration (or Infinity, "Whole song") gives the first downbeat to the last beat. Without a clear
 * beat, starts every 0.5 s and the length is unchanged. Returns { start, end, bars } (bars = 0 without a clear beat).
 */
export function bestWindow(analysis, length) {
  const dur = analysis.duration;
  const energy = analysis.energy || { fps: ENERGY_FPS, values: [] };
  const score = (a, b) => {
    const i0 = Math.max(0, Math.ceil(a * energy.fps - EPS)), i1 = Math.min(energy.values.length, Math.ceil(b * energy.fps - EPS));
    return i1 > i0 ? mean(energy.values, i0, i1) : 0;
  };
  if (!analysis.clearBeat || !(analysis.downbeats || []).length) {
    const L = Math.min(length, dur);
    let best = { start: 0, end: L, bars: 0 }, bestS = -Infinity;
    for (let s = 0; s + L <= dur + EPS; s += 0.5) {
      const v = score(s, s + L);
      if (v > bestS + EPS) { bestS = v; best = { start: s, end: s + L, bars: 0 }; }
    }
    return best;
  }
  const d = analysis.downbeats;
  const beats = analysis.beats;
  const bar = barLength(analysis);
  if (!(length < dur)) {
    const end = beats[beats.length - 1];
    return { start: d[0], end, bars: Math.max(1, Math.round((end - d[0]) / bar)) };
  }
  const nBars = Math.max(1, Math.round(length / bar));
  let best = null, bestS = -Infinity;
  for (let j = 0; j < d.length; j++) {
    const end = j + nBars < d.length ? d[j + nBars] : d[d.length - 1] + (j + nBars - (d.length - 1)) * bar;
    if (end > dur + EPS) break;
    const v = score(d[j], end);
    if (v > bestS + EPS) { bestS = v; best = { start: d[j], end, bars: nBars }; }
  }
  if (!best) return { start: d[0], end: Math.min(dur, d[0] + nBars * bar), bars: nBars };
  return best;
}

/** Onset times: local maxima of env over ±3 frames above mean + 0.5·std, at least 0.1 s apart (earliest wins). */
function pickOnsets(env, fps) {
  const m = mean(env), s = std(env);
  const thr = m + 0.5 * s;
  const out = [];
  const gap = Math.round(0.1 * fps);
  let last = -Infinity;
  for (let i = 0; i < env.length; i++) {
    if (env[i] < thr || env[i] <= EPS) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(env.length - 1, i + 3) && isMax; j++) if (j !== i && (env[j] > env[i] || (env[j] === env[i] && j < i))) isMax = false;
    if (!isMax || i - last < gap) continue;
    out.push(i / fps);
    last = i;
  }
  return out;
}

/** Smoothed loudness 0..1 sampled at 2 Hz: sample i is the mean of the loudness curve over frames in [i/2, (i+1)/2) s. */
function energyCurve(features) {
  const loud = loudnessCurve(features);
  const n = Math.max(1, Math.ceil(features.duration * ENERGY_FPS));
  const values = [];
  for (let i = 0; i < n; i++) {
    const a = Math.min(loud.length - 1, Math.floor((i / ENERGY_FPS) * features.fps)), b = Math.max(a + 1, Math.min(loud.length, Math.floor(((i + 1) / ENERGY_FPS) * features.fps)));
    values.push(mean(loud, a, b));
  }
  return { fps: ENERGY_FPS, values };
}

/**
 * Steps 2–7 from features: tempo (or `bpm` when the user set one), beats, downbeats, sections, onsets, energy and
 * confidence. Beat times are rounded to 1e-6 s. opts: { bpm?: number, tightness?: number }.
 */
export function analyzeFeatures(features, { bpm = null, tightness = TIGHTNESS } = {}) {
  const { env, low, fps, duration } = features;
  const tempo = estimateTempo(env, fps);
  const forced = Number.isFinite(bpm) && bpm > 0;
  const period = forced ? (60 * fps) / bpm : tempo.period;
  const clearBeat = forced || tempo.confidence >= NO_BEAT;
  const raw = trackBeats(env, fps, period, { tightness });
  const beats = raw.map((t) => Math.round(t * 1e6) / 1e6);
  // Tempo from the tracked beats: least-squares slope of beat time against beat index.
  let est = (60 * fps) / period;
  if (beats.length >= 4) {
    const n = beats.length;
    const mx = (n - 1) / 2, my = mean(beats);
    let sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { sxy += (k - mx) * (beats[k] - my); sxx += (k - mx) * (k - mx); }
    if (sxx > 0 && sxy > 0) est = 60 / (sxy / sxx);
  }
  const accent = beatAccents(features, beats);
  const db = clearBeat ? findDownbeats(beats, accent) : { meter: 4, phase: 0, downbeats: [] };
  const sections = findSections(features, db.downbeats);
  return {
    duration,
    bpm: Math.round((forced ? bpm : est) * 1000) / 1000,
    confidence: forced ? 1 : tempo.confidence,
    ratio: tempo.ratio,
    clearBeat,
    meter: db.meter,
    beats: clearBeat ? beats : [],
    downbeats: db.downbeats,
    onsets: pickOnsets(env, fps).map((t) => Math.round(t * 1e6) / 1e6),
    sections,
    energy: energyCurve(features),
  };
}

/**
 * Analyse a music track. samples: mono Float32Array (or number[]) at `rate` (resampled to 22.05 kHz when different).
 * opts: { rate = 22050, bpm?: number } — `bpm` forces the tempo (the "Set BPM…" fix for "No clear beat").
 */
export function analyzeMusic(samples, { rate = BEAT_RATE, bpm = null } = {}) {
  const mono = rate === BEAT_RATE ? samples : resample(samples, rate, BEAT_RATE);
  return analyzeFeatures(musicFeatures(mono, { rate: BEAT_RATE }), { bpm });
}
