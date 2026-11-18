// Real-time export for browsers without WebCodecs encoders (ticket W-06): plays the kept ranges through
// <video> elements, draws every frame with the SAME compositor as the preview, and records the canvas plus
// the audio graph with MediaRecorder. Slower (1× speed) but works in Firefox and Safari. On-device only.
import { renderFrame, usesCamera } from './compositor.js';
import { speechIntervals, musicGainAt, musicSourceTime, musicSettings } from '../../packages/editor-core/src/music.js';
import { loadWallpaper } from './wallpapers.js';
import { ensureCaptionFonts } from './captions.js';
import { totalDuration } from './edl.js';
import { openVideo, closeVideo, seekTo } from './media-compat.js';
import { layoutAt } from '../../packages/editor-core/src/scenes.js';
import { camerasFor } from './exporter.js';

const TYPES = {
  mp4: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'],
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
};

/** The container MediaRecorder will actually produce for a requested format (it may differ). */
export function realtimeMime(format) {
  if (typeof MediaRecorder === 'undefined') return '';
  const order = format === 'webm' ? [...TYPES.webm, ...TYPES.mp4] : [...TYPES.mp4, ...TYPES.webm];
  return order.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Call synchronously inside the click that starts an export: browsers only let audio start from a user
 * gesture, and the real-time path plays the recording through Web Audio. Returns a running AudioContext.
 */
export function primeExportAudio() {
  try {
    const ac = new (self.AudioContext || self.webkitAudioContext)();
    ac.resume().catch(() => {});
    return ac;
  } catch { return null; }
}

const within = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

export function realtimeSupported() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
}

/** Same ctx/opts as exportVideo(). Resolves { blob, codecs: { video: 'realtime', audio, mime } }. */
export async function exportRealtime(ctx, opts, { onProgress = () => {}, signal } = {}) {
  if (!realtimeSupported()) throw new Error('This browser can’t record a canvas. Use a recent Chrome, Edge, Firefox or Safari, or the desktop app.');
  await Promise.all([loadWallpaper(ctx.edit.style.bg), ensureCaptionFonts()]);
  const { width: W, height: H, fps } = opts;
  const outDur = totalDuration(ctx.kept);
  if (outDur <= 0) throw new Error('Nothing to export: every part of the video is cut.');
  const mime = realtimeMime(opts.format);
  if (!mime) throw new Error('This browser can’t record video.');

  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  // keep it in the DOM (some browsers throttle detached canvases) but invisible
  Object.assign(canvas.style, { position: 'fixed', left: '-10000px', top: '0', width: '2px', height: '2px' });
  document.body.append(canvas);
  const g = canvas.getContext('2d', { alpha: false });
  const screen = await openVideo(ctx.screenBlob);
  // Camera angles (S-03): one <video> per angle the edit shows; the active one follows the layout at t.
  const angles = camerasFor(ctx);
  for (const a of angles) a.el = await openVideo(a.blob);
  const activeAngle = (t) => { const want = layoutAt(ctx.edit, t).angle || angles[0]?.id; return angles.find((a) => a.id === want) || angles[0] || null; };
  let camera = null;
  const stream = canvas.captureStream(fps);
  let ac = null, dest = null;
  const wantsMusic = !!(ctx.musicBlob && ctx.edit.music);
  if (ctx.hasAudio || wantsMusic) {
    ac = ctx.audioContext || new (self.AudioContext || self.webkitAudioContext)();
    dest = ac.createMediaStreamDestination();
    if (ctx.hasAudio) {
      screen.muted = false;
      const gain = ac.createGain();
      gain.gain.value = Math.pow(10, (ctx.audioGainDb || 0) / 20); // loudness normalisation, same as the WebCodecs path
      ac.createMediaElementSource(screen).connect(gain).connect(dest);
    }
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  }
  // Music bed (S-04): restarted at the right point of the song for each kept range, with the shared envelope.
  const song = wantsMusic && ac ? await ac.decodeAudioData(await ctx.musicBlob.arrayBuffer()).catch(() => null) : null;
  const speech = song ? speechIntervals(ctx.edit.words, ctx.kept) : [];
  const startMusic = (outT, len) => {
    if (!song || len <= 0) return null;
    const m = musicSettings(ctx.edit.music);
    const off = musicSourceTime(outT, m, song.duration);
    const steps = Math.max(2, Math.ceil(len / 0.05) + 1);
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = musicGainAt(outT + (len * i) / (steps - 1), m, outDur, speech);
    if (off == null && curve.every((v) => v === 0)) return null;
    const src = ac.createBufferSource();
    src.buffer = song;
    src.loop = m.loop;
    src.loopStart = Math.min(song.duration - 0.05, Math.max(0, m.trimIn));
    src.loopEnd = song.duration;
    const gn = ac.createGain();
    src.connect(gn).connect(dest);
    const now = ac.currentTime;
    gn.gain.setValueCurveAtTime(curve, now, len);
    // Before `start` the song is silent; begin it where it should be at the end of that silence.
    const lead = off == null ? Math.max(0, m.start - outT) : 0;
    if (lead < len) src.start(now + lead, off ?? src.loopStart);
    src.stop(now + len + 0.05);
    return src;
  };
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(W * H * fps * (opts.quality === 'medium' ? 0.06 : 0.1)), audioBitsPerSecond: 160_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const edit = opts.captions ? ctx.edit : { ...ctx.edit, captions: { ...ctx.edit.captions, enabled: false } };
  // B-roll (S-04): images decoded once, clips played in sync on muted <video> elements.
  const brollImages = {}, brollVideos = [];
  for (const b of ctx.edit.broll || []) {
    const blob = ctx.brollMedia?.[b.id];
    if (!blob) continue;
    if (b.kind === 'video') brollVideos.push({ b, el: await openVideo(blob) });
    else brollImages[b.id] = await createImageBitmap(blob).catch(() => null);
  }
  const brollFrame = (t) => {
    const out = { ...brollImages };
    for (const { b, el } of brollVideos) {
      if (t < b.start || t >= b.end) { if (!el.paused) el.pause(); continue; }
      const want = (b.trimIn || 0) + (t - b.start);
      if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
      out[b.id] = el;
    }
    return out;
  };
  const draw = () => {
    const t = screen.currentTime;
    const a = activeAngle(t);
    camera = a && t >= (a.offset || 0) ? a.el : null;
    renderFrame(g, W, H, { screen, camera, edit, t, cues: ctx.cues, overlays: brollVideos.length || Object.keys(brollImages).length ? { ...ctx.overlays, broll: brollFrame(t) } : ctx.overlays });
  };
  let done = 0;
  const t0 = performance.now();
  // Intro/outro bumpers (S-02): played full-frame through the same canvas and audio graph.
  const playBumper = async (blob) => {
    const el = await openVideo(blob);
    try {
      if (ac && dest) { el.muted = false; const gn = ac.createGain(); gn.gain.value = Math.pow(10, (ctx.audioGainDb || 0) / 20); ac.createMediaElementSource(el).connect(gn).connect(dest); }
      await seekTo(el, 0);
      const drawBumper = () => {
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        const s = Math.max(W / el.videoWidth, H / el.videoHeight), w = W / s, h = H / s;
        g.drawImage(el, (el.videoWidth - w) / 2, (el.videoHeight - h) / 2, w, h, 0, 0, W, H);
      };
      drawBumper();
      if (rec.state === 'inactive') rec.start(1000); else rec.resume();
      if (ac && ac.state !== 'running') await ac.resume().catch(() => {});
      await el.play();
      await new Promise((resolve) => {
        const step = () => { drawBumper(); if (el.ended || el.currentTime >= el.duration - 0.02) { resolve(); return; } (el.requestVideoFrameCallback ? el.requestVideoFrameCallback.bind(el) : requestAnimationFrame)(step); };
        el.addEventListener('ended', resolve, { once: true });
        step();
      });
      rec.pause();
    } finally { el.pause(); closeVideo(el); }
  };

  try {
    if (ctx.intro) await playBumper(ctx.intro);
    for (const r of ctx.kept) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      await seekTo(screen, r.start);
      for (const a of angles) await seekTo(a.el, Math.max(0, r.start - (a.offset || 0)));
      draw();
      if (rec.state === 'inactive') rec.start(1000); else rec.resume();
      const blocked = 'The browser didn’t let the export play its audio. Click Export again (it needs a click to start sound).';
      if (ac && ac.state !== 'running') await within(ac.resume(), 2500, blocked);
      await within(Promise.all([screen.play(), ...angles.map((a) => a.el.play())]), 5000, blocked);
      const musicNode = startMusic(done, r.end - r.start);
      await new Promise((resolve, reject) => {
        let finished = false;
        const finish = (err) => {
          if (finished) return;
          finished = true;
          clearInterval(timer);
          screen.removeEventListener('ended', onEnded);
          err ? reject(err) : resolve();
        };
        const onEnded = () => { draw(); finish(); };
        const step = () => {
          if (finished) return;
          if (signal?.aborted) { finish(new DOMException('Export cancelled', 'AbortError')); return; }
          const t = screen.currentTime;
          for (const a of angles) { const want = t - (a.offset || 0); if (want >= 0 && Math.abs(a.el.currentTime - want) > 0.2) a.el.currentTime = want; }
          draw();
          const p = (done + Math.max(0, t - r.start)) / outDur;
          onProgress({ done: Math.min(0.99, p), eta: p > 0.02 ? ((performance.now() - t0) / 1000 / p) * (1 - p) : null, frame: Math.round(p * outDur * fps), total: Math.round(outDur * fps) });
          if (t >= r.end - 0.01 || screen.ended) { finish(); return; }
          if (screen.requestVideoFrameCallback) screen.requestVideoFrameCallback(step); else requestAnimationFrame(step);
        };
        // Frame callbacks stop when playback ends or the tab is hidden; this timer and 'ended' cover both.
        const timer = setInterval(() => { if (screen.ended || screen.currentTime >= r.end - 0.01 || signal?.aborted) step(); }, 120);
        screen.addEventListener('ended', onEnded);
        step();
      });
      screen.pause(); for (const a of angles) a.el.pause();
      try { musicNode?.stop(); } catch { /* already stopped */ }
      rec.pause();
      done += r.end - r.start;
    }
    if (ctx.outro) await playBumper(ctx.outro);
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.stop();
    await stopped;
  } catch (err) {
    if (rec.state !== 'inactive') rec.stop();
    throw err;
  } finally {
    screen.pause(); for (const a of angles) a.el.pause();
    for (const tr of stream.getTracks()) tr.stop();
    ac?.close().catch(() => {});
    closeVideo(screen); for (const a of angles) closeVideo(a.el);
    for (const { el } of brollVideos) closeVideo(el);
    canvas.remove();
  }
  onProgress({ done: 1, eta: 0, frame: Math.round(outDur * fps), total: Math.round(outDur * fps) });
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), codecs: { video: 'realtime', audio: ctx.hasAudio ? 'recorded' : null, mime: type } };
}
