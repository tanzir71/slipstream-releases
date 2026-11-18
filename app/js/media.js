// Media I/O on top of Mediabunny (WebCodecs). Decoding happens on-device; nothing is uploaded.
import * as MB from '../vendor/mediabunny.min.mjs';
import { dominantChange } from './autozoom.js';
import { FORCE_COMPAT, canPlayElement, analyzeAudioCompat, thumbnailCompat, framesCompat } from './media-compat.js';

export { MB };

export const PEAKS_PER_SEC = 100;
export const ASR_RATE = 16000;

/** WebCodecs can decode this track (false when ?compat=1 forces the slower <video>/Web Audio path). */
async function decodable(track) {
  return !FORCE_COMPAT && !!track && (await track.canDecode());
}

function openInput(blob) {
  return new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
}

/** Basic facts about a media file. */
export async function probe(blob) {
  const input = openInput(blob);
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    const duration = await input.computeDuration();
    const canDecodeVideo = video ? await decodable(video) : false;
    // No WebCodecs decoder: fall back to the browser's own player (W-06) if it can play the file.
    const element = video && !canDecodeVideo ? await canPlayElement(blob) : null;
    return {
      duration: duration || element?.duration || 0,
      hasVideo: !!video,
      hasAudio: !!audio,
      audioChannels: audio ? audio.numberOfChannels : 0,
      width: video ? video.displayWidth : 0,
      height: video ? video.displayHeight : 0,
      videoCodec: video ? video.codec : null,
      audioCodec: audio ? audio.codec : null,
      canDecodeVideo,
      canDecodeAudio: audio ? await decodable(audio) : false,
      canPlayElement: !!element?.ok,
      compat: !!element?.ok,
    };
  } finally {
    input.dispose?.();
  }
}

/**
 * Stream the audio track once and produce
 *  - peaks: Float32Array of max |amplitude| per 10 ms (for the waveform and silence detection)
 *  - pcm: Float32Array mono 16 kHz (for Whisper)
 */
export async function analyzeAudio(blob, duration, onProgress = () => {}) {
  const input = openInput(blob);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track && !(await decodable(track))) {
      try { return await analyzeAudioCompat(blob, duration, PEAKS_PER_SEC, onProgress); } catch { /* fall through */ }
    }
    if (!track || !(await decodable(track))) return { peaks: new Float32Array(Math.ceil(duration * PEAKS_PER_SEC)), pcm: null };
    const nPeaks = Math.ceil(duration * PEAKS_PER_SEC) + PEAKS_PER_SEC;
    const nPcm = Math.ceil(duration * ASR_RATE) + ASR_RATE;
    const peaks = new Float32Array(nPeaks);
    const sum = new Float32Array(nPcm);
    const cnt = new Uint16Array(nPcm);
    const sink = new MB.AudioBufferSink(track);
    let lastReport = 0;
    for await (const { buffer, timestamp } of sink.buffers()) {
      const sr = buffer.sampleRate, ch = buffer.numberOfChannels, len = buffer.length;
      const chans = [];
      for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
      const base = Math.round(Math.max(0, timestamp) * sr);
      const toPeak = PEAKS_PER_SEC / sr, toPcm = ASR_RATE / sr;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < ch; c++) v += chans[c][i];
        v /= ch;
        const g = base + i;
        const pi = (g * toPeak) | 0;
        const a = v < 0 ? -v : v;
        if (pi < nPeaks && a > peaks[pi]) peaks[pi] = a;
        const qi = (g * toPcm) | 0;
        if (qi < nPcm) { sum[qi] += v; cnt[qi]++; }
      }
      if (timestamp - lastReport > 2) { lastReport = timestamp; onProgress(Math.min(1, timestamp / duration)); }
    }
    const used = Math.ceil(duration * ASR_RATE);
    const pcm = new Float32Array(used);
    for (let i = 0; i < used; i++) pcm[i] = cnt[i] ? sum[i] / cnt[i] : 0;
    onProgress(1);
    return { peaks: peaks.subarray(0, Math.ceil(duration * PEAKS_PER_SEC)), pcm };
  } finally {
    input.dispose?.();
  }
}

/** JPEG data URL of a frame, for project cards. */
export async function thumbnail(blob, at = 1, width = 480) {
  const input = openInput(blob);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track && !(await decodable(track))) return await thumbnailCompat(blob, at, width);
    if (!track) return null;
    const sink = new MB.CanvasSink(track, { width, poolSize: 1 });
    const start = await track.getFirstTimestamp();
    const wrapped = (await sink.getCanvas(start + at)) || (await sink.getCanvas(start));
    if (!wrapped) return null;
    const c = wrapped.canvas;
    if (c.convertToBlob) {
      const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
      return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
    }
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  } finally {
    input.dispose?.();
  }
}

/**
 * Sample low-res frames and measure where the picture changes. Used for auto-zoom on the web, where
 * cursor positions are not available. Returns [{ t, x, y, w, h, area }] with normalized boxes.
 */
export async function activityEvents(blob, duration, { fps = 4, width = 160, onProgress = () => {} } = {}) {
  const input = openInput(blob);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    if (!(await decodable(track))) {
      // slower <video> seeking path (W-06): 2 fps, first 15 minutes
      const events = [];
      let prev = null;
      await framesCompat(blob, duration, { width, onProgress, onFrame: (t, img) => {
        const lum = new Uint8Array(img.width * img.height);
        for (let p = 0, q = 0; q < lum.length; p += 4, q++) lum[q] = (img.data[p] * 77 + img.data[p + 1] * 150 + img.data[p + 2] * 29) >> 8;
        if (prev && prev.length === lum.length) { const ev = dominantChange(lum, prev, img.width, img.height); if (ev) events.push({ t, ...ev }); }
        prev = lum;
      } });
      return events;
    }
    const sink = new MB.CanvasSink(track, { width, poolSize: 2 });
    const start = await track.getFirstTimestamp();
    const times = [];
    for (let t = 0; t < duration; t += 1 / fps) times.push(start + t);
    let prev = null;
    const events = [];
    let i = 0;
    const work = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      const t = times[i++] - start;
      if (!wrapped) continue;
      const c = wrapped.canvas;
      if (work.width !== c.width || work.height !== c.height) { work.width = c.width; work.height = c.height; }
      const wctx = work.getContext('2d', { willReadFrequently: true });
      wctx.drawImage(c, 0, 0);
      const { data, width: w, height: h } = wctx.getImageData(0, 0, c.width, c.height);
      const lum = new Uint8Array(w * h);
      for (let p = 0, q = 0; q < lum.length; p += 4, q++) lum[q] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      if (prev && prev.length === lum.length) {
        const ev = dominantChange(lum, prev, w, h);
        if (ev) events.push({ t, ...ev });
      }
      prev = lum;
      if (i % 20 === 0) onProgress(Math.min(1, t / duration));
    }
    onProgress(1);
    return events;
  } finally {
    input.dispose?.();
  }
}

