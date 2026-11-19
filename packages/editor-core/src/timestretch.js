// Pitch-preserving time-stretch (WSOLA) for the web exporter's multi-clip sound. Segments play at 0.88–1.12× (Auto
// edit's motion ramps). The Mac app (AVAudioTimePitch) and the engine (atempo) keep the pitch, so the web keeps it
// too, instead of resampling. Pure JS, no DOM: sound is one Float32Array per channel.
//
// WSOLA: 30 ms Hann frames are overlap-added at a fixed output hop (half a frame) and read from the input at
// `rate` times that hop. Each frame may start up to ±10 ms from its nominal position, wherever it best continues the
// previous frame (normalised cross-correlation on a mono mix). Its waveform lines up, so the pitch stays and the
// joins don't phase or click.

/**
 * Play `channels` `rate` times faster (rate > 1 shortens) at the same pitch.
 * channels: Float32Array per channel, all the same length. Returns new Float32Arrays of length round(n / rate).
 * opts: { sampleRate = 48000, frameMs = 30, seekMs = 10 }.
 */
export function timeStretch(channels, rate, { sampleRate = 48000, frameMs = 30, seekMs = 10 } = {}) {
  const list = Array.isArray(channels) ? channels : [channels];
  const n = list[0]?.length || 0;
  if (!(rate > 0) || !Number.isFinite(rate)) throw new RangeError('timeStretch: rate must be a positive number');
  const outLen = Math.round(n / rate);
  if (!n) return list.map(() => new Float32Array(0));
  if (Math.abs(rate - 1) < 1e-6) return list.map((c) => Float32Array.from(c));
  const Hs = Math.max(8, Math.round((sampleRate * frameMs) / 2000)); // output hop = half a frame
  const N = 2 * Hs;
  const Ha = Hs * rate; // input hop
  const delta = Math.max(1, Math.round((sampleRate * seekMs) / 1000));
  // Periodic Hann: two copies half a frame apart sum to exactly 1. The first frame keeps its left half flat.
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const first = Float32Array.from(win, (w, i) => (i < Hs ? 1 : w));
  const mono = mixdown(list, n);
  const out = list.map(() => new Float32Array(outLen + N));
  let prev = 0;
  for (let k = 0, o = 0; o < outLen; k++, o += Hs) {
    const nominal = Math.round(k * Ha);
    const sel = k === 0 ? 0 : bestStart(mono, prev + Hs, nominal, delta, Hs);
    const w = k === 0 ? first : win;
    for (let c = 0; c < list.length; c++) {
      const src = list[c], dst = out[c];
      const i0 = Math.max(0, -sel), i1 = Math.min(N, n - sel);
      for (let i = i0; i < i1; i++) dst[o + i] += src[sel + i] * w[i];
    }
    prev = sel;
  }
  return out.map((c) => c.slice(0, outLen));
}

function mixdown(list, n) {
  if (list.length === 1) return list[0];
  const m = new Float32Array(n);
  for (const c of list) for (let i = 0; i < n; i++) m[i] += c[i];
  return m;
}

/**
 * Where a frame should start near `nominal` (±delta) so its first `len` samples best match mono[target, target+len):
 * the natural continuation of the previous frame. Coarse search (every 4th lag, every 2nd sample), then refined.
 */
function bestStart(mono, target, nominal, delta, len) {
  const n = mono.length;
  const L = Math.min(len, n - target);
  if (L < 8) return Math.max(0, Math.min(n - 1, nominal));
  const lo = Math.max(0, nominal - delta), hi = Math.min(n - L, nominal + delta);
  if (hi < lo) return Math.max(0, Math.min(n - 1, nominal));
  const score = (cand, step) => {
    let xy = 0, yy = 0;
    for (let i = 0; i < L; i += step) { const y = mono[cand + i]; xy += mono[target + i] * y; yy += y * y; }
    return yy > 1e-12 ? xy / Math.sqrt(yy) : 0;
  };
  // Ties (silence) keep the nominal start, so quiet stretches don't wander.
  let best = Math.max(lo, Math.min(hi, nominal)), bestScore = score(best, 2);
  for (let c = lo; c <= hi; c += 4) { const s = score(c, 2); if (s > bestScore) { bestScore = s; best = c; } }
  const c0 = Math.max(lo, best - 3), c1 = Math.min(hi, best + 3);
  bestScore = score(best, 1);
  for (let c = c0; c <= c1; c++) { const s = score(c, 1); if (s > bestScore) { bestScore = s; best = c; } }
  return best;
}
