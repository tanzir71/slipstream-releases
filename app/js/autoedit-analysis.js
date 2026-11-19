// Auto edit analysis on this device (AE-02, AE-03): promise wrappers around beats-worker.js and motion-worker.js
// for the Auto edit UI. Both workers cache by the asset's hash in IndexedDB, so a second press doesn't decode again.
// Browsers whose WebCodecs can't decode a file fall back to Web Audio (music) or <video> seeking (motion).
//   analyzeMusicFile(file, { hash?, bpm?, onProgress? }) -> Promise<MusicAnalysis>            (beats.js shape)
//   analyzeClipMotion(file, { hash?, duration?, onProgress? }) -> Promise<{ motion, quality, cached }>  (motion.js shape)
//   closeAnalysisWorkers()
import { framesCompat } from './media-compat.js';
import { MOTION_W, MOTION_H, MOTION_FPS } from '../../packages/editor-core/src/motion.js';

let beats = null, motion = null, seq = 0;
const pending = new Map();

function worker(kind) {
  if (kind === 'beats') {
    if (!beats) { beats = new Worker(new URL('./beats-worker.js', import.meta.url), { type: 'module' }); beats.onmessage = route; }
    return beats;
  }
  if (!motion) { motion = new Worker(new URL('./motion-worker.js', import.meta.url), { type: 'module' }); motion.onmessage = route; }
  return motion;
}

function route(e) {
  const msg = e.data || {};
  const job = pending.get(msg.id);
  if (!job) return;
  if (msg.type === 'progress') { job.onProgress?.(msg.p); return; }
  pending.delete(msg.id);
  if (msg.type === 'error') job.reject(new Error(msg.message));
  else job.resolve(msg);
}

function ask(kind, message, transfer = [], onProgress = null) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker(kind).postMessage({ ...message, id }, transfer);
  });
}

/** Mono samples of a music file through Web Audio (the fallback when WebCodecs can't decode it). */
async function decodeWithWebAudio(file) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buf.length, ch = buf.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    return { pcm: mono, rate: buf.sampleRate };
  } finally {
    ctx.close?.();
  }
}

/** Beats, bars and sections of a music file (see packages/editor-core/src/beats.js). */
export async function analyzeMusicFile(file, { hash = null, bpm = null, onProgress = null } = {}) {
  let res = await ask('beats', { type: 'analyze', file, hash, bpm }, [], onProgress);
  if (res.type === 'unsupported') {
    const { pcm, rate } = await decodeWithWebAudio(file);
    res = await ask('beats', { type: 'analyze-pcm', pcm, rate, hash, bpm }, [pcm.buffer], onProgress);
  }
  return res.analysis;
}

/** Nearest-neighbour resize of a w×h luma image to 64×36. */
function toMotionSize(lum, w, h) {
  if (w === MOTION_W && h === MOTION_H) return lum;
  const out = new Uint8Array(MOTION_W * MOTION_H);
  for (let y = 0; y < MOTION_H; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / MOTION_H));
    for (let x = 0; x < MOTION_W; x++) out[y * MOTION_W + x] = lum[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / MOTION_W))];
  }
  return out;
}

/** Motion curve, moves and centroids of a clip (see packages/editor-core/src/motion.js), plus a 0..1 quality. */
export async function analyzeClipMotion(file, { hash = null, duration = 0, onProgress = null } = {}) {
  let res = await ask('motion', { type: 'analyze', file, hash, duration }, [], onProgress);
  if (res.type === 'unsupported') {
    const frames = [];
    await framesCompat(file, duration, {
      fps: MOTION_FPS, width: MOTION_W, maxSeconds: Infinity, onProgress: (p) => onProgress?.(p * 0.9),
      onFrame: (t, img) => {
        const lum = new Uint8Array(img.width * img.height);
        for (let p = 0, q = 0; q < lum.length; p += 4, q++) lum[q] = (img.data[p] * 77 + img.data[p + 1] * 150 + img.data[p + 2] * 29) >> 8;
        frames.push(toMotionSize(lum, img.width, img.height));
      },
    });
    res = await ask('motion', { type: 'analyze-frames', frames, hash }, [], onProgress);
  }
  return { motion: res.motion, quality: res.quality, cached: !!res.cached };
}

export function closeAnalysisWorkers() {
  beats?.terminate(); motion?.terminate();
  beats = motion = null;
  for (const job of pending.values()) job.reject(new Error('Analysis stopped'));
  pending.clear();
}
