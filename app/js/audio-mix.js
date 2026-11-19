// Mixing the audio tracks of one file into one track (pure: no DOM, no media APIs). Recordings from Slipstream 1
// for Mac, and bundles from Slipstream 2 for Mac, keep system audio and the microphone on separate tracks; a
// <video> element plays only the first, so media.js mixes them on import with these helpers.

/**
 * Decoded audio from one track, consumed in time order. Chunks are { t, rate, n, planes } with `t` in seconds
 * on the file's timeline and one Float32Array per channel.
 */
export class ChunkQueue {
  constructor() {
    this.chunks = [];
    this.done = false;
  }

  push({ t, rate, n, planes }) {
    this.chunks.push({ t, rate, n, planes, end: t + n / rate });
  }

  /** End time of the audio decoded so far (-Infinity when empty). */
  get end() {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].end : -Infinity;
  }

  /** Forget chunks that end at or before t. */
  dropBefore(t) {
    while (this.chunks.length && this.chunks[0].end <= t) this.chunks.shift();
  }

  /**
   * Add this track's audio from t0 into `out` (one Float32Array per channel, all the same length, at `rate`).
   * Samples are matched by time, so tracks with a different start, chunking or sample rate line up. A mono
   * track goes to every output channel; a mono output gets the average of the track's channels; otherwise
   * channels map by index (extra track channels are dropped, extra output channels reuse the last one).
   */
  addInto(out, t0, rate) {
    const n = out[0].length, oc = out.length;
    for (const ch of this.chunks) {
      if (ch.end <= t0) continue;
      const i0 = Math.max(0, Math.ceil((ch.t - t0) * rate - 1e-9));
      if (i0 >= n) break;
      const i1 = Math.min(n, Math.ceil((ch.end - t0) * rate - 1e-9));
      const k = ch.planes.length, step = ch.rate / rate, off = (t0 - ch.t) * ch.rate;
      for (let i = i0; i < i1; i++) {
        const j = Math.floor(off + i * step + 1e-6);
        if (j < 0 || j >= ch.n) continue;
        if (oc === 1) {
          let v = 0;
          for (let c = 0; c < k; c++) v += ch.planes[c][j];
          out[0][i] += v / k;
        } else {
          for (let c = 0; c < oc; c++) out[c][i] += ch.planes[k === 1 ? 0 : Math.min(c, k - 1)][j];
        }
      }
    }
  }
}

/** Clamp every sample to [-1, 1] in place (a plain sum of two loud tracks can exceed full scale). */
export function clampPlanes(planes) {
  for (const p of planes) for (let i = 0; i < p.length; i++) p[i] = p[i] > 1 ? 1 : p[i] < -1 ? -1 : p[i];
  return planes;
}

/** Planar channels -> one Float32Array laid out channel after channel ('f32-planar'). */
export function packPlanar(planes) {
  const n = planes[0]?.length || 0;
  const data = new Float32Array(n * planes.length);
  planes.forEach((p, c) => data.set(p, c * n));
  return data;
}
