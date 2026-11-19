// Auto edit, motion sampling (ticket AE-03): decodes a clip on this device to 64×36 luma at 10 Hz — the same
// Mediabunny CanvasSink path as media.activityEvents, smaller and faster — and runs packages/editor-core/src/motion.js.
// Also scores picture quality (clips.frameQuality on the sampled frames). Results are cached in IndexedDB by the
// asset's hash (motion.motionCacheKey), so a second Auto edit doesn't decode again.
// Protocol:
//   in  { type: 'analyze', id, file: Blob, hash?: string, duration?: number }
//       { type: 'analyze-frames', id, frames: Uint8Array[] (64×36 luma, 10 Hz), hash?: string }
//         (for browsers without WebCodecs video: sample on the main thread, e.g. media-compat.framesCompat, first)
//   out { type: 'progress', id, p } | { type: 'done', id, motion, quality, cached: boolean }
//       | { type: 'unsupported', id } | { type: 'error', id, message }
import * as MB from '../vendor/mediabunny.min.mjs';
import { analyzeMotion, lumaFromRGBA, motionCacheKey, MOTION_W, MOTION_H, MOTION_FPS } from '../../packages/editor-core/src/motion.js';
import { frameQuality } from '../../packages/editor-core/src/clips.js';

const DB = 'slipstream-autoedit';
const STORE = 'analysis';

function openDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cacheGet(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(key, value) {
  const db = await openDB();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

/** 64×36 luma frames at 10 Hz from the primary video track, or null when WebCodecs can't decode it. */
async function sampleFrames(file, duration, onProgress) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track');
    if (!(await track.canDecode())) return null;
    const dur = duration > 0 ? duration : (await input.computeDuration()) || 0;
    const start = await track.getFirstTimestamp();
    const times = [];
    for (let i = 0; i < Math.round(dur * MOTION_FPS); i++) times.push(start + i / MOTION_FPS);
    const sink = new MB.CanvasSink(track, { width: MOTION_W, height: MOTION_H, fit: 'fill', poolSize: 2 });
    const work = new OffscreenCanvas(MOTION_W, MOTION_H);
    const g = work.getContext('2d', { willReadFrequently: true });
    const frames = [];
    let prev = new Uint8Array(MOTION_W * MOTION_H);
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      i++;
      if (!wrapped) { frames.push(prev); continue; } // a missing frame repeats the last one (no motion)
      g.drawImage(wrapped.canvas, 0, 0, MOTION_W, MOTION_H);
      prev = lumaFromRGBA(g.getImageData(0, 0, MOTION_W, MOTION_H).data, MOTION_W, MOTION_H);
      frames.push(prev);
      if (i % 50 === 0) onProgress(Math.min(0.95, i / times.length));
    }
    return frames;
  } finally {
    input.dispose?.();
  }
}

/** Mean frameQuality of up to 12 evenly spaced sampled frames (0..1; coarse at this size, used only to rank clips). */
function qualityOf(frames) {
  if (!frames.length) return 0.6;
  const n = Math.min(12, frames.length);
  let s = 0;
  for (let k = 0; k < n; k++) s += frameQuality(frames[Math.floor(((k + 0.5) * frames.length) / n)], MOTION_W, MOTION_H).score;
  return Math.round((s / n) * 1e6) / 1e6;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id } = msg;
  try {
    const key = msg.hash ? motionCacheKey(msg.hash) : null;
    if (key) {
      const hit = await cacheGet(key);
      if (hit) { self.postMessage({ type: 'done', id, motion: hit.motion, quality: hit.quality, cached: true }); return; }
    }
    let frames;
    if (msg.type === 'analyze-frames') frames = msg.frames;
    else if (msg.type === 'analyze') {
      frames = await sampleFrames(msg.file, msg.duration, (p) => self.postMessage({ type: 'progress', id, p }));
      if (!frames) { self.postMessage({ type: 'unsupported', id }); return; }
    } else return;
    const motion = analyzeMotion(frames);
    const quality = qualityOf(frames);
    self.postMessage({ type: 'progress', id, p: 1 });
    if (key) await cachePut(key, { motion, quality });
    self.postMessage({ type: 'done', id, motion, quality, cached: false });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
