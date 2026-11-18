// Audio sync for multi-file projects (ticket S-03): find how far a second recording (a phone or DSLR
// camera, a separate mic) is shifted against the screen recording by cross-correlating their loudness
// envelopes. Pure: works on Float32Array PCM, no DOM. Tested in test/sync.test.mjs.

/** Loudness envelope: RMS per `hop` seconds, mean-removed and normalised to unit variance. */
export function envelope(pcm, rate, hop = 0.01) {
  const n = Math.max(1, Math.floor(pcm.length / (rate * hop)));
  const step = pcm.length / n;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const a = Math.floor(i * step), b = Math.floor((i + 1) * step);
    for (let k = a; k < b; k++) s += pcm[k] * pcm[k];
    env[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let varr = 0;
  for (let i = 0; i < n; i++) { env[i] -= mean; varr += env[i] * env[i]; }
  const sd = Math.sqrt(varr / n) || 1;
  for (let i = 0; i < n; i++) env[i] /= sd;
  return env;
}

/**
 * Offset in seconds of `other` relative to `ref`: a positive value means `other` started later, i.e. the
 * moment at time t in `other` happened at t + offset in `ref` (the web project's cameraOffset convention).
 * Returns { offset, confidence (0..1, peak correlation), lag frames } or null when either is silent.
 */
export function audioOffset(ref, other, rate, { hop = 0.01, maxLag = 120 } = {}) {
  const a = envelope(ref, rate, hop), b = envelope(other, rate, hop);
  if (a.length < 50 || b.length < 50) return null;
  const maxL = Math.min(Math.round(maxLag / hop), a.length + b.length);
  let best = -Infinity, bestLag = 0;
  // Coarse search on 4× decimated envelopes, then refine around the best lag at full resolution.
  const dec = (e) => { const out = new Float32Array(Math.floor(e.length / 4)); for (let i = 0; i < out.length; i++) out[i] = (e[i * 4] + e[i * 4 + 1] + e[i * 4 + 2] + e[i * 4 + 3]) / 4; return out; };
  const corr = (x, y, lag) => {
    // sum x[i + lag] * y[i] over the overlap, normalised by overlap length
    let s = 0, n = 0;
    const i0 = Math.max(0, -lag), i1 = Math.min(y.length, x.length - lag);
    for (let i = i0; i < i1; i++) { s += x[i + lag] * y[i]; n++; }
    return n > Math.min(x.length, y.length) * 0.25 ? s / n : -Infinity;
  };
  const da = dec(a), db = dec(b), dmax = Math.ceil(maxL / 4);
  const all = [];
  for (let lag = -dmax; lag <= dmax; lag++) {
    const c = corr(da, db, lag);
    if (!Number.isFinite(c)) continue;
    all.push(c);
    if (c > best) { best = c; bestLag = lag * 4; }
  }
  if (!all.length) return null;
  // Confidence: how far the peak stands out from every other lag (a z-score), mapped to 0..1.
  // A real match is a sharp outlier (z ≫ 8); unrelated audio peaks around z ≈ 3–4.
  const mean = all.reduce((x, y) => x + y, 0) / all.length;
  const sd = Math.sqrt(all.reduce((x, y) => x + (y - mean) * (y - mean), 0) / all.length) || 1;
  const z = (best - mean) / sd;
  best = -Infinity;
  let fine = bestLag;
  for (let lag = bestLag - 6; lag <= bestLag + 6; lag++) { const c = corr(a, b, lag); if (c > best) { best = c; fine = lag; } }
  if (!Number.isFinite(best)) return null;
  return { offset: Math.round(fine * hop * 1000) / 1000, confidence: Math.max(0, Math.min(1, (z - 4) / 6)), correlation: best, z, lag: fine };
}
