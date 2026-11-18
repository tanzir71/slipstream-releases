// In-browser recorder: screen (+ system/tab audio) and microphone mixed into one track, camera as a
// separate layer so it can be re-laid-out in the editor. Uses getDisplayMedia + MediaRecorder.
// Chunks go to "sinks" (see rec-sinks.js) every second, so a crashed tab loses at most ~1 s (W-02).

const SCREEN_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const CAMERA_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];

export function pickMime(list) {
  if (typeof MediaRecorder === 'undefined') return '';
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export function recordingSupported() {
  return !!(navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined');
}

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: all.filter((d) => d.kind === 'videoinput'),
    mics: all.filter((d) => d.kind === 'audioinput'),
    labelled: all.some((d) => d.label),
  };
}

export async function openCamera(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
}

export async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

/** Live level meter for a stream. Returns { level(): 0..1, close() }. */
export function meter(stream) {
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  return {
    level() { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); return Math.min(1, m * 1.6); },
    close() { if (ac.state !== 'closed') ac.close().catch(() => {}); },
  };
}

export class Session {
  /** sinks = { screen?, camera? } objects with write(blob), close(type) -> Promise<Blob|File>, abort(). */
  constructor({ display, camera, mic, sinks = {} }) {
    this.display = display;
    this.camera = camera;
    this.mic = mic;
    this.sinks = sinks;
    this.chunks = { screen: [], camera: [] };
    this.onstarted = null;
    this.startedAt = { screen: 0, camera: 0 };
    this.state = 'idle';
    this.onstop = null;
    this.elapsed = 0;
    this._t = 0;
    this.pauses = []; // [from, to] in performance.now() ms; the screen file leaves these out
  }

  _mixedStream() {
    const audioTracks = [...this.display.getAudioTracks(), ...(this.mic ? this.mic.getAudioTracks() : [])];
    const video = this.display.getVideoTracks()[0];
    if (audioTracks.length <= 1) return new MediaStream([video, ...audioTracks]);
    this.ac = new AudioContext();
    const dest = this.ac.createMediaStreamDestination();
    if (this.display.getAudioTracks().length) this.ac.createMediaStreamSource(new MediaStream(this.display.getAudioTracks())).connect(dest);
    if (this.mic) this.ac.createMediaStreamSource(this.mic).connect(dest);
    return new MediaStream([video, ...dest.stream.getAudioTracks()]);
  }

  start() {
    const screenMime = pickMime(SCREEN_TYPES);
    this.screenRec = new MediaRecorder(this._mixedStream(), { mimeType: screenMime || undefined, videoBitsPerSecond: screenBitrate(this.display.getVideoTracks()[0]), audioBitsPerSecond: 160_000 });
    this.screenRec.ondataavailable = (e) => this._chunk('screen', e.data);
    this.screenRec.onstart = () => { this.startedAt.screen = performance.now(); this._started(); };
    if (this.camera) {
      const camMime = pickMime(CAMERA_TYPES);
      this.camRec = new MediaRecorder(this.camera, { mimeType: camMime || undefined, videoBitsPerSecond: 3_500_000 });
      this.camRec.ondataavailable = (e) => this._chunk('camera', e.data);
      this.camRec.onstart = () => { this.startedAt.camera = performance.now(); this._started(); };
    }
    const ended = () => { if (this.state === 'recording' || this.state === 'paused') this.stop(); };
    this.display.getVideoTracks()[0].addEventListener('ended', ended);
    this.screenRec.start(1000);
    this.camRec?.start(1000);
    this.state = 'recording';
    this._t = performance.now();
  }

  _chunk(track, blob) {
    if (!blob.size) return;
    if (this.sinks[track]) this.sinks[track].write(blob);
    else this.chunks[track].push(blob);
  }

  _started() {
    if (!this.startedAt.screen || (this.camRec && !this.startedAt.camera)) return;
    this.onstarted?.({ screenType: this.screenRec.mimeType, cameraType: this.camRec?.mimeType || '', cameraOffset: this.cameraOffset() });
  }

  cameraOffset() { return this.camRec ? Math.max(0, (this.startedAt.camera - this.startedAt.screen) / 1000) : 0; }

  pause() {
    if (this.state !== 'recording') return;
    this.screenRec.pause(); this.camRec?.pause();
    this.elapsed += (performance.now() - this._t) / 1000;
    this.pauses.push([performance.now(), Infinity]);
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.screenRec.resume(); this.camRec?.resume();
    this._t = performance.now();
    this._endPause(this._t);
    this.state = 'recording';
  }

  time() { return this.elapsed + (this.state === 'recording' ? (performance.now() - this._t) / 1000 : 0); }

  _endPause(at) { const p = this.pauses[this.pauses.length - 1]; if (p && p[1] === Infinity) p[1] = at; }

  /** Where the screen file's t = 0 is (performance.now() ms) and the paused stretches it leaves out, for alignCursor(). */
  timeline() { return { start: this.startedAt.screen || this._t, pauses: this.pauses.map((p) => [...p]) }; }

  stop() {
    if (!this._stopping) this._stopping = this._stop();
    return this._stopping;
  }

  async _stop() {
    const wasRecording = this.state === 'recording';
    this.state = 'stopped';
    if (wasRecording) this.elapsed += (performance.now() - this._t) / 1000;
    this._endPause(performance.now());
    const done = (rec) => new Promise((res) => { if (!rec || rec.state === 'inactive') return res(); rec.onstop = () => res(); rec.stop(); });
    await Promise.all([done(this.screenRec), done(this.camRec)]);
    this.release();
    const sType = this.screenRec.mimeType || 'video/webm', cType = this.camRec?.mimeType || 'video/webm';
    const screen = this.sinks.screen ? await this.sinks.screen.close(sType) : new Blob(this.chunks.screen, { type: sType });
    let camera = null;
    if (this.camRec) {
      camera = this.sinks.camera ? await this.sinks.camera.close(cType) : (this.chunks.camera.length ? new Blob(this.chunks.camera, { type: cType }) : null);
      if (camera && !camera.size) camera = null;
    }
    const cameraOffset = camera ? this.cameraOffset() : 0;
    this.result = { screen, camera, cameraOffset, duration: this.elapsed, stored: !!this.sinks.stored };
    queueMicrotask(() => this.onstop?.(this.result));
    return this.result;
  }

  discard() {
    this.state = 'stopped';
    try { this.screenRec?.stop(); this.camRec?.stop(); } catch { /* ignore */ }
    this.sinks.screen?.abort(); this.sinks.camera?.abort();
    this.release();
  }

  release() {
    for (const s of [this.display, this.camera, this.mic]) s?.getTracks().forEach((t) => t.stop());
    if (this.ac && this.ac.state !== 'closed') this.ac.close().catch(() => {});
  }
}

/**
 * Put cursor samples from the desktop shell (desktop.cursor.stop()) on the screen file's timeline.
 * samples: [{ t, x, y, click }] with t in seconds since `origin` (performance.now() ms just before the shell started
 * sampling); start / pauses: Session.timeline(); duration: the take's length in seconds. Samples before the take,
 * while it was paused or after it ended are dropped; the rest move earlier by the pauses before them.
 */
export function alignCursor(samples, { origin, start, pauses = [], duration = Infinity }) {
  const out = [];
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!Number.isFinite(s?.t)) continue;
    const at = origin + s.t * 1000;
    if (at < start) continue;
    let skipped = 0, paused = false;
    for (const [from, to] of pauses) {
      if (at >= to) skipped += to - from;
      else if (at >= from) { paused = true; break; }
    }
    if (paused) continue;
    const t = (at - start - skipped) / 1000;
    if (t <= duration) out.push({ ...s, t });
  }
  return out;
}

/**
 * Bits per second for the screen layer, scaled to the captured size so small text stays crisp
 * after zooms: about 0.08 bits per pixel per frame, between 8 and 24 Mbps
 * (1080p30 → 8, 2880×1800 → 12, 5K → 24).
 */
export function screenBitrate(track) {
  const s = track?.getSettings?.() || {};
  const perSecond = (s.width || 1920) * (s.height || 1080) * Math.min(60, s.frameRate || 30);
  return Math.round(Math.max(8_000_000, Math.min(24_000_000, perSecond * 0.08)));
}

export async function pickDisplay({ systemAudio = true } = {}) {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 }, cursor: 'always' },
    audio: systemAudio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: systemAudio ? 'include' : 'exclude',
    monitorTypeSurfaces: 'include',
  });
}
