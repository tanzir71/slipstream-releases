// Remote guests (S-06) and direct device-to-device sending (S-05).
//
// Host room: the host invites guests with a code, sees them live, and presses record. Every
// participant records on their own device (full quality, independent of the call), and when the
// host stops, each guest's file is sent straight to the host over the encrypted WebRTC link and
// checked with SHA-256. The host gets separate tracks: their own screen/camera plus one file per
// guest with its start offset on the host's timeline.
// Send to device: a one-off direct transfer of an export or project file to another browser.
// No servers: codes travel over whatever chat app people use, and nothing is uploaded.

import { h, icon, fill, toast, modal, segmented, confirmDialog, fmtTime, fmtBytes } from './ui.js';
import { listDevices, openCamera, openMic, meter, Session, pickDisplay, pickMime } from './recorder.js';
import { createHost, joinAsGuest, readInvite, clockNow, p2pSupported, clearPartials } from './p2p.js';
import { parseIceServers, formatEta, startOffsetSeconds, safeFileName } from '../../packages/editor-core/src/signal-codes.js';
import { sha256Blob, createSha256 } from '../../packages/editor-core/src/sha256.js';

const MAX_GUESTS = 4;
const SLOW_CONNECT_MS = 12000;
const GUEST_NAME_KEY = 'slipstream-guest-name';
const NO_ICE_HINT = 'If you’re on different networks, add an ICE server under “Connection settings” and create a new invite.';

// ---- small shared pieces ---------------------------------------------------------------------------
/** Link to this app with a code in the fragment (the fragment never reaches a server). */
export function appLink(route, code) {
  return `${location.href.split('#')[0]}#/${route}/${code}`;
}

async function copyText(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'ok', 1800);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0', pointerEvents: 'none' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    toast(ok ? done : 'Couldn’t copy. Select the text and copy it yourself.', ok ? 'ok' : 'error');
  }
}

function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function warnUnload(e) { e.preventDefault(); e.returnValue = ''; }
function guardUnload(on) {
  window.removeEventListener('beforeunload', warnUnload);
  if (on) window.addEventListener('beforeunload', warnUnload);
}

const loadName = () => { try { return localStorage.getItem(GUEST_NAME_KEY) || ''; } catch { return ''; } };
const saveName = (v) => { try { localStorage.setItem(GUEST_NAME_KEY, v); } catch { /* private mode */ } };
const cloneStream = (tracks) => (tracks.length ? new MediaStream(tracks.map((t) => t.clone())) : null);
const ext = (type) => (/mp4/.test(type) ? 'mp4' : /ogg/.test(type) ? 'ogg' : 'webm');

/** Read-only code (or link) with copy buttons. */
function codeBlock(code, { route = null, label = 'Code' } = {}) {
  const text = route ? appLink(route, code) : code;
  const ta = h('textarea.p2p-code', { readOnly: true, rows: 3, value: text, spellcheck: false, 'aria-label': label, onfocus: (e) => e.target.select() });
  return h('div.p2p-codeblock', ta, h('div.row',
    route ? h('button.btn.small.primary', { onclick: () => copyText(text, 'Link copied') }, icon('share', 14), 'Copy link') : null,
    h(`button.btn.small${route ? '' : '.primary'}`, { onclick: () => copyText(code, 'Code copied') }, icon('file', 14), 'Copy code'),
    route && navigator.share ? h('button.btn.small.ghost', { onclick: () => navigator.share({ text }).catch(() => {}) }, 'Share…') : null));
}

/** Paste box for a code: textarea + button. onSubmit(text) may throw; its message is shown. */
function pasteBox({ label, placeholder, button, onSubmit }) {
  const ta = h('textarea.p2p-code', { rows: 3, spellcheck: false, placeholder, 'aria-label': label });
  const err = h('p.warn.small', { hidden: true, role: 'alert' });
  const btn = h('button.btn.primary', {
    onclick: async () => {
      err.hidden = true;
      btn.disabled = true;
      try { await onSubmit(ta.value); } catch (e) { err.textContent = e.message; err.hidden = false; } finally { btn.disabled = false; }
    },
  }, button);
  return h('div.p2p-paste', h('label.field', h('span', label), ta), err, h('div.row', btn));
}

const iceText = (list) => (list || []).map((s) => [Array.isArray(s.urls) ? s.urls.join(',') : s.urls, s.username, s.credential].filter(Boolean).join(' ')).join('\n');

/** "Connection settings": an optional, user-provided STUN/TURN server. */
function iceSettings(initial = []) {
  const err = h('p.warn.small', { hidden: true, role: 'alert' });
  const ta = h('textarea.p2p-ice-input', {
    rows: 2, spellcheck: false, value: iceText(initial), 'aria-label': 'ICE server',
    placeholder: 'stun:stun.example.org:3478\nturn:turn.example.org:3478 username password',
    onchange: () => { try { parseIceServers(ta.value); err.hidden = true; } catch (e) { err.textContent = e.message; err.hidden = false; } },
  });
  const el = h('details.p2p-ice', initial.length ? { open: true } : {},
    h('summary', icon('info', 14), 'Connection settings', initial.length ? h('span.tag', 'ICE server set') : null),
    h('p.muted.small', 'Without an ICE server, devices connect only on the same computer or local network. To connect across the internet, paste a STUN or TURN server you trust, such as one you run yourself. Slipstream has no servers and none are built in.'),
    h('label.field', h('span', 'ICE server (optional)'), ta), err,
    h('p.muted.small', 'It’s included in the invite so the other person uses it too. Calls and files stay end-to-end encrypted either way.'));
  return {
    el,
    /** Parsed servers; throws with a readable message. */
    value() {
      try { const v = parseIceServers(ta.value); err.hidden = true; return v; } catch (e) { err.textContent = e.message; err.hidden = false; el.open = true; throw e; }
    },
  };
}

function progressRow() {
  const bar = h('div.bar', h('i'));
  const label = h('p.prog-label', 'Waiting…');
  return {
    el: h('div.prog.p2p-prog', label, bar),
    set(p, verb = 'Sending') {
      bar.firstChild.style.width = `${Math.round((p.fraction || 0) * 100)}%`;
      if (p.phase === 'hash') label.textContent = `Preparing the file… ${Math.round(p.fraction * 100)}%`;
      else if (p.phase === 'verify') label.textContent = 'Checking the file…';
      else if (p.phase === 'done') label.textContent = `${fmtBytes(p.total)} checked`;
      else label.textContent = [`${verb} ${fmtBytes(p.done)} of ${fmtBytes(p.total)}`, p.rate ? `${fmtBytes(p.rate)}/s` : '', formatEta(p.eta)].filter(Boolean).join(' · ');
    },
    text(t) { label.textContent = t; },
  };
}

const ROUTE_LABEL = { local: 'On your network', direct: 'Direct', relay: 'Through your relay' };

/** Video tile for the stage. */
function tile(label, { self = false } = {}) {
  const video = h('video', { autoplay: true, playsInline: true, muted: self, hidden: true });
  const empty = h('div.room-empty', icon(self ? 'camera' : 'people', 22), h('span', self ? 'Your camera is off' : 'Waiting for video'));
  const name = h('span.room-name', label);
  const dot = h('span.p2p-dot');
  const el = h(`div.room-tile${self ? '.self' : ''}`, video, empty, h('div.room-label', dot, name));
  let stream = null;
  const update = () => {
    const live = !!stream?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
    video.hidden = !live;
    empty.hidden = live;
  };
  return {
    el,
    setStream(s) {
      if (s !== stream) { stream = s || null; video.srcObject = stream; }
      if (stream) video.play?.().catch(() => {});
      update();
    },
    setName(n) { name.textContent = n; },
    setStatus(kind) { dot.className = `p2p-dot${kind ? ` ${kind}` : ''}`; },
  };
}

/** Camera + mic selects with a level meter. `initial` = { camera?, mic? } MediaStreams (test hook). */
function devicePicker({ onChange = () => {}, initial = null } = {}) {
  const st = { cam: initial?.camera || null, mic: initial?.mic || null, meter: null, raf: 0 };
  const camSel = h('select', { 'aria-label': 'Camera', onchange: (e) => setCam(e.target.value) });
  const micSel = h('select', { 'aria-label': 'Microphone', onchange: (e) => setMic(e.target.value) });
  const level = h('div.level', h('i'));
  const askBtn = h('button.btn.small', { onclick: async () => { askBtn.disabled = true; await setCam('__ask'); await setMic('__ask'); askBtn.disabled = false; } }, icon('camera', 14), 'Turn on camera and mic');
  const startMeter = () => { st.meter?.close(); st.meter = null; if (st.mic) { try { st.meter = meter(st.mic); } catch { /* no audio context */ } } };
  startMeter();

  async function refresh() {
    let d = { cameras: [], mics: [], labelled: false };
    try { d = await listDevices(); } catch { /* no permission yet */ }
    const camId = st.cam?.getVideoTracks()[0]?.getSettings?.().deviceId;
    const micId = st.mic?.getAudioTracks()[0]?.getSettings?.().deviceId;
    const injectedCam = st.cam && initial?.camera === st.cam;
    const injectedMic = st.mic && initial?.mic === st.mic;
    fill(camSel, h('option', { value: '' }, 'No camera'),
      injectedCam ? h('option', { value: '__test', selected: true }, 'Test camera') : null,
      d.cameras.map((c, i) => h('option', { value: c.deviceId, selected: !injectedCam && !!st.cam && c.deviceId === camId }, c.label || `Camera ${i + 1}`)),
      d.labelled ? null : h('option', { value: '__ask' }, 'Allow camera access…'));
    fill(micSel, h('option', { value: '' }, 'No microphone'),
      injectedMic ? h('option', { value: '__test', selected: true }, 'Test microphone') : null,
      d.mics.map((c, i) => h('option', { value: c.deviceId, selected: !injectedMic && !!st.mic && c.deviceId === micId }, c.label || `Microphone ${i + 1}`)),
      d.labelled ? null : h('option', { value: '__ask' }, 'Allow microphone access…'));
    if (!st.cam) camSel.value = '';
    if (!st.mic) micSel.value = '';
    askBtn.hidden = !!(st.cam || st.mic);
  }
  async function setCam(id) {
    if (id === '__test') return;
    st.cam?.getTracks().forEach((t) => t.stop());
    st.cam = null;
    if (id) {
      try { st.cam = await openCamera(id === '__ask' ? undefined : id); } catch (err) { toast(`Camera unavailable: ${err.message}`, 'error'); }
    }
    await refresh();
    onChange();
  }
  async function setMic(id) {
    if (id === '__test') return;
    st.mic?.getTracks().forEach((t) => t.stop());
    st.mic = null;
    if (id) {
      try { st.mic = await openMic(id === '__ask' ? undefined : id); } catch (err) { toast(`Microphone unavailable: ${err.message}`, 'error'); }
    }
    startMeter();
    await refresh();
    onChange();
  }
  const loop = () => {
    level.firstChild.style.width = st.meter ? `${Math.round(st.meter.level() * 100)}%` : '0%';
    st.raf = requestAnimationFrame(loop);
  };
  loop();
  refresh();
  return {
    camSel, micSel, level, askBtn,
    get camera() { return st.cam; },
    get mic() { return st.mic; },
    stream() { return new MediaStream([...(st.cam?.getVideoTracks() || []), ...(st.mic?.getAudioTracks() || [])]); },
    lock(v) { camSel.disabled = v; micSel.disabled = v; askBtn.disabled = v; },
    cleanup() {
      cancelAnimationFrame(st.raf);
      st.meter?.close();
      for (const s of [st.cam, st.mic]) s?.getTracks().forEach((t) => t.stop());
    },
  };
}

function unsupported(root, title) {
  root.replaceChildren(h('div.p2p-page',
    h('header.topbar', h('div.tb-left', h('a.icon-btn', { href: '#/', title: 'Back' }, icon('back')), h('span.tb-title', title)), h('div.tb-center'), h('div.tb-right')),
    h('div.p2p-center', h('div.p2p-card', h('h3', 'Direct connections aren’t available here'), h('p.muted', 'This browser doesn’t support WebRTC. Use a recent Chrome, Edge, Firefox or Safari.'), h('a.btn', { href: '#/' }, 'Back to projects')))));
  return { cleanup() {} };
}

// ---- guest's local recording ------------------------------------------------------------------------
const TAKE_VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const TAKE_AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/**
 * Camera + mic recorded with MediaRecorder, kept in this tab (1 s chunks) until it is sent.
 * Chunks are hashed as they arrive, so the SHA-256 is ready the moment the take stops.
 */
class LocalTake {
  constructor(stream, name) {
    this.stream = stream;
    this.name = name;
    this.kind = stream.getVideoTracks().length ? 'camera' : 'mic';
    this.chunks = [];
    this.startedAt = 0; // clockNow() when the recorder actually started
    this.duration = 0;
    this.state = 'idle';
    this.hasher = createSha256();
    this.hashing = Promise.resolve();
    this.sha256 = '';
  }
  _chunk(blob) {
    if (!blob.size) return;
    this.chunks.push(blob);
    this.hashing = this.hashing.then(async () => { this.hasher?.update(new Uint8Array(await blob.arrayBuffer())); }).catch(() => { this.hasher = null; });
  }
  start() {
    const mimeType = pickMime(this.kind === 'camera' ? TAKE_VIDEO_TYPES : TAKE_AUDIO_TYPES);
    this.rec = new MediaRecorder(this.stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 });
    this.rec.ondataavailable = (e) => this._chunk(e.data);
    return new Promise((resolve, reject) => {
      this.rec.onstart = () => { this.startedAt = clockNow(); this._t = performance.now(); this.state = 'recording'; resolve(this.startedAt); };
      this.rec.onerror = (e) => reject(e.error || new Error('Recording failed.'));
      this.rec.start(1000);
    });
  }
  time() { return this._t ? ((this._end || performance.now()) - this._t) / 1000 : 0; }
  stop() {
    if (!this._stopping) {
      this._stopping = new Promise((resolve) => {
        const finish = async () => {
          this._end = this._end || performance.now();
          this.duration = this.time();
          this.state = 'stopped';
          this.stream.getTracks().forEach((t) => t.stop());
          await this.hashing;
          this.sha256 = this.hasher ? this.hasher.digestHex() : ''; // empty: hashed again before sending
          const type = this.rec?.mimeType || (this.kind === 'camera' ? 'video/webm' : 'audio/webm');
          resolve(new File(this.chunks, `${safeFileName(this.name, 'guest')}-${this.kind}.${ext(type)}`, { type }));
        };
        if (!this.rec || this.rec.state === 'inactive') { finish(); return; }
        this.rec.onstop = finish;
        this.rec.stop();
      });
    }
    return this._stopping;
  }
  discard() {
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch { /* ignore */ }
    this.stream.getTracks().forEach((t) => t.stop());
    this.chunks = [];
    this.state = 'stopped';
  }
}

// ---- host room ------------------------------------------------------------------------------------
/**
 * Host screen. onDone({ host: { screen, camera, cameraOffset, duration, mode }, guests: [{ name,
 * file, startOffset, kind, sha256, duration }] }). In "camera only" mode host.screen is the host's
 * camera + mic recording and host.camera is null. startOffset is seconds from the start of
 * host.screen to the start of the guest's file (positive = guest started later).
 * `media` = { camera?, mic? } MediaStreams to use instead of real devices (test hook).
 * Returns { cleanup }.
 */
export function showHostRoom(root, { onDone, media = null } = {}) {
  if (!p2pSupported()) return unsupported(root, 'Record with guests');
  const st = { mode: 'camera', display: null, slots: [], session: null, phase: 'setup', hostStart: 0, result: null, raf: 0, nextN: 1 };
  const selfTile = tile('You', { self: true });
  const stage = h('div.room-stage', selfTile.el);
  const picker = devicePicker({ initial: media, onChange: mediaChanged });
  const ice = iceSettings([]);
  const slotList = h('div.p2p-slots');
  const addBtn = h('button.btn.small', { onclick: () => addSlot() }, icon('plus', 14), 'Invite a guest');
  const controls = h('div.p2p-controls');

  function mediaChanged() {
    selfTile.setStream(picker.camera);
    selfTile.setStatus(picker.camera || picker.mic ? 'ok' : '');
    for (const s of st.slots) s.peer?.setMedia(picker.stream()).catch(() => {});
    renderControls();
  }

  const side = h('aside.rec-side.p2p-side',
    h('section', h('h4', icon('camera', 14), 'Your camera and mic'), picker.askBtn, picker.camSel, picker.micSel, picker.level),
    h('section', h('h4', icon('people', 14), 'Guests'), h('p.muted.small', 'Each guest records on their own device at full quality. After you stop, their file comes straight to you.'), slotList, addBtn),
    h('section', ice.el),
    controls,
    h('p.muted.small.center', icon('lock', 12), 'Calls and files go directly between browsers, encrypted. Nothing is uploaded.'));
  root.replaceChildren(h('div.rec.p2p-room',
    h('header.topbar', h('div.tb-left', h('button.icon-btn', { title: 'Back', onclick: () => { location.hash = '#/'; } }, icon('back')), h('span.tb-title', 'Record with guests')), h('div.tb-center'), h('div.tb-right')),
    h('div.rec-grid', h('div.rec-preview.p2p-stage-wrap', stage), side)));
  mediaChanged();

  // ---- guest slots ----
  function addSlot() {
    if (st.slots.length >= MAX_GUESTS) return;
    const n = st.nextN++;
    const slot = { n, name: `Guest ${n}`, peer: null, state: 'new', error: '', code: '', route: null, clock: null, recording: 'idle', startedAt: null, file: null, meta: null, startOffset: null, skipped: false, tile: tile(`Guest ${n}`), progress: progressRow(), el: h('div.p2p-slot') };
    st.slots.push(slot);
    slotList.append(slot.el);
    stage.append(slot.tile.el);
    addBtn.hidden = st.slots.length >= MAX_GUESTS;
    invite(slot);
  }

  function removeSlot(slot) {
    slot.peer?.close();
    slot.el.remove();
    slot.tile.el.remove();
    st.slots = st.slots.filter((s) => s !== slot);
    addBtn.hidden = st.slots.length >= MAX_GUESTS || st.phase !== 'setup';
    renderControls();
  }

  async function invite(slot) {
    let iceServers;
    try { iceServers = ice.value(); } catch { slot.error = 'Fix the ICE server under “Connection settings” first.'; setSlot(slot, 'failed'); return; }
    slot.peer?.close();
    slot.error = '';
    slot.route = null;
    setSlot(slot, 'creating');
    let peer;
    try { peer = createHost({ iceServers, media: picker.stream(), purpose: 'call' }); } catch (err) { slot.error = err.message; setSlot(slot, 'failed'); return; }
    slot.peer = peer;
    const live = (fn) => (...a) => { if (slot.peer === peer) fn(...a); };
    peer.on('track', live((s) => slot.tile.setStream(s)));
    peer.on('ready', live(() => onReady(slot)));
    peer.on('state', live((s) => onPeerState(slot, s)));
    peer.on('clock', live((c) => { slot.clock = c; }));
    peer.onJSON(live((m) => onGuestMessage(slot, m)));
    peer.on('file-start', live(() => setSlot(slot, 'receiving')));
    peer.on('file-progress', live((p) => slot.progress.set(p, 'Receiving')));
    peer.on('file', live(({ file, meta }) => onGuestFile(slot, file, meta)));
    peer.on('file-error', live(({ error, resumable }) => {
      slot.error = `${error.message}${resumable ? ' It resumes when the guest sends it again.' : ''}`;
      setSlot(slot, 'waiting');
    }));
    peer.on('bye', live(() => { if (!slot.file) { slot.error = 'The guest left.'; setSlot(slot, 'closed'); } }));
    try {
      slot.code = await peer.createInvite();
      if (slot.peer === peer) setSlot(slot, 'invite');
    } catch (err) {
      slot.error = `Couldn’t create an invite: ${err.message}`;
      setSlot(slot, 'failed');
    }
  }

  function onReady(slot) {
    slot.name = slot.peer.remoteName || slot.name;
    slot.tile.setName(slot.name);
    setSlot(slot, slotStateFor(slot));
    slot.peer.sendJSON({ type: 'hello', state: st.phase === 'setup' ? 'idle' : st.phase === 'recording' ? 'recording' : 'stopped' });
    slot.peer.syncClock(6).catch(() => {});
    slot.peer.route().then((r) => { slot.route = r; renderSlot(slot); });
    reconcile(slot);
    renderControls();
  }

  function slotStateFor(slot) {
    if (slot.file) return 'received';
    if (slot.state === 'receiving') return 'receiving';
    return { recording: 'recording', stopped: 'waiting' }[slot.recording] || 'connected';
  }

  /** Bring a (re)connected guest in line with the host: start late joiners, stop stragglers. */
  function reconcile(slot) {
    if (!slot.peer?.ready) return;
    if (st.phase === 'recording' && slot.recording === 'idle') slot.peer.sendJSON({ type: 'start-recording', at: clockNow() });
    if (st.phase !== 'setup' && st.phase !== 'recording' && slot.recording === 'recording') slot.peer.sendJSON({ type: 'stop-recording', at: clockNow() });
  }

  function onPeerState(slot, s) {
    // The guest's connectivity checks can reach us before their answer is pasted: ignore until then.
    if (slot.state === 'invite' || slot.state === 'creating') return;
    if (s === 'disconnected' && !slot.file) { slot.error = 'Connection interrupted. Trying to reconnect…'; renderSlot(slot); } else if (s === 'connected' && slot.error.startsWith('Connection interrupted')) { slot.error = ''; renderSlot(slot); } else if (s === 'failed' && !slot.file) {
      slot.error = `The connection failed. ${NO_ICE_HINT}`;
      setSlot(slot, 'failed');
    } else if (s === 'closed' && !slot.file && slot.state !== 'failed') {
      slot.error = slot.error || 'The connection closed.';
      setSlot(slot, 'closed');
    }
    renderControls();
  }

  function onGuestMessage(slot, m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello') {
      if (typeof m.name === 'string' && m.name.trim()) { slot.name = m.name.trim().slice(0, 60); slot.tile.setName(slot.name); }
      if (['idle', 'recording', 'stopped', 'sent'].includes(m.state)) slot.recording = m.state === 'sent' ? 'stopped' : m.state;
      if (Number.isFinite(m.startedAt)) slot.startedAt = m.startedAt;
      reconcile(slot);
      setSlot(slot, slotStateFor(slot));
    } else if (m.type === 'recording-started') {
      slot.recording = 'recording';
      if (Number.isFinite(m.startedAt)) slot.startedAt = m.startedAt;
      setSlot(slot, 'recording');
      // A second estimate right after the start keeps the offset honest on long sessions.
      slot.peer?.syncClock(4).catch(() => {});
    } else if (m.type === 'recording-stopped') {
      slot.recording = 'stopped';
      if (!slot.file) setSlot(slot, 'waiting');
    } else if (m.type === 'recording-error') {
      slot.error = `Their recording didn’t start: ${String(m.message || 'unknown error').slice(0, 200)}`;
      toast(`${slot.name}: ${slot.error}`, 'error', 6000);
      renderSlot(slot);
    }
    renderControls();
  }

  function onGuestFile(slot, file, meta) {
    slot.file = file;
    slot.meta = meta;
    const guestStart = Number.isFinite(meta.extra?.startedAt) ? meta.extra.startedAt : slot.startedAt;
    const offset = (slot.peer?.clock || slot.clock)?.offset || 0;
    slot.startOffset = Number.isFinite(guestStart) && st.hostStart ? Math.round(startOffsetSeconds({ hostStart: st.hostStart, guestStart, offset }) * 1000) / 1000 : 0;
    slot.error = '';
    setSlot(slot, 'received');
    renderControls();
  }

  function setSlot(slot, state) { slot.state = state; renderSlot(slot); }

  function renderSlot(slot) {
    const remove = st.phase === 'setup' ? h('button.icon-btn', { title: `Remove ${slot.name}`, 'aria-label': `Remove ${slot.name}`, onclick: () => removeSlot(slot) }, icon('x', 14)) : null;
    const status = {
      new: ['', 'Preparing…'], creating: ['wait', 'Creating invite…'], invite: ['wait', 'Waiting for their answer'], connecting: ['wait', 'Connecting…'],
      connected: ['ok', 'Connected'], recording: ['rec', 'Recording on their device'], waiting: ['wait', 'Waiting for their recording'],
      receiving: ['ok', 'Receiving their recording'], received: ['ok', 'Received and checked'], failed: ['bad', 'Not connected'], closed: ['bad', 'Disconnected'],
    }[slot.state] || ['', slot.state];
    slot.tile.setStatus(status[0]);
    const head = h('div.p2p-slot-head', h('span.p2p-dot', { class: status[0] }), h('b', slot.name), h('span.muted.small', status[1]),
      slot.route && ['connected', 'recording', 'waiting', 'receiving'].includes(slot.state) ? h('span.tag', ROUTE_LABEL[slot.route] || slot.route) : null, h('span.grow-x'), remove);
    const err = slot.error ? h('p.warn.small', slot.error) : null;
    let body = null;
    if (slot.state === 'creating' || slot.state === 'new') {
      body = h('p.muted.small.row', h('span.mini-spin'), 'Gathering connection details…');
    } else if (slot.state === 'invite') {
      body = h('div.stack',
        h('ol.p2p-steps',
          h('li', h('span', 'Send this link to your guest in any chat app.'), codeBlock(slot.code, { route: 'guest', label: `Invite for ${slot.name}` })),
          h('li', pasteBox({ label: 'Paste the answer code they send back', placeholder: 'S1…', button: 'Connect', onSubmit: async (text) => { await slot.peer.accept(text); setSlot(slot, 'connecting'); slowHint(slot); } }))));
    } else if (slot.state === 'connecting') {
      body = h('p.muted.small.row', h('span.mini-spin'), 'Connecting directly…');
    } else if (slot.state === 'receiving') {
      body = slot.progress.el;
    } else if (slot.state === 'received') {
      body = h('p.muted.small', `${fmtBytes(slot.file.size)} · ${slot.meta.kind === 'mic' ? 'audio only' : 'camera and mic'}${Math.abs(slot.startOffset) >= 0.01 ? ` · starts ${Math.abs(slot.startOffset).toFixed(2)} s ${slot.startOffset > 0 ? 'after' : 'before'} yours` : ' · in sync with yours'}`);
    } else if (slot.state === 'failed' || slot.state === 'closed') {
      body = h('div.row',
        h('button.btn.small', { onclick: () => invite(slot) }, 'New invite'),
        st.phase === 'collecting' && !slot.file && !slot.skipped ? h('button.btn.small.ghost', { onclick: () => { slot.skipped = true; renderSlot(slot); renderControls(); } }, 'Continue without them') : null);
    } else if (slot.state === 'waiting' && st.phase === 'collecting') {
      body = h('p.muted.small', 'Their file is sent as soon as their recording stops.');
    }
    fill(slot.el, head, err, body);
  }

  function slowHint(slot) {
    const peer = slot.peer;
    setTimeout(() => {
      if (slot.peer === peer && slot.state === 'connecting') { slot.error = `Still connecting. ${NO_ICE_HINT}`; renderSlot(slot); }
    }, SLOW_CONNECT_MS);
  }

  // ---- recording ----
  function ready() { return st.slots.filter((s) => s.peer?.ready); }

  function renderControls() {
    if (st.phase === 'setup') {
      const n = ready().length;
      const needCam = st.mode === 'camera' && !picker.camera;
      const needScreen = st.mode === 'screen' && !st.display;
      const hint = !n ? 'Connect at least one guest to start.' : needCam ? 'Turn on your camera, or choose “Screen + camera”.' : needScreen ? 'Choose what to share first.' : `Starts recording here and on ${n === 1 ? 'your guest’s device' : `${n} guest devices`}.`;
      const screenRow = st.mode === 'screen'
        ? h('div.row.between', h('span.muted.small', st.display ? (st.display.getVideoTracks()[0]?.label || 'Screen selected') : 'Nothing selected'), h('button.btn.small', { onclick: chooseScreen }, st.display ? 'Change' : 'Choose screen…'))
        : null;
      fill(controls,
        h('section', h('h4', icon('record', 14), 'Your recording'),
          segmented([['camera', 'Camera only'], ['screen', 'Screen + camera']], st.mode, (v) => { st.mode = v; renderControls(); }),
          screenRow),
        h('button.btn.record.wide', { disabled: !n || needCam || needScreen, onclick: startRecording }, icon('record', 16), 'Start recording'),
        h('p.muted.small.center', hint));
    } else if (st.phase === 'recording') {
      const time = h('span.hud-time', fmtTime(st.session?.time() || 0));
      fill(controls, h('div.hud',
        h('div.hud-top', h('span.rec-dot'), time),
        h('p.muted.small', `Recording here and on ${st.slots.filter((s) => s.recording === 'recording').length || 'your'} guest device${st.slots.filter((s) => s.recording === 'recording').length === 1 ? '' : 's'}.`),
        h('button.btn.record', { onclick: () => stopRecording() }, icon('stop', 15), 'Stop')));
      const tick = () => {
        if (st.phase !== 'recording') return;
        time.textContent = fmtTime(st.session.time());
        st.raf = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(st.raf);
      tick();
    } else if (st.phase === 'stopping') {
      fill(controls, h('div.hud', h('p.muted.row', h('span.mini-spin'), 'Saving your recording…')));
    } else if (st.phase === 'collecting') {
      const takers = st.slots.filter((s) => s.recording !== 'idle' || s.file);
      const pending = takers.filter((s) => !s.file && !s.skipped);
      const got = takers.filter((s) => s.file);
      fill(controls, h('div.hud',
        h('p', h('b', pending.length ? 'Collecting guest recordings' : 'Everything is here')),
        h('p.muted.small', pending.length ? `${got.length} of ${takers.length} received. Keep this tab open until they arrive.` : `Your recording${got.length ? ` and ${got.length} guest file${got.length === 1 ? '' : 's'}` : ''}, checked and ready.`),
        st.result ? null : h('p.warn.small', 'Your own recording couldn’t be saved, so there’s nothing to open. Guest files can still be downloaded.'),
        onDone ? h('button.btn.primary.wide', { disabled: !!pending.length || !st.result, onclick: finish }, 'Open in editor') : null,
        pending.length && onDone ? h('button.btn.ghost.small', { onclick: async () => { if (await confirmDialog('Continue without them?', `${pending.map((s) => s.name).join(', ')} won’t be in the project. Their recording stays on their device.`, 'Continue')) finish(); } }, 'Continue without waiting') : null,
        !onDone || got.length || !st.result ? h('div.row', st.result ? h('button.btn.small', { onclick: () => downloadFile(st.result.screen, st.result.screen.name) }, icon('download', 14), 'Your recording') : null,
          st.result?.camera ? h('button.btn.small', { onclick: () => downloadFile(st.result.camera, st.result.camera.name) }, icon('download', 14), 'Your camera') : null,
          got.map((s) => h('button.btn.small', { onclick: () => downloadFile(s.file, s.file.name) }, icon('download', 14), s.name))) : null));
    }
  }

  async function chooseScreen() {
    try {
      const d = await pickDisplay({ systemAudio: true });
      st.display?.getTracks().forEach((t) => t.stop());
      st.display = d;
      d.getVideoTracks()[0]?.addEventListener('ended', () => { if (st.phase === 'setup' && st.display === d) { st.display = null; renderControls(); } });
      renderControls();
    } catch (err) { if (err.name !== 'NotAllowedError') toast(err.message, 'error'); }
  }

  async function startRecording() {
    const guests = ready();
    if (!guests.length) return;
    const cam = picker.camera, mic = picker.mic;
    if (st.mode === 'camera' && !cam) return;
    if (st.mode === 'screen' && !st.display) return;
    st.phase = 'starting';
    fill(controls, h('div.hud', h('p.muted.row', h('span.mini-spin'), 'Syncing clocks…')));
    await Promise.all(guests.map((s) => s.peer.syncClock(4).catch(() => null)));
    // The recorder gets clones so stopping it doesn't cut the live call.
    const display = st.mode === 'screen' ? st.display : cloneStream(cam.getVideoTracks());
    const session = new Session({ display, camera: st.mode === 'screen' && cam ? cloneStream(cam.getVideoTracks()) : null, mic: mic ? cloneStream(mic.getAudioTracks()) : null });
    st.session = session;
    st.hostStart = clockNow(); // replaced by the recorder's own start time below
    session.onstarted = () => { st.hostStart = performance.timeOrigin + session.startedAt.screen; };
    session.onstop = () => stopRecording();
    try { session.start(); } catch (err) {
      st.phase = 'setup';
      st.session = null;
      toast(`Couldn’t start recording: ${err.message}`, 'error', 6000);
      renderControls();
      return;
    }
    st.phase = 'recording';
    for (const s of guests) { try { s.peer.sendJSON({ type: 'start-recording', at: clockNow() }); } catch { /* reconciled on reconnect */ } }
    picker.lock(true);
    addBtn.hidden = true;
    guardUnload(true);
    st.slots.forEach(renderSlot);
    renderControls();
  }

  async function stopRecording() {
    if (st.phase !== 'recording') return;
    st.phase = 'stopping';
    for (const s of st.slots) if (s.peer?.ready) { try { s.peer.sendJSON({ type: 'stop-recording', at: clockNow() }); } catch { /* reconciled on reconnect */ } }
    renderControls();
    try {
      const res = await st.session.stop();
      const base = st.mode === 'screen' ? 'host-screen' : 'host-camera';
      st.result = {
        screen: new File([res.screen], `${base}.${ext(res.screen.type)}`, { type: res.screen.type || 'video/webm' }),
        camera: res.camera ? new File([res.camera], `host-camera.${ext(res.camera.type)}`, { type: res.camera.type || 'video/webm' }) : null,
        cameraOffset: res.cameraOffset,
        duration: res.duration,
        mode: st.mode,
      };
    } catch (err) {
      toast(`Couldn’t save your recording: ${err.message}`, 'error', 8000);
    }
    st.phase = 'collecting';
    picker.lock(false);
    st.slots.forEach(renderSlot);
    renderControls();
  }

  function finish() {
    if (!st.result) return;
    guardUnload(false);
    const guests = st.slots.filter((s) => s.file).map((s) => ({
      name: s.name, file: s.file, startOffset: s.startOffset ?? 0, kind: s.meta.kind, sha256: s.meta.sha256,
      duration: Number.isFinite(s.meta.extra?.duration) ? s.meta.extra.duration : null,
    }));
    for (const s of st.slots) { try { s.peer?.sendJSON({ type: 'done', received: !!s.file }); } catch { /* gone */ } }
    onDone?.({ host: st.result, guests });
  }

  addSlot();
  renderControls();

  return {
    cleanup() {
      cancelAnimationFrame(st.raf);
      guardUnload(false);
      if (st.session && st.session.state !== 'stopped') st.session.discard();
      for (const s of st.slots) s.peer?.close();
      picker.cleanup();
      st.display?.getTracks().forEach((t) => t.stop());
      clearPartials();
    },
  };
}

// ---- guest room -----------------------------------------------------------------------------------
/**
 * Guest screen for an invite `code` (may be empty: the guest pastes it). onDone() when they leave.
 * `media` = { camera?, mic? } MediaStreams to use instead of real devices (test hook). Returns { cleanup }.
 */
export function showGuestRoom(root, code, { onDone, media = null } = {}) {
  if (!p2pSupported()) return unsupported(root, 'Join a recording');
  const st = { code: code || '', invite: null, peer: null, phase: code ? 'reading' : 'paste', error: '', name: loadName(), take: null, file: null, sha256: '', sending: false, sent: false, sendError: '', route: null, hostDone: false, left: '' };
  const hostTile = tile('Host');
  const selfTile = tile('You', { self: true });
  const stage = h('div.room-stage', hostTile.el, selfTile.el);
  const picker = devicePicker({ initial: media, onChange: () => { selfTile.setStream(picker.camera); selfTile.setStatus(picker.camera || picker.mic ? 'ok' : ''); st.peer?.setMedia(picker.stream()).catch(() => {}); } });
  selfTile.setStream(picker.camera);
  let ice = iceSettings([]);
  const progress = progressRow();
  const panel = h('div.p2p-panel');
  const side = h('aside.rec-side.p2p-side', panel,
    h('div.p2p-note', icon('lock', 14), h('span', 'Your recording stays on this device until it is sent directly to the host. Nothing is uploaded.')));
  root.replaceChildren(h('div.rec.p2p-room',
    h('header.topbar', h('div.tb-left', h('button.icon-btn', { title: 'Leave', onclick: leave }, icon('back')), h('span.tb-title', 'Join a recording')), h('div.tb-center'), h('div.tb-right')),
    h('div.rec-grid', h('div.rec-preview.p2p-stage-wrap', stage), side)));

  const devices = () => h('section', h('h4', icon('camera', 14), 'Your camera and mic'), picker.askBtn, picker.camSel, picker.micSel, picker.level);

  function render() {
    const err = st.error ? h('p.warn.small', { role: 'alert' }, st.error) : null;
    if (st.phase === 'paste') {
      fill(panel, h('section', h('h4', icon('people', 14), 'Join a recording'),
        h('p.muted.small', 'Paste the invite link or code the host sent you.'),
        pasteBox({ label: 'Invite', placeholder: 'S1… or a link', button: 'Continue', onSubmit: async (text) => { await readCode(text); } })), err);
    } else if (st.phase === 'reading') {
      fill(panel, h('p.muted.row', h('span.mini-spin'), 'Reading the invite…'));
    } else if (st.phase === 'setup') {
      const nameInput = h('input', { type: 'text', value: st.name, maxLength: 60, placeholder: 'So the host knows who you are', oninput: (e) => { st.name = e.target.value; } });
      fill(panel,
        h('section', h('h4', icon('people', 14), st.invite.name ? `Join ${st.invite.name}’s recording` : 'Join the recording'),
          h('p.muted.small', 'You’ll see each other live. When the host starts recording, your camera and mic are recorded on this device at full quality, then sent straight to the host.'),
          h('label.field', h('span', 'Your name'), nameInput)),
        devices(),
        h('section', ice.el),
        err,
        h('button.btn.primary.wide', { onclick: answer }, 'Create answer code'));
    } else if (st.phase === 'answering') {
      fill(panel, h('p.muted.row', h('span.mini-spin'), 'Preparing your answer…'));
    } else if (st.phase === 'answer') {
      fill(panel,
        h('section', h('h4', icon('share', 14), 'Send this code back to the host'),
          h('p.muted.small', 'Paste it into the same chat. The call starts as soon as the host enters it.'),
          codeBlock(st.peer.answerCode, { label: 'Answer code' }),
          h('p.muted.small.row', h('span.mini-spin'), 'Waiting for the host…')),
        err,
        devices(),
        h('button.btn.ghost.small', { onclick: () => { st.peer?.close(); st.peer = null; st.phase = 'setup'; render(); } }, 'Start over'));
    } else if (st.phase === 'connected' || st.phase === 'left') {
      // Offer to reconnect only while something is still owed: a running take, an unsent file, or no take yet.
      const owed = st.take?.state === 'recording' || (st.file && !st.sent) || (!st.take && !st.hostDone);
      fill(panel, h('section', statusBlock()), err, takeBlock(), st.take?.state === 'recording' || st.phase === 'left' ? null : devices(), st.phase === 'left' && owed ? rejoinBlock() : null,
        h('button.btn.ghost.small', { onclick: leave }, st.sent || !st.file ? 'Leave' : 'Leave without sending'));
    }
  }

  function statusBlock() {
    if (st.phase === 'left') {
      return st.sent || st.hostDone
        ? [h('h4', h('span.p2p-dot'), 'Session ended'), h('p.muted.small', st.left || 'The host closed the session.')]
        : [h('h4', h('span.p2p-dot.bad'), 'Not connected'), h('p.muted.small', st.left || 'The connection ended.')];
    }
    const who = st.invite?.name || 'the host';
    return [h('h4', h('span.p2p-dot.ok'), `Connected to ${who}`, st.route ? h('span.tag', ROUTE_LABEL[st.route] || st.route) : null)];
  }

  function takeBlock() {
    const t = st.take;
    if (!t) return h('section', h('p.muted.small', st.hostDone ? 'The host has finished. You can close this tab.' : 'The host starts the recording. You’ll see a red dot here while this device is recording.'));
    if (t.state === 'recording') {
      const time = h('span.hud-time', fmtTime(t.time()));
      const tick = () => { if (t.state !== 'recording' || !time.isConnected) return; time.textContent = fmtTime(t.time()); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      // Normally the host stops everyone; if the host is gone, the guest can stop their own take.
      return h('div.hud', h('div.hud-top', h('span.rec-dot'), time), h('p.muted.small', `Recording your ${t.kind === 'camera' ? 'camera and mic' : 'mic'} on this device.`),
        st.phase === 'left' ? h('button.btn.record', { onclick: () => stopTake() }, icon('stop', 15), 'Stop recording') : null);
    }
    const download = st.file ? h('button.btn.small', { onclick: () => downloadFile(st.file, st.file.name) }, icon('download', 14), 'Download my copy') : null;
    if (!st.file) return h('div.hud', h('p.muted.row', h('span.mini-spin'), 'Finishing your recording…'));
    if (st.sent) {
      return h('div.hud', h('p.row', h('span.p2p-ok', icon('check', 16)), h('b', 'Sent and checked')),
        h('p.muted.small', `The host has an exact copy of your ${fmtBytes(st.file.size)} recording.${st.hostDone ? ' You can close this tab.' : ''}`), download);
    }
    if (st.sending) return h('div.hud', h('p', h('b', 'Sending to the host')), progress.el, h('p.muted.small', 'Keep this tab open until it’s done.'), download);
    const retry = st.peer?.ready ? h('button.btn.small.primary', { onclick: sendRecording }, 'Try again') : null;
    return h('div.hud', h('p', h('b', 'Your recording is ready')),
      st.sendError ? h('p.warn.small', st.sendError) : h('p.muted.small', st.peer?.ready ? 'Sending…' : 'It will be sent when you reconnect to the host. You can also download it and send it another way.'),
      h('div.row', retry, download));
  }

  function rejoinBlock() {
    return h('section', h('h4', icon('people', 14), 'Reconnect'),
      h('p.muted.small', 'Ask the host for a new invite. Your recording is kept and sent once you’re connected again.'),
      pasteBox({ label: 'New invite', placeholder: 'S1… or a link', button: 'Continue', onSubmit: async (text) => { await readCode(text); } }));
  }

  async function readCode(text) {
    const inv = await readInvite(text, 'call');
    st.code = text;
    st.invite = inv;
    ice = iceSettings(inv.ice);
    st.error = '';
    st.phase = 'setup';
    hostTile.setName(inv.name || 'Host');
    render();
  }

  async function answer() {
    let iceServers;
    try { iceServers = ice.value(); } catch { return; }
    st.name = st.name.trim();
    saveName(st.name);
    st.error = '';
    st.phase = 'answering';
    render();
    try {
      const peer = await joinAsGuest(st.code, { iceServers, media: picker.stream(), name: st.name || 'Guest', purpose: 'call' });
      st.peer = peer;
      wirePeer(peer);
      st.phase = 'answer';
    } catch (err) {
      st.error = err.message;
      st.phase = 'setup';
    }
    render();
  }

  function wirePeer(peer) {
    const live = (fn) => (...a) => { if (st.peer === peer) fn(...a); };
    peer.on('track', live((s) => { hostTile.setStream(s); hostTile.setStatus('ok'); }));
    peer.on('ready', live(() => {
      st.phase = 'connected';
      st.left = '';
      st.error = '';
      peer.sendJSON({ type: 'hello', name: st.name || 'Guest', state: st.sent ? 'sent' : st.take ? (st.take.state === 'recording' ? 'recording' : 'stopped') : 'idle', startedAt: st.take?.startedAt || null });
      peer.route().then(live((r) => { st.route = r; render(); }));
      render();
      if (st.file && !st.sent) sendRecording();
    }));
    peer.on('state', live((s) => {
      if (s === 'disconnected' && st.phase === 'connected') { st.error = 'Connection interrupted. Trying to reconnect…'; render(); } else if (s === 'connected' && st.error.startsWith('Connection interrupted')) { st.error = ''; render(); } else if ((s === 'failed' || s === 'closed') && (st.phase === 'connected' || st.phase === 'answer')) {
        st.left = st.left || (s === 'failed' ? `The connection failed. ${NO_ICE_HINT.replace('create a new invite', 'ask the host for a new invite')}` : 'The connection closed.');
        st.phase = 'left';
        st.error = '';
        hostTile.setStatus('bad');
        render();
      }
    }));
    peer.on('bye', live(() => { st.left = st.hostDone ? 'The host has finished.' : 'The host ended the session.'; }));
    peer.onJSON(live(onHostMessage));
  }

  async function onHostMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'start-recording' && !st.take) await startTake();
    else if (m.type === 'stop-recording' && st.take?.state === 'recording') await stopTake();
    else if (m.type === 'done') { st.hostDone = true; if (m.received) { st.sent = true; guardUnload(false); } render(); }
  }

  async function startTake() {
    const stream = cloneStream([...(picker.camera?.getVideoTracks() || []), ...(picker.mic?.getAudioTracks() || [])]);
    if (!stream) {
      st.peer?.sendJSON({ type: 'recording-error', message: 'They have no camera or microphone turned on.' });
      toast('The host started recording, but your camera and mic are off', 'error', 6000);
      return;
    }
    st.take = new LocalTake(stream, st.name || 'guest');
    try {
      const startedAt = await st.take.start();
      st.peer?.sendJSON({ type: 'recording-started', startedAt, kind: st.take.kind });
      picker.lock(true);
      guardUnload(true);
    } catch (err) {
      st.take.discard();
      st.take = null;
      st.peer?.sendJSON({ type: 'recording-error', message: err.message });
      toast(`Couldn’t start recording: ${err.message}`, 'error', 6000);
    }
    render();
  }

  async function stopTake() {
    if (st.take?.state !== 'recording' || st.stopping) return;
    st.stopping = true;
    render();
    st.file = await st.take.stop();
    st.sha256 = st.take.sha256;
    picker.lock(false);
    try { st.peer?.sendJSON({ type: 'recording-stopped', duration: st.take.duration }); } catch { /* reconnect resends state */ }
    render();
    sendRecording();
  }

  async function sendRecording() {
    if (!st.file || st.sending || st.sent) return;
    if (!st.peer?.ready) { render(); return; }
    st.sending = true;
    st.sendError = '';
    progress.text('Preparing the file…');
    render();
    try {
      if (!st.sha256) st.sha256 = await sha256Blob(st.file, (done, total) => progress.set({ phase: 'hash', done, total, fraction: total ? done / total : 1 }));
      await st.peer.sendFile(st.file, {
        name: st.file.name, type: st.file.type, kind: st.take.kind, sha256: st.sha256,
        extra: { startedAt: st.take.startedAt, duration: st.take.duration, name: st.name || 'Guest' },
      }, (p) => progress.set(p, 'Sending'));
      st.sent = true;
      guardUnload(false);
    } catch (err) {
      st.sendError = err.message;
      if (err.reason === 'checksum') st.sha256 = ''; // re-hash from the file before trying again
    } finally {
      st.sending = false;
      render();
    }
  }

  async function leave() {
    if (st.take?.state === 'recording' || (st.file && !st.sent)) {
      if (!(await confirmDialog('Leave without sending?', 'Your recording hasn’t reached the host. Download your copy first if you want to keep it.', 'Leave'))) return;
    }
    st.peer?.close();
    if (onDone) onDone(); else location.hash = '#/';
  }

  if (st.phase === 'reading') {
    readCode(st.code).catch((err) => { st.error = err.message; st.phase = 'paste'; render(); });
  }
  render();

  return {
    cleanup() {
      guardUnload(false);
      st.take?.state === 'recording' && st.take.discard();
      st.peer?.close();
      picker.cleanup();
    },
  };
}

// ---- send to another device (S-05) ---------------------------------------------------------------
/**
 * Modal: send `blob` straight to another browser running Slipstream Web. The other device opens
 * #/receive/<code>, answers, and the file is sent and checked with SHA-256. Returns { close }.
 */
export function sendToDeviceDialog(blob, name = blob?.name || 'file', { kind } = {}) {
  if (!p2pSupported()) { toast('This browser doesn’t support direct connections (WebRTC)', 'error'); return { close() {} }; }
  const fileName = safeFileName(name);
  const fileKind = kind || (/\.slipstream$/i.test(fileName) ? 'project' : 'export');
  const body = h('div.stack.p2p-send');
  let peer = null, sha256 = '', done = false, sending = false;
  const m = modal('Send to another device', body, { onClose: () => { guardUnload(false); if (sending) peer?.cancelSend(); peer?.close(); } });
  const ice = iceSettings([]);
  const progress = progressRow();
  const intro = h('p.muted', `Send “${fileName}” (${fmtBytes(blob.size)}) straight to another device that has Slipstream Web open. It travels directly between the two browsers, encrypted, and is never uploaded. Keep this window open until it arrives.`);

  const start = () => fill(body, intro, ice.el, h('button.btn.primary.wide', { onclick: create }, icon('share', 16), 'Create link'));

  async function create() {
    let iceServers;
    try { iceServers = ice.value(); } catch { return; }
    fill(body, intro, h('p.muted.row', h('span.mini-spin'), 'Creating link…'));
    try {
      peer = createHost({ iceServers, purpose: 'send' });
      peer.on('ready', () => send());
      peer.on('state', (s) => {
        if ((s === 'failed' || s === 'closed') && !done) {
          fill(body, h('p.warn', s === 'failed' ? `The connection failed. ${NO_ICE_HINT.replace('create a new invite', 'create a new link')}` : 'The other device disconnected.'), h('div.row.end', h('button.btn.primary', { onclick: () => { peer?.close(); peer = null; start(); } }, 'Start over')));
          sending = false;
          guardUnload(false);
        }
      });
      const code = await peer.createInvite({ extra: { f: { name: fileName, size: blob.size, type: blob.type || '' } } });
      fill(body,
        h('ol.p2p-steps',
          h('li', h('span', 'On the other device, open this link (or open Slipstream Web there and paste the code).'), codeBlock(code, { route: 'receive', label: 'Link for the other device' })),
          h('li', pasteBox({ label: 'Paste the answer code it shows', placeholder: 'S1…', button: 'Connect', onSubmit: async (text) => { await peer.accept(text); fill(body, h('p.muted.row', h('span.mini-spin'), 'Connecting directly…')); } }))));
    } catch (err) {
      fill(body, h('p.warn', `Couldn’t create a link: ${err.message}`), h('div.row.end', h('button.btn', { onclick: start }, 'Back')));
    }
  }

  async function send() {
    if (sending || done) return;
    sending = true;
    guardUnload(true);
    progress.text('Preparing the file…');
    fill(body, h('p', h('b', `Sending “${fileName}”`)), progress.el);
    try {
      if (!sha256) sha256 = await sha256Blob(blob, (d, t) => progress.set({ phase: 'hash', done: d, total: t, fraction: t ? d / t : 1 }));
      await peer.sendFile(blob, { name: fileName, type: blob.type, kind: fileKind, sha256 }, (p) => progress.set(p, 'Sending'));
      done = true;
      fill(body, h('p.row', h('span.p2p-ok', icon('check', 16)), h('b', 'Sent and checked')), h('p.muted', 'The other device has an exact copy (SHA-256 verified).'), h('div.row.end', h('button.btn.primary', { onclick: () => m.close() }, 'Done')));
    } catch (err) {
      fill(body, h('p.warn', err.message), h('div.row.end', peer?.ready ? h('button.btn.primary', { onclick: () => send() }, 'Try again') : h('button.btn', { onclick: () => { peer?.close(); peer = null; start(); } }, 'Start over')));
    } finally {
      sending = false;
      guardUnload(false);
    }
  }

  start();
  return m;
}

/**
 * Receiving side of sendToDeviceDialog, for the #/receive/<code> route. Offers a download of the
 * checked file; `onFile(file, meta)` adds an "Open in Slipstream" button (e.g. to import a
 * .slipstream project). Returns { cleanup }.
 */
export function showReceive(root, code, { onFile, onDone } = {}) {
  if (!p2pSupported()) return unsupported(root, 'Receive a file');
  const st = { code: code || '', invite: null, peer: null, phase: code ? 'reading' : 'paste', error: '', file: null, meta: null };
  let ice = iceSettings([]);
  const progress = progressRow();
  const card = h('div.p2p-card');
  const back = () => { if (onDone) onDone(); else location.hash = '#/'; };
  root.replaceChildren(h('div.p2p-page',
    h('header.topbar', h('div.tb-left', h('button.icon-btn', { title: 'Back', onclick: back }, icon('back')), h('span.tb-title', 'Receive a file')), h('div.tb-center'), h('div.tb-right')),
    h('div.p2p-center', card)));

  function render() {
    const err = st.error ? h('p.warn.small', { role: 'alert' }, st.error) : null;
    const f = st.invite?.file;
    const what = f ? h('div.p2p-file', icon('file', 18), h('div', h('b', safeFileName(f.name)), h('span.muted.small', Number.isFinite(f.size) ? fmtBytes(f.size) : ''))) : null;
    const note = h('p.muted.small', icon('lock', 12), 'The file comes directly from the other browser, encrypted, and is checked with SHA-256. Nothing is uploaded.');
    if (st.phase === 'paste') {
      fill(card, h('h3', 'Receive a file'), h('p.muted', 'Paste the link or code from the device that’s sending.'),
        pasteBox({ label: 'Code', placeholder: 'S1… or a link', button: 'Continue', onSubmit: async (text) => { await readCode(text); } }), err, note);
    } else if (st.phase === 'reading' || st.phase === 'answering') {
      fill(card, h('p.muted.row', h('span.mini-spin'), st.phase === 'reading' ? 'Reading the code…' : 'Preparing your answer…'));
    } else if (st.phase === 'setup') {
      fill(card, h('h3', st.invite.name ? `${st.invite.name} wants to send you a file` : 'Someone wants to send you a file'), what, ice.el, err,
        h('button.btn.primary.wide', { onclick: answer }, 'Create answer code'), note);
    } else if (st.phase === 'answer') {
      fill(card, h('h3', 'Send this code back'), what,
        h('p.muted', 'Paste it on the sending device. The transfer starts as soon as it’s entered.'),
        codeBlock(st.peer.answerCode, { label: 'Answer code' }),
        h('p.muted.small.row', h('span.mini-spin'), 'Waiting for the other device…'), err, note);
    } else if (st.phase === 'receiving') {
      fill(card, h('h3', 'Receiving'), what, progress.el, h('p.muted.small', 'Keep this tab open until it’s done.'));
    } else if (st.phase === 'done') {
      fill(card, h('p.row', h('span.p2p-ok', icon('check', 18)), h('b', 'Received and checked')),
        h('div.p2p-file', icon('file', 18), h('div', h('b', st.file.name), h('span.muted.small', `${fmtBytes(st.file.size)} · SHA-256 verified`))),
        h('div.row',
          h('button.btn.primary', { onclick: () => downloadFile(st.file, st.file.name) }, icon('download', 15), 'Download'),
          onFile ? h('button.btn', { onclick: () => onFile(st.file, st.meta) }, 'Open in Slipstream') : null));
    } else if (st.phase === 'failed') {
      fill(card, h('h3', 'The file didn’t arrive'), h('p.warn', st.error), h('div.row', h('button.btn.primary', { onclick: () => { st.peer?.close(); st.peer = null; st.error = ''; st.phase = st.invite ? 'paste' : 'paste'; render(); } }, 'Start over')));
    }
  }

  async function readCode(text) {
    const inv = await readInvite(text, 'send');
    st.code = text;
    st.invite = inv;
    ice = iceSettings(inv.ice);
    st.error = '';
    st.phase = 'setup';
    render();
  }

  async function answer() {
    let iceServers;
    try { iceServers = ice.value(); } catch { return; }
    st.phase = 'answering';
    st.error = '';
    render();
    try {
      const peer = await joinAsGuest(st.code, { iceServers, purpose: 'send' });
      st.peer = peer;
      peer.on('file-start', () => { st.phase = 'receiving'; guardUnload(true); progress.text('Starting…'); render(); });
      peer.on('file-progress', (p) => progress.set(p, 'Receiving'));
      peer.onFile(({ file, meta }) => { st.file = file; st.meta = meta; st.phase = 'done'; guardUnload(false); render(); peer.close(); });
      peer.on('file-error', ({ error, resumable }) => {
        guardUnload(false);
        if (resumable && peer.ready) { st.error = `${error.message} Waiting for the sender to try again…`; render(); return; }
        st.error = error.message;
        st.phase = 'failed';
        render();
      });
      peer.on('state', (s) => {
        if ((s === 'failed' || s === 'closed') && st.phase !== 'done' && st.phase !== 'failed') {
          st.error = s === 'failed' ? `The connection failed. ${NO_ICE_HINT.replace('create a new invite', 'ask for a new link')}` : 'The sending device disconnected.';
          st.phase = 'failed';
          guardUnload(false);
          render();
        }
      });
      st.phase = 'answer';
    } catch (err) {
      st.error = err.message;
      st.phase = 'setup';
    }
    render();
  }

  if (st.phase === 'reading') readCode(st.code).catch((err) => { st.error = err.message; st.phase = 'paste'; render(); });
  render();

  return {
    cleanup() {
      guardUnload(false);
      st.peer?.close();
      clearPartials();
    },
  };
}
