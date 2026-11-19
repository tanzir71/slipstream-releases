// Auto edit, music analysis (ticket AE-02): decodes a music file on this device to 22.05 kHz mono and runs
// packages/editor-core/src/beats.js. Nothing leaves the worker; results can be cached by the file's hash.
// Protocol:
//   in  { type: 'analyze', id, file: Blob, hash?: string, bpm?: number }
//       { type: 'analyze-pcm', id, pcm: Float32Array (mono), rate: number, hash?: string, bpm?: number }
//         (for browsers whose WebCodecs can't decode the file: decode on the main thread with Web Audio first)
//   out { type: 'progress', id, p } | { type: 'done', id, analysis, cached: boolean }
//       | { type: 'unsupported', id } (no WebCodecs decoder: send 'analyze-pcm' instead) | { type: 'error', id, message }
// The cache is IndexedDB 'slipstream-autoedit' / 'analysis', key 'beats:v1:<hash>[:<bpm>]'.
import * as MB from '../vendor/mediabunny.min.mjs';
import { analyzeMusic, createResampler, BEAT_RATE } from '../../packages/editor-core/src/beats.js';

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

const keyFor = (hash, bpm) => (hash ? `beats:v1:${hash}${bpm ? `:${bpm}` : ''}` : null);

/** Decode the primary audio track to 22.05 kHz mono, streaming through the resampler. Null when WebCodecs can't. */
async function decodeMono(file, onProgress) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This file has no audio track');
    if (!(await track.canDecode())) return null;
    const duration = (await input.computeDuration()) || 0;
    const chunks = [];
    let total = 0;
    let rs = null;
    let last = 0;
    for await (const s of new MB.AudioSampleSink(track).samples()) {
      if (!rs) rs = createResampler(s.sampleRate, BEAT_RATE);
      const n = s.numberOfFrames, ch = s.numberOfChannels;
      const mono = new Float32Array(n);
      const plane = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        s.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
      }
      const t = s.timestamp;
      s.close();
      const out = rs.push(mono);
      chunks.push(out);
      total += out.length;
      if (duration > 0 && t - last > 5) { last = t; onProgress(Math.min(0.9, (t / duration) * 0.9)); }
    }
    if (rs) { const tail = rs.flush(); chunks.push(tail); total += tail.length; }
    const pcm = new Float32Array(total);
    let at = 0;
    for (const c of chunks) { pcm.set(c, at); at += c.length; }
    return pcm;
  } finally {
    input.dispose?.();
  }
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id } = msg;
  try {
    const key = keyFor(msg.hash, msg.bpm);
    if (key) {
      const hit = await cacheGet(key);
      if (hit) { self.postMessage({ type: 'done', id, analysis: hit, cached: true }); return; }
    }
    let pcm;
    if (msg.type === 'analyze-pcm') pcm = msg.rate === BEAT_RATE ? msg.pcm : (() => { const rs = createResampler(msg.rate, BEAT_RATE); const a = rs.push(msg.pcm), b = rs.flush(); const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; })();
    else if (msg.type === 'analyze') {
      pcm = await decodeMono(msg.file, (p) => self.postMessage({ type: 'progress', id, p }));
      if (!pcm) { self.postMessage({ type: 'unsupported', id }); return; }
    } else return;
    const analysis = analyzeMusic(pcm, { bpm: msg.bpm || null });
    self.postMessage({ type: 'progress', id, p: 1 });
    if (key) await cachePut(key, analysis);
    self.postMessage({ type: 'done', id, analysis, cached: false });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
