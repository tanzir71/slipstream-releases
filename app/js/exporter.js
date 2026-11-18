// Export: decode only the kept ranges, composite each frame with the same renderer as the preview,
// encode with WebCodecs and mux to MP4/WebM with Mediabunny. Runs entirely on-device.
import { MB } from './media.js';
import { renderFrame, usesCamera } from './compositor.js';
import { layoutAt } from '../../packages/editor-core/src/scenes.js';
import { loadWallpaper } from './wallpapers.js';
import { ensureCaptionFonts } from './captions.js';
import { outToSrc, totalDuration } from './edl.js';
import { webcodecsVideo } from './media-compat.js';
import { exportRealtime, realtimeMime, primeExportAudio } from './exporter-realtime.js';
import desktop from './desktop-bridge.js';
import { speechIntervals, musicGainAt, musicSourceTime } from '../../packages/editor-core/src/music.js';
export { primeExportAudio };

export async function pickCodecs(format, width, height) {
  if (!webcodecsVideo()) return { video: null, audio: null, realtime: realtimeMime(format) };
  const fmt = format === 'webm' ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat({ fastStart: 'in-memory' });
  const vPref = format === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'vp9', 'av1'];
  const aPref = format === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus'];
  const video = await MB.getFirstEncodableVideoCodec(vPref.filter((c) => fmt.getSupportedVideoCodecs().includes(c)), { width, height });
  const audio = await MB.getFirstEncodableAudioCodec(aPref.filter((c) => fmt.getSupportedAudioCodecs().includes(c)));
  return { video, audio };
}

/**
 * opts = { width, height, fps, format: 'mp4'|'webm', quality: 'high'|'medium', captions: bool }
 * ctx  = { edit, kept, cues, screenBlob, cameraBlob, cameraOffset, cameras?, hasAudio, overlays?, brollMedia?: { [itemId]: Blob },
 *          audioGainDb?, intro?: Blob, outro?: Blob, musicBlob?: Blob }  (intro/outro: brand bumper clips, S-02;
 *          musicBlob: the edit.music bed, S-04)
 */
export async function exportVideo(ctx, opts, { onProgress = () => {}, signal } = {}) {
  // Decode the wallpaper and caption faces up front so frame 1 matches the preview.
  await Promise.all([loadWallpaper(ctx.edit.style.bg), ensureCaptionFonts()]);
  const { width: W, height: H, fps } = opts;
  const outDur = totalDuration(ctx.kept);
  if (outDur <= 0) throw new Error('Nothing to export: every part of the video is cut.');
  const codecs = await pickCodecs(opts.format, W, H);
  // No WebCodecs encoder for this format: record the compositor in real time instead (W-06).
  if (!codecs.video) return exportRealtime(ctx, opts, { onProgress, signal });

  const screenInput = new MB.Input({ source: new MB.BlobSource(ctx.screenBlob), formats: MB.ALL_FORMATS });
  // Camera angles (S-03): the primary camera plus any extra angles the edit actually shows.
  const angles = camerasFor(ctx);
  const sTrack = await screenInput.getPrimaryVideoTrack();
  const aTrack = ctx.hasAudio ? await screenInput.getPrimaryAudioTrack() : null;
  const sStart = sTrack ? await sTrack.getFirstTimestamp() : 0;
  for (const a of angles) {
    a.input = new MB.Input({ source: new MB.BlobSource(a.blob), formats: MB.ALL_FORMATS });
    a.track = await a.input.getPrimaryVideoTrack();
    a.start = a.track ? await a.track.getFirstTimestamp() : 0;
  }

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = canvas.getContext('2d', { alpha: false });
  const format = opts.format === 'webm' ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat({ fastStart: 'in-memory' });
  const output = new MB.Output({ format, target: new MB.BufferTarget() });
  const quality = opts.quality === 'medium' ? MB.QUALITY_MEDIUM : MB.QUALITY_HIGH;
  const videoSource = new MB.CanvasSource(canvas, { codec: codecs.video, bitrate: quality, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  const speechOk = !!(aTrack && codecs.audio && (await aTrack.canDecode()));
  const wantsMusic = !!(ctx.musicBlob && ctx.edit.music && codecs.audio);
  if (speechOk || wantsMusic) {
    audioSource = new MB.AudioBufferSource({ codec: codecs.audio, bitrate: quality });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const total = Math.max(1, Math.floor(outDur * fps));
  const srcTimes = [];
  for (let i = 0; i < total; i++) srcTimes.push(outToSrc(ctx.kept, i / fps));

  const sSink = sTrack ? new MB.CanvasSink(sTrack, { poolSize: 3 }) : null;
  const sIter = sSink ? sSink.canvasesAtTimestamps(srcTimes.map((t) => sStart + t)) : null;
  for (const a of angles) {
    if (!a.track) continue;
    const sink = new MB.CanvasSink(a.track, { width: Math.min(1280, a.track.displayWidth), poolSize: 3 });
    a.iter = sink.canvasesAtTimestamps(srcTimes.map((t) => a.start + Math.max(0, t - (a.offset || 0))));
  }
  const primaryAngle = angles[0]?.id;
  const audioFormat = speechOk ? { sampleRate: aTrack.sampleRate, channels: aTrack.numberOfChannels } : audioSource ? { sampleRate: 48000, channels: 2 } : null;
  const music = wantsMusic ? await openMusic(ctx, audioFormat) : null;
  const speechGen = speechOk ? audioChunks(aTrack, ctx.kept, ctx.audioGainDb || 0) : audioSource ? silentChunks(outDur, audioFormat) : null;
  const audioGen = speechGen && music ? withMusic(speechGen, music) : speechGen;
  const intro = ctx.intro ? await openBumper(ctx.intro) : null;
  const outro = ctx.outro ? await openBumper(ctx.outro) : null;
  const bumperFrames = Math.round(((intro?.duration || 0) + (outro?.duration || 0)) * fps);
  const grandTotal = total + bumperFrames;
  let framesDone = 0;
  const bump = async (b, at) => {
    // video frames, cover-fit into the output frame
    const n = Math.max(1, Math.round(b.duration * fps));
    if (audioSource && audioFormat) await audioSource.add(await bumperAudio(b, audioFormat, ctx.audioGainDb || 0));
    const times = Array.from({ length: n }, (_, k) => b.first + Math.min(b.duration - 0.01, k / fps));
    let last = null, k = 0;
    for await (const wr of b.sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (wr) last = wr.canvas;
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      if (last) { const c = coverRect(last.width, last.height, W, H); g.drawImage(last, c.x, c.y, c.w, c.h, 0, 0, W, H); }
      await videoSource.add(at + k / fps, 1 / fps);
      k++; framesDone++;
      if (framesDone % 5 === 0) onProgress({ done: framesDone / grandTotal, eta: null, frame: framesDone, total: grandTotal });
    }
    return n / fps;
  };
  const base = intro ? await bump(intro, 0) : 0;
  const broll = await prepareBroll(ctx);
  let audioOut = 0;
  let audioDone = !audioGen;
  const t0 = performance.now();
  let lastScreen = null;

  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const T = i / fps;
      // keep audio slightly ahead of video so the muxer can interleave
      while (!audioDone && audioOut < T + 1) {
        const next = await audioGen.next();
        if (next.done) { audioDone = true; break; }
        await audioSource.add(next.value);
        audioOut += next.value.duration;
      }
      const s = sIter ? (await sIter.next()).value : null;
      if (s) lastScreen = s.canvas;
      for (const a of angles) { if (!a.iter) continue; const c = (await a.iter.next()).value; if (c) a.last = c.canvas; }
      const want = layoutAt(ctx.edit, srcTimes[i]).angle || primaryAngle;
      const active = angles.find((a) => a.id === want) || angles[0];
      const lastCam = active && srcTimes[i] >= (active.offset || 0) ? active.last : null;
      const overlays = broll.active ? { ...ctx.overlays, broll: await broll.frame(srcTimes[i]) } : ctx.overlays;
      renderFrame(g, W, H, { screen: lastScreen, camera: lastCam, edit: opts.captions ? ctx.edit : { ...ctx.edit, captions: { ...ctx.edit.captions, enabled: false } }, t: srcTimes[i], cues: ctx.cues, overlays });
      await videoSource.add(base + T, 1 / fps);
      framesDone++;
      if (i % 5 === 0) {
        const done = framesDone / grandTotal;
        const elapsed = (performance.now() - t0) / 1000;
        onProgress({ done, eta: done > 0.02 ? (elapsed / done) * (1 - done) : null, frame: framesDone, total: grandTotal });
      }
    }
    while (!audioDone) {
      const next = await audioGen.next();
      if (next.done) break;
      await audioSource.add(next.value);
    }
    if (outro) await bump(outro, base + total / fps);
    await output.finalize();
  } catch (err) {
    try { await output.cancel(); } catch { /* ignore */ }
    throw err;
  } finally {
    sIter?.return?.();
    for (const a of angles) { a.iter?.return?.(); a.input?.dispose?.(); }
    screenInput.dispose?.();
    broll.dispose();
    intro?.input.dispose?.(); outro?.input.dispose?.();
  }
  onProgress({ done: 1, eta: 0, frame: grandTotal, total: grandTotal });
  const mime = opts.format === 'webm' ? 'video/webm' : 'video/mp4';
  return { blob: new Blob([output.target.buffer], { type: mime }), codecs };
}

// ---- intro / outro bumpers (S-02) ----------------------------------------------------------------
async function openBumper(blob) {
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) { input.dispose?.(); return null; }
  return { blob, input, sink: new MB.CanvasSink(track, { poolSize: 2 }), first: await track.getFirstTimestamp(), duration: await input.computeDuration() };
}
/** The bumper's audio (or silence) at the main track's sample rate and channel count, so one encoder takes both. */
async function bumperAudio(b, { sampleRate, channels }, gainDb) {
  const length = Math.max(1, Math.round(b.duration * sampleRate));
  const ctx = new OfflineAudioContext(channels, length, sampleRate);
  try {
    const decoded = await ctx.decodeAudioData(await b.blob.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    const gain = ctx.createGain();
    gain.gain.value = Math.pow(10, (gainDb || 0) / 20);
    src.connect(gain).connect(ctx.destination);
    src.start();
  } catch { /* no audio in the clip: render silence */ }
  return ctx.startRendering();
}
function coverRect(sw, sh, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  const w = dw / s, h = dh / s;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

/** Angles to decode: ctx.cameras = [{ id, blob, offset }] (or the legacy single camera), only those the edit shows. */
export function camerasFor(ctx) {
  const all = ctx.cameras?.length ? ctx.cameras : ctx.cameraBlob ? [{ id: 'camera', blob: ctx.cameraBlob, offset: ctx.cameraOffset || 0 }] : [];
  if (!all.length || !usesCamera(ctx.edit)) return [];
  const used = new Set([ctx.edit.layout?.angle || all[0].id, ...(ctx.edit.scenes || []).map((s) => s.layout?.angle || ctx.edit.layout?.angle || all[0].id)]);
  return all.filter((a) => used.has(a.id)).map((a) => ({ ...a }));
}

/**
 * B-roll sources for export (S-04): images decoded once; video clips decoded with Mediabunny at the exact
 * frame for each output time. frame(t) returns { [itemId]: drawable } for the compositor.
 */
async function prepareBroll(ctx) {
  const items = (ctx.edit.broll || []).filter((b) => ctx.brollMedia?.[b.id]);
  const images = {}, videos = [];
  for (const b of items) {
    const blob = ctx.brollMedia[b.id];
    if (b.kind === 'video') {
      const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) videos.push({ b, input, sink: new MB.CanvasSink(track, { poolSize: 2 }), first: await track.getFirstTimestamp(), dur: await input.computeDuration() });
      else input.dispose?.();
    } else {
      images[b.id] = await createImageBitmap(blob).catch(() => null);
    }
  }
  return {
    active: items.length > 0,
    async frame(t) {
      const out = { ...images };
      for (const v of videos) {
        if (t < v.b.start || t >= v.b.end) continue;
        const local = Math.min(Math.max(0, v.dur - 0.05), (v.b.trimIn || 0) + (t - v.b.start));
        const wr = await v.sink.getCanvas(v.first + local);
        if (wr) out[v.b.id] = wr.canvas;
      }
      return out;
    },
    dispose() { for (const v of videos) v.input.dispose?.(); },
  };
}

/** Silence in 1 s buffers, for exports whose only sound is the music bed. */
async function* silentChunks(duration, { sampleRate, channels }) {
  for (let t = 0; t < duration - 1e-6; t += 1) {
    const length = Math.max(1, Math.round(Math.min(1, duration - t) * sampleRate));
    yield new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
  }
}

/**
 * The music bed (S-04), decoded at the export's sample rate. mixInto(buffer, t0) adds the song at output time
 * t0.. with the shared envelope (volume, fades, ducking under speech) from editor-core/music.js.
 */
async function openMusic(ctx, { sampleRate, channels }) {
  try {
    const ac = new OfflineAudioContext(Math.max(1, channels), 1, sampleRate);
    const song = await ac.decodeAudioData(await ctx.musicBlob.arrayBuffer());
    const total = totalDuration(ctx.kept);
    const speech = speechIntervals(ctx.edit.words, ctx.kept);
    const src = Array.from({ length: song.numberOfChannels }, (_, c) => song.getChannelData(c));
    const BLOCK = 128;
    return {
      mixInto(buf, t0) {
        const sr = buf.sampleRate, n = buf.length;
        const outs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
        for (let i0 = 0; i0 < n; i0 += BLOCK) {
          const i1 = Math.min(n, i0 + BLOCK);
          const ga = musicGainAt(t0 + i0 / sr, ctx.edit.music, total, speech), gb = musicGainAt(t0 + i1 / sr, ctx.edit.music, total, speech);
          if (ga <= 0 && gb <= 0) continue;
          for (let i = i0; i < i1; i++) {
            const st = musicSourceTime(t0 + i / sr, ctx.edit.music, song.duration);
            if (st == null) continue;
            const j = Math.min(song.length - 1, Math.floor(st * song.sampleRate));
            const g = ga + (gb - ga) * ((i - i0) / BLOCK);
            for (let c = 0; c < outs.length; c++) {
              const v = src.length === 1 ? src[0][j] : outs.length === 1 ? (src[0][j] + src[1][j]) / 2 : src[Math.min(c, src.length - 1)][j];
              outs[c][i] = Math.max(-1, Math.min(1, outs[c][i] + v * g));
            }
          }
        }
      },
    };
  } catch (err) {
    console.warn('Music could not be decoded; exporting without it', err);
    return null;
  }
}

/** Pass speech chunks through, adding the music bed at each chunk's output time. */
async function* withMusic(gen, music) {
  let t = 0;
  for await (const buf of gen) {
    music.mixInto(buf, t);
    t += buf.duration;
    yield buf;
  }
}

/** Yields AudioBuffers for each kept range, trimmed precisely and with 6 ms fades at every join. */
async function* audioChunks(track, kept, gainDb = 0) {
  const gain = Math.pow(10, gainDb / 20);
  const sink = new MB.AudioBufferSink(track);
  const first = await track.getFirstTimestamp();
  for (const r of kept) {
    const a = r.start + first, b = r.end + first;
    let firstChunk = true;
    const pending = [];
    for await (const wb of sink.buffers(a, b)) {
      const buf = wb.buffer;
      const sr = buf.sampleRate;
      const s0 = Math.max(0, Math.round((a - wb.timestamp) * sr));
      const s1 = Math.min(buf.length, Math.round((b - wb.timestamp) * sr));
      if (s1 - s0 <= 0) continue;
      const out = new AudioBuffer({ length: s1 - s0, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
      for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(s0, s1), c);
      if (gain !== 1) for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let k = 0; k < d.length; k++) d[k] = Math.max(-1, Math.min(1, d[k] * gain)); }
      if (firstChunk) { fade(out, 'in'); firstChunk = false; }
      pending.push(out);
      if (pending.length > 1) yield pending.shift();
    }
    if (pending.length) { const last = pending.shift(); fade(last, 'out'); yield last; }
  }
}

function fade(buf, dir) {
  const n = Math.min(buf.length, Math.round(buf.sampleRate * 0.006));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const g = i / n;
      if (dir === 'in') d[i] *= g; else d[buf.length - 1 - i] *= g;
    }
  }
}

/**
 * Save a file the user made. In the desktop app this is a native save dialog (resolves null when cancelled);
 * in a browser it's a download (resolves true).
 */
export async function downloadBlob(blob, name) {
  if (desktop.available) {
    try {
      return await desktop.saveFile(blob, name);
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      console.warn('Native save failed, falling back to a download', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
