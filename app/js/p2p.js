// Direct browser-to-browser links over WebRTC with manual, serverless signalling (S-05, S-06).
//
// There is no signalling server and nothing is built in to reach one: the host's browser turns its
// offer into an invite code, the guest's browser answers with a code of its own, and the two codes
// travel over whatever chat app people already use. Without an ICE server only host and mDNS
// candidates exist, so links work on the same machine or local network; people who need to cross
// NATs can paste their own STUN/TURN server (user-provided, never a literal in this code).
//
// Each Peer carries:
//   - an optional audio+video call (transceivers are created up front, so devices can be swapped
//     with replaceTrack and no renegotiation),
//   - "ctl", an ordered data channel for small JSON messages (app messages, clock pings, transfer
//     handshakes), and "file", an ordered data channel for 64 KB binary frames. Keeping them apart
//     means a stop command never waits behind megabytes of file data.
// File transfers verify SHA-256 end to end: a corrupted transfer is reported, never accepted.

import {
  SIGNAL_VERSION, encodeSignal, decodeSignal, checkSignal, stripSdp, candidateTypes, parseIceServers,
  makeHeader, parseHeader, makeFrame, parseFrame, FRAME_SIZE, FRAME_HEADER_BYTES, FRAME_PAYLOAD,
  createProgress, clockSample, estimateClock,
} from '../../packages/editor-core/src/signal-codes.js';
import { createSha256, sha256Blob } from '../../packages/editor-core/src/sha256.js';

export const p2pSupported = () => typeof RTCPeerConnection !== 'undefined';
/** Milliseconds since the epoch on this device's monotonic clock: the shared-clock unit. */
export const clockNow = () => performance.timeOrigin + performance.now();

const ICE_TIMEOUT = 5000;
const HIGH_WATER = 8 * 1024 * 1024; // pause sending above this (Chrome closes a channel at 16 MB)
const LOW_WATER = 1024 * 1024; // resume when the buffer drains below this
const READ_SIZE = 1024 * 1024; // bytes read from the Blob at a time
const BLOB_BATCH = 8 * 1024 * 1024; // received frames are folded into a Blob every 8 MB
const PING_TIMEOUT = 2000;
/** Exposed for tests and tuning. */
export const TRANSFER_LIMITS = Object.freeze({ HIGH_WATER, LOW_WATER, READ_SIZE, BLOB_BATCH });

// Partially received files, kept for this page's lifetime so a re-sent file resumes where it stopped
// (even over a new connection). Key: `${sha256}:${size}`.
const partials = new Map();
export function clearPartials() { partials.clear(); }

class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }
  emit(type, ...args) {
    for (const fn of [...(this._handlers.get(type) || [])]) {
      try { fn(...args); } catch (err) { console.error(`p2p ${type} handler failed`, err); }
    }
  }
}

const randomId = () => {
  const a = new Uint32Array(1);
  globalThis.crypto?.getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 0xffffffff));
  return a[0];
};

/**
 * Control messages and file transfer over two channel-like objects (RTCDataChannel in the app,
 * fakes in tests): `ctl` carries strings, `data` carries binary frames and exposes bufferedAmount,
 * bufferedAmountLowThreshold and the "bufferedamountlow" event.
 * Events: open, close, json, bye, clock, file-start, file-progress, file, file-error.
 */
export class Wire extends Emitter {
  constructor(ctl, data, { now = clockNow, maxMessageSize = FRAME_SIZE } = {}) {
    super();
    this.ctl = ctl;
    this.data = data;
    this.now = now;
    this.maxMessageSize = maxMessageSize;
    this.queue = [];
    this.sendChain = Promise.resolve();
    this.incoming = null;
    this.transfers = new Map(); // outgoing id → { accept, verdict } deferreds
    this.pings = new Map();
    this.clockSamples = [];
    this.clock = null;
    this.closed = false;
    this._pingSeq = 0;
    this._cancel = null;
    data.binaryType = 'arraybuffer';
    ctl.addEventListener('open', () => this._opened());
    data.addEventListener('open', () => this._opened());
    ctl.addEventListener('message', (e) => this._onCtl(e.data));
    data.addEventListener('message', (e) => this._onData(e.data));
    ctl.addEventListener('close', () => this._closed());
    data.addEventListener('close', () => this._closed());
    if (this.open) queueMicrotask(() => this._opened());
  }

  get open() { return this.ctl.readyState === 'open' && this.data.readyState === 'open'; }

  _opened() {
    if (!this.open || this._didOpen) return;
    this._didOpen = true;
    for (const s of this.queue.splice(0)) this.ctl.send(s);
    this.emit('open');
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    const err = new Error('The connection closed.');
    for (const t of this.transfers.values()) { t.accept.reject(err); t.verdict.reject(err); }
    this.transfers.clear();
    for (const p of this.pings.values()) p.reject(err);
    this.pings.clear();
    if (this.incoming) {
      const { meta } = this.incoming;
      this.incoming = null; // the partial stays in `partials` for a resume
      this.emit('file-error', { meta, error: new Error('The connection closed before the file finished. Reconnect and it will resume.'), resumable: true });
    }
    this.emit('close');
  }

  _sendCtl(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.ctl.readyState === 'open') this.ctl.send(s);
    else if (this.ctl.readyState === 'connecting') this.queue.push(s);
    else throw new Error('The connection is closed.');
  }

  /** Send a small JSON value to the other side (delivered to its onJSON handlers). */
  sendJSON(payload) { this._sendCtl({ app: payload }); }
  bye() { try { this._sendCtl({ sys: 'bye' }); } catch { /* already closed */ } }

  _onCtl(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if ('app' in m) { this.emit('json', m.app); return; }
    switch (m.sys) {
      case 'ping': this._sendCtl({ sys: 'pong', i: m.i, b: this.now() }); break;
      case 'pong': { const p = this.pings.get(m.i); if (p) { this.pings.delete(m.i); p.resolve(m.b); } break; }
      case 'file': this._incomingHeader(m); break;
      case 'accept': this.transfers.get(m.id)?.accept.resolve(m); break;
      case 'ok': this.transfers.get(m.id)?.verdict.resolve(m); break;
      case 'bad': {
        const t = this.transfers.get(m.id);
        const err = new Error(m.reason === 'checksum'
          ? 'The file arrived damaged (its SHA-256 didn’t match), so the other side discarded it. Try sending again.'
          : `The other side rejected the file: ${m.reason || 'unknown reason'}.`);
        err.reason = m.reason;
        if (t) { t.failed = err; t.accept.reject(err); t.verdict.reject(err); }
        break;
      }
      case 'cancel': if (this.incoming?.meta.id === m.id) { const { meta } = this.incoming; this.incoming = null; this.emit('file-error', { meta, error: new Error('The sender stopped the transfer.'), resumable: true }); } break;
      case 'bye': this.emit('bye'); break;
      default: break;
    }
  }

  // ---- clock ----------------------------------------------------------------------------------
  _ping() {
    const i = ++this._pingSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pings.delete(i); reject(new Error('No reply to a clock ping.')); }, PING_TIMEOUT);
      this.pings.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this._sendCtl({ sys: 'ping', i });
    });
  }

  /** Estimate the other side's clock minus ours with `n` pings. Returns { offset, rtt, samples } (ms). */
  async syncClock(n = 6) {
    for (let k = 0; k < n; k++) {
      const a = this.now();
      let b;
      try { b = await this._ping(); } catch { continue; }
      this.clockSamples.push(clockSample(a, b, this.now()));
    }
    this.clock = estimateClock(this.clockSamples) || this.clock;
    if (this.clock) this.emit('clock', this.clock);
    return this.clock;
  }

  /** Convert a timestamp taken on the other side's clock to ours. */
  toLocalTime(remoteTime) { return remoteTime - (this.clock?.offset || 0); }

  // ---- sending files --------------------------------------------------------------------------
  /**
   * Send a Blob/File. meta: { name, type, kind, sha256?, extra? }. onProgress({ phase: 'hash' |
   * 'send' | 'verify' | 'done', done, total, fraction, rate, eta }). Resolves once the receiver has
   * checked the SHA-256; rejects if it doesn't match, the receiver refuses it or the link closes.
   * Calls are queued, one transfer at a time.
   */
  sendFile(blob, meta = {}, onProgress = () => {}) {
    const run = () => this._sendFile(blob, meta, onProgress);
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => {});
    return p;
  }

  /** Stop the current outgoing transfer; the receiver keeps what it has for a later resume. */
  cancelSend() { this._cancel?.(); }

  async _sendFile(blob, meta, onProgress) {
    if (this.closed) throw new Error('The connection is closed.');
    const size = blob.size;
    let sha256 = meta.sha256;
    if (!sha256) {
      const hp = createProgress(size, { now: this.now });
      sha256 = await sha256Blob(blob, (done) => onProgress({ phase: 'hash', ...hp.update(done) }));
    }
    const id = randomId();
    const header = makeHeader({ id, name: meta.name ?? blob.name ?? 'file', type: meta.type || blob.type, size, sha256, kind: meta.kind || 'export', extra: meta.extra });
    const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; };
    const t = { accept: deferred(), verdict: deferred() };
    this.transfers.set(id, t);
    let cancelled = false;
    this._cancel = () => { cancelled = true; try { this._sendCtl({ sys: 'cancel', id }); } catch { /* closed */ } t.accept.reject(new Error('Transfer cancelled.')); t.verdict.reject(new Error('Transfer cancelled.')); };
    try {
      this._sendCtl(header);
      const { offset = 0 } = await t.accept.promise;
      const ch = this.data;
      ch.bufferedAmountLowThreshold = LOW_WATER;
      const payloadSize = Math.max(1024, Math.min(FRAME_PAYLOAD, (this.maxMessageSize || FRAME_SIZE) - FRAME_HEADER_BYTES));
      const tracker = createProgress(size, { now: this.now, start: offset });
      let lastReport = 0;
      const report = (phase, done) => {
        const now = this.now();
        if (phase === 'send' && now - lastReport < 100 && done < size) return;
        lastReport = now;
        onProgress({ phase, ...tracker.update(Math.max(offset, done)) });
      };
      const readSize = payloadSize * Math.max(1, Math.floor(READ_SIZE / payloadSize)); // whole frames per read
      for (let off = offset; off < size;) {
        const end = Math.min(size, off + readSize);
        const buf = new Uint8Array(await blob.slice(off, end).arrayBuffer());
        if (buf.byteLength !== end - off) throw new Error('Could not read the file: it may have been moved or changed.');
        for (let i = 0; i < buf.byteLength; i += payloadSize) {
          if (cancelled) throw new Error('Transfer cancelled.');
          if (t.failed) throw t.failed;
          if (this.closed || ch.readyState !== 'open') throw new Error('The connection closed during the transfer.');
          if (ch.bufferedAmount > HIGH_WATER) await this._drain();
          const part = buf.subarray(i, Math.min(buf.byteLength, i + payloadSize));
          ch.send(makeFrame(id, off + i, part, { last: off + i + part.byteLength === size }));
        }
        off = end;
        report('send', off - ch.bufferedAmount);
      }
      // Everything is queued; keep reporting while the buffer drains and the receiver checks it.
      const timer = setInterval(() => report(ch.bufferedAmount > 0 ? 'send' : 'verify', size - ch.bufferedAmount), 200);
      try { await t.verdict.promise; } finally { clearInterval(timer); }
      onProgress({ phase: 'done', ...tracker.update(size) });
      return { id, sha256, size };
    } finally {
      this.transfers.delete(id);
      this._cancel = null;
    }
  }

  _drain() {
    const ch = this.data;
    return new Promise((resolve, reject) => {
      const cleanup = () => { ch.removeEventListener('bufferedamountlow', done); ch.removeEventListener('close', fail); clearInterval(poll); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('The connection closed during the transfer.')); };
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', fail);
      // Safety net for engines that skip the event when the buffer was already low.
      const poll = setInterval(() => { if (ch.readyState !== 'open') fail(); else if (ch.bufferedAmount <= LOW_WATER) done(); }, 250);
    });
  }

  // ---- receiving files ------------------------------------------------------------------------
  _incomingHeader(raw) {
    let meta;
    try { meta = parseHeader(raw); } catch (err) {
      this._sendCtl({ sys: 'bad', id: raw?.id, reason: err.message });
      return;
    }
    if (this.incoming) this.emit('file-error', { meta: this.incoming.meta, error: new Error('A new file started before the previous one finished.'), resumable: true });
    const key = `${meta.sha256}:${meta.size}`;
    let st = partials.get(key);
    if (!st || st.received > meta.size) st = { hasher: createSha256(), parts: [], pending: [], pendingBytes: 0, received: 0 };
    partials.set(key, st);
    this.incoming = { meta, key, st, tracker: createProgress(meta.size, { now: this.now, start: st.received }), last: 0 };
    this.emit('file-start', { meta, offset: st.received });
    this._sendCtl({ sys: 'accept', id: meta.id, offset: st.received });
    if (st.received === meta.size) this._finishIncoming();
  }

  _onData(data) {
    const inc = this.incoming;
    if (!inc) return; // stray frame from a cancelled transfer
    let f;
    try { f = parseFrame(data); } catch { this._failIncoming('a damaged data frame arrived', true); return; }
    if (f.id !== inc.meta.id) return;
    const { st, meta } = inc;
    if (f.offset !== st.received) { this._failIncoming(`data arrived out of order (expected byte ${st.received}, got ${f.offset})`, true); return; }
    if (st.received + f.payload.byteLength > meta.size) { this._failIncoming('more data arrived than the file’s size', false); return; }
    st.hasher.update(f.payload);
    st.pending.push(f.payload);
    st.pendingBytes += f.payload.byteLength;
    st.received += f.payload.byteLength;
    if (st.pendingBytes >= BLOB_BATCH) { st.parts.push(new Blob(st.pending)); st.pending = []; st.pendingBytes = 0; }
    const now = this.now();
    if (now - inc.last >= 100 || st.received === meta.size) {
      inc.last = now;
      this.emit('file-progress', { meta, ...inc.tracker.update(st.received) });
    }
    if (st.received === meta.size) this._finishIncoming();
  }

  _failIncoming(reason, keep) {
    const { meta, key } = this.incoming;
    this.incoming = null;
    if (!keep) partials.delete(key);
    try { this._sendCtl({ sys: 'bad', id: meta.id, reason }); } catch { /* closed */ }
    this.emit('file-error', { meta, error: new Error(`The transfer failed: ${reason}.`), resumable: keep });
  }

  _finishIncoming() {
    const { meta, key, st } = this.incoming;
    this.incoming = null;
    partials.delete(key);
    const got = st.hasher.digestHex();
    if (got !== meta.sha256) {
      try { this._sendCtl({ sys: 'bad', id: meta.id, reason: 'checksum' }); } catch { /* closed */ }
      this.emit('file-error', { meta, error: new Error('The file arrived damaged: its SHA-256 doesn’t match, so it was discarded.'), resumable: false });
      return;
    }
    const file = new File([...st.parts, ...st.pending], meta.name, { type: meta.type });
    try { this._sendCtl({ sys: 'ok', id: meta.id }); } catch { /* closed; the file is still good */ }
    this.emit('file', { file, meta });
  }
}

// ---- WebRTC peer ----------------------------------------------------------------------------------
function iceGathered(pc, timeout) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); pc.removeEventListener('icecandidate', cand); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const cand = (e) => { if (!e.candidate) done(); };
    const timer = setTimeout(done, timeout);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', cand);
  });
}

function preferCodecs(transceiver, kind) {
  try {
    const caps = globalThis.RTCRtpReceiver?.getCapabilities?.(kind)?.codecs;
    if (!caps || !transceiver.setCodecPreferences) return;
    const main = caps.filter((c) => c.mimeType.toLowerCase() === (kind === 'audio' ? 'audio/opus' : 'video/vp8'));
    if (!main.length) return;
    const rtx = kind === 'video' ? caps.filter((c) => c.mimeType.toLowerCase() === 'video/rtx') : [];
    transceiver.setCodecPreferences([...main, ...rtx]);
  } catch { /* stripSdp trims codecs anyway */ }
}

/** Only well-formed stun:/turn: entries from an invite are used; anything else is ignored. */
function sanitizeIce(list) {
  if (!Array.isArray(list) || !list.length) return [];
  try { return parseIceServers(JSON.stringify(list)); } catch { return []; }
}

class Peer extends Emitter {
  constructor(role, { iceServers = [], media = null, purpose = 'call', name = '', shareIce = true } = {}) {
    super();
    this.role = role;
    this.purpose = purpose;
    this.name = name;
    this.iceServers = iceServers;
    this.shareIce = shareIce;
    this.remoteName = '';
    this.closed = false;
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.remoteStream = purpose === 'call' ? new MediaStream() : null;
    const ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    const data = this.pc.createDataChannel('file', { negotiated: true, id: 1, ordered: true });
    this.wire = new Wire(ctl, data);
    for (const ev of ['json', 'file', 'file-start', 'file-progress', 'file-error', 'clock']) this.wire.on(ev, (...a) => this.emit(ev, ...a));
    this.wire.on('open', () => {
      const max = this.pc.sctp?.maxMessageSize;
      if (max && max > FRAME_HEADER_BYTES + 1024) this.wire.maxMessageSize = Math.min(FRAME_SIZE, max);
      this.emit('ready');
      this.emit('state', this.state);
    });
    this.wire.on('close', () => this.emit('state', this.state));
    this.wire.on('bye', () => { this.emit('bye'); this.close({ notify: false }); });
    this.pc.addEventListener('connectionstatechange', () => this.emit('state', this.state));
    this.pc.addEventListener('iceconnectionstatechange', () => this.emit('state', this.state));
    this.pc.addEventListener('track', (e) => {
      if (!this.remoteStream) return;
      if (!this.remoteStream.getTracks().includes(e.track)) this.remoteStream.addTrack(e.track);
      const changed = () => this.emit('track', this.remoteStream);
      e.track.addEventListener('unmute', changed);
      e.track.addEventListener('mute', changed);
      changed();
    });
    if (purpose === 'call' && role === 'host') {
      preferCodecs(this.pc.addTransceiver('audio', { direction: 'sendrecv' }), 'audio');
      preferCodecs(this.pc.addTransceiver('video', { direction: 'sendrecv' }), 'video');
    }
    this.media = null;
    if (media) this._pendingMedia = this.setMedia(media);
  }

  /** 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'; 'connected' once data can flow. */
  get state() {
    if (this.closed) return 'closed';
    const s = this.pc.connectionState || ({ checking: 'connecting', completed: 'connected' }[this.pc.iceConnectionState] ?? this.pc.iceConnectionState);
    if (s === 'connected' && !this.wire.open) return 'connecting';
    return s;
  }
  get ready() { return this.state === 'connected'; }
  get clock() { return this.wire.clock; }

  _transceiver(kind) {
    return this.pc.getTransceivers().find((t) => t.receiver?.track?.kind === kind && !t.stopped);
  }

  /** Swap the camera/mic sent to the other side (null stops sending). No renegotiation needed. */
  async setMedia(stream) {
    this.media = stream || null;
    if (this.purpose !== 'call') return;
    const a = stream?.getAudioTracks()[0] || null;
    const v = stream?.getVideoTracks()[0] || null;
    await Promise.all([this._transceiver('audio')?.sender.replaceTrack(a), this._transceiver('video')?.sender.replaceTrack(v)]);
  }

  async _localCode(kind, extra, timeout) {
    await iceGathered(this.pc, timeout);
    const sdp = stripSdp(this.pc.localDescription.sdp);
    this.localCandidates = candidateTypes(sdp);
    const sig = { v: SIGNAL_VERSION, k: kind, sdp, ...extra };
    if (this.name) sig.n = String(this.name).slice(0, 60);
    return encodeSignal(sig);
  }

  /** Host: create the invite code (waits for ICE gathering, up to `timeout` ms). */
  async createInvite({ timeout = ICE_TIMEOUT, extra = {} } = {}) {
    if (this.role !== 'host') throw new Error('Only the host creates an invite.');
    await this._pendingMedia;
    await this.pc.setLocalDescription(await this.pc.createOffer());
    const add = { p: this.purpose, ...extra };
    if (this.shareIce && this.iceServers.length) add.ice = this.iceServers;
    this.inviteCode = await this._localCode('offer', add, timeout);
    return this.inviteCode;
  }

  /** Host: apply the guest's answer code. Throws SignalCodeError with a readable message. */
  async accept(answerCode) {
    if (this.role !== 'host') throw new Error('Only the host accepts an answer.');
    const sig = checkSignal(await decodeSignal(answerCode), 'answer');
    if (this.pc.signalingState !== 'have-local-offer') throw new Error('This invite has already been answered. Create a new invite for another person.');
    this.remoteName = typeof sig.n === 'string' ? sig.n.slice(0, 60) : '';
    await this.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
    this.emit('state', this.state);
  }

  sendJSON(payload) { this.wire.sendJSON(payload); }
  onJSON(fn) { return this.on('json', fn); }
  onFile(fn) { return this.on('file', fn); }
  onState(fn) { return this.on('state', fn); }
  sendFile(blob, meta, onProgress) { return this.wire.sendFile(blob, meta, onProgress); }
  cancelSend() { this.wire.cancelSend(); }
  syncClock(n) { return this.wire.syncClock(n); }
  toLocalTime(t) { return this.wire.toLocalTime(t); }

  /** How the link is routed: 'local' (both host candidates), 'direct' (through NAT) or 'relay' (TURN). */
  async route() {
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = pair || s; });
      if (!pair) return null;
      const types = [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType];
      if (types.includes('relay')) return 'relay';
      return types.every((t) => t === 'host') ? 'local' : 'direct';
    } catch { return null; }
  }

  /** End the link. The other side is told first (unless it already left). Local media is not stopped. */
  close({ notify = true } = {}) {
    if (this.closed) return;
    if (notify) this.wire.bye();
    this.closed = true;
    this.remoteStream?.getTracks().forEach((t) => t.stop());
    const pc = this.pc;
    setTimeout(() => { try { pc.close(); } catch { /* ignore */ } }, notify ? 150 : 0);
    this.emit('state', 'closed');
  }
}

/**
 * Host side. `media` is the MediaStream to send (may be set later with setMedia); `purpose` is
 * 'call' (camera + mic + data) or 'send' (data only). Call createInvite(), then accept(answer).
 */
export function createHost({ iceServers = [], media = null, purpose = 'call', name = '', shareIce = true } = {}) {
  if (!p2pSupported()) throw new Error('This browser doesn’t support direct connections (WebRTC).');
  return new Peer('host', { iceServers, media, purpose, name, shareIce });
}

/** Decode and check an invite without connecting: { n?: host name, p, f?: file info, ice? }. */
export async function readInvite(code, purpose = 'call') {
  const sig = checkSignal(await decodeSignal(code), 'offer', purpose);
  return { name: typeof sig.n === 'string' ? sig.n.slice(0, 60) : '', purpose: sig.p || 'call', file: sig.f && typeof sig.f === 'object' ? sig.f : null, ice: sanitizeIce(sig.ice) };
}

/**
 * Guest side: answer an invite. Resolves to a Peer with `answerCode` (send it back to the host)
 * and `invite` ({ name, purpose, file, ice }). `iceServers: null` (default) uses the ones in the invite;
 * pass an array (even empty) to override them.
 */
export async function joinAsGuest(code, { iceServers = null, media = null, name = '', purpose = 'call', timeout = ICE_TIMEOUT } = {}) {
  if (!p2pSupported()) throw new Error('This browser doesn’t support direct connections (WebRTC).');
  const sig = checkSignal(await decodeSignal(code), 'offer', purpose);
  const invite = { name: typeof sig.n === 'string' ? sig.n.slice(0, 60) : '', purpose: sig.p || 'call', file: sig.f || null, ice: sanitizeIce(sig.ice) };
  const peer = new Peer('guest', { iceServers: iceServers ?? invite.ice, purpose, name });
  peer.invite = invite;
  peer.remoteName = invite.name;
  try {
    await peer.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
    if (purpose === 'call') {
      for (const t of peer.pc.getTransceivers()) if (t.receiver?.track) t.direction = 'sendrecv';
      if (media) await peer.setMedia(media);
    }
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    peer.answerCode = await peer._localCode('answer', {}, timeout);
  } catch (err) {
    peer.close({ notify: false });
    throw err;
  }
  return peer;
}
