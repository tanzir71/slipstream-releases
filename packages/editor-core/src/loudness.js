// Loudness (tickets M-01 / T-01, the "loudness to −14 LUFS" half of Studio Sound): ITU-R BS.1770-4 /
// EBU R128 integrated loudness with K-weighting, 400 ms blocks (75 % overlap), absolute gate −70 LUFS and
// relative gate −10 LU, plus sample peak and the gain needed to hit a target without clipping.
// Pure: Float32Array in, numbers out. Ported 1:1 to Rust (crates/slipstream-core) and Swift (swift/SlipstreamKit);
// the parity fixtures in test/parity keep the three implementations identical.

/** K-weighting biquads (pre-filter shelf + RLB high-pass) for a sample rate, as in BS.1770 / libebur128. */
export function kWeightingCoefficients(rate) {
  // Stage 1: high shelf (+4 dB above ~1.5 kHz)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  // Stage 2: high-pass (RLB curve, ~38 Hz)
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const highpass = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  return [shelf, highpass];
}

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const toLufs = (meanSquare) => -0.691 + 10 * Math.log10(meanSquare);

/**
 * Integrated loudness of one or more channels (arrays of Float32Array, same length) at `rate`.
 * Returns { lufs, blocks, gatedBlocks, samplePeak (linear), samplePeakDb } — lufs is -Infinity for silence.
 */
export function integratedLoudness(channels, rate) {
  const chans = Array.isArray(channels) ? channels : [channels];
  const n = chans[0]?.length || 0;
  const block = Math.round(0.4 * rate), hop = Math.round(0.1 * rate);
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > peak) peak = a; }
  if (n < block) return { lufs: -Infinity, blocks: 0, gatedBlocks: 0, samplePeak: peak, samplePeakDb: 20 * Math.log10(peak || 1e-12) };
  const [s1, s2] = kWeightingCoefficients(rate);
  const filtered = chans.map((c) => biquad(biquad(c, s1), s2));
  // mean square per block, summed over channels (weights 1.0 for L, R, C and mono)
  const ms = [];
  for (let start = 0; start + block <= n; start += hop) {
    let z = 0;
    for (const f of filtered) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += f[i] * f[i];
      z += s / block;
    }
    ms.push(z);
  }
  const abs = ms.filter((z) => z > 0 && toLufs(z) > -70);
  if (!abs.length) return { lufs: -Infinity, blocks: ms.length, gatedBlocks: 0, samplePeak: peak, samplePeakDb: 20 * Math.log10(peak || 1e-12) };
  const relGate = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => toLufs(z) > relGate);
  const lufs = toLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  return { lufs, blocks: ms.length, gatedBlocks: gated.length, samplePeak: peak, samplePeakDb: 20 * Math.log10(peak || 1e-12) };
}

/**
 * Gain (dB) that brings `measured` to `target` LUFS while keeping the sample peak at or below `ceiling` dBFS
 * (−1.5 by default, the streaming platforms' true-peak headroom). Never more than +maxBoost dB.
 */
export function normalizationGain({ lufs, samplePeakDb }, { target = -14, ceiling = -1.5, maxBoost = 20 } = {}) {
  if (!Number.isFinite(lufs)) return 0;
  const want = target - lufs;
  const room = ceiling - samplePeakDb;
  return Math.round(Math.min(want, room, maxBoost) * 100) / 100;
}

/** Concatenate the kept ranges of a mono PCM buffer (e.g. the editor's 16 kHz transcription audio). */
export function keptPcm(pcm, rate, kept) {
  const total = kept.reduce((s, r) => s + Math.max(0, Math.round(r.end * rate) - Math.round(r.start * rate)), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const r of kept) {
    const a = Math.max(0, Math.round(r.start * rate)), b = Math.min(pcm.length, Math.round(r.end * rate));
    if (b > a) { out.set(pcm.subarray(a, b), o); o += b - a; }
  }
  return out.subarray(0, o);
}

export const dbToGain = (db) => Math.pow(10, db / 20);
