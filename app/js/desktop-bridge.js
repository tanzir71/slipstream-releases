// Desktop bridge (ticket T-07). In the Slipstream desktop app (Tauri, Windows/Linux) the web editor runs unchanged
// and gains native features through `desktop`: native save/open dialogs and project folders, export and
// transcription through the local engine (hardware encoders, whisper.cpp), the recorder's tray and global shortcut,
// a capture-excluded teleprompter, pointer and click sampling during a take, updates, and CORS-free requests to the
// user's own cloud provider.
//
// In a browser `desktop.available` is false and every method rejects (event subscriptions are no-ops), so the web app
// can branch on `desktop.available` and is otherwise unaffected. This module has no imports and no side effects.
//
// Everything stays on this computer: the engine runs locally, files are written where the user picks, and
// cloudFetch only reaches the providers in desktop/tauri/src-tauri/src/cloud.rs (plus localhost).

const T = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
const available = !!(T && T.core && typeof T.core.invoke === 'function');

const WRITE_CHUNK = 8 * 1024 * 1024;
const READ_CHUNK = 16 * 1024 * 1024;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const platform = (() => {
  if (!available) return null;
  const ua = navigator.userAgent;
  return /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'macos' : 'linux';
})();

function toError(e) {
  if (e instanceof Error) return e;
  const err = new Error(e?.message || String(e));
  err.code = e?.code || 'error';
  if (err.code === 'cancelled') err.name = 'AbortError';
  return err;
}
const abortError = () => new DOMException('Cancelled', 'AbortError');
const invoke = (cmd, args, opts) => T.core.invoke(cmd, args, opts).catch((e) => { throw toError(e); });

let seq = 0;
const newId = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function channel(onMessage) {
  const ch = new T.core.Channel();
  ch.onmessage = (m) => { try { onMessage?.(m); } catch (err) { console.error(err); } };
  return ch;
}

/** Subscribe to a shell event; returns a synchronous unsubscribe. */
function on(event, cb) {
  if (!available) return () => {};
  const p = T.event.listen(event, (e) => cb(e.payload));
  return () => { p.then((off) => off()).catch(() => {}); };
}

/** Run an engine command. onProgress gets { kind: 'progress'|'partial'|'log', stage, done (0..1), eta, message, … }. */
async function job(cmd, args, { onProgress, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const jobId = newId(cmd);
  const cancel = () => { invoke('engine_cancel', { jobId }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await invoke(cmd, { ...args, jobId, onEvent: channel(onProgress) });
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

const baseName = (p) => String(p).split(/[\\/]/).pop();
const extOf = (name) => (/\.([a-z0-9-]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', srt: 'application/x-subrip', vtt: 'text/vtt', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', slipstream: 'application/zip', json: 'application/json' };
const LABEL = { mp4: 'MP4 video', mov: 'QuickTime video', webm: 'WebM video', gif: 'GIF', srt: 'SubRip subtitles', vtt: 'WebVTT subtitles', slipstream: 'Slipstream project', 'slipstream-brand': 'Slipstream brand kit', fcpxml: 'Final Cut Pro XML', xml: 'Premiere / Resolve XML', edl: 'Edit decision list', wav: 'WAV audio', m4a: 'M4A audio', jpg: 'JPEG image', png: 'PNG image', zip: 'Zip archive' };
const filtersFor = (name) => { const e = extOf(name); return e ? [{ name: LABEL[e] || e.toUpperCase(), extensions: [e] }] : []; };

async function writeChunks(token, blob, { onProgress, signal } = {}) {
  let off = 0;
  try {
    while (off < blob.size) {
      if (signal?.aborted) throw abortError();
      const end = Math.min(blob.size, off + WRITE_CHUNK);
      const bytes = new Uint8Array(await blob.slice(off, end).arrayBuffer());
      await invoke('write_chunk', bytes, { headers: { 'x-write-token': token, 'x-write-offset': String(off) } });
      off = end;
      onProgress?.({ kind: 'progress', stage: 'write', done: off / blob.size, bytes: off, total: blob.size });
    }
    return await invoke('write_finish', { token });
  } catch (err) {
    await invoke('write_abort', { token }).catch(() => {});
    throw err;
  }
}

/** Write a Blob to a path the user granted (save dialog, project folder). Returns { path, name, size, … }. */
async function writeFile(path, blob, opts) {
  return writeChunks(await invoke('write_begin', { path }), blob, opts);
}

/** Save dialog + write. Resolves null when the user cancels. */
async function saveFile(blob, name, { filters, title, onProgress, signal } = {}) {
  const path = await invoke('pick_save_path', { defaultName: name, filters: filters || filtersFor(name), title });
  if (!path) return null;
  return writeFile(path, blob, { onProgress, signal });
}

/** Read a file the app may read (picked, opened with the app, staged, rendered) into a File. */
async function readFile(target, { type, onProgress, signal } = {}) {
  const info = typeof target === 'string' ? { path: target, name: baseName(target) } : target;
  const size = info.size ?? Infinity;
  const parts = [];
  let off = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    const want = Math.min(READ_CHUNK, size - off);
    if (want <= 0) break;
    const buf = await invoke('read_chunk', { path: info.path, offset: off, length: want });
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
    parts.push(bytes);
    off += bytes.byteLength;
    if (Number.isFinite(size)) onProgress?.({ kind: 'progress', stage: 'read', done: off / size });
    if (bytes.byteLength < want) break;
  }
  return new File(parts, info.name || baseName(info.path), { type: type || MIME[extOf(info.name || info.path)] || '', lastModified: info.modified || Date.now() });
}

/**
 * Copy a browser-stored Blob (OPFS / IndexedDB) to a file the engine can read; reused while the blob is unchanged.
 * key: stable id such as `${project.id}-screen`. Returns the path.
 */
async function stageMedia(blob, { key, name, onProgress, signal } = {}) {
  if (typeof blob === 'string') return blob;
  if (!blob) throw new Error('No media to stage');
  const fullKey = `${key || 'media'}-${blob.size}-${blob.lastModified || 0}`;
  const fileName = name || blob.name || `media.${(blob.type.split('/')[1] || 'bin').split(';')[0]}`;
  const st = await invoke('stage_begin', { key: fullKey, name: fileName, size: blob.size });
  if (!st.token) return st.path;
  const done = await writeChunks(st.token, blob, { onProgress: (p) => onProgress?.({ ...p, stage: 'copy' }), signal });
  return done.path;
}

function normalizeWords(res) {
  const list = Array.isArray(res) ? res : res?.words || res?.transcript?.words || [];
  return list
    .map((w) => {
      const text = String(w.text ?? w.word ?? '').trim();
      const start = Number(w.start ?? w.t0 ?? 0);
      const end = Number(w.end ?? w.t1 ?? start + 0.3);
      const conf = w.confidence ?? w.prob ?? w.probability ?? w.p;
      return text ? { text, start, end: Math.max(end, start + 0.05), ...(conf != null ? { confidence: Number(conf) } : {}) } : null;
    })
    .filter(Boolean);
}

const b64encode = (bytes) => {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64decode = (s) => {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * fetch()-compatible request made by the desktop shell (no CORS), only to the BYO-key providers and localhost.
 * Pass it to SDKs (`new Anthropic({ fetch: desktop.cloudFetch, … })`) or call it like fetch. Rejects with a
 * TypeError for hosts outside the allow-list, like fetch does for network failures.
 */
async function cloudFetch(input, init = {}) {
  const req = new Request(input, init);
  const signal = init.signal || req.signal;
  if (signal?.aborted) throw abortError();
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
  const id = newId('cloud');
  const cancel = () => { invoke('cloud_cancel', { id }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const res = await invoke('cloud_fetch', { request: { id, url: req.url, method: req.method, headers: [...req.headers], bodyBase64: body && body.length ? b64encode(body) : null } });
    const payload = NULL_BODY.has(res.status) || req.method === 'HEAD' ? null : b64decode(res.bodyBase64);
    const response = new Response(payload, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(response, 'url', { value: res.url });
    return response;
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') throw abortError();
    const e = new TypeError(err.message);
    e.code = err.code;
    throw e;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

const api = {
  available: true,
  platform,

  /** { version, os, arch, engine: { available, version, error }, shortcut, updater: { configured, reason }, session, … } */
  info: () => invoke('app_info'),

  // ---- files ------------------------------------------------------------------------------------------------------
  /** Pick a folder for projects and exports. Resolves { path, name, entries: [{ path, name, size, modified, kind }] } or null. */
  openProjectFolder: (opts = {}) => invoke('pick_project_folder', { title: opts.title }),
  listFolder: (path) => invoke('list_folder', { path }),
  /** Open dialog. Resolves { path, name, size, modified, kind } or null; read it with readFile(). */
  pickFile: ({ filters, title } = {}) => invoke('pick_open_file', { filters, title }),
  /** Open dialog for a .slipstream project, read into a File ready for the web app's importFile(). */
  async openProjectFile(opts = {}) {
    const info = await api.pickFile({ filters: [{ name: 'Slipstream project', extensions: ['slipstream'] }], title: 'Open a project' });
    return info ? readFile(info, opts) : null;
  },
  /**
   * Open a Slipstream 1 project (.slipproj / .reelproj, `{editPlan, …}`) through the engine's `plan migrate`.
   * target: path or FileInfo (e.g. from onOpenFiles); omitted shows an open dialog. Resolves
   * { plan: edit plan v2, media: [FileInfo of the recordings it uses], missing: [paths not found] } or null.
   */
  async openLegacyProject(target) {
    const info = target || (await api.pickFile({ filters: [{ name: 'Slipstream 1 project', extensions: ['slipproj', 'reelproj', 'json'] }], title: 'Open a Slipstream 1 project' }));
    if (!info) return null;
    return invoke('engine_migrate_project', { jobId: newId('migrate'), path: typeof info === 'string' ? info : info.path });
  },
  /**
   * A Slipstream 1 Windows recording's pointer track (`<video without .mp4>.cursor.json` next to it), for zooms
   * that follow the cursor. path: the video's path (opened or picked). Resolves
   * { found, samples: [{ t, x, y }] (0..1 of the video), source: 'v1-sidecar' } — found: false when there is none.
   */
  cursorSidecar: (path) => invoke('engine_cursor_sidecar', { video: typeof path === 'string' ? path : path?.path }),
  readFile,
  saveFile,
  writeFile,
  revealInFolder: (path) => invoke('reveal_in_folder', { path }),
  /** URL for <video>/<img> of a readable file (e.g. a finished export). */
  async previewUrl(path) { return T.core.convertFileSrc(await invoke('allow_preview', { path })); },
  stageMedia,
  /** Delete staged copies of project media (the originals in browser storage stay). Resolves bytes freed. */
  clearStaged: () => invoke('clear_staged'),
  /** Files opened with the app (.slipstream association, second launch). cb([{ path, name, size, kind }]). */
  onOpenFiles(cb) {
    const off = on('desktop://open-files', cb);
    invoke('take_opened_files').then((list) => { if (list.length) cb(list); }).catch(() => {});
    return off;
  },
  /** `<a download>` fallback saves land in Downloads; cb({ path, success }). */
  onDownload: (cb) => on('desktop://download', cb),

  // ---- engine -----------------------------------------------------------------------------------------------------
  /**
   * Export through slipstream_engine with hardware encoders.
   * plan: edit plan v2 (object or JSON string, e.g. planFor(project, edit)).
   * opts: { output?: path, name?: default file name for the save dialog, width, height, fps, format: 'mp4'|'webm'|'mov'|'gif',
   *         quality: 'high'|'medium', encoder: 'auto'|id, captions: bool,
   *         media: { screen: Blob|path, camera?: Blob|path|null }, projectId?, signal? }
   * Resolves { path, size, url, engine } or null when the save dialog is cancelled.
   */
  async render(plan, opts = {}, onProgress) {
    const p = typeof plan === 'string' ? JSON.parse(plan) : structuredClone(plan);
    const format = opts.format || 'mp4';
    const output = opts.output || (await invoke('pick_save_path', { defaultName: opts.name || `slipstream.${format}`, filters: filtersFor(`x.${format}`), title: 'Export video' }));
    if (!output) return null;
    const key = opts.projectId || 'project';
    p.sources = p.sources || {};
    if (opts.media?.screen) p.sources.screen = { ...(p.sources.screen || {}), path: await stageMedia(opts.media.screen, { key: `${key}-screen`, onProgress, signal: opts.signal }) };
    if (opts.media?.camera) p.sources.camera = { ...(p.sources.camera || {}), path: await stageMedia(opts.media.camera, { key: `${key}-camera`, onProgress, signal: opts.signal }) };
    const options = { width: opts.width, height: opts.height, fps: opts.fps, format, quality: opts.quality, encoder: opts.encoder || 'auto', captions: opts.captions };
    const res = await job('engine_render', { plan: p, options, output }, { onProgress, signal: opts.signal });
    return { ...res, url: T.core.convertFileSrc(res.path) };
  },
  /**
   * whisper.cpp transcription. input: path or Blob (staged first; pass opts.key to reuse the copy).
   * opts: { model, language, key, signal, onWords(words) }. Resolves { words: [{ text, start, end, confidence? }], language, raw }
   * (same word shape as transcribe() in transcribe.js, without ids).
   */
  async transcribe(input, opts = {}, onProgress) {
    const path = await stageMedia(input, { key: opts.key, onProgress, signal: opts.signal });
    const onEvent = (e) => {
      if (e.kind === 'partial' && opts.onWords) { const ws = normalizeWords(e.data); if (ws.length) opts.onWords(ws); }
      onProgress?.(e);
    };
    const raw = await job('engine_transcribe', { input: path, options: { model: opts.model, language: opts.language } }, { onProgress: onEvent, signal: opts.signal });
    return { words: normalizeWords(raw), language: raw?.language || null, raw };
  },
  /**
   * Export-ready on stop (T-10): transcribe → fillers → silences → zooms in one engine pass. Resolves an edit plan v2.
   * opts.cursor: the take's cursor samples ([{ t, x, y, click }] or { samples }) so zooms follow clicks.
   */
  async polish(input, opts = {}, onProgress) {
    const path = await stageMedia(input, { key: opts.key, onProgress, signal: opts.signal });
    const camera = opts.camera ? await stageMedia(opts.camera, { key: `${opts.key || 'media'}-camera`, onProgress, signal: opts.signal }) : null;
    const samples = Array.isArray(opts.cursor) ? opts.cursor : opts.cursor?.samples;
    const cursor = Array.isArray(samples) && samples.length ? samples : null;
    return job('engine_polish', { input: path, camera, cursor, options: { model: opts.model, language: opts.language } }, { onProgress, signal: opts.signal });
  },
  /** Studio Sound (T-01) on a file; output defaults to a save dialog. Resolves { path, size, url, engine } or null. */
  async studioSound(input, opts = {}, onProgress) {
    const path = await stageMedia(input, { key: opts.key, onProgress, signal: opts.signal });
    const output = opts.output || (await invoke('pick_save_path', { defaultName: opts.name || 'studio-sound.wav', filters: filtersFor(opts.name || 'x.wav'), title: 'Save enhanced audio' }));
    if (!output) return null;
    const res = await job('engine_studio_sound', { input: path, output }, { onProgress, signal: opts.signal });
    return { ...res, url: T.core.convertFileSrc(res.path) };
  },
  /** FCPXML / Premiere XML / EDL with originals linked. format: 'fcpxml'|'xmeml'|'edl'. Resolves { path, size } or null. */
  async nleExport(plan, format, opts = {}, onProgress) {
    const p = typeof plan === 'string' ? JSON.parse(plan) : structuredClone(plan);
    const ext = { fcpxml: 'fcpxml', xmeml: 'xml', edl: 'edl' }[format] || format;
    const output = opts.output || (await invoke('pick_save_path', { defaultName: opts.name || `slipstream.${ext}`, filters: filtersFor(`x.${ext}`), title: 'Export for another editor' }));
    if (!output) return null;
    if (opts.media?.screen) p.sources = { ...(p.sources || {}), screen: { ...(p.sources?.screen || {}), path: await stageMedia(opts.media.screen, { key: `${opts.projectId || 'project'}-screen` }) } };
    return job('engine_nle_export', { plan: p, format, output }, { onProgress, signal: opts.signal });
  },
  /**
   * Preview copy of a video this webview can't decode (HEVC without the Windows extension, ProRes, 10-bit, AVI…):
   * at most 1280 px wide, H.264 + AAC with every audio track mixed in, cached by path, size and date. Only for the
   * preview — exports read the original through the engine. input: path or Blob (staged first; opts.key reuses
   * the copy). Resolves { path, size, engine: { cached, compat } }; read it with readFile().
   */
  async proxy(input, opts = {}, onProgress) {
    const path = await stageMedia(input, { key: opts.key, onProgress, signal: opts.signal });
    return job('engine_proxy', { input: path }, { onProgress, signal: opts.signal });
  },
  /** Every engine job's events in the Slipstream 1 shape: cb({ job_id, type: 'progress'|'log'|'result'|'error'|'cancelled', stage, pct, message, data }). */
  onJobEvent: (cb) => on('job_event', cb),
  /** Available encoders, e.g. [{ id: 'h264_nvenc', codec: 'h264', hardware: true }, …]. */
  async encoders() {
    const r = await invoke('engine_encoders');
    return Array.isArray(r) ? r : r?.encoders || [];
  },
  /** FFmpeg / whisper.cpp runtime (T-09): downloads are made and SHA-256-checked by the engine; sizes come from list(). */
  runtime: {
    async list() { const r = await invoke('runtime_list'); return Array.isArray(r) ? r : r?.components || r?.runtime || []; },
    /** opts.fromZip: true to pick a local archive (offline install), or a path. */
    async install(component, opts = {}, onProgress) {
      let from = typeof opts.fromZip === 'string' ? opts.fromZip : null;
      if (opts.fromZip === true) {
        const picked = await api.pickFile({ filters: [{ name: 'Runtime archive', extensions: ['zip', 'gz', 'tgz', 'xz'] }], title: `Choose the ${component} archive` });
        if (!picked) return null;
        from = picked.path;
      }
      return job('runtime_install', { component, from }, { onProgress, signal: opts.signal });
    },
    verify: (component) => invoke('runtime_verify', { component }),
  },

  // ---- recorder (T-06) --------------------------------------------------------------------------------------------
  /** Tell the shell whether a take is running (tray label, shortcut behaviour, window comes back on stop). */
  setRecording: (recording) => invoke('set_recording_state', { recording: !!recording }),
  globalShortcut: {
    /** Ctrl+Shift+R by default. cb({ recording, source: 'shortcut'|'tray' }): start when idle, stop when recording. */
    onToggle: (cb) => on('desktop://record-toggle', cb),
    /** e.g. 'CommandOrControl+Shift+R'; '' turns it off. Resolves { accelerator, registered, error }. */
    set: (accelerator) => invoke('set_record_shortcut', { accelerator }),
  },
  tray: {
    /** cb({ action: 'check-updates' }) */
    onAction: (cb) => on('desktop://tray', cb),
  },
  teleprompter: {
    /** Floating, always-on-top script window; excluded from screen capture on Windows. Resolves { excludedFromCapture }. */
    open: (text, opts = {}) => invoke('teleprompter_open', { script: { text: String(text || ''), ...opts } }),
    update: (text, opts = {}) => invoke('teleprompter_update', { script: { text: String(text || ''), ...opts } }),
    close: () => invoke('teleprompter_close'),
  },
  /**
   * Pointer and clicks during a take (T-04 / T-10), so auto-zoom can follow what was clicked. Only the pointer
   * position and the primary button are read (never keys), samples stay on this computer, and Wayland can't be
   * sampled (start() says so and the editor uses screen activity instead, as in a browser).
   */
  cursor: {
    /**
     * capture: the screen track's getSettings() — { width, height, displaySurface }. Only whole-monitor captures
     * are sampled. t = 0 is when the shell receives the call: read performance.now() just before. Resolves
     * { supported, reason?, hz }.
     */
    start: (capture = {}) => invoke('cursor_start', {
      capture: {
        width: Number.isFinite(capture.width) ? capture.width : null,
        height: Number.isFinite(capture.height) ? capture.height : null,
        displaySurface: typeof capture.displaySurface === 'string' ? capture.displaySurface : null,
      },
    }),
    /**
     * Stop and collect: { supported, reason?, samples: [{ t, x, y, click }], monitor, guessed }, t in seconds since
     * start(), x/y 0..1 of the recorded monitor (top-left origin), click on primary-button presses. `guessed` when
     * several monitors had the captured size and the one with the clicks was picked.
     */
    stop: () => invoke('cursor_stop'),
  },
  window: {
    minimize: () => T.window.getCurrentWindow().minimize(),
    focus: async () => { const w = T.window.getCurrentWindow(); await w.unminimize(); await w.show(); await w.setFocus(); },
  },

  // ---- updates (R-03) -------------------------------------------------------------------------------------------------
  updater: {
    /** Network request to the GitHub release; call only when the user asks or opted in. */
    check: () => invoke('updater_check'),
    /** After check() found one: download (signature-verified), install, restart. onProgress({ kind, downloaded, total }). */
    install: (onProgress) => invoke('updater_install', { onEvent: channel(onProgress) }),
  },

  // ---- BYO-key cloud ----------------------------------------------------------------------------------------------
  cloudFetch,
};

const notHere = () => Promise.reject(Object.assign(new Error('This needs the Slipstream desktop app.'), { code: 'unavailable' }));
function stub(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') out[k] = k.startsWith('on') ? () => () => {} : notHere;
    else if (v && typeof v === 'object') out[k] = stub(v);
    else out[k] = v;
  }
  return out;
}

export const desktop = Object.freeze(available ? api : { ...stub(api), available: false, platform: null });
export default desktop;
