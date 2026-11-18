// Slower fallbacks for browsers without (full) WebCodecs — older Safari, Firefox on Android, locked-down
// builds (ticket W-06). Decoding goes through <video> and Web Audio instead of VideoDecoder/AudioDecoder.
// Everything still runs on this device. Add ?compat=1 to the URL to force this path for testing.

export const FORCE_COMPAT = typeof location !== 'undefined' && /[?&]compat=1\b/.test(location.search);

export function webcodecsVideo() {
  return !FORCE_COMPAT && typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
}
export function webcodecsAudio() {
  return !FORCE_COMPAT && typeof AudioDecoder !== 'undefined';
}

const once = (el, ev, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${ev}`)); }, ms);
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(new Error(el.error?.message || 'This browser can’t play this file')); };
  const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok, { once: true });
  el.addEventListener('error', bad, { once: true });
});

/** A muted <video> for a blob, with metadata loaded and a finite duration (MediaRecorder files report Infinity). */
export async function openVideo(blob) {
  const el = document.createElement('video');
  el.muted = true; el.playsInline = true; el.preload = 'auto';
  el.src = URL.createObjectURL(blob);
  await once(el, 'loadedmetadata');
  if (!Number.isFinite(el.duration)) {
    el.currentTime = 1e9;
    await once(el, 'durationchange').catch(() => {});
    el.currentTime = 0;
  }
  return el;
}
export function closeVideo(el) { if (!el) return; URL.revokeObjectURL(el.src); el.removeAttribute('src'); el.load(); }

export async function seekTo(el, t) {
  if (Math.abs(el.currentTime - t) < 1e-3 && el.readyState >= 2) return;
  const p = once(el, 'seeked', 10000);
  el.currentTime = t;
  await p;
}

/** Can this browser play the file through a <video> element at all? */
export async function canPlayElement(blob) {
  let el = null;
  try { el = await openVideo(blob); return { ok: true, duration: el.duration, width: el.videoWidth, height: el.videoHeight }; }
  catch { return { ok: false }; }
  finally { closeVideo(el); }
}

/** Waveform peaks (100/s) and 16 kHz mono PCM via Web Audio's decoder (resamples for us). */
export async function analyzeAudioCompat(blob, duration, peaksPerSec = 100, onProgress = () => {}) {
  onProgress(0.05);
  const Ctx = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 16000, 16000);
  const buf = await new Promise((resolve, reject) => {
    blob.arrayBuffer().then((ab) => {
      const p = ctx.decodeAudioData(ab, resolve, reject);
      if (p?.then) p.then(resolve, reject);
    }, reject);
  });
  onProgress(0.7);
  const ch = buf.numberOfChannels, len = buf.length;
  const pcm = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) pcm[i] += d[i] / ch; }
  const per = 16000 / peaksPerSec;
  const n = Math.ceil(duration * peaksPerSec);
  const peaks = new Float32Array(n);
  for (let i = 0; i < len; i++) { const b = (i / per) | 0; const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (b < n && a > peaks[b]) peaks[b] = a; }
  onProgress(1);
  return { peaks, pcm: pcm.subarray(0, Math.ceil(duration * 16000)) };
}

/** JPEG data URL of a frame via <video>. */
export async function thumbnailCompat(blob, at = 1, width = 480) {
  let el = null;
  try {
    el = await openVideo(blob);
    await seekTo(el, Math.min(at, Math.max(0, el.duration - 0.1)));
    const c = document.createElement('canvas');
    c.width = width; c.height = Math.round((width * el.videoHeight) / Math.max(1, el.videoWidth));
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; } finally { closeVideo(el); }
}

/** Low-res luminance frames by seeking a <video>; slower than WebCodecs, so it samples 2 fps and caps length. */
export async function framesCompat(blob, duration, { fps = 2, width = 160, maxSeconds = 900, onFrame, onProgress = () => {} } = {}) {
  let el = null;
  try {
    el = await openVideo(blob);
    const h = Math.max(2, Math.round((width * el.videoHeight) / Math.max(1, el.videoWidth)));
    const c = document.createElement('canvas');
    c.width = width; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    const end = Math.min(duration, maxSeconds);
    for (let t = 0, i = 0; t < end; t += 1 / fps, i++) {
      await seekTo(el, t);
      g.drawImage(el, 0, 0, width, h);
      onFrame(t, g.getImageData(0, 0, width, h));
      if (i % 10 === 0) onProgress(t / end);
    }
    onProgress(1);
  } finally { closeVideo(el); }
}
